/**
 * Ollama adapter: agents on local models, fully offline (docs/09 Runtimes & Sessions.md).
 *
 * Ollama only generates text and tool calls; it has no agent loop and no MCP client. So this adapter:
 *  1. connects to Sebeto's own MCP tool server with the run's token (the same tools, gate, audit and
 *     untrusted-content rules as every other runtime),
 *  2. offers those tools to the model through Ollama's /api/chat `tools`,
 *  3. runs the loop: model → tool calls → tool results → model, until the model answers without
 *     tools, a permission is requested (the turn ends, as the tool tells it to), or limits are hit.
 * The conversation is kept in <ticket>/.sebeto/ollama-<session>.json (reserved and never versioned),
 * so a ticket resumes where it stopped. Local models cost nothing, so costUsd is 0.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentEvent, RuntimeAdapter, RuntimeDetection, TicketRun } from '@sebeto/shared';
import { httpFetch } from './http-fetch.js';

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
/** Max model calls per run (each may call several tools). */
export const OLLAMA_MAX_TURNS = 25;
/** Tool output sent back to the model is capped: small models have small context windows. */
export const OLLAMA_TOOL_RESULT_MAX = 12_000;
/** Messages kept from earlier runs (plus the system prompt). */
export const OLLAMA_HISTORY_MAX = 60;
/**
 * Longest wait for one model reply (minutes). Default 30: a big model on a small GPU (mostly on the
 * CPU) can need many minutes per reply. SEBETO_OLLAMA_TIMEOUT_MIN changes it (1–240).
 */
export const OLLAMA_REPLY_TIMEOUT_MIN = 30;
export function ollamaReplyTimeoutMs(env: string | undefined = process.env.SEBETO_OLLAMA_TIMEOUT_MIN): number {
  const n = Number.parseInt(env ?? '', 10);
  return (Number.isFinite(n) && n >= 1 && n <= 240 ? n : OLLAMA_REPLY_TIMEOUT_MIN) * 60_000;
}
/** Times a malformed model reply (e.g. invalid tool-call JSON) is corrected before the run aborts. */
export const OLLAMA_MALFORMED_RETRIES = 2;
/** Does an Ollama error mean the model's reply couldn't be parsed (not a missing model or a timeout)? */
export function isMalformedReplyError(message: string): boolean {
  return /invalid character|in string literal|cannot unmarshal|invalid json|failed to parse|unexpected end of|looking for beginning of/i.test(message);
}
/**
 * After a single tool has been used this many times, further uses of it no longer count as progress.
 * Catches a model that keeps making varied-but-off-task calls (e.g. reading reference file after
 * reference file) and never advances toward the deliverable — the subtle cousin of the repeat loop.
 */
export const OLLAMA_TOOL_SOFT_CAP = 6;
/** Consecutive unproductive turns (only repeated, failed, or over-used tool calls) before the advisor. */
export const OLLAMA_PIVOT_AFTER = 3;
/** Most advisor pivots per run, so a stuck driver can't ping-pong with the advisor forever. */
export const OLLAMA_MAX_PIVOTS = 2;
/**
 * Advisor ("smart model") that re-plans when the small driver model is stuck. It needs no tool
 * support (it only reasons), so a security-reasoning model like Foundation-Sec is a good fit.
 * Off by default; set SEBETO_OLLAMA_PIVOT_MODEL to the advisor's Ollama name to enable it.
 */
export function ollamaPivotModel(env: string | undefined = process.env.SEBETO_OLLAMA_PIVOT_MODEL): string | undefined {
  const v = (env ?? '').trim();
  return v.length ? v : undefined;
}
const SESSION_RE = /^[A-Za-z0-9-]{1,80}$/;

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_name?: string;
}

