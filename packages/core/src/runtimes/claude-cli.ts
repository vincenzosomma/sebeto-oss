/**
 * Claude Code CLI adapter (docs/09 §2, docs/15 #2/#12). Runs `claude -p` headless per run.
 *
 * Safety rules:
 *  - User text (prompt, system prompt) NEVER goes on the command line: the prompt goes through
 *    stdin and the system prompt through a file (--append-system-prompt-file).
 *  - Every remaining argument is built by us and validated (ids, model name, paths).
 *  - "Sebeto owns side effects": native risky tools are disallowed; only read-only natives and
 *    Sebeto MCP tools are allowed. Only the Sebeto MCP server is loaded (--strict-mcp-config).
 *
 * Flags verified against Claude Code 2.1.319 (`claude --help` plus a real captured run):
 *   -p, --output-format stream-json, --verbose, --session-id <uuid>, --resume <id>, --model,
 *   --max-budget-usd, --append-system-prompt-file (hidden in --help, accepted), --allowedTools,
 *   --disallowedTools, --mcp-config, --strict-mcp-config.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent, PermissionKey, PermissionLevel, RuntimeAdapter, RuntimeDetection, TicketRun } from '@sebeto/shared';
import { claudeMcpSlug } from '@sebeto/shared';
import { createClaudeStreamParser } from './claude-stream.js';

export const MIN_CLAUDE_VERSION = '2.1.0';
export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'] as const;

/** Native tools that change things or reach outside: always off (Sebeto tools replace them). */
export const CLAUDE_DISALLOWED_TOOLS = ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch'] as const;
/** Read-only native tools kept for speed (unless fs.read is 'never'). */
export const CLAUDE_READONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** Sebeto MCP tools. Both forms: server-wide name (older CLIs) and wildcard. */
export const SEBETO_MCP_ALLOW = ['mcp__sebeto', 'mcp__sebeto__*'] as const;
/** Sebeto's tool that answers Claude Code's permission prompts (--permission-prompt-tool). */
export const SEBETO_APPROVE_TOOL = 'mcp__sebeto__approve_tool';

// ------------------------------------------------------------------ versions

/** Extract "x.y.z" from `claude --version` output (e.g. "2.1.319 (Claude Code)"). */
export function parseClaudeVersion(output: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0];
}

/** Compare dotted versions numerically: <0, 0, >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ------------------------------------------------------------------ binary resolution (pure)

export interface ResolveInput {
  /** Explicit binary name or path from settings (default "claude"). */
  binary?: string;
  platform: NodeJS.Platform;
  pathEnv: string;
  fileExists: (p: string) => boolean;
  /** Node executable to run an npm-installed cli.js directly (process.execPath). */
  nodePath: string;
  comSpec?: string;
}

export interface ResolvedCommand {
  command: string;
  prefixArgs: string[];
  /** True when we must go through cmd.exe (a .cmd/.bat shim we could not unwrap). */
  viaCmd: boolean;
}

/**
 * Find how to launch Claude Code without a shell.
 *  - POSIX: spawn the name directly (the OS resolves PATH).
 *  - Windows: search PATH for claude.exe (native installer) first; for an npm .cmd shim, run
 *    `node <dir>/node_modules/@anthropic-ai/claude-code/cli.js` directly; as a last resort use
 *    cmd.exe with strictly validated arguments (see buildSpawnSpec).
 * Returns null when nothing is found (Windows only).
 */
export function resolveClaudeCommand(input: ResolveInput): ResolvedCommand | null {
  const name = input.binary ?? 'claude';
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
      // npm shim: unwrap to node + cli.js so we never need a shell.
      const shimDir = w.dirname(file);
      for (const script of ['cli.js', 'cli.mjs']) {
        const cli = w.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code', script);
        if (input.fileExists(cli)) return { command: input.nodePath, prefixArgs: [cli], viaCmd: false };
      }
      return { command: input.comSpec ?? 'cmd.exe', prefixArgs: [file], viaCmd: true };
    }
  }
  return null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** Characters cmd.exe would interpret. Our arguments never contain them; refuse if they do. */
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

