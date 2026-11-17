import { describe, expect, it } from 'vitest';
import type { AgentEvent, TicketRun } from '@sebeto/shared';
import { DEFAULT_PERMISSIONS } from '@sebeto/shared';
import { createMockAdapter } from './mock.js';
import { createRuntimeRegistry } from './registry.js';

function runInput(prompt: string, extra: Partial<TicketRun> = {}): TicketRun {
  return {
    ticketId: 't1', runId: 'r1', cwd: '.', systemPrompt: 'sys', prompt,
    permissions: DEFAULT_PERMISSIONS, budgetUsd: 1, signal: new AbortController().signal, ...extra,
  };
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('mock adapter', () => {
  const mock = createMockAdapter();

  it('emits session, text, tool, usage and done with fake cost', async () => {
    const ev = await collect(mock.run(runInput('Write a summary')));
    expect(ev.map((e) => e.kind)).toEqual(['session', 'text', 'tool', 'usage', 'done']);
    expect(ev[0]).toEqual({ kind: 'session', externalSessionId: 'mock-t1' });
    expect(ev.at(-1)).toMatchObject({ kind: 'done', costUsd: 0.01, isError: false });
  });

  it('reuses the external session id when resuming, uses newExternalSessionId when new', async () => {
    expect((await collect(mock.run(runInput('hi', { externalSessionId: 'abc' }))))[0]).toEqual({ kind: 'session', externalSessionId: 'abc' });
    expect((await collect(mock.run(runInput('hi', { newExternalSessionId: 'n1' }))))[0]).toEqual({ kind: 'session', externalSessionId: 'n1' });
  });

  it('keywords: ask, fail, block, done (case-insensitive, whole words)', async () => {
    expect((await collect(mock.run(runInput('Please ASK me')))).some((e) => e.kind === 'ask')).toBe(true);
    expect((await collect(mock.run(runInput('finish the task')))).some((e) => e.kind === 'ask')).toBe(false);

    const fail = await collect(mock.run(runInput('this will Fail')));
    expect(fail.some((e) => e.kind === 'error')).toBe(true);
    expect(fail.at(-1)).toMatchObject({ kind: 'done', isError: true });

    expect(await collect(mock.run(runInput('block please')))).toContainEqual(expect.objectContaining({ kind: 'status', status: 'blocked' }));
    expect(await collect(mock.run(runInput('we are DONE')))).toContainEqual(expect.objectContaining({ kind: 'status', status: 'done' }));
  });

  it('stops promptly on abort', async () => {
    const slow = createMockAdapter({ delayMs: 200 });
    const ac = new AbortController();
    const started = Date.now();
    const out: AgentEvent[] = [];
    for await (const e of slow.run(runInput('hello', { signal: ac.signal }))) {
      out.push(e);
      if (e.kind === 'session') ac.abort();
    }
    expect(out.map((e) => e.kind)).toEqual(['session']);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('detect and models', async () => {
    expect((await mock.detect()).installed).toBe(true);
    expect(await mock.models()).toEqual(['mock']);
  });
});

describe('runtime registry', () => {
  it('looks up adapters by id', () => {
    const reg = createRuntimeRegistry([createMockAdapter()]);
    expect(reg.get('mock')?.id).toBe('mock');
    expect(reg.get('claude-cli')).toBeUndefined();
    expect(reg.list()).toHaveLength(1);
  });
});
