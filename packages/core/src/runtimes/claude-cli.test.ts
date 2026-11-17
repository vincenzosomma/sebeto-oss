import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent, TicketRun } from '@sebeto/shared';
import { DEFAULT_PERMISSIONS } from '@sebeto/shared';
import {
  buildClaudeArgs, buildMcpConfig, buildSpawnSpec, compareVersions, createClaudeCliAdapter,
  childEnv, parseClaudeVersion, resolveClaudeCommand,
} from './claude-cli.js';
import { createClaudeStreamParser, summarizeToolUse } from './claude-stream.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '__fixtures__', 'claude');
const fixture = (name: string): string => readFileSync(path.join(fixtures, name), 'utf8');

/** Feed a fixture in small chunks to exercise partial-line handling. */
function parseFixture(name: string, chunk = 37): AgentEvent[] {
  const p = createClaudeStreamParser();
  const text = fixture(name);
  const out: AgentEvent[] = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...p.push(text.slice(i, i + chunk)));
  out.push(...p.end());
  return out;
}

describe('claude stream-json parser (fixtures)', () => {
  it('real captured run (2.1.319): session, tool, text, usage, done', () => {
    const ev = parseFixture('real-read-file.jsonl');
    expect(ev.map((e) => e.kind)).toEqual(['session', 'tool', 'text', 'usage', 'done']);
    expect(ev[0]).toEqual({ kind: 'session', externalSessionId: '0196f000-0000-7000-8000-000000000001' });
    expect(ev[1]).toEqual({ kind: 'tool', name: 'Read', summary: 'Read the file notes.txt' });
    const done = ev.at(-1);
    expect(done).toMatchObject({ kind: 'done', isError: false, tokensOut: 127 });
    if (done?.kind === 'done') {
      expect(done.costUsd).toBeCloseTo(0.00227, 4);
      expect(done.tokensIn).toBe(4 + 9695 + 26817);
    }
  });

  it('tools, MCP tools, thinking, unknown types and invalid lines', () => {
    const p = createClaudeStreamParser();
    const ev = [...p.push(fixture('tool-and-mcp.jsonl')), ...p.end()];
    expect(p.invalidLines).toBe(1);
    expect(p.sawResult).toBe(true);
    expect(ev).toEqual([
      { kind: 'session', externalSessionId: '11111111-2222-4333-8444-555555555555' },
      { kind: 'text', text: "I'll look for the invoices first." },
      { kind: 'tool', name: 'Grep', summary: 'Searched the files for "invoice"' },
      { kind: 'tool', name: 'mcp__sebeto__fs_write', summary: 'Used Sebeto tool fs_write' },
      { kind: 'text', text: 'Summary written to summary.md.' },
      { kind: 'usage', tokensIn: 5120, tokensOut: 450, costUsd: 0.0451 },
      { kind: 'done', tokensIn: 5120, tokensOut: 450, costUsd: 0.0451, isError: false },
    ]);
  });

  it('budget exceeded result → plain-language error + done isError', () => {
    const ev = parseFixture('budget-exceeded.jsonl');
    expect(ev).toContainEqual({ kind: 'error', message: 'The cost limit for this run was reached.' });
    expect(ev.at(-1)).toMatchObject({ kind: 'done', isError: true, costUsd: 0.5123 });
  });

  it('CRLF line endings and non-UUID resumed session ids', () => {
    const ev = parseFixture('resume-crlf.jsonl', 5);
    expect(ev.map((e) => e.kind)).toEqual(['session', 'text', 'usage', 'done']);
    expect(ev[0]).toEqual({ kind: 'session', externalSessionId: 'resumed-session-0001' });
  });

  it('summarizes tools in plain language', () => {
    expect(summarizeToolUse('Glob', { pattern: '**/*.md' })).toBe('Looked for files matching "**/*.md"');
    expect(summarizeToolUse('mcp__github__create_issue', {})).toBe('Used github tool create_issue');
    expect(summarizeToolUse('Weird', null)).toBe('Used the tool Weird');
  });
});

