import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type AgentEvent, type TicketRun } from '@sebeto/shared';
import { createOllamaAdapter, isMalformedReplyError, ollamaPivotModel, stripThinking, type ToolBridge } from './ollama.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-ollama-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

type Reply = { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }> };

/** A fake Ollama HTTP API: scripted chat replies, a model list and capabilities. */
function fakeOllama(replies: Reply[], opts: { down?: boolean; models?: Record<string, string[]> } = {}) {
  const chats: Array<{ model: string; messages: Array<{ role: string; content: string; tool_name?: string }>; tools: Array<{ function: { name: string } }> }> = [];
  const models = opts.models ?? { 'qwen3:4b': ['completion', 'tools'], 'gemma:2b': ['completion'] };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (opts.down) throw new TypeError('fetch failed');
    const p = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (p === '/api/version') return ok({ version: '0.40.15' });
    if (p === '/api/tags') return ok({ models: Object.keys(models).map((name) => ({ name, digest: `d-${name}` })) });
    if (p === '/api/show') return ok({ capabilities: models[body.model] ?? [] });
    if (p === '/api/chat') {
      chats.push(body);
      if (!(body.model in models)) return ok({ error: `model "${body.model}" not found, try pulling it first` }, 404);
      const r = replies.shift() ?? { content: 'Done.' };
      return ok({ message: { role: 'assistant', content: r.content ?? '', tool_calls: r.tool_calls }, prompt_eval_count: 100, eval_count: 20 });
    }
    return ok({ error: 'nope' }, 404);
  }) as typeof fetch;
  return { fetchImpl, chats };
}

function fakeTools(results: Record<string, string> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const bridge: ToolBridge = {
    tools: [
      { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'send_email', description: 'Send email', inputSchema: { type: 'object' } },
      { name: 'report_status', description: 'Report', inputSchema: { type: 'object' } },
    ],
    call: async (name, args) => { calls.push({ name, args }); return { text: results[name] ?? `ok ${name}`, isError: false }; },
    close: async () => undefined,
  };
  return { connectTools: async () => bridge, calls };
}