/** Turn a resolved command + arguments into a spawn() call that needs no shell. */
export function buildSpawnSpec(resolved: ResolvedCommand, args: string[]): SpawnSpec {
  if (!resolved.viaCmd) return { command: resolved.command, args: [...resolved.prefixArgs, ...args], windowsVerbatimArguments: false };
  const all = [...resolved.prefixArgs, ...args];
  for (const a of all) {
    if (CMD_UNSAFE.test(a)) throw new Error('Cannot safely start Claude Code through its .cmd launcher with this argument. Install the native Claude Code build instead.');
  }
  const line = all.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
  return { command: resolved.command, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

// ------------------------------------------------------------------ arguments (pure)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_RE = /^[A-Za-z0-9-]{1,128}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/;

export interface ClaudeArgFiles {
  systemPromptFile: string;
  mcpConfigFile?: string;
}

/** Native tools allowed/disallowed for a run, honouring fs.read = never. */
export function claudeToolLists(permissions: Partial<Record<PermissionKey, PermissionLevel>>, withMcp: boolean): { allowed: string[]; disallowed: string[] } {
  const readOk = permissions['fs.read'] !== 'never';
  const allowed: string[] = [...(readOk ? CLAUDE_READONLY_TOOLS : []), ...(withMcp ? SEBETO_MCP_ALLOW : [])];
  const disallowed: string[] = [...CLAUDE_DISALLOWED_TOOLS, ...(readOk ? [] : CLAUDE_READONLY_TOOLS)];
  return { allowed, disallowed };
}

/**
 * Build the CLI arguments for one run. Contains no user-provided free text: the prompt is sent
 * on stdin and the system prompt via a file. Throws on invalid ids/model names.
 */
export function buildClaudeArgs(run: Pick<TicketRun, 'externalSessionId' | 'newExternalSessionId' | 'model' | 'budgetUsd' | 'permissions' | 'mcp' | 'claudeConnectors'>, files: ClaudeArgFiles): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (run.externalSessionId) {
    if (!SESSION_RE.test(run.externalSessionId)) throw new Error('Invalid Claude session id.');
    args.push('--resume', run.externalSessionId);
  } else if (run.newExternalSessionId) {
    if (!UUID_RE.test(run.newExternalSessionId)) throw new Error('New Claude session id must be a UUID.');
    args.push('--session-id', run.newExternalSessionId);
  }

  if (run.model) {
    if (!MODEL_RE.test(run.model)) throw new Error(`Invalid model name.`);
    args.push('--model', run.model);
  }

  // Infinity = budgets set to warn only: no per-run cost limit.
  if (run.budgetUsd !== Number.POSITIVE_INFINITY) {
    const budget = Math.max(0.01, Number.isFinite(run.budgetUsd) ? run.budgetUsd : 0.01);
    args.push('--max-budget-usd', budget.toFixed(2));
  }

  args.push('--append-system-prompt-file', files.systemPromptFile);

  const { allowed, disallowed } = claudeToolLists(run.permissions, Boolean(run.mcp && files.mcpConfigFile));
  // Single comma-separated value: the options are variadic, so keep each to one token.
  args.push('--disallowedTools', disallowed.join(','));
  if (allowed.length) args.push('--allowedTools', allowed.join(','));

  if (run.mcp && files.mcpConfigFile) args.push('--mcp-config', files.mcpConfigFile);
  if (run.claudeConnectors?.length && run.mcp && files.mcpConfigFile) {
    // The owner's Claude connectors are loaded, but none of their tools is pre-allowed: Claude Code
    // must ask Sebeto's approve_tool for every call, which denies connectors this agent may not use
    // and sends the rest through the permission gate (docs/37).
    args.push('--permission-prompt-tool', SEBETO_APPROVE_TOOL);
  } else {
    // Strict: never load the user's other MCP servers (they could have side effects).
    args.push('--strict-mcp-config');
  }
  return args;
}

/** MCP config file content for the Sebeto server (per-run token in the header). */
export function buildMcpConfig(mcp: { url: string; token: string }): string {
  return JSON.stringify({ mcpServers: { sebeto: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }, null, 2);
}

// ------------------------------------------------------------------ process helpers

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // Kill the whole tree (cmd.exe / node wrappers included). Pid is a number from Node.
    const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  }
}

