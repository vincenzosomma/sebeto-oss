import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, TicketRun } from '@sebeto/shared';
import { DEFAULT_PERMISSIONS } from '@sebeto/shared';
import {
  buildCodexArgs, createCodexCliAdapter, createCodexStreamParser, parseCodexVersion, resolveCodexCommand, CODEX_MCP_TOKEN_ENV,
} from './codex-cli.js';

/** Feed a JSONL string to the parser line by line (mirrors the readline loop in run()). */
function parse(jsonl: string): { events: AgentEvent[]; sawResult: boolean } {
  const p = createCodexStreamParser();
  const events: AgentEvent[] = [];
  for (const line of jsonl.split('\n')) events.push(...p.push(line));
  events.push(...p.end());
  return { events, sawResult: p.sawResult };
}

describe('parseCodexVersion', () => {
  it('reads x.y.z from "codex-cli 0.169.0"', () => {
    expect(parseCodexVersion('codex-cli 0.169.0')).toBe('0.169.0');
    expect(parseCodexVersion('nonsense')).toBeUndefined();
  });
});

describe('codex JSONL parser (real captured shapes)', () => {
  it('session, text, mcp tool (once), usage', () => {
    const { events, sawResult } = parse([
      '{"type":"thread.started","thread_id":"01a1e0e5-dead-7433-aedc-ec97131a80b6"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Calling the tool."}}',
      '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"sebeto","tool":"echo","arguments":{"text":"hi"},"status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"sebeto","tool":"echo","arguments":{"text":"hi"},"result":{"content":[{"type":"text","text":"ECHO:hi"}]},"error":null,"status":"completed"}}',
      '{"type":"turn.completed","usage":{"input_tokens":41378,"cached_input_tokens":38144,"output_tokens":138}}',
    ].join('\n'));
    expect(events).toEqual([
      { kind: 'session', externalSessionId: '01a1e0e5-dead-7433-aedc-ec97131a80b6' },
      { kind: 'text', text: 'Calling the tool.' },
      { kind: 'tool', name: 'sebeto.echo', summary: 'sebeto.echo (completed)' },
      { kind: 'usage', tokensIn: 41378, tokensOut: 138, costUsd: 0, contextTokens: 41378 },
    ]);
    expect(sawResult).toBe(true);
  });

  it('skips config-warning error items but keeps real errors; turn.failed is a result', () => {
    const warn = parse('{"type":"item.completed","item":{"id":"i","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. `mcp_servers.sebeto.trust_level` is ignored."}}');
    expect(warn.events).toEqual([]);
    const fail = parse('{"type":"turn.failed","error":{"message":"model refused"}}');
    expect(fail.events).toEqual([{ kind: 'error', message: 'model refused' }]);
    expect(fail.sawResult).toBe(true);
  });

  it('ignores blank lines, non-JSON, and unknown event types', () => {
    const { events, sawResult } = parse(['', 'not json', '{"type":"turn.started"}', '{"type":"item.started","item":{"type":"reasoning"}}'].join('\n'));
    expect(events).toEqual([]);
    expect(sawResult).toBe(false);
  });
});

describe('buildCodexArgs', () => {
  const base = { cwd: '/tmp/t', model: null, mcp: { url: 'http://127.0.0.1:7600/mcp', token: 'secret' } };
  it('new session: exec with --json, --approve-for-me, MCP overrides, stdin prompt', () => {
    expect(buildCodexArgs({ ...base } as TicketRun)).toEqual([
      'exec', '--json', '--skip-git-repo-check', '--approve-for-me', '-C', '/tmp/t',
      '-c', 'mcp_servers.sebeto.url="http://127.0.0.1:7600/mcp"',
      '-c', `mcp_servers.sebeto.bearer_token_env_var="${CODEX_MCP_TOKEN_ENV}"`,
      '-',
    ]);
  });
  it('resume inserts the thread id; model is passed when set', () => {
    const args = buildCodexArgs({ ...base, externalSessionId: '01a1e0e5-dead-7433-aedc-ec97131a80b6', model: 'gpt-5.1-codex-max' } as TicketRun);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '01a1e0e5-dead-7433-aedc-ec97131a80b6']);
    expect(args).toContain('-m');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.1-codex-max');
  });
  it('rejects a bad session id or model', () => {
    expect(() => buildCodexArgs({ ...base, externalSessionId: 'nope' } as TicketRun)).toThrow(/session id/i);
    expect(() => buildCodexArgs({ ...base, model: 'bad model!' } as TicketRun)).toThrow(/model/i);
  });
  it('omits MCP overrides when there is no mcp', () => {
    const args = buildCodexArgs({ cwd: '/tmp/t', model: null } as TicketRun);
    expect(args).not.toContain('mcp_servers.sebeto.url="http://127.0.0.1:7600/mcp"');
  });
});

