import { describe, expect, it } from 'vitest';
import { LOCKDOWN_MESSAGE, type WsEvent } from '@sebeto/shared';
import { ApiHttpError } from '../api/types';
import { MockApi } from '../api/mock';
import { initialState, reducer } from '../store/reducer';
import { EMPTY_FILTERS, filtersActive, isLockdownError, lockdownErrorKey, parseTicketNumber, toQuery } from './security';
import { translate } from '../i18n/catalog';

describe('security page helpers', () => {
  it('parses ticket numbers and builds the API query', () => {
    expect(parseTicketNumber('T-12')).toBe(12);
    expect(parseTicketNumber(' t12 ')).toBe(12);
    expect(parseTicketNumber('12')).toBe(12);
    expect(parseTicketNumber('abc')).toBeUndefined();
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(toQuery({ ...EMPTY_FILTERS, range: '24h', severity: 'warning,critical', ticket: 'T-7', q: '  vpn ' }, now)).toEqual({
      limit: 50, since: '2026-11-11T12:00:00.000Z', severity: 'warning,critical', ticketNumber: 7, q: 'vpn',
    });
    expect(toQuery({ ...EMPTY_FILTERS, range: 'all' }, now)).toEqual({ limit: 50 });
    expect(filtersActive(EMPTY_FILTERS)).toBe(false);
    expect(filtersActive({ ...EMPTY_FILTERS, agentId: 'a' })).toBe(true);
  });

  it('mock: list, filter, summary, verify, export, emergency stop + release', async () => {
    const api = new MockApi({ speed: 0 });
    const events: WsEvent[] = [];
    const stop = api.subscribe((e) => events.push(e));
    const page = await api.listSecurityEvents({ limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.items[0]!.seq).toBeGreaterThan(page.items[1]!.seq);
    const next = await api.listSecurityEvents({ limit: 5, cursor: page.nextCursor! });
    expect(next.items[0]!.seq).toBeLessThan(page.items[4]!.seq);
    expect((await api.listSecurityEvents({ category: 'permission' })).items.every((e) => e.category === 'permission')).toBe(true);
    const summary = await api.securitySummary();
    expect(summary.deniedPermissions).toBe(1);
    expect(summary.lockdown).toBe(false);
    expect((await api.verifySecurityLog()).ok).toBe(true);
    const csv = await api.exportSecurityLog('csv');
    expect(csv.fileName).toMatch(/\.csv$/);

    await expect(api.emergencyStop({ reason: 'x' })).rejects.toMatchObject({ status: 400 });
    const r = await api.emergencyStop({ reason: 'Unexpected emails' });
    expect(r.pausedAgents).toBeGreaterThan(0);
    expect((await api.listAgents()).every((a) => a.paused)).toBe(true);
    expect((await api.securityStatus()).active).toBe(true);
    expect(events.some((e) => e.type === 'security.lockdown' && e.active)).toBe(true);
    // The reducer turns the WS events into state.
    let state = initialState();
    for (const e of events) state = reducer(state, { type: 'ws', event: e });
    expect(state.lockdown).toBe(true);
    expect(state.versions['security.event']).toBeGreaterThan(0);

    await api.releaseLockdown();
    expect((await api.securityStatus()).active).toBe(false);
    expect((await api.listAgents()).every((a) => a.paused)).toBe(true); // agents stay paused
    stop();
  });

  it('v0.5 I: mock refuses wake-ups with 409 lockdown during the emergency stop; plain create and reads still work', async () => {
    const api = new MockApi({ speed: 0 });
    const ticket = (await api.listTickets({ status: 'backlog' })).items[0]!;
    await api.emergencyStop({ reason: 'Unexpected emails' });
    const lockdown = { status: 409, code: 'lockdown', message: LOCKDOWN_MESSAGE };
    await expect(api.startTicket(ticket.id)).rejects.toMatchObject(lockdown);
    await expect(api.postMessage(ticket.id, { text: 'go on' })).rejects.toMatchObject(lockdown);
    await expect(api.createTicket({ title: 'Stampante guasta', goal: 'x', start: true })).rejects.toMatchObject(lockdown);
    await expect(api.acceptIntake({ start: true, proposals: [{ key: 'a', title: 'x', goal: 'y', agentId: null, costCapUsd: 1, dependsOn: [] }] })).rejects.toMatchObject(lockdown);
    const refused = (await api.listSecurityEvents({ q: 'system.run_refused' })).items;
    expect(refused).toHaveLength(4);
    expect(refused.every((e) => e.category === 'system' && e.severity === 'warning' && typeof e.data?.['route'] === 'string')).toBe(true);
    expect((await api.createTicket({ title: 'Later', goal: 'x' })).status).toBe('backlog');
    expect((await api.getTicket(ticket.id)).ticket.id).toBe(ticket.id);
    await api.releaseLockdown();
    await expect(api.startTicket(ticket.id)).resolves.toBeUndefined();
  });

  it('v0.5 I: lockdown errors are recognised and shown in plain words (en + it)', () => {
    expect(isLockdownError(new ApiHttpError(409, 'lockdown', LOCKDOWN_MESSAGE))).toBe(true);
    expect(isLockdownError(LOCKDOWN_MESSAGE)).toBe(true);
    expect(isLockdownError(new ApiHttpError(409, 'scope_required', 'x'))).toBe(false);
    expect(isLockdownError(null)).toBe(false);
    const key = lockdownErrorKey(new ApiHttpError(409, 'lockdown', LOCKDOWN_MESSAGE))!;
    expect(translate('en', key)).toBe(LOCKDOWN_MESSAGE);
    expect(translate('it', key)).toMatch(/arresto di emergenza/i);
  });
});
