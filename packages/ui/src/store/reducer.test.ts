import { describe, expect, it } from 'vitest';
import type { AuditEvent, Message, PermissionRequest, Run, Ticket, TicketDetail } from '@sebeto/shared';
import { initialState, reducer, undoableRun, pendingPermissionCount, ticketsIn, type AppState } from './reducer';

const ticket = (id: string, status: Ticket['status'], extra: Partial<Ticket> = {}): Ticket => ({
  id, number: 100, title: id, goal: '', status, agentId: null, runtime: null, model: null, currentSessionId: null,
  folder: '/tmp', costCapUsd: 2, costUsd: 0, parentId: null, dependsOn: [], createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z', ...extra,
});
const run = (id: string, startedAt: string, extra: Partial<Run> = {}): Run => ({
  id, sessionId: 's', ticketId: 'a', jobId: null, trigger: 'start', status: 'succeeded', startedAt, endedAt: startedAt,
  tokensIn: 0, tokensOut: 0, costUsd: 0, exitReason: null, snapshotBefore: 'oid', snapshotAfter: null, ...extra,
});
const detail = (t: Ticket, extra: Partial<TicketDetail> = {}): TicketDetail => ({
  ticket: t, messages: [], events: [], permissions: [], runs: [], ...extra,
});
const perm = (id: string, state: PermissionRequest['state']): PermissionRequest => ({
  id, ticketId: 'a', runId: null, agentId: null, key: 'email.send', title: 'Send', detail: '', provenance: null, command: null, state, alwaysAllowed: false, taskScoped: false,
  createdAt: '2026-01-01T00:00:00Z', decidedAt: null,
});

function loaded(): AppState {
  let s = initialState();
  s = reducer(s, { type: 'columnLoaded', status: 'backlog', page: { items: [ticket('a', 'backlog'), ticket('b', 'backlog')], nextCursor: 'c1' }, append: false });
  s = reducer(s, { type: 'columnLoaded', status: 'done', page: { items: [ticket('d', 'done')], nextCursor: null }, append: false });
  return s;
}

