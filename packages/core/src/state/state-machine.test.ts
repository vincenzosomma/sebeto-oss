import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TICKET_STATUSES, uuidv7, type TicketStatus, type WsEvent } from '@sebeto/shared';
import type { Repos, StateMachine } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createEventBus } from '../bus/index.js';
import { InvalidTransitionError, canTransition, createStateMachine } from './index.js';

let dir: string;
let repos: Repos;
let sm: StateMachine;
let events: WsEvent[];

beforeEach(() => {
  dir = path.join(os.tmpdir(), `sebeto-state-${uuidv7()}`);
  ({ repos } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  const bus = createEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  sm = createStateMachine(repos, bus);
});

afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function ticketIn(status: TicketStatus) {
  const t = repos.tickets.create({ title: 'x', goal: 'y' });
  return status === 'backlog' ? t : repos.tickets.update(t.id, { status });
}

describe('canTransition', () => {
  it('user may move anything anywhere', () => {
    for (const from of TICKET_STATUSES) for (const to of TICKET_STATUSES) expect(canTransition(from, to, 'user')).toBe(true);
  });

  it('rule may move to working statuses, and to done only from needs_you', () => {
    expect(canTransition('backlog', 'in_progress', 'rule')).toBe(true);
    expect(canTransition('in_progress', 'needs_you', 'rule')).toBe(true);
    expect(canTransition('done', 'blocked', 'rule')).toBe(true);
    expect(canTransition('needs_you', 'done', 'rule')).toBe(true);
    expect(canTransition('in_progress', 'done', 'rule')).toBe(false);
    expect(canTransition('in_progress', 'backlog', 'rule')).toBe(false);
  });

  it('agent may only move between working statuses', () => {
    expect(canTransition('in_progress', 'blocked', 'agent')).toBe(true);
    expect(canTransition('needs_you', 'in_progress', 'agent')).toBe(true);
    expect(canTransition('in_progress', 'done', 'agent')).toBe(false);
    expect(canTransition('in_progress', 'backlog', 'agent')).toBe(false);
    expect(canTransition('backlog', 'in_progress', 'agent')).toBe(false);
    expect(canTransition('done', 'in_progress', 'agent')).toBe(false);
  });
});

describe('transition', () => {
  it('records the transition, an audit event and publishes ticket.updated', () => {
    const t = ticketIn('in_progress');
    const updated = sm.transition(t.id, 'needs_you', 'rule', { note: 'waiting for permission' });
    expect(updated.status).toBe('needs_you');
    expect(repos.tickets.get(t.id)!.status).toBe('needs_you');

    const [tr] = repos.transitions.listForTicket(t.id);
    expect(tr).toMatchObject({ from: 'in_progress', to: 'needs_you', cause: 'rule', note: 'waiting for permission', runId: null });

    const audit = repos.audit.listForTicket(t.id).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: 'status', summary: 'Moved to Needs you (rule): waiting for permission' });

    const ticketEvents = events.filter((e) => e.type === 'ticket.updated');
    expect(ticketEvents).toHaveLength(1);
    expect(ticketEvents[0]).toMatchObject({ ticket: { id: t.id, status: 'needs_you' } });
  });

  it('same-status transitions are no-ops', () => {
    const t = ticketIn('blocked');
    expect(sm.transition(t.id, 'blocked', 'agent').status).toBe('blocked');
    expect(repos.transitions.listForTicket(t.id)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('rejects forbidden transitions without side effects', () => {
    const t = ticketIn('in_progress');
    expect(() => sm.transition(t.id, 'done', 'agent')).toThrow(InvalidTransitionError);
    expect(() => sm.transition(t.id, 'backlog', 'agent')).toThrow(InvalidTransitionError);
    expect(() => sm.transition(t.id, 'done', 'rule')).toThrow(InvalidTransitionError);
    expect(repos.tickets.get(t.id)!.status).toBe('in_progress');
    expect(repos.transitions.listForTicket(t.id)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('user override and run id are recorded', () => {
    const t = ticketIn('backlog');
    const s = repos.sessions.create({ ticketId: t.id, agentId: null, runtime: 'mock', model: null, reason: 'new' });
    const r = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'start' });
    sm.transition(t.id, 'in_progress', 'rule', { runId: r.id });
    sm.transition(t.id, 'done', 'user');
    const trs = repos.transitions.listForTicket(t.id);
    expect(trs.map((x) => [x.from, x.to, x.cause])).toEqual([
      ['backlog', 'in_progress', 'rule'],
      ['in_progress', 'done', 'user'],
    ]);
    expect(trs[0]!.runId).toBe(r.id);
    expect(repos.audit.listForTicket(t.id).items.map((e) => e.summary)).toEqual([
      'Moved to In progress (rule)',
      'Moved to Completed (user)',
    ]);
  });

  it('throws for unknown tickets', () => {
    expect(() => sm.transition(uuidv7(), 'done', 'user')).toThrow(/not found/);
  });
});
