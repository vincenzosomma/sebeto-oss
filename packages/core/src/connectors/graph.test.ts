import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIL_TEXT_MAX, MailError, type TokenSource } from './clients.js';
import { createGraphClients, formatAddress, GRAPH_BASE, parseMailQuery, searchParam } from './graph.js';

interface Call { method: string; url: URL; rawUrl: string; headers: Record<string, string>; body: unknown }
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | 'network-error';

/** Fake fetch: records every call and answers from a list of replies (in order). */
function fakeGraph(replies: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = String(input);
    calls.push({
      method: init?.method ?? 'GET',
      url: new URL(rawUrl),
      rawUrl,
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = replies.shift();
    if (!r) throw new Error(`unexpected call ${rawUrl}`);
    if (r === 'network-error') throw new TypeError('fetch failed');
    const status = r.status ?? 200;
    return new Response(r.json === undefined || status === 202 || status === 204 ? null : JSON.stringify(r.json), {
      status, headers: { 'content-type': 'application/json', ...r.headers },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function fakeTokens() {
  let n = 0;
  const t = { invalidated: 0, issued: [] as string[] };
  const source: TokenSource = {
    async getAccessToken() { const tok = `tok-${++n}-secretvalue`; t.issued.push(tok); return tok; },
    invalidate() { t.invalidated++; },
  };
  return { source, t };
}

const msg = (id: string, received: string, extra: Record<string, unknown> = {}) => ({
  id, subject: `Subject ${id}`, receivedDateTime: received, isRead: true,
  from: { emailAddress: { name: 'Gennaro Esposito', address: 'gennaro@contoso.com' } },
  toRecipients: [{ emailAddress: { name: 'IT Ops', address: 'itops@contoso.com' } }, { emailAddress: { name: 'me@contoso.com', address: 'me@contoso.com' } }],
  ...extra,
});

function setup(replies: Reply[]) {
  const g = fakeGraph(replies);
  const tk = fakeTokens();
  return { ...g, ...tk, clients: createGraphClients(tk.source, { fetchImpl: g.fetchImpl }) };
}

afterEach(() => { vi.useRealTimers(); });

describe('graph helpers', () => {
  it('formats addresses', () => {
    expect(formatAddress({ emailAddress: { name: 'A B', address: 'a@x.com' } })).toBe('A B <a@x.com>');
    expect(formatAddress({ emailAddress: { name: 'a@x.com', address: 'a@x.com' } })).toBe('a@x.com');
    expect(formatAddress({ emailAddress: { address: 'a@x.com' } })).toBe('a@x.com');
    expect(formatAddress(null)).toBe('');
  });

  it('maps Gmail-style hints', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(parseMailQuery('in:sent from:alice', now)).toEqual({ folder: 'sentitems', unread: null, kql: 'from:alice' });
    expect(parseMailQuery('is:unread', now)).toEqual({ folder: null, unread: true, kql: '' });
    expect(parseMailQuery('subject:"cert expiry" newer_than:7d has:attachment', now).kql)
      .toBe('subject:"cert expiry" received>=2026-11-03 hasattachments:true');
    expect(parseMailQuery(undefined, now)).toEqual({ folder: null, unread: null, kql: '' });
    expect(searchParam('subject:"a b" c\\d')).toBe('"subject:\\"a b\\" c\\\\d"');
  });
});

describe('graph mail', () => {
  it('verify calls /me with the bearer token', async () => {
    const s = setup([{ json: { mail: 'me@contoso.com', userPrincipalName: 'me@contoso.com', displayName: 'Me' } }]);
    await s.clients.mail.verify();
    expect(s.calls[0]!.url.pathname).toBe('/v1.0/me');
    expect(s.calls[0]!.url.searchParams.get('$select')).toBe('mail,userPrincipalName,displayName');
    expect(s.calls[0]!.headers.Authorization).toBe('Bearer tok-1-secretvalue');
  });

  it('search without query lists newest first with $orderby', async () => {
    const s = setup([{ json: { value: [
      msg('AAMk1', '2026-11-10T08:00:00Z', { isRead: false }),
      msg('AAMk2', '2026-11-09T08:00:00Z'),
    ] } }]);
    const res = await s.clients.mail.search({ limit: 100 });
    const c = s.calls[0]!;
    expect(c.rawUrl.startsWith(`${GRAPH_BASE}/me/messages?$top=25&`)).toBe(true);
    expect(c.url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    expect(c.url.searchParams.get('$select')).toBe('id,subject,from,toRecipients,receivedDateTime,isRead');
    expect(c.url.searchParams.has('$search')).toBe(false);
    expect(res).toEqual([
      { id: 'AAMk1', from: 'Gennaro Esposito <gennaro@contoso.com>', to: 'IT Ops <itops@contoso.com>, me@contoso.com', subject: 'Subject AAMk1', date: '2026-11-10T08:00:00.000Z', unread: true },
      { id: 'AAMk2', from: 'Gennaro Esposito <gennaro@contoso.com>', to: 'IT Ops <itops@contoso.com>, me@contoso.com', subject: 'Subject AAMk2', date: '2026-11-09T08:00:00.000Z', unread: false },
    ]);
  });

  it('search with a query uses $search, no $orderby, and sorts client-side', async () => {
    const s = setup([{ json: { value: [
      msg('old', '2026-10-01T08:00:00Z'),
      msg('new', '2026-11-10T08:00:00Z'),
      msg('mid', '2026-11-01T08:00:00Z'),
    ] } }]);
    const res = await s.clients.mail.search({ query: 'from:gennaro subject:"certificate expiry"', limit: 2 });
    const c = s.calls[0]!;
    expect(c.url.pathname).toBe('/v1.0/me/messages');
    expect(c.url.searchParams.get('$search')).toBe('"from:gennaro subject:\\"certificate expiry\\""');
    expect(c.url.searchParams.has('$orderby')).toBe(false);
    expect(c.url.searchParams.get('$top')).toBe('2');
    expect(c.headers.ConsistencyLevel).toBe('eventual');
    expect(res.map((m) => m.id)).toEqual(['new', 'mid']);
  });

  it('in:sent searches the Sent Items folder with the rest as $search', async () => {
    const s = setup([{ json: { value: [msg('s1', '2026-11-10T08:00:00Z')] } }]);
    await s.clients.mail.search({ query: 'in:sent to:vendor', limit: 5 });
    const c = s.calls[0]!;
    expect(c.url.pathname).toBe('/v1.0/me/mailFolders/sentitems/messages');
    expect(c.url.searchParams.get('$search')).toBe('"to:vendor"');
  });

  it('in:sent alone lists the folder by date', async () => {
    const s = setup([{ json: { value: [] } }]);
    await s.clients.mail.search({ query: 'in:sent', limit: 5 });
    expect(s.calls[0]!.url.pathname).toBe('/v1.0/me/mailFolders/sentitems/messages');
    expect(s.calls[0]!.url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
  });

  it('is:unread without text uses $filter; with text filters client-side', async () => {
    const s = setup([
      { json: { value: [msg('u1', '2026-11-10T08:00:00Z', { isRead: false })] } },
      { json: { value: [msg('r1', '2026-11-10T08:00:00Z'), msg('u2', '2026-11-09T08:00:00Z', { isRead: false })] } },
    ]);
    await s.clients.mail.search({ query: 'is:unread', limit: 10 });
    expect(s.calls[0]!.url.searchParams.get('$filter')).toBe('receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false');
    expect(s.calls[0]!.url.searchParams.get('$orderby')).toBe('receivedDateTime desc');
    const res = await s.clients.mail.search({ query: 'is:unread outage', limit: 10 });
    expect(s.calls[1]!.url.searchParams.get('$search')).toBe('"outage"');
    expect(s.calls[1]!.url.searchParams.has('$filter')).toBe(false);
    expect(res.map((m) => m.id)).toEqual(['u2']);
  });

  it('read returns text body, cc, attachments and truncates', async () => {
    const long = 'x'.repeat(MAIL_TEXT_MAX + 10);
    const s = setup([
      { json: { ...msg('AAMk/1+=', '2026-11-10T08:00:00Z'), ccRecipients: [{ emailAddress: { name: 'Ciro', address: 'ciro@contoso.com' } }], body: { contentType: 'text', content: long }, bodyPreview: 'x', hasAttachments: true } },
      { json: { value: [{ name: 'inventory.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 12345 }] } },
    ]);
    const m = await s.clients.mail.read('AAMk/1+=');
    expect(s.calls[0]!.rawUrl.startsWith(`${GRAPH_BASE}/me/messages/AAMk%2F1%2B%3D?$select=`)).toBe(true);
    expect(s.calls[0]!.url.searchParams.get('$select')).toContain('body,bodyPreview,hasAttachments');
    expect(s.calls[0]!.headers.Prefer).toBe('outlook.body-content-type="text"');
    expect(s.calls[1]!.url.pathname).toBe('/v1.0/me/messages/AAMk%2F1%2B%3D/attachments');
    expect(s.calls[1]!.url.searchParams.get('$select')).toBe('name,contentType,size');
    expect(m).toMatchObject({ id: 'AAMk/1+=', cc: 'Ciro <ciro@contoso.com>', truncated: true, attachments: [{ filename: 'inventory.xlsx', size: 12345 }] });
    expect(m!.text).toHaveLength(MAIL_TEXT_MAX);
  });

  it('read without attachments makes one call; HTML fallback is converted', async () => {
    const s = setup([{ json: { ...msg('a', '2026-11-10T08:00:00Z'), body: { contentType: 'html', content: '<p>Disk <b>full</b> on srv01</p><p>Tom &amp; Ciro</p>' }, hasAttachments: false } }]);
    const m = await s.clients.mail.read('a');
    expect(s.calls).toHaveLength(1);
    expect(m).toMatchObject({ text: 'Disk full on srv01\nTom & Ciro', truncated: false, attachments: [] });
  });

  it('read returns null on 404', async () => {
    const s = setup([{ status: 404, json: { error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' } } }]);
    expect(await s.clients.mail.read('missing')).toBeNull();
    await expect(s.clients.mail.read('  ')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('send posts the sendMail body', async () => {
    const s = setup([{ status: 202 }]);
    const r = await s.clients.mail.send({ to: ['a@contoso.com', ' b@fabrikam.com '], subject: 'Patch window', text: 'Tonight 22:00.' });
    const c = s.calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.rawUrl).toBe(`${GRAPH_BASE}/me/sendMail`);
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.body).toEqual({
      message: {
        subject: 'Patch window',
        body: { contentType: 'Text', content: 'Tonight 22:00.' },
        toRecipients: [{ emailAddress: { address: 'a@contoso.com' } }, { emailAddress: { address: 'b@fabrikam.com' } }],
      },
      saveToSentItems: true,
    });
    expect(r.messageId).toMatch(/^graph-\d+$/);
    await expect(s.clients.mail.send({ to: [], subject: 's', text: 't' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('graph calendar', () => {
  it('maps calendarView events (timed, all-day, Teams link, caps)', async () => {
    const attendees = Array.from({ length: 60 }, (_, i) => ({ emailAddress: { name: `Person ${i}`, address: `p${i}@contoso.com` }, type: 'required' }));
    const s = setup([{ json: { value: [
      {
        id: 'ev1', subject: 'CAB: firewall change', isAllDay: false,
        start: { dateTime: '2026-11-11T09:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-11-11T09:30:00.0000000', timeZone: 'UTC' },
        location: { displayName: 'Microsoft Teams Meeting' },
        organizer: { emailAddress: { name: 'Change Manager', address: 'cab@contoso.com' } },
        attendees, bodyPreview: 'n'.repeat(2500),
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' }, onlineMeetingUrl: null,
      },
      {
        id: 'ev2', subject: 'On-call week', isAllDay: true,
        start: { dateTime: '2026-11-12T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-11-13T00:00:00.0000000', timeZone: 'UTC' },
        location: { displayName: '' }, organizer: { emailAddress: { name: 'Me', address: 'me@outlook.com' } },
        attendees: [], bodyPreview: '', onlineMeeting: null, onlineMeetingUrl: 'https://legacy.example/join',
      },
    ] } }]);
    const evs = await s.clients.calendar.listEvents({ from: '2026-11-10T00:00:00Z', to: '2026-11-17T00:00:00Z', limit: 500 });
    const c = s.calls[0]!;
    expect(c.url.pathname).toBe('/v1.0/me/calendarView');
    expect(c.url.searchParams.get('startDateTime')).toBe('2026-11-10T00:00:00.000Z');
    expect(c.url.searchParams.get('endDateTime')).toBe('2026-11-17T00:00:00.000Z');
    expect(c.url.searchParams.get('$top')).toBe('50');
    expect(c.url.searchParams.get('$orderby')).toBe('start/dateTime');
    expect(c.url.searchParams.get('$select')).toContain('onlineMeeting,onlineMeetingUrl');
    expect(c.headers.Prefer).toBe('outlook.timezone="UTC"');
    expect(evs[0]).toMatchObject({
      id: 'ev1', start: '2026-11-11T09:00:00Z', end: '2026-11-11T09:30:00Z', allDay: false,
      location: 'Microsoft Teams Meeting', organizer: 'Change Manager <cab@contoso.com>',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
    });
    expect(evs[0]!.attendees).toHaveLength(50);
    expect(evs[0]!.attendees[0]).toBe('Person 0 <p0@contoso.com>');
    expect(evs[0]!.notes).toHaveLength(2000);
    expect(evs[1]).toMatchObject({ start: '2026-11-12', end: '2026-11-13', allDay: true, organizer: 'Me <me@outlook.com>', joinUrl: 'https://legacy.example/join', attendees: [] });
  });

  it('rejects bad dates', async () => {
    const s = setup([]);
    await expect(s.clients.calendar.listEvents({ from: 'nope', to: '2026-11-17', limit: 5 })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('graph errors', () => {
  it('401 invalidates the token and retries once with a fresh one', async () => {
    const s = setup([{ status: 401, json: { error: { code: 'InvalidAuthenticationToken', message: 'expired' } } }, { json: { value: [] } }]);
    expect(await s.clients.mail.search({ limit: 5 })).toEqual([]);
    expect(s.t.invalidated).toBe(1);
    expect(s.calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1-secretvalue', 'Bearer tok-2-secretvalue']);
  });

  it('401 twice → auth error without the token in the message', async () => {
    const s = setup([{ status: 401, json: {} }, { status: 401, json: {} }]);
    const err = await s.clients.mail.verify().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ code: 'auth', message: 'Microsoft refused the sign-in. Sign in again in Settings → Connectors.' });
    expect((err as Error).message).not.toContain('secretvalue');
    expect(s.calls).toHaveLength(2);
  });

  it('403 → auth error explaining the missing permission', async () => {
    const s = setup([{ status: 403, json: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } }]);
    await expect(s.clients.calendar.listEvents({ from: '2026-11-10', to: '2026-11-11', limit: 5 }))
      .rejects.toMatchObject({ code: 'auth', message: expect.stringMatching(/permission/) });
    expect(s.calls).toHaveLength(1);
  });

  it('429 waits Retry-After (capped at 5 s) and retries once', async () => {
    vi.useFakeTimers();
    const s = setup([{ status: 429, headers: { 'Retry-After': '3600' }, json: {} }, { json: { value: [] } }]);
    const p = s.clients.mail.search({ limit: 5 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual([]);
    expect(s.calls).toHaveLength(2);
  });

  it('503 twice → network error', async () => {
    const s = setup([{ status: 503, headers: { 'Retry-After': '0' }, json: {} }, { status: 503, json: {} }]);
    vi.useFakeTimers();
    const p = s.clients.mail.verify().catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ code: 'network' });
  });

  it('network failure → network error; other errors carry Graph message', async () => {
    const s = setup(['network-error', { status: 400, json: { error: { code: 'BadRequest', message: 'Syntax error in $search.' } } }]);
    await expect(s.clients.mail.verify()).rejects.toMatchObject({ code: 'network' });
    await expect(s.clients.mail.search({ query: 'bad(', limit: 5 })).rejects.toMatchObject({ code: 'other', message: 'Microsoft returned an error: Syntax error in $search.' });
  });

  it('a TokenSource auth failure is passed through', async () => {
    const g = fakeGraph([]);
    const clients = createGraphClients({ getAccessToken: async () => { throw new MailError('Sign in again.', 'auth'); }, invalidate: () => undefined }, { fetchImpl: g.fetchImpl });
    await expect(clients.mail.verify()).rejects.toMatchObject({ code: 'auth', message: 'Sign in again.' });
    expect(g.calls).toHaveLength(0);
  });
});