describe('resolveCodexCommand', () => {
  it('posix: spawns the name directly', () => {
    expect(resolveCodexCommand({ binary: undefined, platform: 'linux', pathEnv: '', fileExists: () => false, nodePath: '/node' }))
      .toEqual({ command: 'codex', prefixArgs: [], viaCmd: false });
  });
  it('windows: unwraps the npm shim to node bin/codex.js', () => {
    const files = new Set([
      'C\\:\\npm\\codex.cmd'.replace('C\\:', 'C:'),
      path.win32.join('C:\\npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ]);
    const r = resolveCodexCommand({ platform: 'win32', pathEnv: 'C:\\npm', fileExists: (p) => files.has(p), nodePath: 'C:\\node.exe' });
    expect(r).toEqual({ command: 'C:\\node.exe', prefixArgs: [path.win32.join('C:\\npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')], viaCmd: false });
  });
  it('windows: prefers codex.exe when present', () => {
    const exe = path.win32.join('C:\\bin', 'codex.exe');
    const r = resolveCodexCommand({ platform: 'win32', pathEnv: 'C:\\bin', fileExists: (p) => p === exe, nodePath: 'C:\\node.exe' });
    expect(r).toEqual({ command: exe, prefixArgs: [], viaCmd: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Real-CLI end-to-end. Skipped unless RUN_CODEX_E2E=1 (needs `codex` installed + `codex login`).
// Verifies the assembled adapter against the real binary and a throwaway MCP server.
// ---------------------------------------------------------------------------------------------
const E2E = process.env.RUN_CODEX_E2E === '1';
describe.skipIf(!E2E)('codex adapter end-to-end (real CLI)', () => {
  let dir: string;
  let server: http.Server;
  let mcpUrl = '';
  const seen: string[] = [];

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('runs a real turn, calls a Sebeto MCP tool with the bearer token, and reports done', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { z } = await import('zod');
    server = http.createServer(async (req, res) => {
      seen.push(String(req.headers['authorization'] ?? ''));
      const mcp = new McpServer({ name: 'probe', version: '1.0.0' });
      mcp.registerTool('echo', { description: 'Echo the text.', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `ECHO:${text}` }] }));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void t.close(); void mcp.close(); });
      await mcp.connect(t); await t.handleRequest(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    dir = mkdtempSync(path.join(tmpdir(), 'codex-e2e-'));

    const run: TicketRun = {
      ticketId: 't', runId: 'r', cwd: dir, model: null,
      systemPrompt: 'You are a test agent. Use the sebeto MCP tools when asked.',
      prompt: 'Call the echo tool (sebeto MCP server) with text "e2e" and report exactly what it returned.',
      permissions: { ...DEFAULT_PERMISSIONS }, budgetUsd: 1, mcp: { url: mcpUrl, token: 'tok-e2e-123' }, signal: new AbortController().signal,
    };
    const events: AgentEvent[] = [];
    for await (const ev of createCodexCliAdapter().run(run)) events.push(ev);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('session');
    expect(kinds).toContain('done');
    expect(events.some((e) => e.kind === 'tool' && e.name === 'sebeto.echo')).toBe(true);
    expect(seen.some((h) => h === 'Bearer tok-e2e-123')).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  }, 120_000);
});
