import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS } from '@sebeto/shared';
import type { PermissionKey } from '@sebeto/shared';
import { createPermissionGate } from './index.js';
import { createFakes } from './test-fakes.js';

function setup(perms: Partial<Record<PermissionKey, 'allow' | 'ask' | 'never'>> = {}) {
  const f = createFakes();
  const gate = createPermissionGate({ repos: f.repos, state: f.state, queue: f.queue, bus: f.bus });
  const agent = f.addAgent({ permissions: { ...DEFAULT_PERMISSIONS, ...perms } });
  const ticket = f.addTicket('/tmp/x', { agentId: agent.id });
  const run = f.addRun(ticket.id);
  const base = { ticketId: ticket.id, runId: run.id, agentId: agent.id, title: 'Permission needed', detail: 'do it' };
  return { f, gate, agent, ticket, run, base };
}

describe('permission gate', () => {
  it('allow and never', () => {
    const { gate, base } = setup({ 'fs.write': 'allow', 'script.run': 'never' });
    expect(gate.check({ ...base, key: 'fs.write' })).toEqual({ outcome: 'allow' });
    const d = gate.check({ ...base, key: 'script.run' });
    expect(d.outcome).toBe('deny');
  });

  it('uses DEFAULT_PERMISSIONS when there is no agent', () => {
    const { gate, base } = setup();
    expect(gate.check({ ...base, agentId: null, key: 'fs.read' }).outcome).toBe('allow');
    expect(gate.check({ ...base, agentId: null, key: 'web.read' }).outcome).toBe('pending');
  });

  it('ask creates a request, publishes, audits, moves to needs_you; identical asks are deduped', () => {
    const { f, gate, base, ticket } = setup();
    const d1 = gate.check({ ...base, key: 'email.send', provenance: 'example.com' });
    expect(d1.outcome).toBe('pending');
    if (d1.outcome !== 'pending') return;
    expect(d1.request.provenance).toBe('example.com');
    expect(f.bus.events.some((e) => e.type === 'permission.created')).toBe(true);
    expect(f.audit.some((e) => e.kind === 'permission')).toBe(true);
    expect(f.state.calls).toEqual([{ ticketId: ticket.id, to: 'needs_you', cause: 'rule' }]);

    const d2 = gate.check({ ...base, key: 'email.send' });
    expect(d2.outcome === 'pending' && d2.request.id).toBe(d1.request.id);
    expect(f.permissions.size).toBe(1);
    // Different detail = different request.
    gate.check({ ...base, key: 'email.send', detail: 'other' });
    expect(f.permissions.size).toBe(2);
  });

  it('ignores invalid transitions when asking', () => {
    const { f, gate, base, ticket } = setup();
    f.tickets.set(ticket.id, { ...ticket, status: 'done' });
    expect(gate.check({ ...base, key: 'web.read' }).outcome).toBe('pending');
  });

  it('allow is consumed once', () => {
    const { f, gate, base } = setup();
    const d = gate.check({ ...base, key: 'web.read' });
    if (d.outcome !== 'pending') throw new Error('expected pending');
    gate.decide(d.request.id, 'allow');
    expect(gate.check({ ...base, key: 'web.read' })).toEqual({ outcome: 'allow' });
    expect(f.audit.some((e) => e.data?.consumed === true && e.data.requestId === d.request.id)).toBe(true);
    expect(f.repos.permissions.consumedAt(d.request.id)).toEqual(expect.any(String));
    // Second attempt asks again.
    const again = gate.check({ ...base, key: 'web.read' });
    expect(again.outcome).toBe('pending');
    expect(again.outcome === 'pending' && again.request.id).not.toBe(d.request.id);
  });

  it('"allow for this task" covers the whole ticket and is not consumed', () => {
    const { f, gate, base } = setup();
    const d = gate.check({ ...base, key: 'web.read' });
    if (d.outcome !== 'pending') throw new Error('expected pending');
    const decided = gate.decide(d.request.id, 'task');
    expect(decided.taskScoped).toBe(true);
    // Reused across many checks without a fresh prompt, and never consumed.
    expect(gate.check({ ...base, key: 'web.read' }).outcome).toBe('allow');
    expect(gate.check({ ...base, key: 'web.read' }).outcome).toBe('allow');
    expect(f.repos.permissions.consumedAt(d.request.id)).toBeNull();
    // A different detail is still a separate action and asks again.
    expect(gate.check({ ...base, key: 'web.read', detail: 'another page' }).outcome).toBe('pending');
    expect(f.audit.some((e) => e.summary?.includes('Allowed for this task'))).toBe(true);
  });

  it('refuses "allow for this task" on production changes (they must be approved each time)', () => {
    const { gate, base } = setup();
    const d = gate.check({ ...base, key: 'prod.change' });
    if (d.outcome !== 'pending') throw new Error('expected pending');
    expect(() => gate.decide(d.request.id, 'task')).toThrow(/each time/i);
  });

  it('consumption survives a new gate instance (stored on the request, not in memory)', () => {
    const { f, gate, base } = setup();
    const d = gate.check({ ...base, key: 'web.read' });
    if (d.outcome !== 'pending') throw new Error('expected pending');
    gate.decide(d.request.id, 'allow');
    expect(gate.check({ ...base, key: 'web.read' }).outcome).toBe('allow');
    const restarted = createPermissionGate({ repos: f.repos, state: f.state, queue: f.queue, bus: f.bus });
    expect(restarted.check({ ...base, key: 'web.read' }).outcome).toBe('pending');
  });

  it('deny applies within the run; a later run may ask again', () => {
    const { f, gate, base, ticket } = setup();
    const d = gate.check({ ...base, key: 'email.send' });
    if (d.outcome !== 'pending') throw new Error('expected pending');
    gate.decide(d.request.id, 'deny');
    expect(gate.check({ ...base, key: 'email.send' }).outcome).toBe('deny');
    const later = f.addRun(ticket.id);
    f.runs.set(later.id, { ...later, startedAt: new Date(Date.now() + 1000).toISOString() });
    expect(gate.check({ ...base, runId: later.id, key: 'email.send' }).outcome).toBe('pending');
  });

  it('ALWAYS_ASK keys are clamped to ask', () => {
    const { gate, base } = setup({ 'prod.change': 'allow' });
    expect(gate.check({ ...base, key: 'prod.change' }).outcome).toBe('pending');
  });

  it('untrusted input forces ask for outbound keys only', () => {
    const { gate, base } = setup({ 'email.send': 'allow', 'web.read': 'allow', 'fs.write': 'allow' });
    expect(gate.check({ ...base, key: 'email.send' }).outcome).toBe('allow');
    expect(gate.check({ ...base, key: 'email.send', untrustedInput: true }).outcome).toBe('pending');
    expect(gate.check({ ...base, key: 'web.read', untrustedInput: true }).outcome).toBe('allow');
    expect(gate.check({ ...base, key: 'fs.write', untrustedInput: true }).outcome).toBe('allow');
  });

  it('decide enqueues a run.permission job (allow and deny), publishes and is idempotent', () => {
    const { f, gate, base, ticket } = setup();
    const a = gate.check({ ...base, key: 'web.read', detail: 'a' });
    const b = gate.check({ ...base, key: 'web.read', detail: 'b' });
    if (a.outcome !== 'pending' || b.outcome !== 'pending') throw new Error('expected pending');
    const decided = gate.decide(a.request.id, 'allow');
    expect(decided.state).toBe('allowed');
    gate.decide(b.request.id, 'deny');
    expect(f.queue.jobs).toHaveLength(2);
    expect(f.queue.jobs[0]).toMatchObject({
      kind: 'run.permission', priority: 0, dedupeKey: `perm:${ticket.id}`,
      payload: { ticketId: ticket.id, permissionRequestId: a.request.id },
    });
    expect(f.bus.events.filter((e) => e.type === 'permission.updated')).toHaveLength(2);
    expect(gate.decide(a.request.id, 'allow').state).toBe('allowed');
    expect(() => gate.decide(a.request.id, 'deny')).toThrow();
    expect(() => gate.decide('missing', 'allow')).toThrow();
  });
});
