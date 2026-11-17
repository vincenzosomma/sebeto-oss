/**
 * Built-in Slack connector: the Slack Web API with a bot token (xoxb-) or a user token (xoxp-).
 * See docs/37 Atlassian & Slack Connectors.md.
 *
 * Setting: SLACK_TOKEN (secret). A bot token sees only channels the app was invited to; message
 * search (search.messages) works only with a user token, because Slack does not allow it for bots.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BuiltinError, clip, json, run, type FetchLike } from './common.js';

export const SLACK_ENV = { token: 'SLACK_TOKEN', appToken: 'SLACK_APP_TOKEN' } as const;
const API = 'https://slack.com/api/';
const MAX_MESSAGES = 100;

export function slackToken(env: Record<string, string>): string {
  const token = (env[SLACK_ENV.token] ?? '').trim();
  if (!/^xox[bp]-[A-Za-z0-9-]+$/.test(token)) throw new BuiltinError('Enter a Slack bot token (xoxb-…) or user token (xoxp-…).');
  return token;
}

/** App-level token (xapp-) for Socket Mode (buttons in DMs). */
export function slackAppToken(env: Record<string, string>): string {
  const token = (env[SLACK_ENV.appToken] ?? '').trim();
  if (!/^xapp-[A-Za-z0-9-]+$/.test(token)) throw new BuiltinError('Enter a Slack app-level token (xapp-…).');
  return token;
}

const SLACK_ERRORS: Record<string, string> = {
  invalid_auth: 'Slack refused the token. Update the connector.',
  not_authed: 'Slack refused the token. Update the connector.',
  token_revoked: 'The Slack token was revoked. Update the connector.',
  token_expired: 'The Slack token expired. Update the connector.',
  account_inactive: 'The Slack app or user behind this token is deactivated.',
  missing_scope: 'The Slack token is missing a permission (scope) for this.',
  channel_not_found: 'Channel not found, or the Slack app was not invited to it (/invite @YourApp in the channel).',
  not_in_channel: 'The Slack app is not in that channel. Invite it first (/invite @YourApp).',
  is_archived: 'That channel is archived.',
  thread_not_found: 'Thread not found.',
  user_not_found: 'User not found.',
  not_allowed_token_type: 'This needs a user token (xoxp-); Slack does not allow it with a bot token.',
  msg_too_long: 'The message is too long for Slack.',
  ratelimited: 'Slack is rate limiting requests; try again in a minute.',
};

export type SlackCall = <T extends Record<string, unknown>>(method: string, params: Record<string, unknown>, opts?: { post?: boolean; signal?: AbortSignal }) => Promise<T>;

