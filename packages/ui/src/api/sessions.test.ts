import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@sebeto/shared';
import { MockApi } from './mock';
import { HttpClient } from './client';
import { initialState, reducer } from '../store/reducer';

describe('session library (mock + client)', () => {
  it('mock: lists, filters, scans, edits, opens and removes, with sessions.changed events', async () => {
    const api = new MockApi({ speed: 0 });
    const events: WsEvent[] = [];
    api.subscribe((e) => events.push(e));
    const all = await api.listSessions();
    expect(all.items.length).toBeGreaterThanOrEqual(4);
    expect((await api.listSessions({ source: 'claude-code' })).items.every((e) => e.source === 'claude-code')).toBe(true);
    expect((await api.listSessions({ q: 'vpn profiles' })).items).toHaveLength(1);
    expect((await api.listSessions({ category: '-' })).items.every((e) => e.category === '')).toBe(true);
    const cats = await api.sessionCategories();
    expect(cats.reduce((n, c) => n + c.count, 0)).toBe(all.items.length);

    expect(await api.scanSessions()).toMatchObject({ added: 1 });
    expect(await api.scanSessions()).toMatchObject({ added: 0 });
    const outside = (await api.listSessions({ source: 'claude-code' })).items[0]!;
    const edited = await api.updateSession(outside.id, { category: 'Red Team', pinned: true });
    expect(edited).toMatchObject({ category: 'red-team', pinned: true });

    const opened = await api.openSession(outside.id);
    expect(opened.action).toBe('created');
    expect(opened.ticket.runtime).toBe('claude-cli');
    expect((await api.openSession(outside.id)).action).toBe('existing');

    const done = (await api.listSessions({ q: 'vpn profiles' })).items[0]!;
    expect(done.ticketId).not.toBeNull();
    expect(await api.openSession(done.id)).toMatchObject({ action: 'reopened', ticket: { status: 'needs_you' } });

    expect((await api.sessionTranscript(done.id, 1)).turns).toHaveLength(1);
    await api.deleteSession(done.id);
    expect((await api.listSessions({ q: 'vpn profiles' })).items).toHaveLength(0);
    expect(events.filter((e) => e.type === 'sessions.changed').length).toBeGreaterThanOrEqual(4);
  });

  it('client: builds the session URLs', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const client = new HttpClient({
      origin: 'http://core', token: () => 'tok',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
        return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('{"items":[],"nextCursor":null}', { status: 200 });
      },
    });
    await client.listSessions({ q: 'vpn cert', category: '-', source: 'claude-code', limit: 30 });
    await client.scanSessions();
    await client.sessionTranscript('a b', 10);
    await client.updateSession('id1', { pinned: true });
    await client.openSession('id1');
    await client.deleteSession('id1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://core/api/v1/sessions?q=vpn+cert&category=-&source=claude-code&limit=30',
      'POST http://core/api/v1/sessions/scan',
      'GET http://core/api/v1/sessions/a%20b/transcript?limit=10',
      'PATCH http://core/api/v1/sessions/id1',
      'POST http://core/api/v1/sessions/id1/open',
      'DELETE http://core/api/v1/sessions/id1',
    ]);
  });

  it('mock: suggest categories (rules preview, AI with a cost cap), apply, never over the owner\'s category (v0.5 K)', async () => {
    const api = new MockApi({ speed: 0 });
    await api.scanSessions();
    const before = (await api.listSessions({ category: '-' })).items;
    expect(before.length).toBeGreaterThan(1);
    const owned = before[0]!;
    await api.updateSession(owned.id, { category: 'mine' });
    const rules = await api.suggestSessionCategories({});
    expect(rules).toMatchObject({ mode: 'rules', dryRun: true, applied: 0, modelCalls: 0, costUsd: 0 });
    expect(rules.choices).toContain('general');
    expect(rules.suggestions.every((s) => s.source === 'rules' && rules.choices.includes(s.category) && s.entryId !== owned.id)).toBe(true);
    expect((await api.listSessions({ category: '-' })).items).toHaveLength(before.length - 1); // preview wrote nothing

    const ai = await api.suggestSessionCategories({ mode: 'ai', maxCostUsd: 0 });
    expect(ai).toMatchObject({ mode: 'ai', suggestions: [], costUsd: 0 });
    expect(ai.skipped.budget).toBe(ai.considered);
    const ai2 = await api.suggestSessionCategories({ mode: 'ai' });
    expect(ai2.suggestions.length).toBe(ai2.considered);
    expect(ai2.costUsd).toBeLessThanOrEqual(0.05);

    const res = await api.applySessionCategories({ items: [
      ...ai2.suggestions.map((s) => ({ id: s.entryId, category: s.category, source: s.source })),
      { id: owned.id, category: 'general', source: 'auto' as const },
    ] });
    expect(res).toEqual({ applied: ai2.suggestions.length, skipped: 1 });
    expect((await api.listSessions({ category: '-' })).items).toHaveLength(0);
    const after = (await api.listSessions()).items;
    expect(after.find((e) => e.id === owned.id)).toMatchObject({ category: 'mine', categorySource: 'owner' });
    expect(after.some((e) => e.categorySource === 'auto')).toBe(true);
  });

  it('client: suggest and apply categories URLs', async () => {
    const calls: string[] = [];
    const client = new HttpClient({
      origin: 'http://core', token: () => 'tok',
      fetchImpl: async (url, init) => { calls.push(`${init?.method} ${String(url)} ${String(init?.body)}`); return new Response('{}', { status: 200 }); },
    });
    await client.suggestSessionCategories({ mode: 'ai', maxCostUsd: 0.05 });
    await client.applySessionCategories({ items: [{ id: 'a', category: 'devops', source: 'auto' }] });
    expect(calls).toEqual([
      'POST http://core/api/v1/sessions/suggest-categories {"mode":"ai","maxCostUsd":0.05}',
      'POST http://core/api/v1/sessions/apply-categories {"items":[{"id":"a","category":"devops","source":"auto"}]}',
    ]);
  });

  it('store: the Sessions page and the sessions.changed version counter', () => {
    const s1 = reducer(initialState({ selectedId: 't1' }), { type: 'setPage', page: 'sessions' });
    expect(s1).toMatchObject({ page: 'sessions', selectedId: null });
    const s2 = reducer(s1, { type: 'ws', event: { type: 'sessions.changed' } });
    expect(s2.versions['sessions.changed']).toBe(1);
  });
});