interface ChatResponse {
  message?: OllamaMessage;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** The tools part of a run, so tests can replace Sebeto's MCP server with a fake. */
export interface ToolBridge {
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export interface OllamaAdapterOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** How to reach Sebeto's tools for a run (default: MCP over Streamable HTTP). */
  connectTools?: (mcp: { url: string; token: string }) => Promise<ToolBridge>;
  maxTurns?: number;
  /** Context window requested from Ollama (tokens). */
  numCtx?: number;
  /** Advisor model that re-plans when the driver is stuck (default: SEBETO_OLLAMA_PIVOT_MODEL; null = off). */
  pivotModel?: string | null;
  /** Unproductive turns before the advisor is asked (tests; default OLLAMA_PIVOT_AFTER). */
  pivotAfter?: number;
  /** Most advisor pivots per run (tests; default OLLAMA_MAX_PIVOTS). */
  maxPivots?: number;
  /** Uses of one tool after which further uses stop counting as progress (tests; default OLLAMA_TOOL_SOFT_CAP). */
  toolSoftCap?: number;
}

/** Default bridge: an MCP client to Sebeto's tool server, scoped by the run's token. */
export async function mcpToolBridge(mcp: { url: string; token: string }): Promise<ToolBridge> {
  const client = new Client({ name: 'sebeto-ollama', version: '0.2' });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), {
    requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } },
  }));
  const list = await client.listTools();
  return {
    tools: list.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown> })),
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      const parts = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
      return { text: parts.map((p) => (p.type === 'text' ? p.text ?? '' : `[${p.type}]`)).join('\n'), isError: !!res.isError };
    },
    close: () => client.close(),
  };
}

/**
 * Remove <think>…</think> blocks that reasoning models put in their answer. Handles two shapes of a
 * *dangling* </think> with no opening tag: the usual "thoughts</think>answer" (keep what follows),
 * and the inverted "answer</think>" some models emit (keep what precedes — don't drop the answer).
 * Exported for tests.
 */
export function stripThinking(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const close = t.search(/<\/think>/i);
  if (close !== -1) {
    const after = t.slice(close).replace(/<\/think>/i, '').trim();
    const before = t.slice(0, close).trim();
    t = after.length ? after : before; // answer after the tag, else the answer was before it
  }
  return t.replace(/<\/?think>/gi, '').trim();
}

