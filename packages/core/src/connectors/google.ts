/**
 * Google client: Gmail + Google Calendar over their REST APIs, for Google Workspace and personal
 * Gmail accounts signed in with OAuth (see clients.ts and docs/26 Microsoft & Google Connectors.md).
 *
 * - Plain `fetch`, `Authorization: Bearer <access token>` from a TokenSource. This module never sees
 *   refresh tokens or client secrets, and never logs or echoes the access token.
 * - Scopes it needs: gmail.readonly (search/read), gmail.send (send), calendar.readonly (events).
 * - Everything it returns is mailbox content: untrusted data for the agents (the tool server tags it).
 */
import {
  MAIL_SEARCH_MAX, MAIL_TEXT_MAX, MailError,
  type CalendarClient, type CalendarEvent, type MailClient, type MailMessage, type MailSummary,
  type ProviderClientFactory, type ProviderClients, type TokenSource,
} from './clients.js';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

const NOTES_MAX = 2_000;
const ATTENDEES_MAX = 50;
const EVENTS_MAX = 50;
const METADATA_CONCURRENCY = 5;
const RETRY_AFTER_MAX_MS = 5_000;
const RETRY_DEFAULT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const SIGN_IN_AGAIN = 'Google refused the sign-in. Sign in again in Settings → Connectors.';

export interface GoogleClientOptions {
  fetchImpl?: typeof fetch;
  /** Waits before a retry (tests replace it to avoid real delays). */
  sleep?: (ms: number) => Promise<void>;
}

// ------------------------------------------------------------------ HTTP

interface GoogleErrorBody { error?: { code?: number; message?: string; status?: string; errors?: Array<{ reason?: string }> } }

