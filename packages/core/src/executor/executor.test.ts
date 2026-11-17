import { describe, expect, it } from 'vitest';
import type { AgentEvent, RuntimeAdapter, TicketRun } from '@sebeto/shared';
import { createMockAdapter } from '../runtimes/mock.js';
import { createExecutor, decideFinalStatus, isTransientError } from './executor.js';
import { createFakes } from './testing/fakes.js';

const lastTransition = (f: ReturnType<typeof createFakes>, ticketId: string) => f.transitions.filter((t) => t.ticketId === ticketId).at(-1);

/** Adapter that runs a scripted body (for snapshot / exception scenarios). */
function scripted(id: string, body: (r: TicketRun) => AsyncGenerator<AgentEvent>): RuntimeAdapter {
  return { id, displayName: id, capabilities: { tools: false, resume: true, costReport: true }, detect: async () => ({ installed: true }), models: async () => [], run: body };
}

describe('executor', () => {
  it('happy path: session, run, messages, audit, cost, needs_you "turn finished"', async () => {
    const f = createFakes();
    const agent = f.addAgent();
    const t = f.addTicket({ agentId: agent.id, title: 'Quarterly report' });
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(f.ctx);
    expect(ex.tick()).toBe(1);
    expect(ex.activeRuns()).toBe(1);
    await ex.idle();

    const ticket = f.tickets.get(t.id)!;
    expect(ticket.status).toBe('needs_you');
    expect(lastTransition(f, t.id)).toMatchObject({ to: 'needs_you', cause: 'rule', note: 'turn finished' });
    expect(f.transitions.map((x) => x.to)).toEqual(['in_progress', 'needs_you']);
    expect(ticket.costUsd).toBeCloseTo(0.01);

    const session = f.sessions.get(ticket.currentSessionId!)!;
    expect(session).toMatchObject({ runtime: 'mock', reason: 'new' });
    expect(session.externalSessionId).toMatch(/^[0-9a-f-]{36}$/);

    const run = [...f.runs.values()][0]!;
    expect(run).toMatchObject({ status: 'succeeded', trigger: 'start', costUsd: 0.01, tokensIn: 100, tokensOut: 50, snapshotBefore: 'oid-1', snapshotAfter: 'oid-1' });
    expect(run.endedAt).not.toBeNull();

    expect(f.messages[0]).toMatchObject({ role: 'agent', author: 'Analyst', runId: run.id });
    expect(f.messages[0]!.text).toContain('Quarterly report');
    expect(f.audit.some((e) => e.kind === 'tool')).toBe(true);
    expect(f.events.some((e) => e.type === 'message.created')).toBe(true);
    expect(f.events.some((e) => e.type === 'event.created')).toBe(true);
    expect(f.events.filter((e) => e.type === 'run.updated').length).toBeGreaterThanOrEqual(2);
    expect(f.revoked).toEqual([`token-${run.id}`]);
    expect(f.jobs[0]!.state).toBe('done');
  });

  it('reuses the session on the next run (resume) and switches on runtime change', async () => {
    const f = createFakes({ adapters: [createMockAdapter(), { ...createMockAdapter(), id: 'other' }] });
    const t = f.addTicket();
    const ex = createExecutor(f.ctx);
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    ex.tick();
    await ex.idle();
    const first = f.tickets.get(t.id)!.currentSessionId;

    f.ctx.queue.enqueue('run.reply', { ticketId: t.id, text: 'Thanks, carry on' });
    ex.tick();
    await ex.idle();
    expect(f.tickets.get(t.id)!.currentSessionId).toBe(first);
    expect(f.sessions.size).toBe(1);

    f.ctx.repos.tickets.update(t.id, { runtime: 'other' });
    f.ctx.queue.enqueue('run.reply', { ticketId: t.id, text: 'again' });
    ex.tick();
    await ex.idle();
    const now = f.tickets.get(t.id)!.currentSessionId!;
    expect(now).not.toBe(first);
    expect(f.sessions.get(now)!.reason).toBe('runtime_change');
    expect(f.sessions.get(first!)!.endedAt).not.toBeNull();
  });

  it('ask → needs_you "question for you"', async () => {
    const f = createFakes();
    const t = f.addTicket();
    f.ctx.queue.enqueue('run.reply', { ticketId: t.id, text: 'Please ask me what you need' });
    const ex = createExecutor(f.ctx);
    ex.tick();
    await ex.idle();
    expect(lastTransition(f, t.id)).toMatchObject({ to: 'needs_you', note: 'question for you' });
    expect(f.messages.some((m) => m.text.includes('Could you tell me'))).toBe(true);
  });

  it('proposal done → needs_you "ready for your review"; proposal blocked → blocked', async () => {
    const f = createFakes();
    const a = f.addTicket({ goal: 'we are done' });
    const b = f.addTicket({ goal: 'block this' });
    f.ctx.queue.enqueue('run.start', { ticketId: a.id });
    f.ctx.queue.enqueue('run.start', { ticketId: b.id });
    const ex = createExecutor(f.ctx);
    expect(ex.tick()).toBe(2);
    await ex.idle();
    expect(f.tickets.get(a.id)!.status).toBe('needs_you');
    expect(lastTransition(f, a.id)!.note).toBe('ready for your review');
    expect(f.tickets.get(b.id)!.status).toBe('blocked');
  });

  it('error → blocked, run failed', async () => {
    const f = createFakes();
    const t = f.addTicket({ goal: 'this will fail' });
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(f.ctx);
    ex.tick();
    await ex.idle();
    expect(f.tickets.get(t.id)!.status).toBe('blocked');
    expect([...f.runs.values()][0]!.status).toBe('failed');
    expect(f.audit.some((e) => e.kind === 'error')).toBe(true);
  });

  it('pending permission → needs_you "waiting for permission"', async () => {
    const f = createFakes();
    const t = f.addTicket();
    f.ctx.repos.permissions.create({ ticketId: t.id, runId: null, agentId: null, key: 'email.send', title: 'Send email', detail: 'to bob', provenance: null });
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(f.ctx);
    ex.tick();
    await ex.idle();
    expect(lastTransition(f, t.id)).toMatchObject({ to: 'needs_you', note: 'waiting for permission' });
  });

  it('budget reached → blocked without running', async () => {
    const f = createFakes();
    const t = f.addTicket({ costCapUsd: 1, costUsd: 1 });
    const agent = f.addAgent();
    const t2 = f.addTicket({ agentId: agent.id });
    f.agentSpend.set(agent.id, agent.monthlyBudgetUsd);
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    f.ctx.queue.enqueue('run.start', { ticketId: t2.id });
    const ex = createExecutor(f.ctx);
    ex.tick();
    await ex.idle();
    for (const id of [t.id, t2.id]) {
      expect(f.tickets.get(id)!.status).toBe('blocked');
      expect(lastTransition(f, id)!.note).toBe('Budget reached');
    }
    expect(f.runs.size).toBe(0);
    expect(f.jobs.every((j) => j.state === 'done')).toBe(true);
  });

  it('budgets set to warn only → runs anyway with no cost limit and a warning', async () => {
    const f = createFakes();
    (f.ctx as { settings?: unknown }).settings = { get: () => ({ budgetBlocks: false }), update: () => ({}) };
    const t = f.addTicket({ costCapUsd: 1, costUsd: 1 });
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(f.ctx);
    ex.tick();
    await ex.idle();
    expect(f.tickets.get(t.id)!.status).not.toBe('blocked');
    expect(f.runs.size).toBe(1);
    expect(f.ctx.repos.audit.listForTicket(t.id, { limit: 50 }).items.some((e) => e.summary.startsWith('Over budget'))).toBe(true);
  });

  it('one active run per ticket: second job is re-queued as "ticket busy"', async () => {
    const f = createFakes({ adapters: [createMockAdapter({ delayMs: 20 })] });
    const t = f.addTicket();
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    f.ctx.queue.enqueue('run.reply', { ticketId: t.id, text: 'more' });
    const ex = createExecutor(f.ctx);
    expect(ex.tick()).toBe(1);
    expect(f.failures).toHaveLength(1);
    expect(f.failures[0]!.error).toBe('ticket busy');
    expect(f.failures[0]!.retryAt!.getTime()).toBeGreaterThan(Date.now() + 1000);
    expect(f.jobs[1]!.state).toBe('queued');
    await ex.idle();
  });

  it('respects maxParallelRuns', async () => {
    const f = createFakes({ adapters: [createMockAdapter({ delayMs: 10 })], maxParallelRuns: 2 });
    for (let i = 0; i < 3; i++) f.ctx.queue.enqueue('run.start', { ticketId: f.addTicket().id });
    const ex = createExecutor(f.ctx);
    expect(ex.tick()).toBe(2);
    expect(f.ctx.queue.depth()).toBe(1);
    await ex.idle();
  });

  it('cancel aborts the active run → run cancelled, ticket needs_you', async () => {
    const f = createFakes({ adapters: [createMockAdapter({ delayMs: 200 })] });
    const t = f.addTicket();
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(f.ctx);
    ex.tick();
    expect(ex.cancel(t.id)).toBe(true);
    expect(ex.cancel('nope')).toBe(false);
    await ex.idle();
    expect([...f.runs.values()][0]!.status).toBe('cancelled');
    expect(lastTransition(f, t.id)).toMatchObject({ to: 'needs_you', note: 'stopped by you' });
  });

  it('records changed files from snapshots', async () => {
    const f = createFakes();
    const t = f.addTicket({ runtime: 'writer' });
    f.ctx.runtimes = { get: () => scripted('writer', async function* (r) {
      f.touch(r.cwd, 'report.md');
      yield { kind: 'done', costUsd: 0 };
    }), list: () => [] };
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(f.ctx);
    ex.tick();
    await ex.idle();
    const snapEvent = f.audit.find((e) => e.kind === 'snapshot');
    expect(snapEvent?.summary).toBe('Changed 1 file: report.md');
    expect([...f.runs.values()][0]).toMatchObject({ snapshotBefore: 'oid-1', snapshotAfter: 'oid-2' });
  });

  it('exceptions: audit, run failed, ticket blocked, transient retry with backoff; loop survives', async () => {
    const f = createFakes();
    const t = f.addTicket({ runtime: 'flaky' });
    f.ctx.runtimes = { get: () => scripted('flaky', async function* () {
      yield { kind: 'text', text: 'starting' };
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    }), list: () => [] };
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(f.ctx, { backoffMs: 1000 });
    ex.tick();
    await ex.idle();
    expect(f.tickets.get(t.id)!.status).toBe('blocked');
    expect([...f.runs.values()][0]!.status).toBe('failed');
    expect(f.audit.some((e) => e.kind === 'error' && e.summary.includes('database is locked'))).toBe(true);
    expect(f.failures[0]!.retryAt).toBeInstanceOf(Date);
    expect(f.jobs[0]!.state).toBe('queued');

    // Non-transient error: no retry.
    f.jobs[0]!.state = 'done';
    f.ctx.runtimes = { get: () => scripted('flaky', async function* () { throw new Error('boom'); }), list: () => [] };
    f.ctx.queue.enqueue('run.start', { ticketId: t.id });
    ex.tick();
    await ex.idle();
    expect(f.failures[1]!.retryAt).toBeUndefined();
  });

  it('heartbeat and permission prompts', async () => {
    const f = createFakes();
    const seen: string[] = [];
    f.ctx.runtimes = { get: () => scripted('spy', async function* (r) {
      seen.push(r.prompt);
      expect(r.systemPrompt).toContain('Sebeto rules');
      expect(r.mcp?.token).toMatch(/^token-/);
      yield { kind: 'done' };
    }), list: () => [] };
    const t = f.addTicket();
    const p = f.ctx.repos.permissions.create({ ticketId: t.id, runId: null, agentId: null, key: 'email.send', title: 'Send email', detail: 'to bob', provenance: null });
    f.ctx.repos.permissions.decide(p.id, 'allowed');
    f.ctx.queue.enqueue('run.heartbeat', { ticketId: t.id });
    const ex = createExecutor(f.ctx);
    ex.tick();
    await ex.idle();
    f.ctx.queue.enqueue('run.permission', { ticketId: t.id, permissionRequestId: p.id });
    ex.tick();
    await ex.idle();
    expect(seen[0]).toMatch(/^Check-in/);
    expect(seen[1]).toContain('allowed your permission request "Send email"');
  });
});

