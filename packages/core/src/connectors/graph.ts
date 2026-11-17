/**
 * Microsoft Graph client for mail + calendar (Microsoft 365 work/school accounts and personal
 * Outlook.com / Hotmail accounts): see docs/26 Microsoft & Google Connectors.md.
 *
 * Plain HTTPS calls to https://graph.microsoft.com/v1.0 with a bearer token from a TokenSource.
 * The client never sees refresh tokens and never logs or echoes the access token.
 *
 * search() query mapping (agents are used to Gmail syntax, Graph speaks KQL):
 *  - `in:sent` searches the Sent Items folder, `in:inbox` the Inbox; otherwise all folders (/me/messages).
 *  - `is:unread` / `is:read`: without free text → `$filter=isRead eq …` (sorted by date on the server);
 *    with free text → filtered client-side after `$search` (Graph does not combine the two).
 *  - `has:attachment` → KQL `hasattachments:true`; `newer_than:7d` (d/m/y) → KQL `received>=YYYY-MM-DD`;
 *    `older_than:…` → `received<YYYY-MM-DD`.
 *  - Everything else (`from:alice`, `subject:invoice`, plain words, "quoted phrases") is passed
 *    through as KQL in `$search="…"`. `$search` cannot be combined with `$orderby`, so results are
 *    sorted newest first here.
 */
import { MAIL_SEARCH_MAX, MAIL_TEXT_MAX, MailError, type CalendarEvent, type MailMessage, type MailSummary, type ProviderClientFactory } from './clients.js';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const CAL_MAX = 50;
const ATTENDEES_MAX = 50;
const NOTES_MAX = 2_000;
const RETRY_AFTER_MAX_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;

const SUMMARY_FIELDS = 'id,subject,from,toRecipients,receivedDateTime,isRead';
const MESSAGE_FIELDS = `${SUMMARY_FIELDS},ccRecipients,body,bodyPreview,hasAttachments`;
const EVENT_FIELDS = 'id,subject,start,end,isAllDay,location,organizer,attendees,bodyPreview,onlineMeeting,onlineMeetingUrl';

const AUTH_MSG = 'Microsoft refused the sign-in. Sign in again in Settings → Connectors.';
const FORBIDDEN_MSG = 'Microsoft denied access: the sign-in is missing a permission (Mail.Read, Mail.Send or Calendars.Read), or your organisation blocks it. Sign in again in Settings → Connectors and accept all permissions, or ask your admin.';
const NETWORK_MSG = 'Could not reach Microsoft (Outlook). Check the internet connection and try again.';
const BUSY_MSG = 'Microsoft (Outlook) is busy or throttling requests. Try again in a minute.';

interface GraphAddress { emailAddress?: { name?: string | null; address?: string | null } | null }
interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: GraphAddress | null;
  toRecipients?: GraphAddress[] | null;
  ccRecipients?: GraphAddress[] | null;
  receivedDateTime?: string | null;
  isRead?: boolean | null;
  body?: { contentType?: string; content?: string | null } | null;
  bodyPreview?: string | null;
  hasAttachments?: boolean | null;
}
interface GraphDateTime { dateTime?: string | null; timeZone?: string | null }
interface GraphEvent {
  id: string;
  subject?: string | null;
  start?: GraphDateTime | null;
  end?: GraphDateTime | null;
  isAllDay?: boolean | null;
  location?: { displayName?: string | null } | null;
  organizer?: GraphAddress | null;
  attendees?: GraphAddress[] | null;
  bodyPreview?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  onlineMeetingUrl?: string | null;
}

/** Query string with literal `$` keys (Graph's OData options) and encoded values. */
function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** "Name <addr>", or just the address when there is no distinct name. */
export function formatAddress(a: GraphAddress | null | undefined): string {
  const name = a?.emailAddress?.name?.trim() ?? '';
  const address = a?.emailAddress?.address?.trim() ?? '';
  if (!address) return name;
  return name && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address;
}
const formatList = (list: GraphAddress[] | null | undefined): string => (list ?? []).map(formatAddress).filter(Boolean).join(', ');

