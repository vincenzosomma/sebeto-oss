/**
 * OpenAI-compatible adapter (v0.7 R, docs/31 v0.7 Plan.md): agents on LM Studio, vLLM, llama.cpp
 * server, OpenRouter or any `/v1/chat/completions` endpoint with tool calling.
 *
 * Same design as the Ollama adapter (ollama.ts): the endpoint only generates text and tool calls, so
 * this adapter
 *  1. connects to Sebeto's own MCP tool server with the run's token (same tools, permission gate,
 *     audit and untrusted-content rules as every other runtime: after untrusted input every outbound
 *     action asks, exactly as with Claude),
 *  2. offers those tools through `tools` (OpenAI function calling),
 *  3. runs the loop: model → tool_calls → tool results → model, until the model answers without tools,
 *     a permission is requested (the turn ends), the cost cap is reached, or the step limit is hit.
 * History: <ticket>/.sebeto/openai-<session>.json (reserved, never versioned), last 60 messages.
 *
 * Each connection is its own runtime, id `openai:<connectionId>` (packages/shared/src/ai-connections.ts).
 *
 * Security (the endpoint is outside Sebeto, maybe on the internet):
 *  - http:// only to this computer, or to a private LAN IP the owner explicitly allowed; else https;
 *  - every request goes to the connection's own origin; redirects to another origin are refused, so
 *    the API key is never sent anywhere else;
 *  - the key is read from the secrets store per request and never put in errors or events.
 * Cost: 0 for local connections. Remote: the provider's `usage.cost` when it reports one (OpenRouter),
 * else the owner's price per 1M tokens for the model, else 0 ("unknown").
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, AiConnection, RuntimeAdapter, RuntimeDetection, TicketRun } from '@sebeto/shared';
import { isLoopbackHost } from '../config.js';
import { isPrivateIp } from '../tools/fetch.js';
import { httpFetch } from './http-fetch.js';
import { mcpToolBridge, stripThinking, type ToolBridge } from './ollama.js';

export const OPENAI_MAX_TURNS = 25;
export const OPENAI_TOOL_RESULT_MAX = 12_000;
export const OPENAI_HISTORY_MAX = 60;
/** Same-origin redirects followed at most. */
const MAX_REDIRECTS = 3;
/** detect() / models() are cached this long (the runtime list is loaded often; remote calls are slow). */
const DETECT_CACHE_MS = 30_000;
const SESSION_RE = /^[A-Za-z0-9-]{1,80}$/;

/** A plain-language problem with the endpoint URL or a refused request (never contains the key). */
export class EndpointError extends Error {
  constructor(message: string, readonly code: 'invalid_url' | 'insecure' | 'redirect' | 'not_local' = 'invalid_url') {
    super(message);
    this.name = 'EndpointError';
  }
}

/** Host names that can only be on the owner's network (used to accept them for 'local' connections). */
function isLanName(host: string): boolean {
  return !host.includes('.') || /\.(local|lan|home|internal|intranet|home\.arpa)$/i.test(host);
}

/**
 * Check and normalise an endpoint base URL. Rules:
 *  - http(s) only, no user:password@, no query or fragment;
 *  - plain http only to loopback, or to a private LAN IP literal with `allowPrivateHttp`;
 *  - a 'local' connection must point to this computer or the LAN (so a cloud provider cannot be
 *    labelled local to hide that ticket content leaves the computer, or to make it look free);
 *  - an empty path becomes /v1.
 * Returns the normalised base URL (no trailing slash).
 */
export function checkEndpointUrl(raw: string, kind: AiConnection['kind'], allowPrivateHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EndpointError('That is not a valid URL. Example: http://127.0.0.1:1234/v1 or https://openrouter.ai/api/v1');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EndpointError('Only http:// and https:// addresses are supported.');
  if (url.username || url.password) throw new EndpointError('Put the API key in the API key field, not in the address.');
  if (url.search || url.hash) throw new EndpointError('The address must not contain ? or #.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = isLoopbackHost(host) || host === '::1';
  const privateIp = !loopback && isPrivateIp(host);
  if (url.protocol === 'http:' && !loopback) {
    if (!privateIp) {
      throw new EndpointError('Use https:// for this address. Plain http:// is allowed only to this computer (127.0.0.1, localhost) or to a private network address you allow.', 'insecure');
    }
    if (!allowPrivateHttp) {
      throw new EndpointError(`${host} is a private network address over plain http://. Tick "Allow plain http on my local network" if you trust this network, or use https://.`, 'insecure');
    }
  }
  if (kind === 'local' && !loopback && !privateIp && !isLanName(host)) {
    throw new EndpointError(`${host} is not on this computer or your local network. Choose "Remote" for an internet provider: ticket content is sent to it.`, 'not_local');
  }
  let p = url.pathname.replace(/\/+$/, '');
  if (p === '') p = '/v1';
  return `${url.protocol}//${url.host}${p}`;
}

/** OpenAI chat message (the subset Sebeto uses). */
export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: unknown } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string } | string;
}

