/**
 * OpenAI Codex CLI adapter (v0.8 "more adapters"). Runs `codex exec --json` headless per run, using
 * the owner's ChatGPT **subscription** login (`codex login`) — no API key, cost $0 to Sebeto.
 *
 * Verified against Codex CLI 0.169.0 (`codex exec --help` + real captured runs):
 *  - Headless: `codex exec --json` streams JSONL events to stdout; the prompt is read from stdin (`-`).
 *  - System prompt: Codex has no system-prompt flag, so Sebeto's system prompt is written to
 *    `<ticket>/AGENTS.md`, which Codex reads as project instructions (confirmed: it obeys it).
 *  - Sebeto tools: a per-run MCP server is injected with `-c mcp_servers.sebeto.url=…` and the token
 *    via `-c mcp_servers.sebeto.bearer_token_env_var="SEBETO_MCP_TOKEN"` (Codex sends it as a Bearer
 *    header — confirmed). `--approve-for-me` lets Codex call the (trusted) Sebeto tools without an
 *    interactive prompt; Sebeto's own permission gate still governs each tool. `--approve-for-me`
 *    forces the workspace-write sandbox, so Codex's native shell/edits are confined to the ticket
 *    folder (no network, nothing outside) and are captured by Sebeto's per-run snapshot.
 *  - Resume: `codex exec resume <thread_id>` continues a session; the id comes from `thread.started`.
 *
 * Safety: user text never goes on the command line (prompt via stdin, system prompt via file); every
 * other argument is built and validated here. On Windows the npm shim is unwrapped to
 * `node .../@openai/codex/bin/codex.js` so no shell is needed (its args contain quotes/colons).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent, RuntimeAdapter, RuntimeDetection, TicketRun } from '@sebeto/shared';
import { buildSpawnSpec, childEnv, compareVersions, type ResolveInput, type ResolvedCommand } from './claude-cli.js';

export const MIN_CODEX_VERSION = '0.40.0';
/** Known current Codex model; the model is optional (unset = the account's Codex default). */
export const CODEX_MODELS = ['gpt-5.1-codex-max'] as const;
/** Env var Codex reads the Sebeto MCP bearer token from (never placed on the command line). */
export const CODEX_MCP_TOKEN_ENV = 'SEBETO_MCP_TOKEN';

const NOT_INSTALLED = 'The Codex CLI is not installed on this computer. Install it (npm i -g @openai/codex), run "codex login" once, then come back.';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ version + binary resolution

/** Extract "x.y.z" from `codex --version` (e.g. "codex-cli 0.169.0"). */
export function parseCodexVersion(output: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0];
}

/**
 * Find how to launch Codex without a shell. POSIX: the name directly. Windows: codex.exe if present,
 * else the npm shim unwrapped to `node .../@openai/codex/bin/codex.js`, else cmd.exe as a last resort.
 */
export function resolveCodexCommand(input: ResolveInput): ResolvedCommand | null {
  const name = input.binary ?? 'codex';
  if (input.platform !== 'win32') return { command: name, prefixArgs: [], viaCmd: false };
  const w = path.win32;
  const exts = ['.exe', '.com', '.cmd', '.bat'];
  const hasExt = exts.includes(w.extname(name).toLowerCase());
  const isPath = /[\\/]/.test(name);
  const dirs = isPath ? [''] : input.pathEnv.split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? w.join(dir, name) : name;
    const candidates = hasExt ? [base] : exts.map((e) => base + e);
    for (const file of candidates) {
      if (!input.fileExists(file)) continue;
      const ext = w.extname(file).toLowerCase();
      if (ext === '.exe' || ext === '.com') return { command: file, prefixArgs: [], viaCmd: false };
      // npm shim: unwrap to node + bin/codex.js so we never need a shell.
      const cli = w.join(w.dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (input.fileExists(cli)) return { command: input.nodePath, prefixArgs: [cli], viaCmd: false };
      return { command: input.comSpec ?? 'cmd.exe', prefixArgs: [file], viaCmd: true };
    }
  }
  return null;
}

// ------------------------------------------------------------------ arguments (pure)

/**
 * Build `codex exec` arguments for one run. No user free text: the prompt goes on stdin (`-`) and the
 * system prompt via AGENTS.md. Throws on an invalid model name or session id.
 */