describe('test fakes', () => {
  it('queue claims by priority and honours runAfter', () => {
    const f = createFakes();
    f.ctx.queue.enqueue('run.heartbeat', { ticketId: 'a' }, { priority: 30 });
    f.ctx.queue.enqueue('run.reply', { ticketId: 'b' }, { priority: 0 });
    f.ctx.queue.enqueue('run.start', { ticketId: 'c' }, { priority: 0, runAfter: new Date(Date.now() + 60_000) });
    expect(f.ctx.queue.claim('w')?.payload.ticketId).toBe('b');
    expect(f.ctx.queue.claim('w')?.payload.ticketId).toBe('a');
    expect(f.ctx.queue.claim('w')).toBeUndefined();
  });
});

describe('decideFinalStatus / isTransientError', () => {
  const base = { isError: false, errors: [], question: null, proposal: null };
  it('rule table', () => {
    expect(decideFinalStatus(base, false, false)).toEqual(['needs_you', 'turn finished']);
    expect(decideFinalStatus({ ...base, errors: ['x'] }, false, true)).toEqual(['needs_you', 'waiting for permission']);
    expect(decideFinalStatus({ ...base, isError: true }, false, false)[0]).toBe('blocked');
  });
  it('transient detection', () => {
    expect(isTransientError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true);
    expect(isTransientError(new Error('boom'))).toBe(false);
  });
});
