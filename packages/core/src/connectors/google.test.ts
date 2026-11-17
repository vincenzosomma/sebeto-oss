import { describe, expect, it } from 'vitest';
import { MailError, MAIL_TEXT_MAX, type TokenSource } from './clients.js';
import { buildRawMessage, CALENDAR_API, createGoogleClients, GMAIL_API, googleClients, htmlToText } from './google.js';

// ------------------------------------------------------------------ fakes

interface Call { url: string; method: string; headers: Record<string, string>; body: string | undefined }
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | Error;
type Route = (url: URL, call: Call) => Reply | undefined;

function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input), method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) }, body: init?.body as string | undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const r = route(new URL(call.url), call);
      if (!r) continue;
      if (r instanceof Error) throw r;
      return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
        status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers },
      });
    }
    return new Response(JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.' } }), { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

function fakeTokens(list = ['tok-1', 'tok-2', 'tok-3']) {
  let i = 0;
  const state = { invalidated: 0, issued: 0 };
  const tokens: TokenSource = {
    getAccessToken: async () => { state.issued++; return list[Math.min(i, list.length - 1)] as string; },
    invalidate: () => { state.invalidated++; i++; },
  };
  return { tokens, state };
}

const sleeps: number[] = [];
const noSleep = async (ms: number) => { sleeps.push(ms); };
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function setup(routes: Route[], tokenList?: string[]) {
  const f = fakeFetch(routes);
  const t = fakeTokens(tokenList);
  sleeps.length = 0;
  const clients = googleClients(t.tokens, { fetchImpl: f.impl, sleep: noSleep });
  return { ...clients, calls: f.calls, tokenState: t.state };
}

const path = (u: URL) => u.origin + u.pathname;

// ------------------------------------------------------------------ Gmail JSON

const meta = (id: string, internalDate: string, from: string, subject: string, unread: boolean) => ({
  id, threadId: `t${id}`, labelIds: unread ? ['UNREAD', 'INBOX'] : ['SENT'], snippet: '...', internalDate,
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: from }, { name: 'To', value: 'Alex <alex@example.com>' },
      { name: 'Subject', value: subject }, { name: 'Date', value: 'Mon, 9 Nov 2026 10:00:00 +0100' },
    ],
  },
});

const fullMessage = {
  id: '18f0a1b2c3d4e5f6', threadId: '18f0a1b2c3d4e5f6', labelIds: ['INBOX'], internalDate: '1794300000000',
  payload: {
    partId: '', mimeType: 'multipart/mixed', filename: '',
    headers: [
      { name: 'From', value: 'NOC <noc@example.com>' }, { name: 'To', value: 'ops@example.com' },
      { name: 'Cc', value: 'Carla <carla@example.com>' }, { name: 'Subject', value: 'Certificato in scadenza: vpn.example.com' },
      { name: 'Date', value: 'Tue, 10 Nov 2026 08:00:00 +0100' }, { name: 'Content-Type', value: 'multipart/mixed; boundary="x"' },
    ],
    body: { size: 0 },
    parts: [
      {
        partId: '0', mimeType: 'multipart/alternative', filename: '', headers: [{ name: 'Content-Type', value: 'multipart/alternative; boundary="y"' }],
        body: { size: 0 },
        parts: [
          { partId: '0.0', mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="UTF-8"' }],
            body: { size: 60, data: b64u('Il certificato scade il 20/11.\r\nRinnovare entro venerdì.') } },
          { partId: '0.1', mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
            body: { size: 80, data: b64u('<p>HTML version</p>') } },
        ],
      },
      { partId: '1', mimeType: 'application/pdf', filename: 'cert-report.pdf',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="cert-report.pdf"' }],
        body: { size: 48213, attachmentId: 'ANGjdJ8' } },
    ],
  },
};

// ------------------------------------------------------------------ tests