function isoOrNull(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Crude HTML → text, used only if Graph ignores the "text body" preference. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const toSummary = (m: GraphMessage): MailSummary => ({
  id: m.id,
  from: formatAddress(m.from),
  to: formatList(m.toRecipients),
  subject: m.subject ?? '',
  date: isoOrNull(m.receivedDateTime),
  unread: m.isRead === false,
});

/** Graph returns UTC times as "2026-11-10T09:00:00.0000000" (timeZone "UTC") when asked for UTC. */
function eventTime(t: GraphDateTime | null | undefined, allDay: boolean): string {
  const raw = t?.dateTime ?? '';
  if (!raw) return '';
  if (allDay) return raw.slice(0, 10);
  const tz = (t?.timeZone ?? 'UTC').toUpperCase();
  if (tz === 'UTC' || tz === 'ETC/UTC' || tz === 'COORDINATED UNIVERSAL TIME') {
    const hasOffset = /(Z|[+-]\d\d:\d\d)$/.test(raw);
    const d = new Date(hasOffset ? raw : `${raw}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString().replace('.000Z', 'Z');
  }
  return raw;
}

const toEvent = (e: GraphEvent): CalendarEvent => {
  const allDay = e.isAllDay === true;
  return {
    id: e.id,
    subject: e.subject ?? '',
    start: eventTime(e.start, allDay),
    end: eventTime(e.end, allDay),
    allDay,
    location: e.location?.displayName ?? '',
    organizer: formatAddress(e.organizer),
    attendees: (e.attendees ?? []).map(formatAddress).filter(Boolean).slice(0, ATTENDEES_MAX),
    notes: (e.bodyPreview ?? '').slice(0, NOTES_MAX),
    joinUrl: e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || null,
  };
};

export interface ParsedQuery {
  folder: 'sentitems' | 'inbox' | null;
  unread: boolean | null;
  /** KQL for $search, or '' when there is no free text. */
  kql: string;
}

/** Map the Gmail-style hints we support to Graph (see the file header). */
export function parseMailQuery(query: string | undefined, now = new Date()): ParsedQuery {
  let folder: ParsedQuery['folder'] = null;
  let unread: boolean | null = null;
  const terms: string[] = [];
  // Tokens: key:"quoted value", "quoted phrase", or a run of non-space characters.
  const tokens = (query ?? '').match(/[^\s"]+:"[^"]*"|"[^"]*"|\S+/g) ?? [];
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower === 'in:sent' || lower === 'in:sentitems' || lower === 'label:sent') folder = 'sentitems';
    else if (lower === 'in:inbox' || lower === 'label:inbox') folder = 'inbox';
    else if (lower === 'in:anywhere' || lower === 'in:all') folder = null;
    else if (lower === 'is:unread') unread = true;
    else if (lower === 'is:read') unread = false;
    else if (lower === 'has:attachment' || lower === 'has:attachments') terms.push('hasattachments:true');
    else {
      const age = /^(newer|older)_than:(\d{1,4})([dmy])$/.exec(lower);
      if (age) {
        const d = new Date(now);
        const n = Number(age[2]);
        if (age[3] === 'd') d.setUTCDate(d.getUTCDate() - n);
        else if (age[3] === 'm') d.setUTCMonth(d.getUTCMonth() - n);
        else d.setUTCFullYear(d.getUTCFullYear() - n);
        terms.push(`received${age[1] === 'newer' ? '>=' : '<'}${d.toISOString().slice(0, 10)}`);
      } else {
        terms.push(tok);
      }
    }
  }
  return { folder, unread, kql: terms.join(' ') };
}

/** `$search` value: the whole KQL in double quotes; inner quotes and backslashes escaped. */
export const searchParam = (kql: string): string => `"${kql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const clamp = (n: number, max: number): number => Math.max(1, Math.min(max, Math.floor(Number.isFinite(n) ? n : max)));

function retryAfterMs(res: Response): number {
  const h = res.headers.get('retry-after');
  if (!h) return 1_000;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(RETRY_AFTER_MAX_MS, secs * 1000));
  const at = Date.parse(h);
  return Number.isNaN(at) ? 1_000 : Math.max(0, Math.min(RETRY_AFTER_MAX_MS, at - Date.now()));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function graphErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    return body.error?.message || body.error?.code || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export const createGraphClients: ProviderClientFactory = (tokens, opts) => {
  const fetchImpl = opts?.fetchImpl ?? fetch;

  async function token(): Promise<string> {
    try {
      return await tokens.getAccessToken();
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError(AUTH_MSG, 'auth');
    }
  }

  /**
   * One Graph call with the error policy: 401 → invalidate + retry once; 429/503 → wait Retry-After
   * (max 5 s) + retry once; 403 → auth; network failure → network. Returns null on 404 when allowed.
   */
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    o: { headers?: Record<string, string>; body?: unknown; allow404?: boolean } = {},
  ): Promise<T | null> {
    let authRetried = false;
    let throttleRetried = false;
    for (;;) {
      const headers: Record<string, string> = { Accept: 'application/json', ...o.headers, Authorization: `Bearer ${await token()}` };
      if (o.body !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await fetchImpl(`${GRAPH_BASE}${path}`, {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new MailError(NETWORK_MSG, 'network');
      }
      if (res.ok) {
        if (res.status === 202 || res.status === 204) return null;
        const text = await res.text();
        try {
          return (text ? JSON.parse(text) : null) as T | null;
        } catch {
          throw new MailError('Microsoft returned an unreadable response.', 'other');
        }
      }
      if (res.status === 401) {
        tokens.invalidate();
        if (!authRetried) { authRetried = true; continue; }
        throw new MailError(AUTH_MSG, 'auth');
      }
      if (res.status === 403) throw new MailError(FORBIDDEN_MSG, 'auth');
      if (res.status === 404 && o.allow404) return null;
      if (res.status === 429 || res.status === 503) {
        if (!throttleRetried) { throttleRetried = true; await sleep(retryAfterMs(res)); continue; }
        throw new MailError(BUSY_MSG, 'network');
      }
      throw new MailError(`Microsoft returned an error: ${await graphErrorMessage(res)}`, 'other');
    }
  }

  return {
    mail: {
      async verify() {
        await call('GET', `/me${qs({ $select: 'mail,userPrincipalName,displayName' })}`);
      },

      async search({ query, limit }) {
        const top = clamp(limit, MAIL_SEARCH_MAX);
        const q = parseMailQuery(query);
        const base = q.folder ? `/me/mailFolders/${q.folder}/messages` : '/me/messages';
        if (!q.kql) {
          // $filter + $orderby: Graph wants the ordered property in the filter too, and first.
          const filter = q.unread === null ? undefined : `receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq ${q.unread ? 'false' : 'true'}`;
          const data = await call<{ value?: GraphMessage[] }>('GET', `${base}${qs({ $top: top, $filter: filter, $orderby: 'receivedDateTime desc', $select: SUMMARY_FIELDS })}`);
          return (data?.value ?? []).slice(0, top).map(toSummary);
        }
        // With is:read/unread we filter after the search, so ask for more to still fill `top`.
        const fetchTop = q.unread === null ? top : Math.min(top * 4, 100);
        const data = await call<{ value?: GraphMessage[] }>(
          'GET',
          `${base}${qs({ $search: searchParam(q.kql), $top: fetchTop, $select: SUMMARY_FIELDS })}`,
          { headers: { ConsistencyLevel: 'eventual' } },
        );
        return (data?.value ?? [])
          .filter((m) => q.unread === null || (m.isRead === false) === q.unread)
          .map(toSummary)
          .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
          .slice(0, top);
      },

      async read(id) {
        if (typeof id !== 'string' || !id.trim()) throw new MailError('Unknown email id. Use an id from search_email.', 'invalid');
        const path = `/me/messages/${encodeURIComponent(id)}`;
        const m = await call<GraphMessage>('GET', `${path}${qs({ $select: MESSAGE_FIELDS })}`, {
          headers: { Prefer: 'outlook.body-content-type="text"' },
          allow404: true,
        });
        if (!m) return null;
        let attachments: MailMessage['attachments'] = [];
        if (m.hasAttachments) {
          const att = await call<{ value?: Array<{ name?: string | null; contentType?: string | null; size?: number | null }> }>(
            'GET', `${path}/attachments${qs({ $select: 'name,contentType,size' })}`, { allow404: true },
          );
          attachments = (att?.value ?? []).map((a) => ({ filename: a.name ?? '', contentType: a.contentType ?? '', size: a.size ?? 0 }));
        }
        const raw = m.body?.content ?? m.bodyPreview ?? '';
        const full = m.body?.contentType?.toLowerCase() === 'html' ? htmlToText(raw) : raw;
        return {
          ...toSummary(m),
          cc: formatList(m.ccRecipients),
          text: full.slice(0, MAIL_TEXT_MAX),
          truncated: full.length > MAIL_TEXT_MAX,
          attachments,
        };
      },

      async send({ to, subject, text }) {
        const recipients = to.map((t) => t.trim()).filter(Boolean);
        if (!recipients.length) throw new MailError('At least one recipient is needed.', 'invalid');
        await call('POST', '/me/sendMail', {
          body: {
            message: {
              subject,
              body: { contentType: 'Text', content: text },
              toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
            },
            saveToSentItems: true,
          },
        });
        // Graph's sendMail returns 202 with no body and no message id.
        return { messageId: `graph-${Date.now()}` };
      },
    },

    calendar: {
      async listEvents({ from, to, limit }) {
        const start = new Date(from);
        const end = new Date(to);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new MailError('Invalid date range for the calendar.', 'invalid');
        if (end <= start) return [];
        const top = clamp(limit, CAL_MAX);
        const data = await call<{ value?: GraphEvent[] }>(
          'GET',
          `/me/calendarView${qs({
            startDateTime: start.toISOString(),
            endDateTime: end.toISOString(),
            $top: top,
            $orderby: 'start/dateTime',
            $select: EVENT_FIELDS,
          })}`,
          { headers: { Prefer: 'outlook.timezone="UTC"' } },
        );
        return (data?.value ?? []).slice(0, top).map(toEvent);
      },
    },
  };
};