function runCapture(spec: SpawnSpec, timeoutMs: number, opts: { stdin?: string; cwd?: string } = {}): Promise<{ code: number | null; stdout: string; error?: NodeJS.ErrnoException; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'ignore'], env: childEnv(spec.command), ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
    } catch (error) {
      resolve({ code: null, stdout: '', error: error as NodeJS.ErrnoException, timedOut: false });
      return;
    }
    if (opts.stdin !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(opts.stdin);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, error, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, timedOut });
    });
  });
}

// ------------------------------------------------------------------ adapter

export interface ClaudeCliAdapterOptions {
  /** Binary name or absolute path (default "claude"). */
  binary?: string;
  /** Override command resolution (advanced; tests use it to run a fake CLI). */
  command?: ResolvedCommand;
  /** Timeout for `claude --version` in detect() (default 15 s). */
  detectTimeoutMs?: number;
}

const NOT_INSTALLED = 'Claude Code is not installed on this computer. Install it from https://claude.com/claude-code, sign in once, then come back.';

/**
 * Environment for the Claude process. Inside the desktop app process.execPath is Sebeto.exe
 * (Electron); when it is used to run an npm-installed cli.js it must act as plain Node.
 * Exported for tests.
 */
export function childEnv(command: string, env: NodeJS.ProcessEnv = process.env, execPath = process.execPath, electron = process.versions.electron): NodeJS.ProcessEnv {
  return electron && command === execPath ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
}

export function createClaudeCliAdapter(opts: ClaudeCliAdapterOptions = {}): RuntimeAdapter {
  const resolve = (): ResolvedCommand | null =>
    opts.command ??
    resolveClaudeCommand({
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
    if (res.timedOut) return { installed: true, problem: 'Claude Code did not answer in time. Try opening a terminal and running "claude --version".' };
    const version = parseClaudeVersion(res.stdout);
    if (res.code !== 0 || !version) return { installed: true, problem: 'Claude Code is installed but did not start correctly. Try running "claude --version" in a terminal.' };
    if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
      return { installed: true, version, problem: `Claude Code ${version} is too old. Update it to ${MIN_CLAUDE_VERSION} or newer (run "claude update").` };
    }
    // Login state is not cheaply checkable without a model call; the first run reports it.
    return { installed: true, version };
  }

  async function* run(r: TicketRun): AsyncGenerator<AgentEvent> {
    const resolved = resolve();
    if (!resolved) {
      yield { kind: 'error', message: NOT_INSTALLED };
      yield { kind: 'done', isError: true };
      return;
    }

    // Per-run files live in <ticket>/.sebeto/ and are removed afterwards (the MCP file holds a token).
    const dir = path.join(r.cwd, '.sebeto');
    const tag = r.runId.replace(/[^A-Za-z0-9-]/g, '');
    const systemPromptFile = path.join(dir, `run-${tag}-system.md`);
    const mcpConfigFile = r.mcp ? path.join(dir, `run-${tag}-mcp.json`) : undefined;

    let child: ChildProcess | undefined;
    const onAbort = (): void => {
      if (child) killTree(child);
    };
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(systemPromptFile, r.systemPrompt, 'utf8');
      if (r.mcp && mcpConfigFile) await writeFile(mcpConfigFile, buildMcpConfig(r.mcp), { encoding: 'utf8', mode: 0o600 });

      const spec = buildSpawnSpec(resolved, buildClaudeArgs(r, { systemPromptFile, mcpConfigFile }));
      if (r.signal.aborted) return;

      child = spawn(spec.command, spec.args, {
        cwd: r.cwd,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv(spec.command),
      });
      r.signal.addEventListener('abort', onAbort, { once: true });

      let spawnError: NodeJS.ErrnoException | undefined;
      child.on('error', (e: NodeJS.ErrnoException) => (spawnError = e));
      const closed = new Promise<number | null>((res) => child!.on('close', (code) => res(code)));

      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < 8000) stderr += d.toString('utf8');
      });

      // Prompt via stdin only.
      child.stdin?.on('error', () => undefined); // EPIPE if the process died early
      child.stdin?.end(r.prompt, 'utf8');

      const parser = createClaudeStreamParser();
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of rl) {
          for (const ev of parser.push(`${line}\n`)) yield ev;
        }
      }
      for (const ev of parser.end()) yield ev;
      const code = await closed;

      if (!parser.sawResult) {
        if (r.signal.aborted) return; // stopped by the user: the executor records the cancel
        const detail = spawnError?.code === 'ENOENT' ? NOT_INSTALLED : stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
        yield { kind: 'error', message: detail || `Claude Code stopped unexpectedly (exit code ${code ?? 'unknown'}).` };
        yield { kind: 'done', isError: true };
      }
    } finally {
      r.signal.removeEventListener('abort', onAbort);
      if (child) killTree(child); // no-op when already exited; covers early consumer exit
      await rm(systemPromptFile, { force: true }).catch(() => undefined);
      if (mcpConfigFile) await rm(mcpConfigFile, { force: true }).catch(() => undefined);
    }
  }

  return {
    id: 'claude-cli',
    displayName: 'Claude (Claude Code on this computer)',
    // Claude Code compacts long conversations by itself.
    capabilities: { tools: true, resume: true, costReport: true, contextWindow: 200_000, nativeCompaction: true },
    detect,
    models: async () => [...CLAUDE_MODELS],
    run,
  };
}