export function buildCodexArgs(run: Pick<TicketRun, 'externalSessionId' | 'model' | 'cwd' | 'mcp'>): string[] {
  const args = ['exec'];
  if (run.externalSessionId) {
    if (!UUID_RE.test(run.externalSessionId)) throw new Error('Invalid Codex session id.');
    args.push('resume', run.externalSessionId);
  }
  args.push('--json', '--skip-git-repo-check', '--approve-for-me', '-C', run.cwd);
  if (run.model) {
    if (!MODEL_RE.test(run.model)) throw new Error('Invalid model name.');
    args.push('-m', run.model);
  }
  if (run.mcp) {
    args.push('-c', `mcp_servers.sebeto.url="${run.mcp.url}"`);
    args.push('-c', `mcp_servers.sebeto.bearer_token_env_var="${CODEX_MCP_TOKEN_ENV}"`);
  }
  args.push('-'); // prompt read from stdin
  return args;
}

// ------------------------------------------------------------------ JSONL stream parser (pure)

export interface CodexParser {
  push(line: string): AgentEvent[];
  end(): AgentEvent[];
  /** True once a turn.completed was seen (the run produced a result). */
  readonly sawResult: boolean;
}

function toolSummary(item: Record<string, any>): string {
  const status = typeof item.status === 'string' ? item.status : '';
  const err = item.error && typeof item.error.message === 'string' ? ` — ${item.error.message}` : '';
  if (item.type === 'mcp_tool_call') return `${item.server}.${item.tool}${status ? ` (${status})` : ''}${err}`;
  if (item.type === 'command_execution') return `${String(item.command ?? 'command').slice(0, 120)}${status ? ` (${status})` : ''}`;
  return item.type ?? 'tool';
}

/** Parse Codex `--json` events (one JSON object per line) into Sebeto AgentEvents. */
export function createCodexStreamParser(): CodexParser {
  let sawResult = false;
  let tokensIn = 0;
  let tokensOut = 0;
  const seenToolItems = new Set<string>(); // emit each tool item once (on completed)

  function handle(ev: Record<string, any>): AgentEvent[] {
    const out: AgentEvent[] = [];
    switch (ev.type) {
      case 'thread.started':
        if (typeof ev.thread_id === 'string') out.push({ kind: 'session', externalSessionId: ev.thread_id });
        break;
      case 'item.completed': {
        const item = ev.item ?? {};
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          out.push({ kind: 'text', text: item.text });
        } else if (item.type === 'mcp_tool_call' || item.type === 'command_execution') {
          const key = String(item.id ?? `${item.type}:${seenToolItems.size}`);
          if (!seenToolItems.has(key)) {
            seenToolItems.add(key);
            const name = item.type === 'mcp_tool_call' ? `${item.server}.${item.tool}` : 'shell';
            out.push({ kind: 'tool', name, summary: toolSummary(item) });
          }
        } else if (item.type === 'error' && typeof item.message === 'string') {
          // Config warnings ("ignoring … configuration setting") are non-fatal noise: skip them.
          if (!/ignoring .* configuration setting|unrecognized configuration/i.test(item.message)) {
            out.push({ kind: 'error', message: item.message });
          }
        }
        break;
      }
      case 'turn.completed': {
        const u = ev.usage ?? {};
        if (typeof u.input_tokens === 'number') tokensIn += u.input_tokens;
        if (typeof u.output_tokens === 'number') tokensOut += u.output_tokens;
        out.push({ kind: 'usage', tokensIn, tokensOut, costUsd: 0, ...(typeof u.input_tokens === 'number' ? { contextTokens: u.input_tokens } : {}) });
        sawResult = true;
        break;
      }
      case 'turn.failed': {
        const msg = ev.error?.message ?? 'Codex turn failed.';
        out.push({ kind: 'error', message: String(msg) });
        sawResult = true; // a failure is still a result: don't double-report a generic error at close
        break;
      }
      case 'stream_error':
        if (typeof ev.message === 'string') out.push({ kind: 'error', message: ev.message });
        break;
      default:
        break; // turn.started, item.started, item.updated, reasoning, etc. — ignored
    }
    return out;
  }

  return {
    push(line: string): AgentEvent[] {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== '{') return [];
      let ev: Record<string, any>;
      try { ev = JSON.parse(trimmed); } catch { return []; }
      return handle(ev);
    },
    end: () => [],
    get sawResult() { return sawResult; },
  };
}

// ------------------------------------------------------------------ process helpers

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000).unref();
  }
}

function runCapture(spec: ReturnType<typeof buildSpawnSpec>, timeoutMs: number): Promise<{ code: number | null; stdout: string; error?: NodeJS.ErrnoException; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, { windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'ignore'], env: childEnv(spec.command) });
    } catch (error) {
      resolve({ code: null, stdout: '', error: error as NodeJS.ErrnoException, timedOut: false });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ code: null, stdout, error, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, timedOut }); });
  });
}

// ------------------------------------------------------------------ adapter

export interface CodexCliAdapterOptions {
  binary?: string;
  command?: ResolvedCommand;
  detectTimeoutMs?: number;
}