/** Minimal Slack Web API client. Exported so triggers can reuse it. */
export function slackClient(token: string, fetchImpl: FetchLike = fetch): SlackCall {
  return async (method, params, opts = {}) => {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
    let res: Response;
    try {
      res = opts.post
        ? await fetchImpl(API + method, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(params), ...(opts.signal ? { signal: opts.signal } : {}) })
        : await fetchImpl(`${API}${method}?${new URLSearchParams(clean)}`, { headers: { Authorization: `Bearer ${token}` }, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err;
      throw new BuiltinError('Could not reach Slack. Check the network.');
    }
    if (res.status === 429) throw new BuiltinError(`Slack is rate limiting requests; try again in ${res.headers.get('retry-after') ?? '60'} s.`);
    let body: { ok?: boolean; error?: string; needed?: string } & Record<string, unknown>;
    try { body = (await res.json()) as typeof body; } catch { throw new BuiltinError(`Slack sent an unexpected answer (HTTP ${res.status}).`); }
    if (!body.ok) {
      const e = body.error ?? 'unknown_error';
      throw new BuiltinError(`${SLACK_ERRORS[e] ?? `Slack said: ${e}.`}${e === 'missing_scope' && body.needed ? ` Needed: ${body.needed}.` : ''}`);
    }
    return body as never;
  };
}

interface SlackChannel { id: string; name?: string; is_private?: boolean; is_archived?: boolean; is_member?: boolean; num_members?: number; topic?: { value?: string }; purpose?: { value?: string } }
export interface SlackMessage { ts: string; user?: string; bot_id?: string; username?: string; subtype?: string; text?: string; thread_ts?: string; reply_count?: number; bot_profile?: { name?: string }; attachments?: Array<{ fallback?: string; title?: string; text?: string; title_link?: string; author_name?: string; from_url?: string; is_share?: boolean; is_msg_unfurl?: boolean }>; blocks?: unknown[] }

/** Readable text of a message, including bot attachments (Jira, monitoring alerts…). Exported for triggers. */
export function slackMessageText(m: SlackMessage): string {
  const parts = [m.text ?? ''];
  for (const a of m.attachments ?? []) {
    // A forwarded / shared message: say whose message it was (the person who needs help).
    if ((a.is_share || a.is_msg_unfurl) && a.author_name) parts.push(`Forwarded message from ${a.author_name}${a.from_url ? ` (${a.from_url})` : ''}:`);
    parts.push([a.title, a.title_link, a.text ?? a.fallback].filter(Boolean).join('\n'));
    parts.push(blocksText((a as { blocks?: unknown[] }).blocks));
  }
  parts.push(blocksText(m.blocks));
  // Apps often repeat the same words in text, attachments and blocks: keep each line once.
  const seen = new Set<string>();
  return parts.join('\n').split('\n').map((l) => l.trimEnd()).filter((l) => {
    const k = l.trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join('\n');
}

/** Text inside Block Kit blocks (section/header/context text, fields, rich text, link urls). */
function blocksText(blocks: unknown[] | undefined): string {
  const out: string[] = [];
  const walk = (n: unknown, depth: number): void => {
    if (!n || typeof n !== 'object' || depth > 8 || out.length > 200) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    const o = n as Record<string, unknown>;
    if (typeof o.text === 'string' && (o.type === 'mrkdwn' || o.type === 'plain_text' || o.type === 'text')) out.push(o.text);
    if (o.type === 'link' && typeof o.url === 'string') out.push(String(o.text ?? o.url));
    for (const k of ['text', 'fields', 'elements', 'accessory']) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
  };
  walk(blocks ?? [], 0);
  return out.join('\n');
}

/** Resolves "#name", "name" or an id (C…/G…/D…) to a channel id. Exported for triggers. */
export async function resolveChannel(call: SlackCall, channel: string, signal?: AbortSignal): Promise<{ id: string; name: string | null }> {
  const c = channel.trim().replace(/^#/, '');
  if (/^[CGD][A-Z0-9]{6,}$/.test(c)) return { id: c, name: null };
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await call<{ channels?: SlackChannel[]; response_metadata?: { next_cursor?: string } }>('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 1000, cursor }, { signal });
    const hit = (r.channels ?? []).find((x) => x.name === c.toLowerCase());
    if (hit) return { id: hit.id, name: hit.name ?? null };
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  throw new BuiltinError(`Channel "${channel}" not found, or the Slack app cannot see it.`);
}

const tsToIso = (ts: string) => new Date(Number(ts.split('.')[0]) * 1000).toISOString();

export function createSlackServer(env: Record<string, string>, opts: { fetchImpl?: FetchLike; version?: string } = {}): McpServer {
  const call = slackClient(slackToken(env), opts.fetchImpl ?? fetch);
  const server = new McpServer({ name: 'sebeto-slack', version: opts.version ?? '1.0.0' });
  const READ = { readOnlyHint: true, openWorldHint: true } as const;
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const names = new Map<string, string>();

  async function userName(id: string | undefined, signal?: AbortSignal): Promise<string | null> {
    if (!id) return null;
    if (names.has(id)) return names.get(id)!;
    try {
      const r = await call<{ user?: { real_name?: string; name?: string; profile?: { display_name?: string } } }>('users.info', { user: id }, { signal });
      const n = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || id;
      names.set(id, n);
      return n;
    } catch { return id; }
  }

  async function shape(msgs: SlackMessage[], signal?: AbortSignal) {
    const ids = [...new Set(msgs.map((m) => m.user).filter((x): x is string => !!x))].slice(0, 30);
    for (const id of ids) await userName(id, signal);
    return msgs.map((m) => ({
      ts: m.ts, time: tsToIso(m.ts),
      from: m.user ? names.get(m.user) ?? m.user : m.bot_profile?.name ?? m.username ?? (m.bot_id ? `bot ${m.bot_id}` : null),
      text: clip(slackMessageText(m), 4000),
      ...(m.thread_ts && m.thread_ts !== m.ts ? { thread_ts: m.thread_ts } : {}),
      ...(m.reply_count ? { replies: m.reply_count } : {}),
    }));
  }

  server.registerTool('slack_list_channels', {
    description: 'List Slack channels the token can see (id, name, members, whether the app is a member, topic).',
    inputSchema: {
      query: z.string().max(100).optional().describe('Only channels whose name contains this'),
      cursor: z.string().max(500).optional(),
    },
    annotations: READ,
  }, async ({ query, cursor }, extra) => run(async () => {
    const r = await call<{ channels?: SlackChannel[]; response_metadata?: { next_cursor?: string } }>('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 500, cursor }, { signal: extra.signal });
    const q = query?.replace(/^#/, '').toLowerCase();
    const channels = (r.channels ?? []).filter((c) => !q || (c.name ?? '').includes(q)).map((c) => ({
      id: c.id, name: c.name ?? null, private: !!c.is_private, member: !!c.is_member, members: c.num_members ?? null,
      topic: clip(c.topic?.value || c.purpose?.value || '', 200),
    }));
    return json({ channels, ...(r.response_metadata?.next_cursor ? { cursor: r.response_metadata.next_cursor } : {}) });
  }));

  server.registerTool('slack_read_channel', {
    description: 'Read recent messages of a channel (newest first). Thread replies are not included; use slack_read_thread with the message ts.',
    inputSchema: {
      channel: z.string().min(1).max(100).describe('"#name" or channel id'),
      limit: z.number().int().min(1).max(MAX_MESSAGES).optional().describe(`At most ${MAX_MESSAGES} (default 20)`),
      since_hours: z.number().min(0.1).max(24 * 90).optional().describe('Only messages from the last N hours'),
    },
    annotations: READ,
  }, async ({ channel, limit, since_hours }, extra) => run(async () => {
    const ch = await resolveChannel(call, channel, extra.signal);
    const oldest = since_hours ? String((Date.now() / 1000 - since_hours * 3600).toFixed(6)) : undefined;
    const r = await call<{ messages?: SlackMessage[]; has_more?: boolean }>('conversations.history', { channel: ch.id, limit: limit ?? 20, oldest }, { signal: extra.signal });
    return json({ channel: ch.name ?? ch.id, channel_id: ch.id, messages: await shape(r.messages ?? [], extra.signal), has_more: !!r.has_more });
  }));

  server.registerTool('slack_read_thread', {
    description: 'Read a message and its thread replies.',
    inputSchema: {
      channel: z.string().min(1).max(100).describe('"#name" or channel id'),
      thread_ts: z.string().regex(/^\d+\.\d+$/).describe('ts of the parent message'),
      limit: z.number().int().min(1).max(MAX_MESSAGES * 2).optional(),
    },
    annotations: READ,
  }, async ({ channel, thread_ts, limit }, extra) => run(async () => {
    const ch = await resolveChannel(call, channel, extra.signal);
    const r = await call<{ messages?: SlackMessage[] }>('conversations.replies', { channel: ch.id, ts: thread_ts, limit: limit ?? 50 }, { signal: extra.signal });
    return json({ channel: ch.name ?? ch.id, messages: await shape(r.messages ?? [], extra.signal) });
  }));

  server.registerTool('slack_search_messages', {
    description: 'Search Slack messages with Slack search syntax (e.g. "vpn in:#help-desk after:2026-11-01"). Needs a user token (xoxp-); bot tokens cannot search.',
    inputSchema: {
      query: z.string().min(1).max(500),
      count: z.number().int().min(1).max(MAX_MESSAGES).optional().describe('Default 20'),
    },
    annotations: READ,
  }, async ({ query, count }, extra) => run(async () => {
    const r = await call<{ messages?: { total?: number; matches?: Array<{ ts: string; text?: string; username?: string; user?: string; permalink?: string; channel?: { id?: string; name?: string } }> } }>('search.messages', { query, count: count ?? 20, sort: 'timestamp' }, { signal: extra.signal });
    return json({
      total: r.messages?.total ?? 0,
      matches: (r.messages?.matches ?? []).map((m) => ({ ts: m.ts, time: tsToIso(m.ts), channel: m.channel?.name ?? m.channel?.id ?? null, from: m.username ?? m.user ?? null, text: clip(m.text, 2000), link: m.permalink ?? null })),
    });
  }));

  server.registerTool('slack_get_user', {
    description: 'Look up a Slack user by id (name, title, email if the token may read it, time zone).',
    inputSchema: { user_id: z.string().regex(/^[UW][A-Z0-9]{6,}$/) },
    annotations: READ,
  }, async ({ user_id }, extra) => run(async () => {
    const r = await call<{ user?: { id: string; name?: string; real_name?: string; tz?: string; deleted?: boolean; is_bot?: boolean; profile?: { title?: string; email?: string; display_name?: string } } }>('users.info', { user: user_id }, { signal: extra.signal });
    const u = r.user;
    return json(u ? { id: u.id, name: u.profile?.display_name || u.real_name || u.name, title: u.profile?.title || null, email: u.profile?.email ?? null, tz: u.tz ?? null, deactivated: !!u.deleted, bot: !!u.is_bot } : null);
  }));

  server.registerTool('slack_post_message', {
    description: 'Post a message to a channel, or a reply in a thread (thread_ts). Slack mrkdwn is allowed.',
    inputSchema: {
      channel: z.string().min(1).max(100).describe('"#name" or channel id'),
      text: z.string().min(1).max(10_000),
      thread_ts: z.string().regex(/^\d+\.\d+$/).optional().describe('Reply in this thread'),
    },
    annotations: WRITE,
  }, async ({ channel, text, thread_ts }, extra) => run(async () => {
    const ch = await resolveChannel(call, channel, extra.signal);
    const r = await call<{ ts?: string; channel?: string }>('chat.postMessage', { channel: ch.id, text, thread_ts, unfurl_links: false }, { post: true, signal: extra.signal });
    let link: string | null = null;
    try { link = (await call<{ permalink?: string }>('chat.getPermalink', { channel: r.channel ?? ch.id, message_ts: r.ts ?? '' }, { signal: extra.signal })).permalink ?? null; } catch { /* optional */ }
    return json({ posted: true, channel: ch.name ?? ch.id, ts: r.ts ?? null, link });
  }));

  return server;
}
