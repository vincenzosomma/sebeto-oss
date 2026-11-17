/**
 * Contract-style tests for the OpenAI-compatible adapter (v0.7 R) against a fake
 * /v1/chat/completions endpoint. No real network: a fake fetch, plus two loopback servers for the
 * redirect test of the default node:http fetch.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, aiConnectionIdOf, aiConnectionRuntimeId, type AgentEvent, type AiConnection, type TicketRun } from '@sebeto/shared';
import { checkEndpointUrl, createOpenAiCompatAdapter, replyCost, trimHistory, type OpenAiMessage } from './openai-compat.js';
import type { ToolBridge } from './ollama.js';

const KEY = 'sk-test-0123456789abcdefSECRET';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-openai-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const conn = (p: Partial<AiConnection> = {}): AiConnection => ({
  id: '01900000-0000-7000-8000-000000000001', runtimeId: aiConnectionRuntimeId('01900000-0000-7000-8000-000000000001'),
  name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'local', defaultModel: 'qwen3-4b', hasApiKey: false,
  allowPrivateHttp: false, prices: {}, replyTimeoutMin: 30, contextWindow: null, createdAt: '', updatedAt: '', ...p,
});

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
type Reply = { status?: number; json?: unknown; headers?: Record<string, string>; hang?: boolean };

/** A fake OpenAI-compatible endpoint: scripted replies for /chat/completions, a model list. */
function fakeEndpoint(replies: Reply[], opts: { models?: Reply } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const u = new URL(String(url));
    const reply = u.pathname.endsWith('/models') ? opts.models ?? { json: { object: 'list', data: [{ id: 'qwen3-4b' }, { id: 'llama-3.1-8b' }] } } : replies.shift() ?? { json: chat('Done.') };
    if (reply.hang) {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { 'content-type': 'application/json', ...reply.headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const chat = (content: string | null, toolCalls?: Array<{ id?: string; name: string; args: unknown }>, usage: Record<string, number> = { prompt_tokens: 100, completion_tokens: 20 }) => ({
  id: 'chatcmpl-1', object: 'chat.completion',
  choices: [{ index: 0, finish_reason: toolCalls ? 'tool_calls' : 'stop', message: {
    role: 'assistant', content,
    ...(toolCalls ? { tool_calls: toolCalls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })) } : {}),
  } }],
  usage,
});

function fakeTools(results: Record<string, string> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let closed = false;
  const bridge: ToolBridge = {
    tools: [
      { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'send_email', description: 'Send email', inputSchema: { type: 'object' } },
    ],
    call: async (name, args) => { calls.push({ name, args }); return { text: results[name] ?? `ok ${name}`, isError: false }; },
    close: async () => { closed = true; },
  };
  return { connectTools: async () => bridge, calls, closed: () => closed };
}

