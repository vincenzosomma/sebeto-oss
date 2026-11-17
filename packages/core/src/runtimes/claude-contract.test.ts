/**
 * Contract tests for the Claude Code adapter (docs/15 Architecture Review #12).
 *
 * Every `__fixtures__/claude/<scenario>.<version>.jsonl` is REAL `claude -p --output-format
 * stream-json` output recorded by packages/core/scripts/record-claude-fixtures.mjs. Each recorded
 * Claude Code version is checked automatically: recording a new version adds coverage with no code
 * change. Every fixture goes through the stream parser AND through the real adapter (spawning a
 * stand-in CLI that replays the recording), and must produce the AgentEvents Sebeto relies on.
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type AgentEvent } from '@sebeto/shared';
import { MIN_CLAUDE_VERSION, compareVersions, createClaudeCliAdapter, parseClaudeVersion } from './claude-cli.js';
import { createClaudeStreamParser } from './claude-stream.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '__fixtures__', 'claude');
const replayScript = path.join(dir, 'replay-claude.mjs');

/** Scenarios every recorded version must have (see the recorder). */
const SCENARIOS = ['plain', 'resume-start', 'resume-continue', 'mcp-echo', 'error-invalid-model', 'error-budget'] as const;
type Scenario = (typeof SCENARIOS)[number];

const VERSIONED = /^([a-z0-9-]+)\.(\d+\.\d+\.\d+)\.jsonl$/;
const versions = new Map<string, Map<string, string>>(); // version → scenario → file
for (const f of readdirSync(dir)) {
  const m = VERSIONED.exec(f);
  if (!m) continue;
  const [, scenario, version] = m as unknown as [string, string, string];
  if (!versions.has(version)) versions.set(version, new Map());
  versions.get(version)!.set(scenario, path.join(dir, f));
}
const sortedVersions = [...versions.keys()].sort(compareVersions);

type Raw = Record<string, unknown>;
const rawLines = (file: string): Raw[] =>
  readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Raw);

function parse(file: string): { events: AgentEvent[]; invalidLines: number; sawResult: boolean } {
  const p = createClaudeStreamParser();
  const text = readFileSync(file, 'utf8');
  const events: AgentEvent[] = [];
  for (let i = 0; i < text.length; i += 211) events.push(...p.push(text.slice(i, i + 211)));
  events.push(...p.end());
  return { events, invalidLines: p.invalidLines, sawResult: p.sawResult };
}

const of = <K extends AgentEvent['kind']>(events: AgentEvent[], kind: K) =>
  events.filter((e): e is Extract<AgentEvent, { kind: K }> => e.kind === kind);

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** Run the real adapter against a stand-in CLI that replays `file`. */
async function viaAdapter(file: string): Promise<AgentEvent[]> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'sebeto-contract-'));
  tmpDirs.push(cwd);
  const adapter = createClaudeCliAdapter({ command: { command: process.execPath, prefixArgs: [replayScript, file], viaCmd: false } });
  const out: AgentEvent[] = [];
  for await (const e of adapter.run({
    ticketId: 't', runId: 'contract', newExternalSessionId: '0196f000-0000-7000-8000-00000000c0de', cwd, model: 'haiku',
    systemPrompt: 'Test.', prompt: 'Test.', permissions: { ...DEFAULT_PERMISSIONS }, budgetUsd: 0.05,
    mcp: { url: 'http://127.0.0.1:1/mcp', token: 'x' }, signal: new AbortController().signal,
  })) out.push(e);
  return out;
}

it('has recorded fixtures for at least one Claude Code version', () => {
  expect(sortedVersions.length).toBeGreaterThan(0);
});

