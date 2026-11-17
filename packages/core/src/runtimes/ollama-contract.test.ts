/**
 * Contract tests for the Ollama adapter (docs/15 Architecture Review #12).
 *
 * Every `__fixtures__/ollama/tool-call.<version>.json` holds REAL /api/chat requests and responses
 * recorded by packages/core/scripts/record-ollama-fixtures.mjs (one tool offered, the model calls
 * it, then answers with the tool result). Each file is replayed through createOllamaAdapter with a
 * fake fetch serving the recorded responses; new Ollama versions are picked up automatically.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type AgentEvent } from '@sebeto/shared';
import { createOllamaAdapter, type ToolBridge } from './ollama.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '__fixtures__', 'ollama');

interface Exchange { path: string; request: Record<string, unknown> | null; status: number; response: Record<string, unknown> }
interface Fixture {
  ollamaVersion: string;
  model: string;
  capabilities: string[];
  systemPrompt: string;
  prompt: string;
  tools: ToolBridge['tools'];
  toolResult: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  exchanges: Exchange[];
}
type ChatMessage = { role: string; content: string; tool_calls?: unknown[]; tool_name?: string };
type ChatResponse = { message?: ChatMessage; prompt_eval_count?: number; eval_count?: number };

const files = fs.readdirSync(fixturesDir).filter((f) => /^tool-call\.\d+\.\d+\.\d+\.json$/.test(f)).sort();

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-ollama-contract-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

it('has recorded Ollama fixtures', () => {
  expect(files.length).toBeGreaterThan(0);
});

describe.each(files)('%s (recorded /api/chat)', (file) => {
  const fx = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as Fixture;
  const recordedChats = fx.exchanges.filter((x) => x.path === '/api/chat');

  /** Fake Ollama: serves the recorded responses in order and keeps what the adapter sent. */
  function replay() {
    const queue = [...recordedChats];
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const p = new URL(String(url)).pathname;
      const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (p === '/api/version') return ok({ version: fx.ollamaVersion });
      if (p === '/api/tags') return ok({ models: [{ name: fx.model, digest: 'recorded' }] });
      if (p === '/api/show') return ok({ capabilities: fx.capabilities });
      if (p === '/api/chat') {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const next = queue.shift();
        if (!next) return ok({ error: 'no more recorded responses' }, 500);
        return ok(next.response, next.status);
      }
      return ok({ error: 'not recorded' }, 404);
    }) as typeof fetch;
    return { fetchImpl, sent };
  }

  function bridge() {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const b: ToolBridge = {
      tools: fx.tools,
      call: async (name, args) => { calls.push({ name, args }); return { text: fx.toolResult, isError: false }; },
      close: async () => undefined,
    };
    return { connectTools: async () => b, calls };
  }

  async function run() {
    const o = replay();
    const t = bridge();
    const adapter = createOllamaAdapter({ fetchImpl: o.fetchImpl, connectTools: t.connectTools });
    const events: AgentEvent[] = [];
    for await (const e of adapter.run({
      ticketId: 't', runId: 'contract', newExternalSessionId: 'contract-session', cwd: dir, model: fx.model,
      systemPrompt: fx.systemPrompt, prompt: fx.prompt, permissions: { ...DEFAULT_PERMISSIONS }, budgetUsd: 0,
      mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' }, signal: new AbortController().signal,
    })) events.push(e);
    return { events, sent: o.sent, calls: t.calls, adapter };
  }

  it('the recording holds a tool call followed by a final answer', () => {
    expect(recordedChats.length).toBeGreaterThanOrEqual(2);
    const first = recordedChats[0]!.response as ChatResponse;
    expect(first.message?.tool_calls?.length).toBeGreaterThan(0);
    const last = recordedChats.at(-1)!.response as ChatResponse;
    expect(last.message?.tool_calls ?? []).toEqual([]);
    expect(last.message?.content).toBeTruthy();
  });

  it('detect() and models() accept the recorded version and capabilities', async () => {
    const adapter = createOllamaAdapter({ fetchImpl: replay().fetchImpl });
    expect(await adapter.detect()).toEqual({ installed: true, version: fx.ollamaVersion, loggedIn: true });
    expect(await adapter.models()).toEqual([fx.model]);
  });

  it('replays to session, tool, text, usage, done with the recorded token counts', async () => {
    const { events, calls } = await run();
    expect(events[0]).toEqual({ kind: 'session', externalSessionId: 'contract-session' });
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);

    // The tool call the model made is run through Sebeto's tools with the parsed arguments.
    expect(calls).toEqual(fx.toolCalls);
    const tools = events.filter((e): e is Extract<AgentEvent, { kind: 'tool' }> => e.kind === 'tool');
    expect(tools.map((e) => e.name)).toEqual(fx.toolCalls.map((c) => c.name));
    for (const [i, e] of tools.entries()) expect(e.summary).toBe(`Used Sebeto tool ${fx.toolCalls[i]!.name} ${JSON.stringify(fx.toolCalls[i]!.args)}`);

    // The final answer is shown as text and uses the tool result.
    const final = (recordedChats.at(-1)!.response as ChatResponse).message!.content.trim();
    const texts = events.filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text').map((e) => e.text);
    expect(texts.at(-1)).toBe(final);
    expect(final).toMatch(/112/);

    const sum = (k: 'prompt_eval_count' | 'eval_count') => recordedChats.reduce((n, x) => n + ((x.response as ChatResponse)[k] ?? 0), 0);
    expect(events.slice(-2).map((e) => e.kind)).toEqual(['usage', 'done']);
    expect(events.at(-1)).toEqual({ kind: 'done', tokensIn: sum('prompt_eval_count'), tokensOut: sum('eval_count'), costUsd: 0, isError: false });
    expect(sum('eval_count')).toBeGreaterThan(0);
  });

  it('sends the same conversation shape as the recorded run', async () => {
    const { sent } = await run();
    expect(sent).toHaveLength(recordedChats.length);
    for (const [i, body] of sent.entries()) {
      const rec = recordedChats[i]!.request!;
      const roles = (m: unknown) => (m as ChatMessage[]).map((x) => x.role);
      expect(roles(body['messages'])).toEqual(roles(rec['messages']));
      expect(body['model']).toBe(rec['model']);
      expect(body['stream']).toBe(false);
      expect(body['tools']).toEqual(rec['tools']);
    }
    // The tool result goes back as role "tool" with the tool's name.
    const second = sent[1]!['messages'] as ChatMessage[];
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_name: fx.toolCalls[0]!.name, content: fx.toolResult });
  });
});