const runOf = (p: Partial<TicketRun> = {}): TicketRun => ({
  ticketId: 't1', runId: 'r1', newExternalSessionId: 'sess-1', cwd: dir, model: null, systemPrompt: 'You are Assistant.',
  prompt: 'Write notes.md', permissions: { ...DEFAULT_PERMISSIONS }, budgetUsd: 1, mcp: { url: 'http://x/mcp', token: 't' },
  signal: new AbortController().signal, ...p,
});

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('openai-compatible adapter', () => {
  it('uses the runtime id openai:<connectionId> and a clear display name', () => {
    const a = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null });
    expect(a.id).toBe('openai:01900000-0000-7000-8000-000000000001');
    expect(aiConnectionIdOf(a.id)).toBe('01900000-0000-7000-8000-000000000001');
    expect(aiConnectionIdOf('ollama')).toBeNull();
    expect(a.displayName).toBe('LM Studio (local)');
    const r = createOpenAiCompatAdapter({ connection: conn({ name: 'OpenRouter', kind: 'remote', baseUrl: 'https://openrouter.ai/api/v1' }), apiKey: async () => KEY });
    expect(r.displayName).toBe('OpenRouter (remote · openrouter.ai)');
  });

  it('detects the endpoint and lists its models from GET /models', async () => {
    const f = fakeEndpoint([]);
    const a = createOpenAiCompatAdapter({ connection: conn({ defaultModel: 'my-default' }), apiKey: async () => null, fetchImpl: f.fetchImpl });
    expect(await a.detect()).toEqual({ installed: true, loggedIn: true });
    expect(await a.models()).toEqual(['my-default', 'llama-3.1-8b', 'qwen3-4b']);
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:1234/v1/models');
    expect(f.calls.length).toBe(1); // cached

    const refused = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => 'bad', fetchImpl: fakeEndpoint([], { models: { status: 401, json: { error: { message: 'invalid key' } } } }).fetchImpl });
    expect(await refused.detect()).toMatchObject({ installed: true, loggedIn: false });
    const noList = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null, fetchImpl: fakeEndpoint([], { models: { status: 404, json: {} } }).fetchImpl });
    expect(await noList.detect()).toEqual({ installed: true, loggedIn: true });
    expect(await noList.models()).toEqual(['qwen3-4b']);
    const down = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    expect(await down.detect()).toMatchObject({ installed: false });
    expect(await down.models()).toEqual(['qwen3-4b']);
  });

  it('runs the tool loop through Sebeto tools (tool_calls → tool results → model) and reports usage', async () => {
    const f = fakeEndpoint([
      { json: chat('<think>plan</think>I will write the file.', [{ id: 'call_a', name: 'write_file', args: { path: 'notes.md', content: 'hi' } }]) },
      { json: chat(null, [{ name: 'send_email', args: '{"to":"a@b.c"}' }]) },
      { json: chat('Done: notes.md is ready.') },
    ]);
    const t = fakeTools();
    const a = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null, fetchImpl: f.fetchImpl, connectTools: t.connectTools });
    const events = await collect(a.run(runOf()));

    expect(events[0]).toEqual({ kind: 'session', externalSessionId: 'sess-1' });
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual(['I will write the file.', 'Done: notes.md is ready.']);
    expect(events.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name)).toEqual(['write_file', 'send_email']);
    expect(t.calls).toEqual([{ name: 'write_file', args: { path: 'notes.md', content: 'hi' } }, { name: 'send_email', args: { to: 'a@b.c' } }]);
    expect(t.closed()).toBe(true);

    const chats = f.calls.filter((c) => c.url.endsWith('/chat/completions'));
    expect(chats).toHaveLength(3);
    expect(chats[0]!.url).toBe('http://127.0.0.1:1234/v1/chat/completions');
    const b0 = chats[0]!.body as { model: string; stream: boolean; tools: Array<{ type: string; function: { name: string } }>; tool_choice: string; usage?: unknown };
    expect(b0.model).toBe('qwen3-4b');
    expect(b0.stream).toBe(false);
    expect(b0.tool_choice).toBe('auto');
    expect(b0.tools.map((x) => x.function.name)).toEqual(['write_file', 'send_email']);
    expect(b0.usage).toBeUndefined(); // the OpenRouter cost flag goes to remote endpoints only
    expect(chats[0]!.headers.authorization).toBeUndefined();
    // The tool result goes back with its tool_call_id, after the assistant's tool_calls.
    const m1 = (chats[1]!.body as { messages: OpenAiMessage[] }).messages;
    expect(m1.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'write_file' } }] });
    expect(m1.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_a', content: 'ok write_file' });

    expect(events.at(-2)).toMatchObject({ kind: 'usage', tokensIn: 300, tokensOut: 60, costUsd: 0 });
    expect(events.at(-1)).toEqual({ kind: 'done', tokensIn: 300, tokensOut: 60, costUsd: 0, isError: false });

    // History is kept in <ticket>/.sebeto/openai-<session>.json and resumed next run.
    const history = JSON.parse(fs.readFileSync(path.join(dir, '.sebeto', 'openai-sess-1.json'), 'utf8')) as OpenAiMessage[];
    expect(history[0]).toEqual({ role: 'user', content: 'Write notes.md' });
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'Done: notes.md is ready.' });
    const f2 = fakeEndpoint([{ json: chat('Again.') }]);
    const a2 = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null, fetchImpl: f2.fetchImpl, connectTools: fakeTools().connectTools });
    await collect(a2.run(runOf({ externalSessionId: 'sess-1', newExternalSessionId: undefined, prompt: 'And now?' })));
    const resumed = (f2.calls[0]!.body as { messages: OpenAiMessage[] }).messages;
    expect(resumed[0]!.role).toBe('system');
    expect(resumed[1]).toEqual({ role: 'user', content: 'Write notes.md' });
    expect(resumed.at(-1)).toEqual({ role: 'user', content: 'And now?' });
  });

  it('ends the turn when a tool asks the owner for permission (every call still gets its answer)', async () => {
    const f = fakeEndpoint([{ json: chat(null, [{ id: 'c1', name: 'send_email', args: {} }, { id: 'c2', name: 'write_file', args: {} }]) }]);
    const t = fakeTools({ send_email: 'Permission requested from the owner: send an email. Stop now.' });
    const a = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null, fetchImpl: f.fetchImpl, connectTools: t.connectTools });
    const events = await collect(a.run(runOf()));
    expect(f.calls.filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: false });
    const history = JSON.parse(fs.readFileSync(path.join(dir, '.sebeto', 'openai-sess-1.json'), 'utf8')) as OpenAiMessage[];
    expect(history.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['c1', 'c2']);
  });

  it('remote: sends the key only as a Bearer header, asks for usage.cost and uses it', async () => {
    const f = fakeEndpoint([{ json: chat('Hi.', undefined, { prompt_tokens: 1000, completion_tokens: 500, cost: 0.0123 }) }]);
    const a = createOpenAiCompatAdapter({
      connection: conn({ name: 'OpenRouter', kind: 'remote', baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: true, prices: { 'x/model': { inputPerM: 100, outputPerM: 100 } } }),
      apiKey: async () => KEY, fetchImpl: f.fetchImpl, connectTools: fakeTools().connectTools,
    });
    const events = await collect(a.run(runOf({ model: 'x/model' })));
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(f.calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((f.calls[0]!.body as { usage: unknown }).usage).toEqual({ include: true });
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain(KEY);
    // The provider's cost wins over the owner's price.
    expect(events.at(-1)).toMatchObject({ kind: 'done', costUsd: 0.0123, tokensIn: 1000, tokensOut: 500 });
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('cost: 0 local, owner price per 1M tokens, else unknown (0)', () => {
    const usage = { prompt_tokens: 2_000_000, completion_tokens: 1_000_000 };
    expect(replyCost({ kind: 'local', prices: { m: { inputPerM: 5, outputPerM: 5 } } }, 'm', { ...usage, cost: 9 })).toEqual({ costUsd: 0, known: true });
    expect(replyCost({ kind: 'remote', prices: { m: { inputPerM: 3, outputPerM: 15 } } }, 'm', usage)).toEqual({ costUsd: 21, known: true });
    expect(replyCost({ kind: 'remote', prices: {} }, 'm', usage)).toEqual({ costUsd: 0, known: false });
    expect(replyCost({ kind: 'remote', prices: {} }, 'm', { ...usage, cost: 0.5 })).toEqual({ costUsd: 0.5, known: true });
  });

  it('stops a paid run at the cost cap', async () => {
    const f = fakeEndpoint([
      { json: chat(null, [{ name: 'write_file', args: {} }], { prompt_tokens: 10, completion_tokens: 10, cost: 0.6 }) },
      { json: chat(null, [{ name: 'write_file', args: {} }], { prompt_tokens: 10, completion_tokens: 10, cost: 0.6 }) },
      { json: chat('never') },
    ]);
    const a = createOpenAiCompatAdapter({ connection: conn({ kind: 'remote', baseUrl: 'https://api.example.com/v1' }), apiKey: async () => KEY, fetchImpl: f.fetchImpl, connectTools: fakeTools().connectTools });
    const events = await collect(a.run(runOf({ budgetUsd: 1 })));
    expect(events.some((e) => e.kind === 'error' && /cost cap/.test(e.message))).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: true, costUsd: 1.2 });
    expect(f.calls.filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(2);
  });

  it('turns endpoint errors into plain errors and never repeats the key', async () => {
    const f = fakeEndpoint([{ status: 500, json: { error: { message: `upstream exploded for key ${KEY}` } } }]);
    const a = createOpenAiCompatAdapter({ connection: conn({ kind: 'remote', baseUrl: 'https://api.example.com/v1', hasApiKey: true }), apiKey: async () => KEY, fetchImpl: f.fetchImpl, connectTools: fakeTools().connectTools });
    const events = await collect(a.run(runOf()));
    const err = events.find((e) => e.kind === 'error') as { message: string };
    expect(err.message).toMatch(/failed \(500\): upstream exploded/);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('<redacted>');
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: true });

    const refused = fakeEndpoint([{ status: 401, json: { error: 'bad key' } }]);
    const b = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => 'x', fetchImpl: refused.fetchImpl, connectTools: fakeTools().connectTools });
    expect((await collect(b.run(runOf()))).find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/refused the API key \(401\)/) });

    const noModel = createOpenAiCompatAdapter({ connection: conn({ defaultModel: null }), apiKey: async () => null, fetchImpl: fakeEndpoint([], { models: { json: { data: [] } } }).fetchImpl });
    expect((await collect(noModel.run(runOf()))).find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/No model is set/) });
  });

  it('times out a reply that never comes', async () => {
    const f = fakeEndpoint([{ hang: true }]);
    const a = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null, fetchImpl: f.fetchImpl, connectTools: fakeTools().connectTools, replyTimeoutMs: 50 });
    const events = await collect(a.run(runOf()));
    expect(events.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/did not answer within 1 minute/) });
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: true });
  });

  it('stops at once when the run is cancelled', async () => {
    const f = fakeEndpoint([{ hang: true }]);
    const t = fakeTools();
    const ctl = new AbortController();
    const a = createOpenAiCompatAdapter({ connection: conn(), apiKey: async () => null, fetchImpl: f.fetchImpl, connectTools: t.connectTools });
    setTimeout(() => ctl.abort(), 30);
    const events = await collect(a.run(runOf({ signal: ctl.signal })));
    expect(events.map((e) => e.kind)).toEqual(['session']);
    expect(t.closed()).toBe(true);
  });

  it('refuses a redirect to another origin (the key is not sent there), follows a same-origin one', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      seen.push(`${u.origin}${u.pathname} ${new Headers(init?.headers).get('authorization') ?? '-'}`);
      expect(init?.redirect).toBe('manual');
      if (u.pathname === '/v1/models') return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
      if (u.pathname === '/v1/chat/completions') return new Response(null, { status: 307, headers: { location: '/v2/chat/completions' } });
      return new Response(JSON.stringify(chat('Moved but fine.')), { status: 200 });
    }) as typeof fetch;
    const a = createOpenAiCompatAdapter({ connection: conn({ kind: 'remote', baseUrl: 'https://api.example.com/v1', hasApiKey: true }), apiKey: async () => KEY, fetchImpl, connectTools: fakeTools().connectTools });
    const d = await a.detect();
    expect(d.installed).toBe(false);
    expect(d.problem).toMatch(/redirected to another host \(evil\.example\)/);
    expect(seen.some((s) => s.startsWith('https://evil.example'))).toBe(false);

    const events = await collect(a.run(runOf()));
    expect(events.find((e) => e.kind === 'text')).toEqual({ kind: 'text', text: 'Moved but fine.' });
    expect(seen.filter((s) => s.includes('chat/completions'))).toEqual([
      `https://api.example.com/v1/chat/completions Bearer ${KEY}`,
      `https://api.example.com/v2/chat/completions Bearer ${KEY}`,
    ]);
  });

  it('the default node:http fetch does not follow a cross-origin redirect either', async () => {
    let evilHits = 0;
    const evil = http.createServer((_req, res) => { evilHits++; res.end('{}'); });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    const evilPort = (evil.address() as AddressInfo).port;
    const good = http.createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/v1/models` }); res.end(); });
    await new Promise<void>((r) => good.listen(0, '127.0.0.1', r));
    const goodPort = (good.address() as AddressInfo).port;
    try {
      const a = createOpenAiCompatAdapter({ connection: conn({ baseUrl: `http://127.0.0.1:${goodPort}/v1`, hasApiKey: true }), apiKey: async () => KEY });
      const d = await a.detect();
      expect(d.problem).toMatch(/redirected to another host/);
      expect(evilHits).toBe(0);
    } finally {
      evil.close();
      good.close();
    }
  });

  it('trims history so it never starts with an orphan tool result', () => {
    const msgs: OpenAiMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: 'r' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'done' },
    ];
    expect(trimHistory(msgs, 4)).toEqual(msgs.slice(4));
    expect(trimHistory(msgs, 60)).toEqual(msgs);
  });
});