function parseArgs(a: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!a) return {};
  if (typeof a === 'string') {
    try {
      const v = JSON.parse(a) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return a;
}

const short = (o: unknown) => {
  const s = JSON.stringify(o);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

export function createOllamaAdapter(opts: OllamaAdapterOptions = {}): RuntimeAdapter {
  // SEBETO_OLLAMA_URL (e.g. an SSH tunnel to another computer's Ollama) > OLLAMA_HOST > this computer.
  const baseUrl = (opts.baseUrl ?? process.env.SEBETO_OLLAMA_URL ?? process.env.OLLAMA_HOST ?? OLLAMA_DEFAULT_URL).replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'http://');
  // node:http, not the global fetch: undici aborts after 300 s without response headers (slow local models).
  const doFetch = opts.fetchImpl ?? (httpFetch as typeof fetch);
  const replyTimeoutMs = ollamaReplyTimeoutMs();
  const connectTools = opts.connectTools ?? mcpToolBridge;
  const maxTurns = opts.maxTurns ?? OLLAMA_MAX_TURNS;
  // Context window: option > SEBETO_OLLAMA_NUM_CTX (bigger GPUs can afford more) > 16k.
  const envCtx = Number.parseInt(process.env.SEBETO_OLLAMA_NUM_CTX ?? '', 10);
  const numCtx = opts.numCtx ?? (Number.isFinite(envCtx) && envCtx >= 2048 && envCtx <= 1_048_576 ? envCtx : 16_384);
  // Stuck-detection safeguard: when set, a stronger "advisor" model re-plans if the driver loops.
  const pivotModel = opts.pivotModel === undefined ? ollamaPivotModel() : (opts.pivotModel ?? undefined);
  const pivotAfter = opts.pivotAfter ?? OLLAMA_PIVOT_AFTER;
  const maxPivots = opts.maxPivots ?? OLLAMA_MAX_PIVOTS;
  const toolSoftCap = opts.toolSoftCap ?? OLLAMA_TOOL_SOFT_CAP;
  const capsCache = new Map<string, string[]>(); // digest → capabilities

  async function json<T>(p: string, body?: unknown, signal?: AbortSignal, timeoutMs = 5000): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await doFetch(`${baseUrl}${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Ollama answered ${res.status}`);
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * One no-tools reasoning call to the advisor model: given the task, the tools the driver actually
   * has, and what it keeps trying, return one concrete way to pivot. Failures are swallowed (the run
   * continues without a hint). The advisor only reads the driver's own transcript and never acts.
   */
  async function askAdvisor(
    advisorModel: string,
    task: string,
    toolList: Array<{ name: string; description: string }>,
    attempts: string,
    signal: AbortSignal,
  ): Promise<{ advice: string | null; tin: number; tout: number }> {
    const sys =
      'You are a senior offensive-security engineer mentoring an AI agent that is stuck repeating actions that do not work. The agent can act ONLY through the tools listed — it has no shell and no raw network access. Reply with ONE short, concrete next action, naming the tool to use and why the stuck approach fails. At most 3 sentences. No preamble, no code fences.';
    const toolsText = toolList.map((t) => `- ${t.name}: ${t.description}`).join('\n').slice(0, 2000);
    const user = `The agent's task:\n${task.slice(0, 1500)}\n\nTools the agent actually has:\n${toolsText}\n\nWhat it keeps trying (and the results):\n${attempts.slice(0, 2000)}\n\nGive it one different, concrete next step with these tools.`;
    try {
      const res = await json<ChatResponse>(
        '/api/chat',
        { model: advisorModel, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], stream: false, options: { num_ctx: numCtx } },
        signal,
        replyTimeoutMs,
      );
      const advice = stripThinking(res.message?.content ?? '').slice(0, 1200);
      return { advice: advice || null, tin: res.prompt_eval_count ?? 0, tout: res.eval_count ?? 0 };
    } catch {
      return { advice: null, tin: 0, tout: 0 };
    }
  }

  /** Installed models that support tool calling (agents need tools). */
  async function toolModels(): Promise<string[]> {
    const tags = await json<{ models?: Array<{ name: string; digest?: string }> }>('/api/tags');
    const out: string[] = [];
    for (const m of tags.models ?? []) {
      const key = m.digest ?? m.name;
      let caps = capsCache.get(key);
      if (!caps) {
        const show = await json<{ capabilities?: string[] }>('/api/show', { model: m.name }).catch(() => ({ capabilities: [] as string[] }));
        caps = show.capabilities ?? [];
        capsCache.set(key, caps);
      }
      if (caps.includes('tools')) out.push(m.name);
    }
    return out.sort();
  }

  async function detect(): Promise<RuntimeDetection> {
    let version: string;
    try {
      version = (await json<{ version?: string }>('/api/version', undefined, undefined, 2000)).version ?? 'unknown';
    } catch {
      return { installed: false, problem: 'Ollama is not running on this computer. Install it from ollama.com and start it.' };
    }
    const models = await toolModels().catch(() => [] as string[]);
    return models.length
      ? { installed: true, version, loggedIn: true }
      : { installed: true, version, loggedIn: true, problem: 'No model with tool support is installed. Download one, for example: ollama pull qwen3' };
  }

  async function* run(r: TicketRun): AsyncGenerator<AgentEvent> {
    const sessionId = r.externalSessionId ?? r.newExternalSessionId ?? `ollama-${r.runId}`;
    if (!SESSION_RE.test(sessionId)) {
      yield { kind: 'error', message: 'Invalid session id.' };
      yield { kind: 'done', isError: true, costUsd: 0 };
      return;
    }
    yield { kind: 'session', externalSessionId: sessionId };

    const model = r.model || (await toolModels().catch(() => []))[0];
    if (!model) {
      yield { kind: 'error', message: 'No Ollama model with tool support is installed. Download one, for example: ollama pull qwen3' };
      yield { kind: 'done', isError: true, costUsd: 0 };
      return;
    }

    const historyFile = path.join(r.cwd, '.sebeto', `ollama-${sessionId}.json`);
    let history: OllamaMessage[] = [];
    try {
      history = JSON.parse(await fsp.readFile(historyFile, 'utf8')) as OllamaMessage[];
    } catch { /* new session */ }

    let bridge: ToolBridge | null = null;
    if (r.mcp) {
      try {
        bridge = await connectTools(r.mcp);
      } catch (err) {
        yield { kind: 'error', message: `Could not reach Sebeto's tools: ${(err as Error).message}` };
        yield { kind: 'done', isError: true, costUsd: 0 };
        return;
      }
    }

    const tools = (bridge?.tools ?? []).map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: { type: 'object', ...t.inputSchema } },
    }));
    const system: OllamaMessage = {
      role: 'system',
      content: `${r.systemPrompt}\n\nUse the provided tools to act; you cannot do anything outside them. When a tool says a permission was requested, stop and wait.`,
    };
    const convo: OllamaMessage[] = [...history.slice(-OLLAMA_HISTORY_MAX), { role: 'user', content: r.prompt }];
    let tokensIn = 0;
    let tokensOut = 0;
    let contextTokens = 0;
    let isError = false;
    // Stuck-detection state for the pivot-assist safeguard.
    const signatures = new Set<string>();
    const toolUseCount = new Map<string, number>();
    let unproductiveStreak = 0;
    let pivotsUsed = 0;
    let recentAttempts: string[] = [];
    let malformedRetries = 0;
    /** The agent handed the ticket back (needs you / blocked / done): one last reply, without tools. */
    let finalReported = false;

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (r.signal.aborted) return;
        let res: ChatResponse;
        try {
          res = await json<ChatResponse>('/api/chat', {
            model, messages: [system, ...convo], tools: finalReported ? [] : tools, stream: false,
            options: { num_ctx: numCtx },
          }, r.signal, replyTimeoutMs);
        } catch (err) {
          if (r.signal.aborted) return;
          const msg = (err as Error).message;
          const timedOut = (err as Error).name === 'AbortError' || /aborted/i.test(msg);
          if (timedOut) {
            yield { kind: 'error', message: `Ollama did not answer within ${Math.round(replyTimeoutMs / 60_000)} minutes (the model may be too big for this computer's GPU). Pick a smaller model, or raise SEBETO_OLLAMA_TIMEOUT_MIN.` };
            isError = true;
            break;
          }
          // Some local models emit a tool call with invalid JSON (e.g. a raw newline in a string),
          // which Ollama rejects. Don't kill the run: tell the model to re-issue it and try again.
          if (isMalformedReplyError(msg) && malformedRetries < OLLAMA_MALFORMED_RETRIES) {
            malformedRetries++;
            yield { kind: 'text', text: `The model produced an invalid tool call (${msg}); asking it to retry (${malformedRetries}/${OLLAMA_MALFORMED_RETRIES}).` };
            convo.push({ role: 'user', content: 'Your previous reply was not valid: a tool call contained malformed JSON (for example a raw newline inside a string value). Re-issue it as a single tool call with properly escaped JSON arguments, or answer in plain text. Do not repeat the invalid output.' });
            continue;
          }
          yield { kind: 'error', message: /not found/i.test(msg) ? `The model "${model}" is not installed in Ollama (ollama pull ${model}).` : `Ollama failed: ${msg}` };
          isError = true;
          break;
        }
        tokensIn += res.prompt_eval_count ?? 0;
        // Ollama may skip cached tokens in prompt_eval_count: also estimate from the text (~4 chars/token).
        const approx = Math.ceil(([system, ...convo].reduce((n, m) => n + m.content.length, 0) + JSON.stringify(tools).length) / 4);
        contextTokens = Math.max(contextTokens, res.prompt_eval_count ?? 0, approx);
        tokensOut += res.eval_count ?? 0;
        const msg = res.message ?? { role: 'assistant', content: '' };
        const calls = msg.tool_calls ?? [];
        convo.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
        const text = stripThinking(msg.content ?? '');
        if (text) yield { kind: 'text', text };
        // The wrap-up reply after a final status: whatever it says, the turn ends here (any tool calls are ignored).
        if (finalReported) break;
        if (!calls.length) break;

        let stop = false;
        let turnProductive = false;
        for (const c of calls) {
          const name = c.function?.name ?? '';
          const args = parseArgs(c.function?.arguments);
          yield { kind: 'tool', name, summary: `Used Sebeto tool ${name} ${short(args)}` };
          let out: { text: string; isError: boolean };
          if (!bridge || !bridge.tools.some((t) => t.name === name)) {
            out = { text: `Unknown tool "${name}". Use one of the provided tools.`, isError: true };
          } else {
            try {
              out = await bridge.call(name, args);
            } catch (err) {
              out = { text: `The tool failed: ${(err as Error).message}`, isError: true };
            }
          }
          const capped = out.text.length > OLLAMA_TOOL_RESULT_MAX ? `${out.text.slice(0, OLLAMA_TOOL_RESULT_MAX)}\n[truncated]` : out.text;
          convo.push({ role: 'tool', content: capped, tool_name: name });
          // Stuck-detection: a call makes progress only if it is new (not retried), did not error,
          // and the tool hasn't been leaned on past the soft cap (varied but off-task spinning).
          const sig = `${name} ${JSON.stringify(args)}`;
          const useCount = (toolUseCount.get(name) ?? 0) + 1;
          toolUseCount.set(name, useCount);
          if (!signatures.has(sig) && !out.isError && useCount <= toolSoftCap) turnProductive = true;
          signatures.add(sig);
          recentAttempts.push(`${name}(${short(args)}) → ${out.isError ? 'ERROR: ' : ''}${capped.slice(0, 300)}`);
          // The gate asked the owner: end the turn now, like Claude does (deterministic for small models).
          if (/^Permission requested from the owner/.test(out.text)) stop = true;
          // A final status (needs you / blocked / done) ends the turn, like Claude does: one wrap-up reply
          // without tools follows. Small local models otherwise keep calling tools after handing the
          // ticket back (seen with qwen3:14b).
          if (name === 'report_status' && !out.isError && ['needs_you', 'blocked', 'done'].includes(String(args.status))) finalReported = true;
        }
        if (stop) break;

        // Pivot assist: if the driver keeps only repeating or erroring, ask the advisor ("smart
        // model") how to change tack and feed that back in, so a weak local model isn't left looping.
        if (turnProductive) {
          unproductiveStreak = 0;
          recentAttempts = [];
        } else {
          unproductiveStreak++;
        }
        if (pivotModel && unproductiveStreak >= pivotAfter && pivotsUsed < maxPivots) {
          const { advice, tin, tout } = await askAdvisor(pivotModel, r.prompt, bridge?.tools ?? [], recentAttempts.slice(-8).join('\n'), r.signal);
          tokensIn += tin;
          tokensOut += tout;
          pivotsUsed++;
          unproductiveStreak = 0;
          recentAttempts = [];
          if (advice) {
            yield { kind: 'text', text: `↪︎ Stuck after ${pivotAfter} turns — asked the advisor (${pivotModel}) how to pivot:\n${advice}` };
            convo.push({
              role: 'user',
              content: `You are stuck: you keep repeating actions that don't work. A senior security advisor suggests a different approach:\n\n${advice}\n\nFollow it now. Take a concrete, different action with the tools — do not repeat the failed approach.`,
            });
          } else {
            yield { kind: 'text', text: `↪︎ Stuck after ${pivotAfter} turns — asked the advisor (${pivotModel}) but it returned no usable suggestion.` };
          }
        }
        if (turn === maxTurns - 1) yield { kind: 'error', message: `Stopped after ${maxTurns} steps without finishing.` };
      }
    } finally {
      await bridge?.close().catch(() => undefined);
      await fsp.mkdir(path.dirname(historyFile), { recursive: true }).catch(() => undefined);
      await fsp.writeFile(historyFile, JSON.stringify(convo.slice(-OLLAMA_HISTORY_MAX)), 'utf8').catch(() => undefined);
    }
    yield { kind: 'usage', tokensIn, tokensOut, costUsd: 0, contextTokens };
    yield { kind: 'done', tokensIn, tokensOut, costUsd: 0, isError };
  }

  return {
    id: 'ollama',
    displayName: 'Ollama (local models, offline)',
    capabilities: { tools: true, resume: true, costReport: true, contextWindow: numCtx, nativeCompaction: false },
    detect,
    models: () => toolModels().catch(() => []),
    run,
  };
}
