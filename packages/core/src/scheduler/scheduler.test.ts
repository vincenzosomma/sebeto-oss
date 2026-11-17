import { describe, expect, it } from 'vitest';
import { createFakes } from '../executor/testing/fakes.js';
import { createScheduler, requestStartWhenReady } from './scheduler.js';

const past = new Date(Date.now() - 60_000).toISOString();

/** A ticket in progress for an agent, with one finished run that started a minute ago. */
function setup() {
  const f = createFakes();
  const agent = f.addAgent({ heartbeatMinutes: 10 });
  const t = f.addTicket({ agentId: agent.id, status: 'in_progress' });
  const run = f.ctx.repos.runs.create({ sessionId: 's', ticketId: t.id, jobId: null, trigger: 'start' });
  f.runs.set(run.id, { ...run, status: 'succeeded', startedAt: past });
  let clock = 1_000_000;
  const sched = createScheduler(f.ctx, { now: () => clock });
  return { f, agent, t, run, sched, advance: (ms: number) => (clock += ms) };
}

describe('scheduler', () => {
  it('no work → no jobs (no model call)', () => {
    const { f, sched } = setup();
    expect(sched.tick()).toEqual({ heartbeats: [], starts: [] });
    expect(f.jobs).toHaveLength(0);
  });

  it('unseen user message → one heartbeat (priority 30, deduped), respects the interval', () => {
    const { f, t, sched, advance } = setup();
    f.ctx.repos.messages.create({ ticketId: t.id, role: 'user', author: 'You', text: 'any news?' });
    expect(sched.tick().heartbeats).toEqual([t.id]);
    expect(f.jobs[0]).toMatchObject({ kind: 'run.heartbeat', priority: 30 });
    // Not due again until heartbeatMinutes has passed.
    expect(sched.tick().heartbeats).toEqual([]);
    advance(10 * 60_000);
    sched.tick();
    expect(f.jobs).toHaveLength(1); // dedupeKey keeps a single queued heartbeat
  });

  it('dependency completed after the last run → heartbeat', () => {
    const { f, t, sched } = setup();
    const dep = f.addTicket({ status: 'in_progress' });
    f.ctx.repos.tickets.update(t.id, { dependsOn: [dep.id] });
    expect(sched.tick().heartbeats).toEqual([]);
    const s2 = createScheduler(f.ctx, { now: () => 0 });
    f.ctx.state.transition(dep.id, 'done', 'user');
    expect(s2.tick().heartbeats).toEqual([t.id]);
  });

  it('skips paused agents, tickets with an active run, and old messages', () => {
    const { f, agent, t, run, sched, advance } = setup();
    f.ctx.repos.messages.create({ ticketId: t.id, role: 'user', author: 'You', text: 'hi' });
    f.ctx.repos.agents.update(agent.id, { paused: true });
    expect(sched.tick().heartbeats).toEqual([]);
    f.ctx.repos.agents.update(agent.id, { paused: false });
    f.runs.set(run.id, { ...f.runs.get(run.id)!, status: 'running' });
    advance(10 * 60_000);
    expect(sched.tick().heartbeats).toEqual([]);
    // Run finished after the message: nothing new to do.
    f.runs.set(run.id, { ...f.runs.get(run.id)!, status: 'succeeded', startedAt: new Date(Date.now() + 1000).toISOString() });
    advance(10 * 60_000);
    expect(sched.tick().heartbeats).toEqual([]);
  });

  it('deferred start: backlog ticket starts when deps are done and start was requested', () => {
    const f = createFakes();
    const dep = f.addTicket({ status: 'in_progress' });
    const t = f.addTicket({ dependsOn: [dep.id] });
    const plain = f.addTicket({ dependsOn: [dep.id] }); // never explicitly started
    const sched = createScheduler(f.ctx);
    requestStartWhenReady(f.ctx, t.id);
    expect(sched.tick().starts).toEqual([]); // dep not done yet
    f.ctx.state.transition(dep.id, 'done', 'user');
    expect(sched.tick().starts).toEqual([t.id]);
    expect(f.jobs[0]).toMatchObject({ kind: 'run.start', priority: 10 });
    expect(f.jobs.some((j) => j.payload.ticketId === plain.id)).toBe(false);
  });

  it('prunes old finished jobs at most once per hour', () => {
    const { f, sched, advance } = setup();
    sched.tick();
    expect(f.prunes).toEqual([undefined]); // queue default retention (14 days)
    advance(30 * 60_000);
    sched.tick();
    expect(f.prunes).toHaveLength(1);
    advance(30 * 60_000);
    sched.tick();
    expect(f.prunes).toHaveLength(2);
  });

  it('start/stop do not throw', () => {
    const { sched } = setup();
    sched.start();
    sched.stop();
  });
});