for (const version of sortedVersions) {
  const files = versions.get(version)!;
  const file = (s: Scenario): string => {
    const f = files.get(s);
    if (!f) throw new Error(`Missing fixture ${s}.${version}.jsonl: re-record with scripts/record-claude-fixtures.mjs`);
    return f;
  };

  describe(`Claude Code ${version} (recorded stream-json)`, () => {
    it('has every scenario', () => {
      expect([...files.keys()].sort()).toEqual(expect.arrayContaining([...SCENARIOS]));
    });

    it('`claude --version` output parses, and the minimum version is satisfied', () => {
      const out = readFileSync(path.join(dir, `version.${version}.txt`), 'utf8');
      expect(parseClaudeVersion(out)).toBe(version);
      expect(compareVersions(MIN_CLAUDE_VERSION, version)).toBeLessThanOrEqual(0);
    });

    describe.each([...files.entries()])('%s', (_scenario, f) => {
      it('maps to session … usage, done with the recorded session id, cost and tokens', () => {
        const raw = rawLines(f);
        const init = raw.find((o) => o['type'] === 'system' && o['subtype'] === 'init');
        const result = raw.find((o) => o['type'] === 'result');
        expect(init?.['session_id']).toMatch(/^[0-9a-f-]{36}$/);
        expect(result).toBeDefined();

        const { events, invalidLines, sawResult } = parse(f);
        expect(invalidLines).toBe(0);
        expect(sawResult).toBe(true);
        expect(events[0]).toEqual({ kind: 'session', externalSessionId: init!['session_id'] });
        expect(of(events, 'session')).toHaveLength(1);
        // The run ends with exactly one usage + done pair.
        expect(events.slice(-2).map((e) => e.kind)).toEqual(['usage', 'done']);
        expect(of(events, 'done')).toHaveLength(1);

        const usage = (result!['usage'] ?? {}) as Record<string, number>;
        const tokensIn = (usage['input_tokens'] ?? 0) + (usage['cache_creation_input_tokens'] ?? 0) + (usage['cache_read_input_tokens'] ?? 0);
        const done = of(events, 'done')[0]!;
        expect(done.costUsd).toBe(result!['total_cost_usd']);
        expect(done.tokensIn).toBe(tokensIn);
        expect(done.tokensOut).toBe(usage['output_tokens'] ?? 0);
        expect(done.isError).toBe(result!['is_error'] === true);
        expect(of(events, 'usage')[0]).toEqual({ kind: 'usage', tokensIn: done.tokensIn, tokensOut: done.tokensOut, costUsd: done.costUsd });
        // An error result always produces an error event (→ Blocked), and only then.
        expect(of(events, 'error').length > 0).toBe(done.isError);
      });

      it('gives the same events through the real adapter (spawned CLI, stdin, readline)', async () => {
        expect(await viaAdapter(f)).toEqual(parse(f).events);
      });
    });

    it('plain answer: text "ok", cost and tokens reported', () => {
      const { events } = parse(file('plain'));
      expect(of(events, 'text').map((e) => e.text.toLowerCase())).toContain('ok');
      const done = of(events, 'done')[0]!;
      expect(done).toMatchObject({ isError: false });
      expect(done.costUsd).toBeGreaterThan(0);
      expect(done.tokensIn).toBeGreaterThan(0);
      expect(done.tokensOut).toBeGreaterThan(0);
      expect(of(events, 'tool')).toEqual([]);
    });

    it('--resume keeps the session id and the conversation', () => {
      const start = parse(file('resume-start')).events;
      const cont = parse(file('resume-continue')).events;
      expect(of(cont, 'session')[0]).toEqual(of(start, 'session')[0]);
      expect(of(cont, 'text').map((e) => e.text).join(' ')).toContain('VESUVIO');
      expect(of(cont, 'done')[0]).toMatchObject({ isError: false });
    });

    it('MCP tool call: Sebeto server connected, tool event with name and summary, result text', () => {
      const raw = rawLines(file('mcp-echo'));
      const init = raw.find((o) => o['type'] === 'system' && o['subtype'] === 'init')!;
      expect(init['mcp_servers']).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'sebeto', status: 'connected' })]));
      const { events } = parse(file('mcp-echo'));
      const echo = of(events, 'tool').filter((e) => e.name === 'mcp__sebeto__echo');
      expect(echo).toEqual([{ kind: 'tool', name: 'mcp__sebeto__echo', summary: 'Used Sebeto tool echo' }]);
      // The tool event comes before the answer that uses its result.
      const iTool = events.findIndex((e) => e.kind === 'tool' && e.name === 'mcp__sebeto__echo');
      const iText = events.findIndex((e) => e.kind === 'text' && e.text.includes('echo: ping'));
      expect(iTool).toBeGreaterThan(0);
      expect(iText).toBeGreaterThan(iTool);
      expect(of(events, 'done')[0]).toMatchObject({ isError: false });
    });

    it('error: unknown model → error event naming the problem, isError, no cost', () => {
      const { events } = parse(file('error-invalid-model'));
      expect(of(events, 'error')).toHaveLength(1);
      expect(of(events, 'error')[0]!.message).toMatch(/model/i);
      expect(of(events, 'done')[0]).toMatchObject({ isError: true, costUsd: 0 });
    });

    it('error: budget cap reached → plain-language error, isError, cost reported', () => {
      const { events } = parse(file('error-budget'));
      expect(of(events, 'error')).toEqual([{ kind: 'error', message: 'The cost limit for this run was reached.' }]);
      const done = of(events, 'done')[0]!;
      expect(done.isError).toBe(true);
      expect(done.costUsd).toBeGreaterThan(0);
    });
  });
}

describe('internal Claude Code tools', () => {
  it('ToolSearch (loading deferred tools) is not reported as an action', async () => {
    const { mapClaudeMessage } = await import('./claude-stream.js');
    const events = mapClaudeMessage({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'ToolSearch', input: { query: 'select:mcp__sebeto__echo' } },
      { type: 'tool_use', name: 'mcp__sebeto__echo', input: { text: 'ping' } },
    ] } });
    expect(events.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name)).toEqual(['mcp__sebeto__echo']);
  });
});