describe('endpoint address rules', () => {
  it('allows http only to this computer, or a private LAN IP the owner allows', () => {
    expect(checkEndpointUrl('http://127.0.0.1:1234', 'local')).toBe('http://127.0.0.1:1234/v1');
    expect(checkEndpointUrl('http://localhost:8000/v1/', 'local')).toBe('http://localhost:8000/v1');
    expect(checkEndpointUrl('http://[::1]:11434/v1', 'local')).toBe('http://[::1]:11434/v1');
    expect(checkEndpointUrl('https://openrouter.ai/api/v1', 'remote')).toBe('https://openrouter.ai/api/v1');
    expect(() => checkEndpointUrl('http://openrouter.ai/api/v1', 'remote')).toThrow(/Use https/);
    expect(() => checkEndpointUrl('http://93.184.216.34/v1', 'remote')).toThrow(/Use https/);
    expect(() => checkEndpointUrl('http://192.168.1.20:1234/v1', 'local')).toThrow(/Allow plain http/);
    expect(checkEndpointUrl('http://192.168.1.20:1234/v1', 'local', true)).toBe('http://192.168.1.20:1234/v1');
    expect(checkEndpointUrl('https://gpu-box.lan/v1', 'local')).toBe('https://gpu-box.lan/v1');
  });

  it('refuses a cloud host labelled local, credentials in the URL, and odd schemes', () => {
    expect(() => checkEndpointUrl('https://openrouter.ai/api/v1', 'local')).toThrow(/Choose "Remote"/);
    expect(() => checkEndpointUrl('https://user:pw@api.example.com/v1', 'remote')).toThrow(/API key field/);
    expect(() => checkEndpointUrl('https://api.example.com/v1?key=1', 'remote')).toThrow(/\?/);
    expect(() => checkEndpointUrl('file:///etc/passwd', 'local')).toThrow(/http/);
    expect(() => checkEndpointUrl('not a url', 'local')).toThrow(/not a valid URL/);
  });

  it('a hand-edited insecure address makes the runtime unusable instead of calling it', async () => {
    const f = fakeEndpoint([]);
    const a = createOpenAiCompatAdapter({ connection: conn({ kind: 'remote', baseUrl: 'http://api.example.com/v1' }), apiKey: async () => KEY, fetchImpl: f.fetchImpl });
    expect(await a.detect()).toMatchObject({ installed: false, problem: expect.stringMatching(/https/) });
    const events = await collect(a.run(runOf()));
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: true });
    expect(f.calls).toHaveLength(0);
  });
});