export interface OpenAiCompatAdapterOptions {
  /** The connection (the store rebuilds the adapter when it changes). */
  connection: AiConnection;
  /** Reads the API key from the secrets store (null = none). */
  apiKey: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  connectTools?: (mcp: { url: string; token: string }) => Promise<ToolBridge>;
  maxTurns?: number;
  /** Tests: reply timeout in ms (default: the connection's replyTimeoutMin). */
  replyTimeoutMs?: number;
}

function parseArgs(a: unknown): Record<string, unknown> {
  if (!a) return {};
  if (typeof a === 'string') {
    try {
      const v = JSON.parse(a) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {};
}

const short = (o: unknown) => {
  const s = JSON.stringify(o);
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
};

/**
 * Keep the last `max` messages, starting at a user message: a slice must not begin with a tool
 * result (or an assistant tool call) whose partner was cut off, or the endpoint rejects the history.
 */
export function trimHistory(messages: OpenAiMessage[], max = OPENAI_HISTORY_MAX): OpenAiMessage[] {
  let out = messages.slice(-max);
  const firstUser = out.findIndex((m) => m.role === 'user');
  out = firstUser < 0 ? [] : out.slice(firstUser);
  return out;
}

/** Cost of one reply: 0 local; provider-reported cost; else the owner's price; else 0 (unknown). */
export function replyCost(conn: Pick<AiConnection, 'kind' | 'prices'>, model: string, usage: ChatCompletion['usage']): { costUsd: number; known: boolean } {
  if (conn.kind === 'local') return { costUsd: 0, known: true };
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) return { costUsd: usage.cost, known: true };
  const price = conn.prices[model];
  if (!price) return { costUsd: 0, known: false };
  const cost = ((usage?.prompt_tokens ?? 0) * price.inputPerM + (usage?.completion_tokens ?? 0) * price.outputPerM) / 1_000_000;
  return { costUsd: cost, known: true };
}

export function createOpenAiCompatAdapter(opts: OpenAiCompatAdapterOptions): RuntimeAdapter {
  const conn = opts.connection;
  // Validated again here: a hand-edited settings file must not bypass the rules.
  let base: string | null = null;
  let urlProblem: string | null = null;
  try {
    base = checkEndpointUrl(conn.baseUrl, conn.kind, conn.allowPrivateHttp);
  } catch (err) {
    urlProblem = (err as Error).message;
  }
  const origin = base ? new URL(base).origin : '';
  const host = base ? new URL(base).host : conn.baseUrl;
  // node:http(s), not undici: no 300 s header limit and no automatic redirects.
  const doFetch = opts.fetchImpl ?? (httpFetch as typeof fetch);
  const connectTools = opts.connectTools ?? mcpToolBridge;
  const maxTurns = opts.maxTurns ?? OPENAI_MAX_TURNS;
  const replyTimeoutMs = opts.replyTimeoutMs ?? Math.min(Math.max(conn.replyTimeoutMin || 30, 1), 240) * 60_000;
  const quickTimeoutMs = conn.kind === 'local' ? 5_000 : 15_000;
  let cache: { at: number; detection: RuntimeDetection; models: string[] } | null = null;

  /** Remove the key from any text that might echo it (an error body, a message). */
  const scrub = (text: string, key: string | null) => (key && key.length >= 4 ? text.split(key).join('<redacted>') : text);

  /**
   * One request to the connection's own origin. Same-origin redirects are followed (at most 3);
   * a redirect to another origin is refused, so the key never leaves for another host.
   */
  async function request(p: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ status: number; data: Record<string, unknown> }> {
    if (!base) throw new EndpointError(urlProblem ?? 'Invalid address.');
    const key = await opts.apiKey();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ctl.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let url = new URL(`${base}${p}`);
      for (let hop = 0; ; hop++) {
        if (url.origin !== origin) throw new EndpointError(`The endpoint redirected to another host (${url.host}). Sebeto refused to follow it, so your API key was not sent there.`, 'redirect');
        const headers: Record<string, string> = { accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        if (key) headers.authorization = `Bearer ${key}`;
        const res = await doFetch(url.toString(), {
          method: body === undefined ? 'GET' : 'POST', headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctl.signal, redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          await res.body?.cancel().catch(() => undefined);
          if (!loc) throw new Error(`The endpoint answered ${res.status} without a location.`);
          const next = new URL(loc, url);
          if (next.origin !== origin) throw new EndpointError(`The endpoint redirected to another host (${next.host}). Sebeto refused to follow it, so your API key was not sent there.`, 'redirect');
          if (hop >= MAX_REDIRECTS) throw new Error('The endpoint redirected too many times.');
          url = next;
          continue;
        }
        const text = await res.text().catch(() => '');
        let data: Record<string, unknown> = {};
        try {
          const v = JSON.parse(text) as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v)) data = v as Record<string, unknown>;
        } catch { /* not JSON */ }
        if (!res.ok) {
          const e = data.error as { message?: unknown } | string | undefined;
          const raw = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : typeof data.message === 'string' ? data.message : text.slice(0, 200);
          const err = new Error(scrub(`${raw || 'no details'}`.slice(0, 500), key)) as Error & { status?: number };
          err.status = res.status;
          throw err;
        }
        return { status: res.status, data };
      }
    } catch (err) {
      if (err instanceof EndpointError) throw err;
      const e = err as Error & { status?: number };
      if (ctl.signal.aborted && !signal?.aborted) {
        const t = new Error('timeout') as Error & { timeout?: boolean };
        t.timeout = true;
        throw t;
      }
      // Never let the key out through an error message.
      const out = new Error(scrub(e.message ?? String(err), key)) as Error & { status?: number };
      out.status = e.status;
      throw out;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function listModels(): Promise<{ detection: RuntimeDetection; models: string[] }> {
    if (cache && Date.now() - cache.at < DETECT_CACHE_MS) return cache;
    const withDefault = (ms: string[]) => (conn.defaultModel && !ms.includes(conn.defaultModel) ? [conn.defaultModel, ...ms] : ms);
    let detection: RuntimeDetection;
    let models: string[] = [];
    if (!base) {
      detection = { installed: false, problem: urlProblem ?? 'Invalid address.' };
    } else {
      try {
        const { data } = await request('/models', undefined, undefined, quickTimeoutMs);
        const list = Array.isArray(data.data) ? (data.data as Array<{ id?: unknown }>) : [];
        models = withDefault(list.map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean).sort());
        detection = models.length
          ? { installed: true, loggedIn: true }
          : { installed: true, loggedIn: true, problem: 'The endpoint lists no model. Load a model there, or set the default model of this connection.' };
      } catch (err) {
        const e = err as Error & { status?: number; timeout?: boolean };
        if (e.status === 401 || e.status === 403) {
          detection = { installed: true, loggedIn: false, problem: `${conn.name} refused the API key (${e.status}). Check the key in Connectors → AI connections.` };
        } else if (e.status === 404 || e.status === 405) {
          // Endpoint without a model list: usable with the default model.
          models = withDefault([]);
          detection = models.length ? { installed: true, loggedIn: true } : { installed: true, loggedIn: true, problem: 'This endpoint has no model list. Set the default model of this connection.' };
        } else if (e.status) {
          detection = { installed: false, problem: `${conn.name} answered ${e.status}: ${e.message}` };
        } else {
          detection = { installed: false, problem: e.timeout ? `${host} did not answer in time.` : `Could not reach ${host}: ${e.message}` };
        }
        // Keep the owner's default model in the pickers while the endpoint is down.
        if (!models.length) models = withDefault([]);
      }
    }
    cache = { at: Date.now(), detection, models };
    return cache;
  }

  async function* run(r: TicketRun): AsyncGenerator<AgentEvent> {
    const sessionId = r.externalSessionId ?? r.newExternalSessionId ?? `openai-${r.runId}`;
    if (!SESSION_RE.test(sessionId)) {
      yield { kind: 'error', message: 'Invalid session id.' };
      yield { kind: 'done', isError: true, costUsd: 0 };
      return;
    }
    yield { kind: 'session', externalSessionId: sessionId };
    if (!base) {
      yield { kind: 'error', message: `The AI connection "${conn.name}" cannot be used: ${urlProblem}` };
      yield { kind: 'done', isError: true, costUsd: 0 };
      return;
    }

    const model = r.model || conn.defaultModel || (await listModels().catch(() => ({ models: [] as string[] }))).models[0];
    if (!model) {
      yield { kind: 'error', message: `No model is set for "${conn.name}". Set its default model in Connectors → AI connections, or pick a model for the agent.` };
      yield { kind: 'done', isError: true, costUsd: 0 };
      return;
    }

    const historyFile = path.join(r.cwd, '.sebeto', `openai-${sessionId}.json`);
    let history: OpenAiMessage[] = [];
    try {
      const raw = JSON.parse(await fsp.readFile(historyFile, 'utf8')) as unknown;
      if (Array.isArray(raw)) history = raw as OpenAiMessage[];
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
    const system: OpenAiMessage = {
      role: 'system',
      content: `${r.systemPrompt}\n\nUse the provided tools to act; you cannot do anything outside them. When a tool says a permission was requested, stop and wait.`,
    };
    const convo: OpenAiMessage[] = [...trimHistory(history), { role: 'user', content: r.prompt }];
    let tokensIn = 0;
    let tokensOut = 0;
    let contextTokens = 0;
    let costUsd = 0;
    let isError = false;

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (r.signal.aborted) return;
        let res: ChatCompletion;
        try {
          res = (await request('/chat/completions', {
            model, messages: [system, ...convo], stream: false,
            ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
            // OpenRouter: ask for the real cost in `usage.cost`. Only sent to remote endpoints.
            ...(conn.kind === 'remote' ? { usage: { include: true } } : {}),
          }, r.signal, replyTimeoutMs)).data as ChatCompletion;
        } catch (err) {
          if (r.signal.aborted) return;
          const e = err as Error & { status?: number; timeout?: boolean };
          isError = true;
          if (e.timeout) {
            yield { kind: 'error', message: `${conn.name} did not answer within ${Math.max(1, Math.round(replyTimeoutMs / 60_000))} minute(s). Pick a smaller model, or raise the reply timeout of this connection.` };
          } else if (e.status === 401 || e.status === 403) {
            yield { kind: 'error', message: `${conn.name} refused the API key (${e.status}). Check the key in Connectors → AI connections.` };
          } else if (e.status === 404 && /model/i.test(e.message)) {
            yield { kind: 'error', message: `The model "${model}" is not available on ${conn.name}: ${e.message}` };
          } else {
            yield { kind: 'error', message: `${conn.name} failed${e.status ? ` (${e.status})` : ''}: ${e.message}` };
          }
          break;
        }
        const usage = res.usage;
        tokensIn += usage?.prompt_tokens ?? 0;
        tokensOut += usage?.completion_tokens ?? 0;
        const approx = Math.ceil(([system, ...convo].reduce((n, m) => n + (m.content?.length ?? 0), 0) + JSON.stringify(tools).length) / 4);
        contextTokens = Math.max(contextTokens, usage?.prompt_tokens ?? 0, approx);
        const cost = replyCost(conn, model, usage);
        costUsd += cost.costUsd;

        const msg = res.choices?.[0]?.message ?? {};
        const calls = (msg.tool_calls ?? [])
          .filter((c) => c && c.function && typeof c.function.name === 'string')
          .map((c, i) => ({
            id: typeof c.id === 'string' && c.id ? c.id : `call_${turn}_${i}`,
            type: 'function' as const,
            function: { name: c.function!.name!, arguments: typeof c.function!.arguments === 'string' ? c.function!.arguments : JSON.stringify(c.function!.arguments ?? {}) },
          }));
        const content = typeof msg.content === 'string' ? msg.content : '';
        convo.push({ role: 'assistant', content: content || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
        const text = stripThinking(content);
        if (text) yield { kind: 'text', text };
        if (!calls.length) break;

        let stop = false;
        for (const c of calls) {
          const name = c.function.name;
          const args = parseArgs(c.function.arguments);
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
          const capped = out.text.length > OPENAI_TOOL_RESULT_MAX ? `${out.text.slice(0, OPENAI_TOOL_RESULT_MAX)}\n[truncated]` : out.text;
          // Every tool call gets its answer (the API requires it), even when the turn stops.
          convo.push({ role: 'tool', tool_call_id: c.id, content: capped });
          if (/^Permission requested from the owner/.test(out.text)) stop = true;
        }
        if (stop) break;
        // A paid endpoint: stop at the run's budget (the ticket cap / the agent's monthly budget).
        if (costUsd >= r.budgetUsd && costUsd > 0) {
          yield { kind: 'error', message: `Stopped: the cost cap was reached ($${costUsd.toFixed(4)} of $${r.budgetUsd.toFixed(2)}).` };
          isError = true;
          break;
        }
        if (turn === maxTurns - 1) yield { kind: 'error', message: `Stopped after ${maxTurns} steps without finishing.` };
      }
    } finally {
      await bridge?.close().catch(() => undefined);
      await fsp.mkdir(path.dirname(historyFile), { recursive: true }).catch(() => undefined);
      await fsp.writeFile(historyFile, JSON.stringify(trimHistory(convo)), 'utf8').catch(() => undefined);
    }
    // A remote reply without a reported cost or an owner price is "unknown" and counted as $0
    // (the AI connections screen says so next to the model's price).
    yield { kind: 'usage', tokensIn, tokensOut, costUsd, contextTokens };
    yield { kind: 'done', tokensIn, tokensOut, costUsd, isError };
  }

  return {
    id: conn.runtimeId,
    displayName: conn.kind === 'local' ? `${conn.name} (local)` : `${conn.name} (remote · ${host})`,
    capabilities: { tools: true, resume: true, costReport: true, ...(conn.contextWindow ? { contextWindow: conn.contextWindow } : {}), nativeCompaction: false },
    detect: async () => (await listModels()).detection,
    models: async () => (await listModels().catch(() => ({ models: [] as string[] }))).models,
    run,
  };
}