describe('claude argument builder', () => {
  const base = { model: null, budgetUsd: 1.234, permissions: DEFAULT_PERMISSIONS };
  const files = { systemPromptFile: '/t/.sebeto/run-1-system.md' };

  it('new session: print mode, stream-json, session id, budget, tool lists, strict mcp', () => {
    const args = buildClaudeArgs({ ...base, newExternalSessionId: '0196f000-0000-7000-8000-000000000001' }, files);
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('1.23');
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(files.systemPromptFile);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash,PowerShell,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--model');
  });

  it('resume + model + MCP', () => {
    const args = buildClaudeArgs(
      { ...base, model: 'sonnet', externalSessionId: 'abc-123', newExternalSessionId: '0196f000-0000-7000-8000-000000000001', mcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' } },
      { ...files, mcpConfigFile: '/t/.sebeto/run-1-mcp.json' },
    );
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123');
    expect(args).not.toContain('--session-id');
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/t/.sebeto/run-1-mcp.json');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,mcp__sebeto,mcp__sebeto__*');
    expect(args.join(' ')).not.toContain('tok'); // token only in the file
  });

  it('fs.read = never disables read-only natives too', () => {
    const args = buildClaudeArgs({ ...base, permissions: { ...DEFAULT_PERMISSIONS, 'fs.read': 'never' } }, files);
    expect(args).not.toContain('--allowedTools');
    expect(args[args.indexOf('--disallowedTools') + 1]).toContain('Read,Glob,Grep');
  });

  it('rejects unsafe ids and model names; clamps tiny budgets', () => {
    expect(() => buildClaudeArgs({ ...base, newExternalSessionId: 'not a uuid' }, files)).toThrow();
    expect(() => buildClaudeArgs({ ...base, externalSessionId: 'x & calc' }, files)).toThrow();
    expect(() => buildClaudeArgs({ ...base, model: 'sonnet --dangerously-skip-permissions' }, files)).toThrow();
    const args = buildClaudeArgs({ ...base, budgetUsd: 0.001 }, files);
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.01');
    expect(buildClaudeArgs({ ...base, budgetUsd: Number.POSITIVE_INFINITY }, files)).not.toContain('--max-budget-usd');
  });

  it('MCP config file shape', () => {
    expect(JSON.parse(buildMcpConfig({ url: 'http://h/mcp', token: 't' }))).toEqual({
      mcpServers: { sebeto: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer t' } } },
    });
  });
});

describe('claude binary resolution (pure)', () => {
  const W = 'C:\\Users\\u\\.local\\bin';
  const NPM = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const win = (files: string[], binary?: string) =>
    resolveClaudeCommand({ binary, platform: 'win32', pathEnv: `C:\\Windows;"${W}";${NPM}`, fileExists: (p) => files.includes(p), nodePath: 'C:\\node\\node.exe', comSpec: 'C:\\Windows\\system32\\cmd.exe' });

  it('POSIX: plain name, no lookup', () => {
    expect(resolveClaudeCommand({ platform: 'linux', pathEnv: '', fileExists: () => false, nodePath: 'node' })).toEqual({ command: 'claude', prefixArgs: [], viaCmd: false });
  });

  it('Windows: prefers claude.exe found on PATH (quoted PATH entries ok)', () => {
    expect(win([`${W}\\claude.exe`, `${NPM}\\claude.cmd`])).toEqual({ command: `${W}\\claude.exe`, prefixArgs: [], viaCmd: false });
  });

  it('Windows: npm .cmd shim is unwrapped to node + cli.js (no shell)', () => {
    const cli = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
    expect(win([`${NPM}\\claude.cmd`, cli])).toEqual({ command: 'C:\\node\\node.exe', prefixArgs: [cli], viaCmd: false });
  });

  it('Windows: unknown .cmd falls back to cmd.exe with validated args', () => {
    const r = win([`${NPM}\\claude.cmd`]);
    expect(r).toEqual({ command: 'C:\\Windows\\system32\\cmd.exe', prefixArgs: [`${NPM}\\claude.cmd`], viaCmd: true });
    const spec = buildSpawnSpec(r!, ['-p', '--append-system-prompt-file', 'C:\\My Tickets\\T-1\\.sebeto\\s.md']);
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args).toEqual(['/d', '/s', '/c', `"${NPM}\\claude.cmd -p --append-system-prompt-file "C:\\My Tickets\\T-1\\.sebeto\\s.md""`]);
    expect(() => buildSpawnSpec(r!, ['a&b'])).toThrow();
    expect(() => buildSpawnSpec(r!, ['%PATH%'])).toThrow();
  });

  it('Windows: explicit path and not-found', () => {
    expect(win(['D:\\tools\\claude.exe'], 'D:\\tools\\claude')).toEqual({ command: 'D:\\tools\\claude.exe', prefixArgs: [], viaCmd: false });
    expect(win([])).toBeNull();
  });

  it('direct spawn spec passes args as-is', () => {
    expect(buildSpawnSpec({ command: 'x', prefixArgs: ['cli.js'], viaCmd: false }, ['-p'])).toEqual({ command: 'x', args: ['cli.js', '-p'], windowsVerbatimArguments: false });
  });

  it('version parsing and comparison', () => {
    expect(parseClaudeVersion('2.1.319 (Claude Code)')).toBe('2.1.319');
    expect(parseClaudeVersion('nope')).toBeUndefined();
    expect(compareVersions('2.1.319', '2.1.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.99', '2.1.0')).toBeLessThan(0);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
  });
});