const runOf = (p: Partial<TicketRun> = {}): TicketRun => ({
  ticketId: 't1', runId: 'r1', newExternalSessionId: 'sess-1', cwd: dir, model: 'qwen3:4b', systemPrompt: 'You are Assistant.',
  prompt: 'Write notes.md', permissions: { ...DEFAULT_PERMISSIONS }, budgetUsd: 1, mcp: { url: 'http://x/mcp', token: 't' },
  signal: new AbortController().signal, ...p,
});

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('ollama adapter', () => {
  it('detects Ollama and lists only models with tool support', async () => {
    const a = createOllamaAdapter({ fetchImpl: fakeOllama([]).fetchImpl });
    expect(await a.detect()).toEqual({ installed: true, version: '0.40.15', loggedIn: true });
    expect(await a.models()).toEqual(['qwen3:4b']);
    const none = createOllamaAdapter({ fetchImpl: fakeOllama([], { models: { 'gemma:2b': ['completion'] } }).fetchImpl });
    expect((await none.detect()).problem).toMatch(/ollama pull/);
    const down = createOllamaAdapter({ fetchImpl: fakeOllama([], { down: true }).fetchImpl });
    expect(await down.detect()).toMatchObject({ installed: false });
    expect(await down.models()).toEqual([]);
  });

  it('runs the tool loop through Sebeto tools and reports usage', async () => {
    const o = fakeOllama([
      { content: '<think>plan</think>I will write the file.', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'notes.md', content: 'hi' } } }] },
      { tool_calls: [{ function: { name: 'report_status', arguments: '{"status":"needs_you"}' } }] },
      { content: 'Done: notes.md is ready.' },
    ]);
    const t = fakeTools();
    const events = await collect(createOllamaAdapter({ fetchImpl: o.fetchImpl, connectTools: t.connectTools }).run(runOf()));
    expect(t.calls).toEqual([{ name: 'write_file', args: { path: 'notes.md', content: 'hi' } }, { name: 'report_status', args: { status: 'needs_you' } }]);
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual(['I will write the file.', 'Done: notes.md is ready.']);
    expect(events[0]).toEqual({ kind: 'session', externalSessionId: 'sess-1' });
    expect(events.at(-1)).toEqual({ kind: 'done', tokensIn: 300, tokensOut: 60, costUsd: 0, isError: false });
    // Tools are offered in Ollama's format; tool results go back as role "tool".
    expect(o.chats[0]!.tools.map((x) => x.function.name)).toEqual(['write_file', 'send_email', 'report_status']);
    expect(o.chats[1]!.messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'write_file', content: 'ok write_file' });
    expect(o.chats[0]!.messages[0]!.role).toBe('system');
  });

  it('ends the turn when a permission is requested, and resumes from history next run', async () => {
    const o = fakeOllama([
      { tool_calls: [{ function: { name: 'send_email', arguments: { to: 'boss@example.com' } } }] },
      { content: 'Email sent.' },
    ]);
    const t = fakeTools({ send_email: 'Permission requested from the owner (Permission needed: send email). Stop here and end your turn.' });
    const adapter = createOllamaAdapter({ fetchImpl: o.fetchImpl, connectTools: t.connectTools });
    const first = await collect(adapter.run(runOf()));
    expect(o.chats).toHaveLength(1); // stopped right after the permission request
    expect(first.at(-1)).toMatchObject({ kind: 'done', isError: false });
    expect(fs.existsSync(path.join(dir, '.sebeto', 'ollama-sess-1.json'))).toBe(true);

    await collect(adapter.run(runOf({ newExternalSessionId: undefined, externalSessionId: 'sess-1', prompt: 'The owner allowed it. Continue.' })));
    const msgs = o.chats[1]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(msgs.at(-1)!.content).toBe('The owner allowed it. Continue.');
  });

  it('ends the turn after a final status report, but not after "in progress"', async () => {
    const o = fakeOllama([
      { tool_calls: [{ function: { name: 'report_status', arguments: { status: 'in_progress', note: 'checking' } } }] },
      { tool_calls: [{ function: { name: 'report_status', arguments: { status: 'needs_you', note: 'Found 0 files.' } } }] },
      { tool_calls: [{ function: { name: 'report_status', arguments: { status: 'done', note: 'again' } } }] },
    ]);
    const t = fakeTools({ report_status: 'Status recorded.' });
    const ev = await collect(createOllamaAdapter({ fetchImpl: o.fetchImpl, connectTools: t.connectTools }).run(runOf()));
    // After "needs_you": one wrap-up reply WITHOUT tools; its tool call is ignored and the turn ends.
    expect(o.chats).toHaveLength(3);
    expect(o.chats[2]!.tools).toEqual([]);
    expect(t.calls.map((c) => c.args.status)).toEqual(['in_progress', 'needs_you']);
    expect(ev.at(-1)).toMatchObject({ kind: 'done', isError: false });
  });

  it('handles unknown tools, missing models, Ollama being down, and turn limits', async () => {
    const t = fakeTools();
    const unknown = fakeOllama([{ tool_calls: [{ function: { name: 'rm_rf', arguments: {} } }] }, { content: 'ok' }]);
    await collect(createOllamaAdapter({ fetchImpl: unknown.fetchImpl, connectTools: t.connectTools }).run(runOf()));
    expect(unknown.chats[1]!.messages.at(-1)!.content).toMatch(/Unknown tool "rm_rf"/);
    expect(t.calls).toEqual([]);

    const missing = await collect(createOllamaAdapter({ fetchImpl: fakeOllama([]).fetchImpl, connectTools: t.connectTools }).run(runOf({ model: 'llama9' })));
    expect(missing.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/not installed in Ollama \(ollama pull llama9\)/) });
    expect(missing.at(-1)).toMatchObject({ kind: 'done', isError: true });

    const loop = fakeOllama(Array.from({ length: 10 }, () => ({ tool_calls: [{ function: { name: 'report_status', arguments: {} } }] })));
    const looped = await collect(createOllamaAdapter({ fetchImpl: loop.fetchImpl, connectTools: t.connectTools, maxTurns: 3 }).run(runOf()));
    expect(loop.chats).toHaveLength(3);
    expect(looped.some((e) => e.kind === 'error' && /Stopped after 3 steps/.test(e.message))).toBe(true);

    const down = await collect(createOllamaAdapter({ fetchImpl: fakeOllama([], { down: true }).fetchImpl, connectTools: t.connectTools }).run(runOf()));
    expect(down.find((e) => e.kind === 'error')).toMatchObject({ message: expect.stringMatching(/Ollama failed/) });
  });

  it('strips thinking blocks', () => {
    expect(stripThinking('<think>a\nb</think>\nAnswer')).toBe('Answer');
    expect(stripThinking('half thought</think>Answer')).toBe('Answer');
    expect(stripThinking('Plain')).toBe('Plain');
    // Inverted shape some reasoning models emit (Foundation-Sec): answer first, then a dangling tag.
    expect(stripThinking('Use read_file next.\n</think>')).toBe('Use read_file next.');
    expect(stripThinking('answer</think>')).toBe('answer');
  });
});