export function createCodexCliAdapter(opts: CodexCliAdapterOptions = {}): RuntimeAdapter {
  const resolve = (): ResolvedCommand | null =>
    opts.command ??
    resolveCodexCommand({
      binary: opts.binary,
      platform: process.platform,
      pathEnv: process.env['PATH'] ?? process.env['Path'] ?? '',
      fileExists: (p) => existsSync(p),
      nodePath: process.execPath,
      comSpec: process.env['ComSpec'],
    });

  async function detect(): Promise<RuntimeDetection> {
    const resolved = resolve();
    if (!resolved) return { installed: false, problem: NOT_INSTALLED };
    const res = await runCapture(buildSpawnSpec(resolved, ['--version']), opts.detectTimeoutMs ?? 15_000);
    if (res.error?.code === 'ENOENT') return { installed: false, problem: NOT_INSTALLED };
    if (res.timedOut) return { installed: true, problem: 'Codex did not answer in time. Try running "codex --version" in a terminal.' };
    const version = parseCodexVersion(res.stdout);
    if (res.code !== 0 || !version) return { installed: true, problem: 'Codex is installed but did not start correctly. Try running "codex --version" in a terminal.' };
    if (compareVersions(version, MIN_CODEX_VERSION) < 0) {
      return { installed: true, version, problem: `Codex ${version} is too old. Update it to ${MIN_CODEX_VERSION} or newer.` };
    }
    // Login state is not cheaply checkable here; the first run reports it. Sign in with "codex login".
    return { installed: true, version };
  }

  async function* run(r: TicketRun): AsyncGenerator<AgentEvent> {
    const resolved = resolve();
    if (!resolved) {
      yield { kind: 'error', message: NOT_INSTALLED };
      yield { kind: 'done', isError: true };
      return;
    }

    const agentsFile = path.join(r.cwd, 'AGENTS.md');
    let priorAgents: string | null = null;
    let hadAgents = false;
    let child: ChildProcess | undefined;
    const onAbort = (): void => { if (child) killTree(child); };

    try {
      await mkdir(r.cwd, { recursive: true });
      // Preserve any existing AGENTS.md: write ours for the run, restore it afterwards.
      try { priorAgents = await readFile(agentsFile, 'utf8'); hadAgents = true; } catch { hadAgents = false; }
      await writeFile(agentsFile, r.systemPrompt, 'utf8');

      const spec = buildSpawnSpec(resolved, buildCodexArgs(r));
      if (r.signal.aborted) return;

      child = spawn(spec.command, spec.args, {
        cwd: r.cwd,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
        // The Sebeto MCP bearer token is passed through the environment, never on the command line.
        env: { ...childEnv(spec.command), ...(r.mcp ? { [CODEX_MCP_TOKEN_ENV]: r.mcp.token } : {}) },
      });
      r.signal.addEventListener('abort', onAbort, { once: true });

      let spawnError: NodeJS.ErrnoException | undefined;
      child.on('error', (e: NodeJS.ErrnoException) => (spawnError = e));
      const closed = new Promise<number | null>((res) => child!.on('close', (code) => res(code)));

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 8000) stderr += d.toString('utf8'); });

      child.stdin?.on('error', () => undefined); // EPIPE if the process died early
      child.stdin?.end(r.prompt, 'utf8');

      const parser = createCodexStreamParser();
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          for (const ev of parser.push(line)) yield ev;
        }
      }
      const code = await closed;

      if (parser.sawResult) {
        yield { kind: 'done', costUsd: 0 };
      } else {
        if (r.signal.aborted) return; // stopped by the user: the executor records the cancel
        const detail = spawnError?.code === 'ENOENT' ? NOT_INSTALLED : stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
        yield { kind: 'error', message: detail || `Codex stopped unexpectedly (exit code ${code ?? 'unknown'}).` };
        yield { kind: 'done', isError: true };
      }
    } finally {
      r.signal.removeEventListener('abort', onAbort);
      if (child) killTree(child);
      // Restore the ticket folder's AGENTS.md to what it was before the run.
      if (hadAgents && priorAgents !== null) await writeFile(agentsFile, priorAgents, 'utf8').catch(() => undefined);
      else await rm(agentsFile, { force: true }).catch(() => undefined);
    }
  }

  return {
    id: 'codex-cli',
    displayName: 'Codex (OpenAI Codex CLI on this computer)',
    // Codex manages its own session history/compaction; cost is $0 to Sebeto (subscription login).
    capabilities: { tools: true, resume: true, costReport: false, contextWindow: 256_000, nativeCompaction: true },
    detect,
    models: async () => [...CODEX_MODELS],
    run,
  };
}