describe('claude adapter with a fake CLI process', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sebeto-claude-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const adapter = createClaudeCliAdapter({ command: { command: process.execPath, prefixArgs: [path.join(fixtures, 'fake-claude.mjs')], viaCmd: false } });
  const input = (prompt: string, signal: AbortSignal, extra: Partial<TicketRun> = {}): TicketRun => ({
    ticketId: 't1', runId: '0196f000-aaaa-7000-8000-000000000001', cwd: tmp, systemPrompt: 'You are a tester & "quoted"',
    prompt, permissions: DEFAULT_PERMISSIONS, budgetUsd: 2, signal, newExternalSessionId: '0196f000-0000-7000-8000-0000000000ff', ...extra,
  });

  it('sends the prompt via stdin, system prompt + MCP via files, then cleans up', async () => {
    const prompt = 'Hello; rm -rf / & "quotes" $(x)';
    const ev: AgentEvent[] = [];
    for await (const e of adapter.run(input(prompt, new AbortController().signal, { mcp: { url: 'http://127.0.0.1:9/mcp', token: 'secret-token' } }))) ev.push(e);
    expect(ev.map((e) => e.kind)).toEqual(['session', 'text', 'usage', 'done']);
    expect(ev[0]).toEqual({ kind: 'session', externalSessionId: '0196f000-0000-7000-8000-0000000000ff' });
    const echo = JSON.parse((ev[1] as { text: string }).text) as { args: string[]; stdin: string; files: { systemPrompt: string; mcp: unknown }; cwd: string };
    expect(echo.stdin).toBe(prompt);
    expect(echo.args.join(' ')).not.toContain('Hello');
    expect(echo.files.systemPrompt).toBe('You are a tester & "quoted"');
    expect(echo.files.mcp).toEqual({ mcpServers: { sebeto: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer secret-token' } } } });
    // realpath: on macOS the temp folder is reached through /var → /private/var.
    expect(realpathSync(echo.cwd)).toBe(realpathSync(tmp));
    expect(ev.at(-1)).toMatchObject({ kind: 'done', costUsd: 0.02, isError: false });
    expect(readdirSync(path.join(tmp, '.sebeto'))).toEqual([]); // temp files removed
  });

  it('kills the process on abort', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const ev: AgentEvent[] = [];
    for await (const e of adapter.run(input('hang', ac.signal))) {
      ev.push(e);
      if (e.kind === 'session') ac.abort();
    }
    expect(ev.map((e) => e.kind)).toEqual(['session']);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(path.join(tmp, '.sebeto', 'run-0196f000-aaaa-7000-8000-000000000001-system.md'))).toBe(false);
  });
});

// Optional live smoke test against the real CLI (costs a fraction of a cent).
describe.runIf(process.env['SEBETO_E2E_CLAUDE'] === '1')('claude-cli live smoke', () => {
  it('detects and runs a trivial prompt', async () => {
    const adapter = createClaudeCliAdapter();
    const det = await adapter.detect();
    expect(det.problem).toBeUndefined();
    const cwd = mkdtempSync(path.join(tmpdir(), 'sebeto-claude-live-'));
    const ev: AgentEvent[] = [];
    for await (const e of adapter.run({
      ticketId: 'live', runId: 'live-1', cwd, systemPrompt: 'Answer in one word.', prompt: 'Say hi.',
      permissions: DEFAULT_PERMISSIONS, budgetUsd: 0.05, model: 'haiku', signal: new AbortController().signal,
      newExternalSessionId: globalThis.crypto.randomUUID(),
    })) ev.push(e);
    rmSync(cwd, { recursive: true, force: true });
    expect(ev[0]?.kind).toBe('session');
    expect(ev.at(-1)).toMatchObject({ kind: 'done', isError: false });
  }, 120_000);
});

describe('childEnv (desktop app)', () => {
  it('runs an npm-installed cli.js through Electron as plain Node only when needed', () => {
    const env = { PATH: 'x' };
    expect(childEnv('C:/Sebeto/Sebeto.exe', env, 'C:/Sebeto/Sebeto.exe', '38.8.6')).toEqual({ PATH: 'x', ELECTRON_RUN_AS_NODE: '1' });
    expect(childEnv('C:/claude/claude.exe', env, 'C:/Sebeto/Sebeto.exe', '38.8.6')).toBe(env);
    expect(childEnv('C:/node/node.exe', env, 'C:/node/node.exe', undefined)).toBe(env);
  });
});