/** Like fakeOllama, but driver replies come from the queue while the advisor model answers fixed advice. */
function fakeOllamaWithAdvisor(driverModel: string, advisorModel: string, advice: string, driverReplies: Reply[]) {
  const chats: Array<{ model: string; messages: Array<{ role: string; content: string; tool_name?: string }> }> = [];
  const models: Record<string, string[]> = { [driverModel]: ['completion', 'tools'], [advisorModel]: ['completion', 'thinking'] };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const p = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (p === '/api/version') return ok({ version: '0.40.15' });
    if (p === '/api/tags') return ok({ models: Object.keys(models).map((name) => ({ name, digest: `d-${name}` })) });
    if (p === '/api/show') return ok({ capabilities: models[body.model] ?? [] });
    if (p === '/api/chat') {
      chats.push(body);
      if (body.model === advisorModel) return ok({ message: { role: 'assistant', content: advice }, prompt_eval_count: 50, eval_count: 10 });
      const r = driverReplies.shift() ?? { content: 'Done.' };
      return ok({ message: { role: 'assistant', content: r.content ?? '', tool_calls: r.tool_calls }, prompt_eval_count: 100, eval_count: 20 });
    }
    return ok({ error: 'nope' }, 404);
  }) as typeof fetch;
  return { fetchImpl, chats };
}