// ------------------------------------------------------------------ the owner's Claude connectors

/**
 * One short headless `claude` run with the prompt on stdin (Sebeto's own helper calls, e.g. reading
 * Slack through the owner's Claude connector). Runs in `cwd` so no project settings are picked up.
 */
export async function runClaudeOnce(args: string[], stdin: string, timeoutMs: number, opts: { binary?: string; cwd?: string } = {}): Promise<{ code: number | null; stdout: string; error?: Error; timedOut: boolean }> {
  const resolved = resolveClaudeCommand({
    binary: opts.binary, platform: process.platform, pathEnv: process.env['PATH'] ?? process.env['Path'] ?? '',
    fileExists: (p) => existsSync(p), nodePath: process.execPath, comSpec: process.env['ComSpec'],
  });
  if (!resolved) return { code: null, stdout: '', error: new Error(NOT_INSTALLED), timedOut: false };
  if (opts.cwd) await mkdir(opts.cwd, { recursive: true });
  return runCapture(buildSpawnSpec(resolved, args), timeoutMs, { stdin, cwd: opts.cwd });
}

/** Parse `claude mcp list` output. Exported for tests. */
export function parseClaudeMcpList(output: string): Array<{ name: string; slug: string; connected: boolean; status: string }> {
  const out: Array<{ name: string; slug: string; connected: boolean; status: string }> = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon <= 0 || dash <= colon) continue;
    const name = line.slice(0, colon).trim();
    const status = line.slice(dash + 3).replace(/^[^A-Za-z]+/, '').trim();
    if (!name || name.startsWith('Checking')) continue;
    out.push({ name, slug: claudeMcpSlug(name), connected: /^connected$/i.test(status), status });
  }
  return out;
}

/** The owner's MCP servers as Claude Code sees them (`claude mcp list`, includes claude.ai connectors). */
export async function listClaudeConnectors(opts: { binary?: string; timeoutMs?: number } = {}): Promise<Array<{ name: string; slug: string; connected: boolean; status: string }>> {
  const resolved = resolveClaudeCommand({
    binary: opts.binary, platform: process.platform, pathEnv: process.env['PATH'] ?? process.env['Path'] ?? '',
    fileExists: (p) => existsSync(p), nodePath: process.execPath, comSpec: process.env['ComSpec'],
  });
  if (!resolved) throw new Error(NOT_INSTALLED);
  const res = await runCapture(buildSpawnSpec(resolved, ['mcp', 'list']), opts.timeoutMs ?? 120_000);
  if (res.error) throw new Error(res.error.code === 'ENOENT' ? NOT_INSTALLED : res.error.message);
  if (res.timedOut) throw new Error('Claude Code took too long to list its connectors.');
  return parseClaudeMcpList(res.stdout);
}
