import { describe, expect, it } from 'vitest';
import type { Ticket } from '@sebeto/shared';
import { attentionEvents, snapshotForNotify } from './notify';

const t = (id: string, status: Ticket['status'], updatedAt = '1'): Ticket => ({
  id, number: Number(id.slice(1)), title: `Ticket ${id}`, goal: '', status, agentId: null, runtime: null, model: null,
  currentSessionId: null, folder: '', costCapUsd: 1, costUsd: 0, parentId: null, dependsOn: [], createdAt: '', updatedAt,
});

describe('attentionEvents', () => {
  it('first look records only; later moves into Needs you / Blocked are reported', () => {
    const a = { t1: t('t1', 'in_progress'), t2: t('t2', 'needs_you') };
    expect(attentionEvents(null, a, {})).toEqual([]);
    const prev = snapshotForNotify(a, {});
    const b = { t1: t('t1', 'needs_you', '2'), t2: t('t2', 'needs_you'), t3: t('t3', 'blocked') };
    const ev = attentionEvents(prev, b, {});
    expect(ev.map((e) => [e.ticketId, e.kind])).toEqual([['t1', 'needs_you']]); // t2 unchanged, t3 new (no previous status)
  });

  it('reports blocked and new permission requests; a permission replaces the matching needs_you', () => {
    const prev = snapshotForNotify({ t1: t('t1', 'in_progress'), t2: t('t2', 'in_progress') }, {});
    const now = { t1: t('t1', 'needs_you', '2'), t2: t('t2', 'blocked', '2') };
    const ev = attentionEvents(prev, now, { p1: 't1' }, { p1: 'Permission needed: send email' });
    expect(ev.map((e) => [e.ticketId, e.kind, e.detail])).toEqual([['t2', 'blocked', undefined], ['t1', 'permission', 'Permission needed: send email']]);
    // Already-known permissions are not repeated.
    expect(attentionEvents(snapshotForNotify(now, { p1: 't1' }), now, { p1: 't1' })).toEqual([]);
  });

  it('moving out of attention or to done is not reported', () => {
    const prev = snapshotForNotify({ t1: t('t1', 'needs_you') }, {});
    expect(attentionEvents(prev, { t1: t('t1', 'done', '2') }, {})).toEqual([]);
    expect(attentionEvents(prev, { t1: t('t1', 'in_progress', '2') }, {})).toEqual([]);
  });
});