describe('ollama pivot assist', () => {
  it('reads the advisor model from the environment', () => {
    expect(ollamaPivotModel('sec-advisor')).toBe('sec-advisor');
    expect(ollamaPivotModel('  padded  ')).toBe('padded');
    expect(ollamaPivotModel('   ')).toBeUndefined();
    expect(ollamaPivotModel(undefined)).toBeUndefined();
  });

  it('asks the advisor to pivot when the driver loops on a failing tool, and feeds the hint back', async () => {
    const hint = 'Stop fetching 127.0.0.1 — it is blocked by design. Use write_file to record findings from the source instead.';
    const fetchFail = { function: { name: 'http_fetch', arguments: { url: 'http://127.0.0.1:7600' } } }; // unknown tool -> error
    const o = fakeOllamaWithAdvisor('qwen3:4b', 'sec-advisor', hint, [
      { tool_calls: [fetchFail] }, // turn 0: new but errors -> unproductive (streak 1)
      { tool_calls: [fetchFail] }, // turn 1: repeat+error -> unproductive (streak 2 >= pivotAfter) -> pivot
      { content: 'Thanks — recording findings.', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'findings.md' } } }] }, // productive
      { content: 'Done.' },
    ]);
    const t = fakeTools();
    const events = await collect(
      createOllamaAdapter({ fetchImpl: o.fetchImpl, connectTools: t.connectTools, pivotModel: 'sec-advisor', pivotAfter: 2, maxPivots: 1 }).run(runOf()),
    );

    // The advisor was consulted exactly once, and only after the driver was stuck.
    const advisorChats = o.chats.filter((c) => c.model === 'sec-advisor');
    expect(advisorChats).toHaveLength(1);
    // The advisor was told what the driver kept trying (the failed fetch).
    expect(advisorChats[0]!.messages.at(-1)!.content).toMatch(/http_fetch.*ERROR/s);
    // The hint is surfaced in the timeline and fed back to the driver as a user message.
    expect(events.some((e) => e.kind === 'text' && /↪︎ Stuck/.test((e as { text: string }).text) && /blocked by design/.test((e as { text: string }).text))).toBe(true);
    const driverAfterPivot = o.chats.filter((c) => c.model === 'qwen3:4b').at(-2)!; // the call that carried the hint
    expect(driverAfterPivot.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('blocked by design') });
    // The driver then pivoted to a different, working tool.
    expect(t.calls.some((c) => c.name === 'write_file')).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: false });
  });

  it('classifies malformed-reply errors (not timeouts or missing models)', () => {
    expect(isMalformedReplyError("invalid character '\\n' in string literal")).toBe(true);
    expect(isMalformedReplyError('json: cannot unmarshal number into Go value')).toBe(true);
    expect(isMalformedReplyError('model "llama9" not found, try pulling it first')).toBe(false);
    expect(isMalformedReplyError('request aborted')).toBe(false);
  });

  it('recovers from a malformed tool call instead of aborting the run', async () => {
    let first = true;
    const driver = [
      { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'ok.md' } } }] },
      { content: 'Done after the retry.' },
    ] as Reply[];
    const chats: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const p = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (p === '/api/version') return ok({ version: '0.40.15' });
      if (p === '/api/tags') return ok({ models: [{ name: 'qwen3:4b', digest: 'd' }] });
      if (p === '/api/show') return ok({ capabilities: ['completion', 'tools'] });
      if (p === '/api/chat') {
        chats.push(body);
        if (first) { first = false; return ok({ error: "invalid character '\\n' in string literal" }, 500); }
        const r = driver.shift() ?? { content: 'Done.' };
        return ok({ message: { role: 'assistant', content: r.content ?? '', tool_calls: r.tool_calls }, prompt_eval_count: 100, eval_count: 20 });
      }
      return ok({ error: 'nope' }, 404);
    }) as typeof fetch;
    const t = fakeTools();
    const events = await collect(createOllamaAdapter({ fetchImpl, connectTools: t.connectTools }).run(runOf()));
    // The run did not abort: the driver retried, wrote the file, and finished cleanly.
    expect(events.some((e) => e.kind === 'text' && /invalid tool call/.test((e as { text: string }).text))).toBe(true);
    expect(t.calls.some((c) => c.name === 'write_file')).toBe(true);
    expect(events.find((e) => e.kind === 'error')).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: false });
    // The model was told to re-issue valid JSON after the bad reply.
    expect(chats[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('malformed JSON') });
  });

  it('pivots when the driver keeps using one tool on different targets without finishing', async () => {
    const hint = 'You have read enough. Stop listing/reading and write your findings with report_status now.';
    const o = fakeOllamaWithAdvisor('qwen3:4b', 'sec-advisor', hint, [
      { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a0.md' } } }] }, // use 1 (productive)
      { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a1.md' } } }] }, // use 2 (productive)
      { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a2.md' } } }] }, // use 3 > cap -> unproductive (streak 1)
      { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a3.md' } } }] }, // use 4 > cap -> unproductive (streak 2 >= pivotAfter) -> pivot
      { content: 'Understood — writing findings.' },
    ]);
    const t = fakeTools();
    const events = await collect(
      createOllamaAdapter({ fetchImpl: o.fetchImpl, connectTools: t.connectTools, pivotModel: 'sec-advisor', pivotAfter: 2, maxPivots: 1, toolSoftCap: 2 }).run(runOf()),
    );
    expect(o.chats.filter((c) => c.model === 'sec-advisor')).toHaveLength(1); // the varied-but-off-task spin was caught
    expect(events.some((e) => e.kind === 'text' && /write your findings/.test((e as { text: string }).text))).toBe(true);
    expect(t.calls.filter((c) => c.name === 'write_file')).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ kind: 'done', isError: false });
  });

  it('does not consult an advisor when none is configured (default behaviour unchanged)', async () => {
    const fetchFail = { function: { name: 'http_fetch', arguments: {} } };
    const o = fakeOllamaWithAdvisor('qwen3:4b', 'sec-advisor', 'unused', Array.from({ length: 10 }, () => ({ tool_calls: [fetchFail] })));
    const t = fakeTools();
    const events = await collect(
      createOllamaAdapter({ fetchImpl: o.fetchImpl, connectTools: t.connectTools, pivotModel: null, maxTurns: 3 }).run(runOf()),
    );
    expect(o.chats.some((c) => c.model === 'sec-advisor')).toBe(false);
    expect(events.some((e) => e.kind === 'text' && /↪︎ Stuck/.test((e as { text: string }).text))).toBe(false);
    expect(events.some((e) => e.kind === 'error' && /Stopped after 3 steps/.test((e as { message: string }).message))).toBe(true);
  });
});