describe('google client: Gmail', () => {
  it('exports a ProviderClientFactory', () => {
    const c = createGoogleClients(fakeTokens().tokens, { fetchImpl: fakeFetch([]).impl });
    expect(typeof c.mail.search).toBe('function');
    expect(typeof c.calendar.listEvents).toBe('function');
  });

  it('verify() reads the profile with the bearer token', async () => {
    const { mail, calls } = setup([(u) => (u.pathname.endsWith('/profile') ? { json: { emailAddress: 'alex@example.com', messagesTotal: 10 } } : undefined)]);
    await mail.verify();
    expect(calls[0]?.url).toBe(`${GMAIL_API}/profile`);
    expect(calls[0]?.headers.Authorization).toBe('Bearer tok-1');
  });

  it('search passes the Gmail query through, fetches metadata and sorts newest first', async () => {
    const { mail, calls } = setup([
      (u) => (path(u) === `${GMAIL_API}/messages` ? { json: { messages: [{ id: 'aaa111', threadId: 'x' }, { id: 'bbb222', threadId: 'y' }, { id: 'gone333' }], resultSizeEstimate: 3 } } : undefined),
      (u) => (u.pathname.endsWith('/messages/aaa111') ? { json: meta('aaa111', '1794200000000', 'Alice <alice@example.com>', 'Old', false) } : undefined),
      (u) => (u.pathname.endsWith('/messages/bbb222') ? { json: meta('bbb222', '1794300000000', 'Bob <bob@example.com>', '', true) } : undefined),
    ]);
    const out = await mail.search({ query: 'in:sent newer_than:7d', limit: 10 });
    const list = new URL(calls[0]!.url);
    expect(path(list)).toBe(`${GMAIL_API}/messages`);
    expect(list.searchParams.get('q')).toBe('in:sent newer_than:7d');
    expect(list.searchParams.get('maxResults')).toBe('10');
    const metaUrl = new URL(calls.find((c) => c.url.includes('/messages/aaa111'))!.url);
    expect(metaUrl.searchParams.get('format')).toBe('metadata');
    expect(metaUrl.searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Subject', 'Date']);
    expect(out).toEqual([
      { id: 'bbb222', from: 'Bob <bob@example.com>', to: 'Alex <alex@example.com>', subject: '(no subject)', date: new Date(1794300000000).toISOString(), unread: true },
      { id: 'aaa111', from: 'Alice <alice@example.com>', to: 'Alex <alex@example.com>', subject: 'Old', date: new Date(1794200000000).toISOString(), unread: false },
    ]);
  });

  it('search without query omits q and caps the limit at 25', async () => {
    const { mail, calls } = setup([(u) => (path(u) === `${GMAIL_API}/messages` ? { json: { resultSizeEstimate: 0 } } : undefined)]);
    expect(await mail.search({ limit: 500 })).toEqual([]);
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.has('q')).toBe(false);
    expect(u.searchParams.get('maxResults')).toBe('25');
  });

  it('search fetches metadata with at most 5 requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const impl = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (path(u) === `${GMAIL_API}/messages`) return new Response(JSON.stringify({ messages: ids.map((id) => ({ id })) }));
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const id = u.pathname.split('/').pop()!;
      return new Response(JSON.stringify(meta(id, String(1794000000000 + Number(id.slice(1))), 'x@example.com', id, false)));
    }) as typeof fetch;
    const { mail } = googleClients(fakeTokens().tokens, { fetchImpl: impl, sleep: noSleep });
    const out = await mail.search({ limit: 12 });
    expect(out).toHaveLength(12);
    expect(out[0]?.id).toBe('m11');
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it('read walks nested multipart/alternative, prefers text/plain and lists attachments', async () => {
    const { mail, calls } = setup([(u) => (u.pathname.endsWith('/messages/18f0a1b2c3d4e5f6') ? { json: fullMessage } : undefined)]);
    const m = await mail.read('18f0a1b2c3d4e5f6');
    expect(new URL(calls[0]!.url).searchParams.get('format')).toBe('full');
    expect(m).toEqual({
      id: '18f0a1b2c3d4e5f6', from: 'NOC <noc@example.com>', to: 'ops@example.com', cc: 'Carla <carla@example.com>',
      subject: 'Certificato in scadenza: vpn.example.com', date: new Date(1794300000000).toISOString(), unread: false,
      text: 'Il certificato scade il 20/11.\nRinnovare entro venerdì.', truncated: false,
      attachments: [{ filename: 'cert-report.pdf', contentType: 'application/pdf', size: 48213 }],
    });
  });

  it('read falls back to HTML converted to text (scripts and styles stripped)', async () => {
    const html = '<html><head><title>t</title><style>p{color:red}</style></head><body>'
      + '<script>alert("pwned")</script><h1>Incident INC-42</h1><p>Disk &amp; CPU at 95%&nbsp;on srv-01<br>Check <a href="https://status.example.com/inc/42">the status page</a></p>'
      + '<ul><li>Step one</li><li>Step two</li></ul><!-- hidden comment --></body></html>';
    const msg = {
      id: 'html1', labelIds: ['UNREAD'], internalDate: '1794300000000',
      payload: { mimeType: 'text/html', filename: '', headers: [{ name: 'Subject', value: 'HTML only' }, { name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: { size: html.length, data: b64u(html) } },
    };
    const { mail } = setup([(u) => (u.pathname.endsWith('/messages/html1') ? { json: msg } : undefined)]);
    const m = await mail.read('html1');
    expect(m?.unread).toBe(true);
    expect(m?.text).not.toContain('alert');
    expect(m?.text).not.toContain('color:red');
    expect(m?.text).not.toContain('hidden comment');
    expect(m?.text).not.toMatch(/<[a-z]/i);
    expect(m?.text).toBe('Incident INC-42\n\nDisk & CPU at 95% on srv-01\nCheck the status page (https://status.example.com/inc/42)\n\n- Step one\n- Step two');
  });

  it('read decodes non-UTF-8 charsets and truncates long bodies', async () => {
    const latin1 = Buffer.from('Caffè pronto', 'latin1').toString('base64url');
    const long = 'x'.repeat(MAIL_TEXT_MAX + 10);
    const { mail } = setup([
      (u) => (u.pathname.endsWith('/messages/l1') ? { json: { id: 'l1', payload: { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }], body: { data: latin1 } } } } : undefined),
      (u) => (u.pathname.endsWith('/messages/big') ? { json: { id: 'big', payload: { mimeType: 'text/plain', body: { data: b64u(long) } } } } : undefined),
    ]);
    expect((await mail.read('l1'))?.text).toBe('Caffè pronto');
    const big = await mail.read('big');
    expect(big?.text).toHaveLength(MAIL_TEXT_MAX);
    expect(big?.truncated).toBe(true);
  });

  it('read returns null on 404 and rejects malformed ids without calling Google', async () => {
    const { mail, calls } = setup([]);
    expect(await mail.read('doesnotexist')).toBeNull();
    await expect(mail.read('../profile')).rejects.toMatchObject({ code: 'invalid' });
    await expect(mail.read('a'.repeat(65))).rejects.toBeInstanceOf(MailError);
    expect(calls).toHaveLength(1);
  });

  it('send builds an RFC 5322 message with RFC 2047 subject, base64url raw', async () => {
    const { mail, calls } = setup([(u, c) => (path(u) === `${GMAIL_API}/messages/send` && c.method === 'POST' ? { json: { id: 'sent123', threadId: 't', labelIds: ['SENT'] } } : undefined)]);
    const subject = 'Rinnovo certificato – già fatto ✅';
    const res = await mail.send({ to: ['carla@example.com', 'José Núñez <jose@example.com>'], subject, text: 'Ciao,\nfatto.\nAlex' });
    expect(res).toEqual({ messageId: 'sent123' });
    const call = calls[0]!;
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers.Authorization).toBe('Bearer tok-1');
    const { raw } = JSON.parse(call.body!) as { raw: string };
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no + / =
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    const [head, body] = mime.split('\r\n\r\n') as [string, string];
    expect(head).toMatch(/^To: carla@example\.com, =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <jose@example\.com>\r\n/);
    expect(head).toContain('MIME-Version: 1.0');
    expect(head).toContain('Content-Type: text/plain; charset=utf-8');
    expect(head).toContain('Content-Transfer-Encoding: base64');
    expect(head).not.toMatch(/^From:/m);
    expect(mime).not.toContain('✅');
    // Decode the encoded words of the (possibly folded) Subject header.
    const subjLine = /Subject: ([\s\S]*?)\r\n(?! )/.exec(`${head}\r\n`)![1]!;
    for (const w of subjLine.split(/\r\n /)) expect(w.length).toBeLessThanOrEqual(75);
    const decoded = [...subjLine.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1]!, 'base64')).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)).toString('utf8');
    expect(decoded).toBe(subject);
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Ciao,\r\nfatto.\r\nAlex');
  });

  it('send keeps an ASCII subject as is', () => {
    const mime = Buffer.from(buildRawMessage({ to: ['a@example.com'], subject: 'Patch Tuesday', text: 'ok' }), 'base64url').toString('utf8');
    expect(mime).toContain('Subject: Patch Tuesday\r\n');
  });

  it('send rejects header injection and empty recipients without calling Google', async () => {
    const { mail, calls } = setup([]);
    await expect(mail.send({ to: ['a@example.com'], subject: 'Hi\r\nBcc: evil@example.com', text: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(mail.send({ to: ['a@example.com\nBcc: evil@example.com'], subject: 'Hi', text: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(mail.send({ to: [], subject: 'Hi', text: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(mail.send({ to: ['a@example.com, b@example.com'], subject: 'Hi', text: 'x' })).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toHaveLength(0);
  });
});

describe('google client: Calendar', () => {
  const events = {
    kind: 'calendar#events',
    items: [
      {
        id: 'ev1', status: 'confirmed', summary: 'Change window: firewall upgrade',
        description: '<b>Runbook</b>: <a href="https://wiki.example.com/fw">wiki</a><br>Rollback plan ready',
        location: 'Sala server, Napoli',
        start: { dateTime: '2026-11-12T22:00:00+01:00', timeZone: 'Europe/Rome' }, end: { dateTime: '2026-11-13T01:00:00+01:00' },
        organizer: { email: 'alex@example.com', displayName: 'Alex', self: true },
        attendees: [{ email: 'carla@example.com', displayName: 'Carla', responseStatus: 'accepted' }, { email: 'net@example.com' }],
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      },
      { id: 'ev2', status: 'confirmed', summary: 'Ferie', start: { date: '2026-11-14' }, end: { date: '2026-11-15' }, organizer: { email: 'alex@example.com' } },
      {
        id: 'ev3', status: 'confirmed', summary: 'Vendor call', start: { dateTime: '2026-11-13T15:00:00Z' }, end: { dateTime: '2026-11-13T15:30:00Z' },
        description: 'x'.repeat(3000),
        attendees: Array.from({ length: 60 }, (_, i) => ({ email: `p${i}@example.com` })),
        conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+39-02-1234' }, { entryPointType: 'video', uri: 'https://meet.google.com/xyz-abcd-efg' }] },
      },
      { id: 'ev4', status: 'cancelled' },
    ],
  };

  it('lists events from the primary calendar and maps them', async () => {
    const { calendar, calls } = setup([(u) => (path(u) === `${CALENDAR_API}/calendars/primary/events` ? { json: events } : undefined)]);
    const out = await calendar.listEvents({ from: '2026-11-12T00:00:00+01:00', to: '2026-11-16T00:00:00Z', limit: 20 });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('timeMin')).toBe('2026-11-11T23:00:00.000Z');
    expect(u.searchParams.get('timeMax')).toBe('2026-11-16T00:00:00.000Z');
    expect(u.searchParams.get('singleEvents')).toBe('true');
    expect(u.searchParams.get('orderBy')).toBe('startTime');
    expect(u.searchParams.get('maxResults')).toBe('20');
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      id: 'ev1', subject: 'Change window: firewall upgrade', start: '2026-11-12T22:00:00+01:00', end: '2026-11-13T01:00:00+01:00',
      allDay: false, location: 'Sala server, Napoli', organizer: 'Alex <alex@example.com>',
      attendees: ['Carla <carla@example.com>', 'net@example.com'],
      notes: 'Runbook: wiki (https://wiki.example.com/fw)\nRollback plan ready', joinUrl: 'https://meet.google.com/abc-defg-hij',
    });
    expect(out[1]).toMatchObject({ id: 'ev2', subject: 'Ferie', start: '2026-11-14', end: '2026-11-15', allDay: true, joinUrl: null, attendees: [], notes: '' });
    expect(out[2]?.joinUrl).toBe('https://meet.google.com/xyz-abcd-efg');
    expect(out[2]?.attendees).toHaveLength(50);
    expect(out[2]?.notes).toHaveLength(2000);
  });

  it('caps the limit at 50 and rejects bad dates', async () => {
    const { calendar, calls } = setup([() => ({ json: { items: [] } })]);
    await calendar.listEvents({ from: '2026-11-01', to: '2026-12-01', limit: 999 });
    expect(new URL(calls[0]!.url).searchParams.get('maxResults')).toBe('50');
    await expect(calendar.listEvents({ from: 'tomorrow', to: '2026-12-01', limit: 5 })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('google client: errors', () => {
  it('401: invalidates the token and retries once with a fresh one', async () => {
    const { mail, calls, tokenState } = setup([
      (_u, c) => (c.headers.Authorization === 'Bearer tok-1' ? { status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } } : undefined),
      () => ({ json: { emailAddress: 'alex@example.com' } }),
    ]);
    await mail.verify();
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(tokenState.invalidated).toBe(1);
  });

  it('401 twice: MailError auth, token never echoed', async () => {
    const { mail, calls, tokenState } = setup([() => ({ status: 401, json: { error: { code: 401, message: 'Invalid Credentials' } } })]);
    const err = await mail.verify().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err).toMatchObject({ code: 'auth' });
    expect((err as Error).message).toContain('Sign in again');
    expect((err as Error).message).not.toContain('tok-');
    expect(calls).toHaveLength(2);
    expect(tokenState.invalidated).toBe(2);
  });

  it('a TokenSource that needs sign-in propagates its MailError', async () => {
    const tokens: TokenSource = { getAccessToken: async () => { throw new MailError('Sign in again.', 'auth'); }, invalidate: () => undefined };
    const f = fakeFetch([]);
    const { mail } = googleClients(tokens, { fetchImpl: f.impl });
    await expect(mail.verify()).rejects.toMatchObject({ code: 'auth', message: 'Sign in again.' });
    expect(f.calls).toHaveLength(0);
  });

  it('403 insufficient permissions: MailError auth with Google\'s reason', async () => {
    const { mail, calls } = setup([() => ({ status: 403, json: { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } } })]);
    const err = await mail.send({ to: ['a@example.com'], subject: 's', text: 't' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'auth' });
    expect((err as Error).message).toContain('insufficient authentication scopes');
    expect(calls).toHaveLength(1);
  });

  it('403 rate limit: retries once, then MailError network', async () => {
    const { mail, calls } = setup([() => ({ status: 403, json: { error: { code: 403, message: 'User Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } } })]);
    await expect(mail.search({ limit: 5 })).rejects.toMatchObject({ code: 'network' });
    expect(calls).toHaveLength(2);
  });

  it('429: waits Retry-After (capped at 5 s) and retries once', async () => {
    let n = 0;
    const { calendar, calls } = setup([() => (n++ === 0 ? { status: 429, headers: { 'retry-after': '30' }, json: { error: { code: 429, message: 'Too many requests' } } } : { json: { items: [] } })]);
    expect(await calendar.listEvents({ from: '2026-11-10', to: '2026-11-11', limit: 5 })).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([5000]);
  });

  it('503 twice: MailError network', async () => {
    const { mail, calls } = setup([() => ({ status: 503, headers: { 'retry-after': '1' } })]);
    await expect(mail.verify()).rejects.toMatchObject({ code: 'network' });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('network failure: MailError network', async () => {
    const { mail } = setup([() => new TypeError('fetch failed')]);
    await expect(mail.verify()).rejects.toMatchObject({ code: 'network' });
  });

  it('other errors: MailError other with Google\'s message', async () => {
    const { mail } = setup([() => ({ status: 400, json: { error: { code: 400, message: 'Invalid query' } } })]);
    await expect(mail.search({ query: 'bad(', limit: 5 })).rejects.toMatchObject({ code: 'other', message: 'Google returned an error: Invalid query.' });
  });
});

describe('htmlToText', () => {
  it('handles entities, tables and unclosed scripts', () => {
    expect(htmlToText('<table><tr><td>Host</td><td>Status</td></tr><tr><td>srv&#45;01</td><td>&#x2713; ok</td></tr></table>'))
      .toBe('Host Status\nsrv-01 ✓ ok');
    expect(htmlToText('Hello<script>steal()')).toBe('Hello');
    expect(htmlToText('<a href="javascript:alert(1)">click</a>')).toBe('click');
  });
});