class HttpStatus extends Error {
  constructor(readonly status: number, readonly body: GoogleErrorBody | null) { super(`HTTP ${status}`); }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

function googleMessage(body: GoogleErrorBody | null): string {
  const msg = body?.error?.message?.replace(/\s+/g, ' ').trim() ?? '';
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

function reasons(body: GoogleErrorBody | null): string[] {
  return (body?.error?.errors ?? []).map((e) => e.reason ?? '').filter(Boolean);
}

function retryDelay(res: Response): number {
  const h = res.headers.get('retry-after');
  if (!h) return RETRY_DEFAULT_MS;
  const secs = Number(h);
  let ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

async function readError(res: Response): Promise<GoogleErrorBody | null> {
  try {
    return (await res.json()) as GoogleErrorBody;
  } catch {
    return null;
  }
}

type Request = (url: string, init?: { method?: string; json?: unknown; notFoundOk?: boolean }) => Promise<unknown>;

function createRequester(tokens: TokenSource, opts: GoogleClientOptions): Request {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function token(): Promise<string> {
    try {
      return await tokens.getAccessToken();
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError(SIGN_IN_AGAIN, 'auth');
    }
  }

  return async (url, init = {}) => {
    let refreshed = false;
    let retried = false;
    for (;;) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await token()}`, Accept: 'application/json' };
      if (init.json !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await doFetch(url, {
          method: init.method ?? 'GET', headers,
          body: init.json === undefined ? undefined : JSON.stringify(init.json),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new MailError('Could not reach Google. Check the internet connection.', 'network');
      }
      if (res.ok) {
        if (res.status === 204) return null;
        try {
          return await res.json();
        } catch {
          throw new MailError('Google sent an answer Sebeto could not read.', 'other');
        }
      }
      const body = await readError(res);
      if (res.status === 401) {
        tokens.invalidate();
        if (!refreshed) { refreshed = true; continue; }
        throw new MailError(SIGN_IN_AGAIN, 'auth');
      }
      const rateLimited = res.status === 429 || res.status === 503
        || (res.status === 403 && reasons(body).some((r) => RATE_REASONS.has(r)));
      if (rateLimited) {
        if (!retried) { retried = true; await sleep(retryDelay(res)); continue; }
        throw new MailError('Google is busy or rate-limiting Sebeto. Try again in a minute.', 'network');
      }
      if (res.status === 403) {
        const detail = googleMessage(body);
        throw new MailError(
          `Google refused this request: Sebeto does not have permission${detail ? ` (${detail})` : ''}. `
          + 'Sign in again in Settings → Connectors and allow access to Gmail and Google Calendar; '
          + 'on a Google Workspace account your administrator may have to allow it.',
          'auth',
        );
      }
      if (res.status === 404 && init.notFoundOk) throw new HttpStatus(404, body);
      const detail = googleMessage(body);
      throw new MailError(`Google returned an error${detail ? `: ${detail}` : ` (HTTP ${res.status})`}.`, 'other');
    }
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; keeps the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ------------------------------------------------------------------ text helpers

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷',
  laquo: '«', raquo: '»', shy: '', zwnj: '', zwj: '', agrave: 'à', aacute: 'á', egrave: 'è', eacute: 'é',
  igrave: 'ì', iacute: 'í', ograve: 'ò', oacute: 'ó', ugrave: 'ù', uacute: 'ú', ccedil: 'ç', ntilde: 'ñ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', Agrave: 'À', Egrave: 'È', Eacute: 'É', Ograve: 'Ò', Ugrave: 'Ù',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    return ENTITIES[ent] ?? ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/**
 * Small HTML → readable text converter (no DOM, no dependency). Drops scripts, styles and comments,
 * keeps line breaks for block elements, shows link targets, decodes entities. The result is plain
 * text only, never re-rendered as HTML.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/<(script|style|head|title|noscript|template|svg|object|iframe)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, h1?: string, h2?: string, h3?: string, inner = '') => {
        // Entities are decoded once, at the end, for the whole text.
        const href = (h1 ?? h2 ?? h3 ?? '').trim();
        const text = inner.replace(/<[^>]*>/g, '').trim();
        if (!/^(https?:|mailto:)/i.test(href) || /[<>]/.test(href)) return inner;
        const target = href.replace(/^mailto:/i, '');
        return decodeEntities(text) === decodeEntities(target) || !text ? ` ${target} ` : `${inner} (${target})`;
      })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/?(p|div|table|thead|tbody|ul|ol|h[1-6]|blockquote|pre|section|article|header|footer|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, '\t')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s).replace(/ /g, ' ');
  return s
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBody(data: string, charset: string): string {
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded words (UTF-8, base64), each at most 75 characters, folded onto new lines. */
function encodeWord(s: string): string {
  if (isAscii(s)) return s;
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    // 45 bytes of UTF-8 → 60 base64 characters + 12 for "=?UTF-8?B?" and "?=" = 72 ≤ 75.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** "Name <addr>" with a non-ASCII name → encoded name, address untouched. */
function encodeAddress(a: string): string {
  const m = /^\s*"?([^"<>]*?)"?\s*<([^<>]+)>\s*$/.exec(a);
  if (m && m[1] && !isAscii(m[1])) return `${encodeWord(m[1])} <${m[2]}>`;
  return a.trim();
}

/** Builds the RFC 5322 message Gmail sends (From is filled in by Gmail). */
export function buildRawMessage(m: { to: string[]; subject: string; text: string }): string {
  const to = m.to.map((t) => t.trim()).filter(Boolean);
  if (!to.length) throw new MailError('Add at least one recipient.', 'invalid');
  for (const t of [...to, m.subject]) {
    if (/[\r\n\0]/.test(t)) throw new MailError('Recipients and subject must be on one line.', 'invalid');
  }
  for (const t of to) {
    if (!/@/.test(t) || /[,;]/.test(t.replace(/"[^"]*"/g, ''))) throw new MailError(`"${t.slice(0, 100)}" is not a valid email address.`, 'invalid');
  }
  const body = Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
  const headers = [
    `To: ${to.map(encodeAddress).join(', ')}`,
    `Subject: ${encodeWord(m.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8').toString('base64url');
}

// ------------------------------------------------------------------ Gmail

interface GmailHeader { name?: string; value?: string }
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage { id?: string; labelIds?: string[]; internalDate?: string; payload?: GmailPart }

const header = (headers: GmailHeader[] | undefined, name: string): string =>
  (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? '';

function messageDate(msg: GmailMessage): string | null {
  const ms = Number(msg.internalDate);
  if (msg.internalDate && Number.isFinite(ms)) return new Date(ms).toISOString();
  const d = Date.parse(header(msg.payload?.headers, 'Date'));
  return Number.isFinite(d) ? new Date(d).toISOString() : null;
}

function summary(msg: GmailMessage, id: string): MailSummary {
  const h = msg.payload?.headers;
  return {
    id: msg.id ?? id,
    from: header(h, 'From'),
    to: header(h, 'To'),
    subject: header(h, 'Subject') || '(no subject)',
    date: messageDate(msg),
    unread: (msg.labelIds ?? []).includes('UNREAD'),
  };
}

function walkParts(root: GmailPart | undefined): { plain: string[]; html: string[]; attachments: MailMessage['attachments'] } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: MailMessage['attachments'] = [];
  const visit = (p: GmailPart, depth: number) => {
    if (depth > 30) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    const disposition = header(p.headers, 'Content-Disposition').toLowerCase();
    if (p.filename) {
      attachments.push({ filename: p.filename, contentType: p.mimeType || 'application/octet-stream', size: p.body?.size ?? 0 });
      return;
    }
    if (p.parts?.length) { for (const c of p.parts) visit(c, depth + 1); return; }
    if (disposition.startsWith('attachment') || !p.body?.data) return;
    const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(header(p.headers, 'Content-Type'))?.[1] ?? 'utf-8';
    if (mime === 'text/plain') plain.push(decodeBody(p.body.data, charset));
    else if (mime === 'text/html') html.push(decodeBody(p.body.data, charset));
  };
  if (root) visit(root, 0);
  return { plain, html, attachments };
}

function gmailClient(request: Request): MailClient {
  const fetchMessage = async (id: string, query: string): Promise<GmailMessage | null> => {
    try {
      return (await request(`${GMAIL_API}/messages/${encodeURIComponent(id)}?${query}`, { notFoundOk: true })) as GmailMessage;
    } catch (err) {
      if (err instanceof HttpStatus) return null;
      throw err;
    }
  };

  return {
    async verify() {
      const profile = (await request(`${GMAIL_API}/profile`)) as { emailAddress?: string } | null;
      if (!profile?.emailAddress) throw new MailError('Google did not return the Gmail address for this account.', 'other');
    },

    async search({ query, limit }) {
      const max = Math.min(Math.max(1, Math.floor(limit) || 1), MAIL_SEARCH_MAX);
      const params = new URLSearchParams({ maxResults: String(max) });
      const q = query?.trim();
      if (q) params.set('q', q);
      const list = (await request(`${GMAIL_API}/messages?${params}`)) as { messages?: Array<{ id?: string }> } | null;
      const ids = (list?.messages ?? []).map((m) => m.id ?? '').filter((id) => ID_RE.test(id)).slice(0, max);
      const meta = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';
      const found = await mapLimit(ids, METADATA_CONCURRENCY, async (id) => {
        const msg = await fetchMessage(id, meta);
        return msg ? summary(msg, id) : null; // deleted between the list and the fetch
      });
      return found
        .filter((m): m is MailSummary => m !== null)
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    },

    async read(id) {
      if (!ID_RE.test(id)) throw new MailError('Unknown email id. Use an id from search_email.', 'invalid');
      const msg = await fetchMessage(id, 'format=full');
      if (!msg) return null;
      const { plain, html, attachments } = walkParts(msg.payload);
      const full = (plain.length ? plain.join('\n\n') : html.map(htmlToText).join('\n\n')).replace(/\r\n/g, '\n').trim();
      return {
        ...summary(msg, id),
        cc: header(msg.payload?.headers, 'Cc'),
        text: full.slice(0, MAIL_TEXT_MAX),
        truncated: full.length > MAIL_TEXT_MAX,
        attachments,
      };
    },

    async send(m) {
      const raw = buildRawMessage(m);
      const res = (await request(`${GMAIL_API}/messages/send`, { method: 'POST', json: { raw } })) as { id?: string } | null;
      if (!res?.id) throw new MailError('Google did not confirm that the email was sent.', 'other');
      return { messageId: res.id };
    },
  };
}

// ------------------------------------------------------------------ Calendar

interface GPerson { email?: string; displayName?: string; resource?: boolean }
interface GEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: GPerson;
  attendees?: GPerson[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

const person = (p: GPerson | undefined): string => {
  if (!p) return '';
  const email = p.email ?? '';
  return p.displayName && p.displayName !== email ? `${p.displayName} <${email}>` : email;
};

const httpsUrl = (u: string | undefined): string | null => (u && /^https:\/\/\S+$/i.test(u) ? u : null);

function toEvent(e: GEvent): CalendarEvent {
  const allDay = !e.start?.dateTime && !!e.start?.date;
  const raw = e.description ?? '';
  const notes = (/<[a-z][^>]*>/i.test(raw) ? htmlToText(raw) : decodeEntities(raw)).trim();
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri;
  return {
    id: e.id ?? '',
    subject: e.summary?.trim() || '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    allDay,
    location: e.location?.trim() ?? '',
    organizer: person(e.organizer),
    attendees: (e.attendees ?? []).slice(0, ATTENDEES_MAX).map(person).filter(Boolean),
    notes: notes.slice(0, NOTES_MAX),
    joinUrl: httpsUrl(e.hangoutLink) ?? httpsUrl(video),
  };
}

function calendarClient(request: Request): CalendarClient {
  return {
    async listEvents({ from, to, limit }) {
      const start = Date.parse(from);
      const end = Date.parse(to);
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new MailError('Use ISO dates for the calendar range.', 'invalid');
      if (end <= start) return [];
      const max = Math.min(Math.max(1, Math.floor(limit) || 1), EVENTS_MAX);
      const params = new URLSearchParams({
        timeMin: new Date(start).toISOString(),
        timeMax: new Date(end).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(max),
      });
      const res = (await request(`${CALENDAR_API}/calendars/primary/events?${params}`)) as { items?: GEvent[] } | null;
      return (res?.items ?? [])
        .filter((e) => e.status !== 'cancelled' && e.id)
        .slice(0, max)
        .map(toEvent);
    },
  };
}

// ------------------------------------------------------------------ factory

export function googleClients(tokens: TokenSource, opts: GoogleClientOptions = {}): ProviderClients {
  const request = createRequester(tokens, opts);
  return { mail: gmailClient(request), calendar: calendarClient(request) };
}

export const createGoogleClients: ProviderClientFactory = googleClients;