describe('reducer', () => {
  it('loads columns and keeps cursors', () => {
    const s = loaded();
    expect(s.columns.backlog.ids).toEqual(['a', 'b']);
    expect(s.columns.backlog.cursor).toBe('c1');
    expect(s.columns.done.ids).toEqual(['d']);
  });

  it('appends the next page without duplicates', () => {
    let s = loaded();
    s = reducer(s, { type: 'columnLoaded', status: 'backlog', page: { items: [ticket('b', 'backlog'), ticket('c', 'backlog')], nextCursor: null }, append: true });
    expect(s.columns.backlog.ids).toEqual(['a', 'b', 'c']);
    expect(s.columns.backlog.cursor).toBeNull();
  });

  it('moves a ticket between columns on ticket.updated', () => {
    let s = loaded();
    s = reducer(s, { type: 'ws', event: { type: 'ticket.updated', ticket: ticket('a', 'in_progress') } });
    expect(s.columns.backlog.ids).toEqual(['b']);
    expect(s.columns.in_progress.ids).toEqual(['a']);
    expect(ticketsIn(s, 'in_progress')[0]?.status).toBe('in_progress');
  });

  it('inserts unknown tickets at the top of their column', () => {
    let s = loaded();
    s = reducer(s, { type: 'ticketUpserted', ticket: ticket('z', 'backlog') });
    expect(s.columns.backlog.ids[0]).toBe('z');
  });

  it('removes deleted tickets and closes the panel', () => {
    let s = loaded();
    s = reducer(s, { type: 'select', id: 'a' });
    s = reducer(s, { type: 'ws', event: { type: 'ticket.deleted', ticketId: 'a' } });
    expect(s.columns.backlog.ids).toEqual(['b']);
    expect(s.tickets.a).toBeUndefined();
    expect(s.selectedId).toBeNull();
  });

  it('ignores stale detail responses', () => {
    let s = loaded();
    s = reducer(s, { type: 'select', id: 'b' });
    s = reducer(s, { type: 'detailLoaded', detail: detail(ticket('a', 'backlog')) });
    expect(s.detail).toBeNull();
  });

  it('applies live messages/events to the open ticket and dedupes by id', () => {
    let s = loaded();
    s = reducer(s, { type: 'select', id: 'a' });
    s = reducer(s, { type: 'detailLoaded', detail: detail(ticket('a', 'backlog')) });
    const m: Message = { id: 'm1', ticketId: 'a', runId: null, role: 'user', author: 'You', text: 'hi', createdAt: '2026-01-01T00:00:00Z' };
    s = reducer(s, { type: 'messageAdded', message: m });
    s = reducer(s, { type: 'ws', event: { type: 'message.created', message: m } });
    expect(s.detail?.messages).toHaveLength(1);
    const e: AuditEvent = { id: 'e1', ticketId: 'a', runId: null, kind: 'tool', summary: 'Read file', data: null, createdAt: '2026-01-01T00:00:00Z' };
    s = reducer(s, { type: 'ws', event: { type: 'event.created', event: e } });
    expect(s.detail?.events).toHaveLength(1);
    expect(s.activity.a?.summary).toBe('Read file');
  });

  it('records latest activity for tickets that are not open', () => {
    let s = loaded();
    const e: AuditEvent = { id: 'e2', ticketId: 'b', runId: null, kind: 'tool', summary: 'Scanned 86 hosts', data: null, createdAt: '2026-01-01T00:00:00Z' };
    s = reducer(s, { type: 'ws', event: { type: 'event.created', event: e } });
    expect(s.activity.b?.summary).toBe('Scanned 86 hosts');
    expect(s.detail).toBeNull();
  });

  it('seeds latest activity from loaded pages', () => {
    let s = initialState();
    const last = { summary: 'Patched 12 servers', at: '2026-01-02T10:00:00Z' };
    s = reducer(s, { type: 'columnLoaded', status: 'done', page: { items: [ticket('x', 'done', { lastActivity: last }), ticket('y', 'done', { lastActivity: null })], nextCursor: null }, append: false });
    expect(s.activity.x).toEqual(last);
    expect(s.activity.y).toBeUndefined();
  });

  it('keeps the known activity when ticket.updated arrives without (or with older) lastActivity', () => {
    let s = loaded();
    const e: AuditEvent = { id: 'e3', ticketId: 'a', runId: null, kind: 'tool', summary: 'Restarted the print spooler', data: null, createdAt: '2026-01-03T00:00:00Z' };
    s = reducer(s, { type: 'ws', event: { type: 'event.created', event: e } });
    s = reducer(s, { type: 'ws', event: { type: 'ticket.updated', ticket: ticket('a', 'in_progress') } });
    expect(s.activity.a).toEqual({ summary: 'Restarted the print spooler', at: '2026-01-03T00:00:00Z' });
    s = reducer(s, { type: 'ws', event: { type: 'ticket.updated', ticket: ticket('a', 'in_progress', { lastActivity: { summary: 'old', at: '2026-01-01T00:00:00Z' } }) } });
    expect(s.activity.a?.summary).toBe('Restarted the print spooler');
    s = reducer(s, { type: 'ws', event: { type: 'ticket.updated', ticket: ticket('a', 'in_progress', { lastActivity: { summary: 'newer', at: '2026-01-04T00:00:00Z' } }) } });
    expect(s.activity.a?.summary).toBe('newer');
  });

  it('tracks pending permissions per ticket', () => {
    let s = loaded();
    s = reducer(s, { type: 'ws', event: { type: 'permission.created', request: perm('p1', 'pending') } });
    expect(pendingPermissionCount(s, 'a')).toBe(1);
    s = reducer(s, { type: 'ws', event: { type: 'permission.updated', request: perm('p1', 'allowed') } });
    expect(pendingPermissionCount(s, 'a')).toBe(0);
  });

  it('upserts runs into the open detail', () => {
    let s = loaded();
    s = reducer(s, { type: 'select', id: 'a' });
    s = reducer(s, { type: 'detailLoaded', detail: detail(ticket('a', 'backlog'), { runs: [run('r1', '2026-01-01T00:00:00Z')] }) });
    s = reducer(s, { type: 'ws', event: { type: 'run.updated', run: run('r2', '2026-01-02T00:00:00Z', { status: 'running' }) } });
    s = reducer(s, { type: 'ws', event: { type: 'run.updated', run: run('r1', '2026-01-01T00:00:00Z', { status: 'failed' }) } });
    expect(s.detail?.runs.map((r) => `${r.id}:${r.status}`)).toEqual(['r2:running', 'r1:failed']);
  });
});

describe('undoableRun', () => {
  it('returns the latest finished run with a snapshot', () => {
    const runs = [
      run('old', '2026-01-01T00:00:00Z'),
      run('new', '2026-01-03T00:00:00Z', { snapshotBefore: null }),
      run('mid', '2026-01-02T00:00:00Z'),
    ];
    expect(undoableRun(runs)?.id).toBe('mid');
  });
  it('skips running runs and returns null when nothing qualifies', () => {
    expect(undoableRun([run('r', '2026-01-01T00:00:00Z', { status: 'running' })])).toBeNull();
    expect(undoableRun([])).toBeNull();
  });
});
