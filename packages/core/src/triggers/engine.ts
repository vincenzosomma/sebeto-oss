/**
 * Trigger engine: schedules and mail rules, driven by the scheduler tick (every 60 s).
 *
 * Schedules: `state.nextRunAt` is persisted BEFORE the ticket is created, so a restart never fires
 * the same occurrence twice. When the core was off at the due time: fire once on start when the
 * occurrence was missed by at most an hour, otherwise skip it (logged, 'ignored' fire row).
 * Several missed occurrences collapse into one.
 *
 * Mail rules: poll the connected mailbox every `pollMinutes` (never two polls at once), match
 * sender / subject / folder, one ticket per new email (dedupe on the message id). Emails older than
 * the moment the rule was created or turned on are never used. Without a mailbox: skip silently,
 * with one warning in the log.
 */
import { SLACK_TICKET_WAIT_MINUTES, SLACK_VIA_CLAUDE, nextRun, parseCron, type JiraTriggerConfig, type MailTriggerConfig, type SlackTriggerConfig } from '@sebeto/shared';
import type { AppContext, StoredTrigger, TriggerTicker } from '../contracts.js';
import type { MailClient, MailSummary } from '../connectors/mail.js';
import { fire, jiraIncoming, mailIncoming, recordOutcome, scheduleIncoming, slackGroupKey, slackIncoming, triggerRepo } from './service.js';
import { ATLASSIAN_SITE_SETTING } from '../connectors/catalog.js';
import { resolveChannel, slackClient, slackMessageText, slackToken, type SlackCall, type SlackMessage } from '../connectors/builtin/slack.js';
import type { FetchLike } from '../connectors/builtin/common.js';
import { claudeConnectorRead, claudeSlackCall } from '../connectors/builtin/slack-claude.js';
import { listClaudeConnectors, runClaudeOnce } from '../runtimes/claude-cli.js';
import path from 'node:path';

/** A missed schedule still fires on start when it was due at most this long ago. */
export const MISSED_GRACE_MS = 60 * 60_000;
/** Emails handled per rule per poll (the rest wait for the next poll). */
export const MAIL_PER_POLL = 10;
/** Slack messages handled per rule per poll (the rest wait for the next poll). */
export const SLACK_PER_POLL = 10;
/** Message subtypes that are real messages; joins, edits, deletions, topic changes… are ignored. */
const SLACK_MESSAGE_SUBTYPES = new Set([undefined, 'bot_message', 'file_share', 'thread_broadcast']);
const SEEN_MAX = 500;

export interface TriggerEngine extends TriggerTicker {
  /** Promise of the mail poll in progress (tests). */
  idle(): Promise<void>;
  /** Run one mail poll now for every due rule (tests / manual). */
  pollMail(now: Date): Promise<void>;
  /** Run one Slack poll now for every due channel rule (tests / manual). */
  pollSlack(now: Date): Promise<void>;
  /** Run one Jira poll now for every due JQL rule (tests / manual). */
  pollJira(now: Date): Promise<void>;
  /** Fire due schedules (sync part; ticket creation runs in the background). */
  runSchedules(now: Date): Promise<void>;
}

/** Gmail-style search text for a rule (Gmail / Google). Other providers get a plain word. */
export function mailQuery(cfg: MailTriggerConfig, provider: string | undefined, since: Date): string {
  const q = (s: string) => `"${s.replace(/["\\]/g, ' ').trim()}"`;
  if (provider === 'gmail' || provider === 'google') {
    const parts = [cfg.folder ? `in:${q(cfg.folder)}` : 'in:inbox'];
    if (cfg.from) parts.push(`from:${q(cfg.from)}`);
    if (cfg.subjectContains) parts.push(`subject:${q(cfg.subjectContains)}`);
    parts.push(`after:${Math.floor(since.getTime() / 1000)}`);
    return parts.join(' ');
  }
  return cfg.from || cfg.subjectContains || '';
}

/** Local filter (all providers): case-insensitive "contains" on sender and subject, date window, not seen. */
export function mailMatches(cfg: MailTriggerConfig, m: MailSummary, since: Date, seen: ReadonlySet<string>): boolean {
  if (seen.has(m.id)) return false;
  if (cfg.from && !m.from.toLowerCase().includes(cfg.from.toLowerCase())) return false;
  if (cfg.subjectContains && !m.subject.toLowerCase().includes(cfg.subjectContains.toLowerCase())) return false;
  if (!m.date || new Date(m.date).getTime() < since.getTime()) return false;
  return true;
}

/**
 * The ticket key a ticketing app posted in the thread, e.g. Jira Service Management's
 * "[<https://…/HELP-583|HELP-583>] …". Only replies from apps/bots count. Exported for tests.
 */
export function ticketKeyFromThread(replies: SlackMessage[], parentTs: string): { key: string; url: string | null } | null {
  for (const r of replies) {
    if (r.ts === parentTs || !(r.bot_id || r.subtype === 'bot_message')) continue;
    const text = slackMessageText(r);
    const linked = /<(https?:\/\/[^|>\s]+)\|([A-Z][A-Z0-9_]+-\d+)>/.exec(text);
    if (linked) return { key: linked[2]!, url: linked[1]! };
    const bare = /\b([A-Z][A-Z0-9_]+-\d+)\b/.exec(text);
    if (bare) return { key: bare[1]!, url: null };
  }
  return null;
}

export interface ParsedJiraIssue { key: string; summary: string; reporter: string; created: string; type: string; priority: string; description: string }

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const str = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' ? String((v as Record<string, unknown>).displayName ?? (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).value ?? '') : '');

/** Plain text of a description that may be markdown, or Atlassian Document Format. */
function richText(v: unknown): string {
  if (typeof v === 'string') return v;
  const walk = (n: unknown): string => {
    if (!n || typeof n !== 'object') return '';
    const o = n as { type?: string; text?: string; content?: unknown[] };
    if (o.type === 'text') return o.text ?? '';
    if (o.type === 'hardBreak') return '\n';
    const inner = (o.content ?? []).map(walk).join('');
    return o.type === 'paragraph' || o.type === 'heading' || o.type === 'listItem' ? `${inner}\n` : inner;
  };
  return walk(v).trim();
}

/**
 * Issues from the answer of Atlassian MCP's searchJiraIssuesUsingJql. Tolerant of its shape: JSON with
 * issues[] (fields nested or flat) anywhere in the object, or plain text from which only keys can be read.
 * Exported for tests.
 */
export function parseJiraSearch(text: string): ParsedJiraIssue[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = null; }
  const found: unknown[] = [];
  const hunt = (n: unknown, depth: number) => {
    if (!n || typeof n !== 'object' || depth > 5) return;
    if (Array.isArray(n)) { if (n.some((x) => x && typeof x === 'object' && ISSUE_KEY.test(String((x as Record<string, unknown>).key ?? '')))) found.push(...n); else for (const x of n) hunt(x, depth + 1); return; }
    for (const v of Object.values(n)) hunt(v, depth + 1);
  };
  hunt(data, 0);
  if (found.length) {
    return found.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && ISSUE_KEY.test(String((x as Record<string, unknown>).key ?? ''))).map((x) => {
      const f = (x.fields && typeof x.fields === 'object' ? x.fields : x) as Record<string, unknown>;
      return {
        key: String(x.key), summary: str(f.summary) || String(x.key), reporter: str(f.reporter) || 'unknown', created: str(f.created),
        type: str(f.issuetype ?? f.issueType ?? f.type), priority: str(f.priority), description: richText(f.description).slice(0, 5000),
      };
    });
  }
  // Not JSON: keep the keys in order of appearance (details come from the ticket itself later).
  const keys = [...new Set(text.match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) ?? [])];
  return keys.map((key) => ({ key, summary: key, reporter: 'unknown', created: '', type: '', priority: '', description: '' }));
}

/** Should this Slack message open a ticket? Exported for tests. */
/** A message link without the Slack API: <workspace>/archives/<channel>/p<ts without the dot>. Exported for tests. */
export function slackMessageLink(workspaceUrl: string | undefined, channelId: string, ts: string): string | null {
  const base = (workspaceUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com$/.test(base) || !/^\d+\.\d+$/.test(ts)) return null;
  return `${base}/archives/${channelId}/p${ts.replace('.', '')}`;
}

export function slackMatches(cfg: SlackTriggerConfig, m: SlackMessage, from: string, self: { userId: string | null; botId: string | null }, seen: ReadonlySet<string>): boolean {
  if (seen.has(m.ts)) return false;
  if (!SLACK_MESSAGE_SUBTYPES.has(m.subtype)) return false;
  if (m.thread_ts && m.thread_ts !== m.ts && m.subtype !== 'thread_broadcast') return false; // replies
  // Never react to what Sebeto itself posted with this token (no loops). Those posts carry the token's
  // user id; an incoming-webhook post from the same Slack app (e.g. a Jira Automation relay) has no user.
  if ((self.userId && m.user === self.userId) || (self.botId && m.bot_id === self.botId && m.user)) return false;
  const bot = !!m.bot_id || m.subtype === 'bot_message';
  if (bot && !cfg.includeBots) return false;
  if (cfg.fromContains && !from.toLowerCase().includes(cfg.fromContains.toLowerCase())) return false;
  if (cfg.textContains && !slackMessageText(m).toLowerCase().includes(cfg.textContains.toLowerCase())) return false;
  return true;
}

export function createTriggerEngine(ctx: AppContext, opts: { fetchImpl?: FetchLike; claudeSlack?: SlackCall; claudeRead?: (serverName: string) => (tool: string, args: Record<string, unknown>) => Promise<string> } = {}): TriggerEngine {
  /** Slack through the owner's Claude Slack connector (rules with connectorId "claude"), made on first use. */
  let viaClaude: SlackCall | null = opts.claudeSlack ?? null;
  const claudeSlack = (): SlackCall => (viaClaude ??= claudeSlackCall({
    exec: (args, stdin, timeoutMs) => runClaudeOnce(args, stdin, timeoutMs, { cwd: path.join(ctx.config.workspaceDir, 'tmp', 'claude-slack') }),
    otherServers: async () => (await listClaudeConnectors()).map((c) => c.name),
  }));
  /** Reads through any other Claude connector (Jira rules with connectorId "claude"), one per server. */
  const claudeReaders = new Map<string, (tool: string, args: Record<string, unknown>) => Promise<string>>();
  const claudeRead = (serverName: string) => {
    let r = claudeReaders.get(serverName);
    if (!r) {
      r = opts.claudeRead?.(serverName) ?? claudeConnectorRead({
        serverName,
        exec: (args, stdin, timeoutMs) => runClaudeOnce(args, stdin, timeoutMs, { cwd: path.join(ctx.config.workspaceDir, 'tmp', 'claude-slack') }),
        otherServers: async () => (await listClaudeConnectors()).map((c) => c.name),
      });
      claudeReaders.set(serverName, r);
    }
    return r;
  };
  async function claudeAtlassianServer(cfg: JiraTriggerConfig): Promise<string> {
    if (cfg.claudeServer) return cfg.claudeServer;
    const found = (await listClaudeConnectors()).find((c) => c.connected && /atlassian/i.test(c.name));
    if (!found) throw new Error('No connected Atlassian connector in Claude (claude mcp list). Connect it in Claude, or choose a Jira & Confluence connector.');
    return found.name;
  }
  let polling: Promise<void> | null = null;
  let slackPolling: Promise<void> | null = null;
  let jiraPolling: Promise<void> | null = null;
  /** Per connector: who the token is (auth.test), so Sebeto skips its own posts. */
  const slackSelf = new Map<string, { userId: string | null; botId: string | null }>();
  /** Per connector: user id → display name. */
  const slackNames = new Map<string, Map<string, string>>();
  let warnedNoMailbox = false;
  const pendingSchedules = new Set<Promise<unknown>>();

  const locked = () => !!ctx.securityLog?.lockdown();

  async function runSchedules(now: Date): Promise<void> {
    const repo = ctx.repos.triggers;
    if (!repo) return;
    for (const t of repo.list()) {
      if (t.kind !== 'schedule' || !t.enabled || t.config.kind !== 'schedule') continue;
      let spec;
      try {
        spec = parseCron(t.config.cron);
      } catch {
        continue; // validated on save; an old bad row is just skipped
      }
      const due = t.state.nextRunAt ? new Date(t.state.nextRunAt) : null;
      if (!due || Number.isNaN(due.getTime())) {
        repo.setState(t.id, { ...t.state, nextRunAt: nextRun(spec, now)?.toISOString() });
        continue;
      }
      if (now.getTime() < due.getTime()) continue;
      // Persist the next occurrence FIRST: a crash or restart after this never fires it again.
      const next = nextRun(spec, now);
      repo.setState(t.id, { ...t.state, nextRunAt: next?.toISOString() });
      if (locked()) {
        recordOutcome(ctx, t, 'ignored', 'skipped: the emergency stop is on');
        continue;
      }
      if (now.getTime() - due.getTime() > MISSED_GRACE_MS) {
        ctx.log.warn({ triggerId: t.id, due: due.toISOString() }, 'scheduled trigger missed while Sebeto was off; skipped');
        recordOutcome(ctx, t, 'ignored', `missed while Sebeto was off (due ${due.toISOString()})`);
        continue;
      }
      const p = fire(ctx, t.id, scheduleIncoming(t, due));
      pendingSchedules.add(p);
      void p.finally(() => pendingSchedules.delete(p));
    }
    await Promise.all([...pendingSchedules]);
  }

  async function pollRule(t: StoredTrigger, cfg: MailTriggerConfig, client: MailClient, provider: string | undefined, now: Date): Promise<void> {
    const repo = triggerRepo(ctx);
    const since = new Date(t.state.since ?? t.createdAt);
    const seen = new Set(t.state.seen ?? []);
    const found = await client.search({ query: mailQuery(cfg, provider, since), limit: 25 });
    const fresh = found.filter((m) => mailMatches(cfg, m, since, seen))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
      .slice(0, MAIL_PER_POLL);
    for (const m of fresh) {
      seen.add(m.id);
      if (repo.seenKey(t.id, `mail:${m.id}`)) continue;
      // Remember it before creating the ticket: a crash never turns one email into two tickets.
      repo.setState(t.id, { ...t.state, since: since.toISOString(), seen: [...seen].slice(-SEEN_MAX), lastPollAt: now.toISOString() });
      let text = '';
      try {
        text = (await client.read(m.id))?.text ?? '';
      } catch (err) {
        ctx.log.warn({ triggerId: t.id, err: (err as Error).message }, 'mail rule: could not read an email; using the headers only');
      }
      if (locked()) return;
      await fire(ctx, t.id, mailIncoming({ id: m.id, from: m.from, subject: m.subject, date: m.date, text }, now));
    }
    const latest = triggerRepo(ctx).get(t.id);
    if (latest) repo.setState(t.id, { ...latest.state, since: since.toISOString(), seen: [...seen].slice(-SEEN_MAX), lastPollAt: now.toISOString() });
  }

  async function pollMail(now: Date): Promise<void> {
    const repo = ctx.repos.triggers;
    if (!repo) return;
    const due = repo.list().filter((t): t is StoredTrigger & { config: MailTriggerConfig } => t.enabled && t.config.kind === 'mail'
      && (!t.state.lastPollAt || now.getTime() - new Date(t.state.lastPollAt).getTime() >= t.config.pollMinutes * 60_000 - 5_000));
    if (!due.length) return;
    const opened = ctx.mail ? await ctx.mail.open().catch(() => null) : null;
    if (!opened) {
      if (!warnedNoMailbox) ctx.log.warn({ rules: due.length }, 'mail rules are on but no mailbox is connected; skipping');
      warnedNoMailbox = true;
      return;
    }
    warnedNoMailbox = false;
    const st = ctx.mail?.status();
    const provider = st && st.connected ? st.provider : undefined;
    for (const t of due) {
      if (locked()) return;
      try {
        await pollRule(t, t.config, opened.client, provider, now);
      } catch (err) {
        ctx.log.warn({ triggerId: t.id, err: (err as Error).message }, 'mail rule poll failed');
        const latest = repo.get(t.id);
        if (latest) repo.setState(t.id, { ...latest.state, lastPollAt: now.toISOString() });
      }
    }
  }

  async function slackSender(connectorId: string, call: SlackCall, m: SlackMessage): Promise<string> {
    if (!m.user) return m.bot_profile?.name ?? m.username ?? (m.bot_id ? `app ${m.bot_id}` : 'unknown');
    let names = slackNames.get(connectorId);
    if (!names) slackNames.set(connectorId, (names = new Map()));
    if (names.has(m.user)) return names.get(m.user)!;
    let name = m.user;
    try {
      const r = await call<{ user?: { real_name?: string; name?: string; profile?: { display_name?: string; real_name?: string } } }>('users.info', { user: m.user });
      name = r.user?.profile?.real_name || r.user?.real_name || r.user?.profile?.display_name || r.user?.name || m.user;
    } catch { /* keep the id */ }
    if (names.size > 2000) names.clear();
    names.set(m.user, name);
    return name;
  }

  async function pollSlackRule(t: StoredTrigger, cfg: SlackTriggerConfig, now: Date): Promise<void> {
    const repo = triggerRepo(ctx);
    const claude = cfg.connectorId === SLACK_VIA_CLAUDE;
    if (!claude && !ctx.connectors) throw new Error('connectors are not available');
    const call = claude ? claudeSlack() : slackClient(slackToken(await ctx.connectors!.settingsFor(cfg.connectorId)), opts.fetchImpl ?? fetch);
    let self = slackSelf.get(cfg.connectorId);
    if (claude) self = { userId: null, botId: null };
    else if (!self) {
      const who = await call<{ user_id?: string; bot_id?: string }>('auth.test', {});
      self = { userId: who.user_id ?? null, botId: who.bot_id ?? null };
      slackSelf.set(cfg.connectorId, self);
    }
    // Through Claude: use the id as given (C…, G…, D…, or a user id U… for that DM).
    const ch = claude ? { id: cfg.channel.replace(/^#/, ''), name: null } : await resolveChannel(call, cfg.channel);
    if (claude && !/^[CGDU][A-Z0-9]{6,}$/.test(ch.id)) throw new Error('With the Claude Slack connector, use the channel id (C0123ABCD), not its name.');
    const cursor = t.state.cursor ?? (new Date(t.state.since ?? t.createdAt).getTime() / 1000).toFixed(6);
    const seen = new Set(t.state.seen ?? []);
    const r = await call<{ messages?: SlackMessage[] }>('conversations.history', { channel: ch.id, oldest: cursor, inclusive: false, limit: 100 });
    // Oldest first, so the cursor only ever moves forward over handled messages.
    const batch = (r.messages ?? []).filter((m) => Number(m.ts) > Number(cursor)).sort((a, b) => Number(a.ts) - Number(b.ts)).slice(0, SLACK_PER_POLL * 3);
    let newest = cursor;
    let created = 0;
    for (const m of batch) {
      if (created >= SLACK_PER_POLL) break;
      if (seen.has(m.ts)) { newest = m.ts; continue; }
      const from = await slackSender(cfg.connectorId, call, m);
      const match = slackMatches(cfg, m, from, self, seen);
      let issue: { key: string; url: string | null } | null = null;
      if (match && cfg.waitForTicket) {
        const r = await call<{ messages?: SlackMessage[] }>('conversations.replies', { channel: ch.id, ts: m.ts, limit: 20 });
        issue = ticketKeyFromThread(r.messages ?? [], m.ts);
        // No ticket yet: stop here and look again next poll (the cursor stays before this message).
        if (!issue && now.getTime() / 1000 - Number(m.ts) < SLACK_TICKET_WAIT_MINUTES * 60) break;
      }
      newest = m.ts;
      seen.add(m.ts);
      // Remember it before creating the ticket: a crash never turns one message into two tickets.
      const latest = repo.get(t.id) ?? t;
      repo.setState(t.id, { ...latest.state, cursor: newest, seen: [...seen].slice(-SEEN_MAX), lastPollAt: now.toISOString() });
      if (!match || (cfg.waitForTicket && !issue) || repo.seenKey(t.id, `slack:${ch.id}:${m.ts}`)) continue;
      if (locked()) return;
      let link: string | null = null;
      if (claude) link = slackMessageLink(cfg.workspaceUrl, ch.id, m.ts);
      else try { link = (await call<{ permalink?: string }>('chat.getPermalink', { channel: ch.id, message_ts: m.ts })).permalink ?? null; } catch { /* optional */ }
      const text = slackMessageText(m);
      await fire(ctx, t.id, slackIncoming({ channel: ch.name ?? cfg.channel.replace(/^#/, ''), channelId: ch.id, ts: m.ts, from, text, link, bot: !!m.bot_id, issue, groupKey: slackGroupKey(cfg.dedupeOn, text) }, now));
      created++;
    }
    const latest = repo.get(t.id);
    if (latest) repo.setState(t.id, { ...latest.state, cursor: newest, seen: [...seen].slice(-SEEN_MAX), lastPollAt: now.toISOString() });
  }

  async function pollSlack(now: Date): Promise<void> {
    const repo = ctx.repos.triggers;
    if (!repo) return;
    const due = repo.list().filter((t): t is StoredTrigger & { config: SlackTriggerConfig } => t.enabled && t.config.kind === 'slack'
      && (!t.state.lastPollAt || now.getTime() - new Date(t.state.lastPollAt).getTime() >= t.config.pollMinutes * 60_000 - 5_000));
    for (const t of due) {
      if (locked()) return;
      try {
        await pollSlackRule(t, t.config, now);
      } catch (err) {
        ctx.log.warn({ triggerId: t.id, err: (err as Error).message }, 'slack channel rule poll failed');
        const latest = repo.get(t.id);
        if (latest) repo.setState(t.id, { ...latest.state, lastPollAt: now.toISOString() });
      }
    }
  }

  async function pollJiraRule(t: StoredTrigger, cfg: JiraTriggerConfig, now: Date): Promise<void> {
    const repo = triggerRepo(ctx);
    const claude = cfg.connectorId === SLACK_VIA_CLAUDE;
    const hub = ctx.connectors;
    if (!claude && !hub) throw new Error('connectors are not available');
    const site = claude ? cfg.site : (await hub!.settingsFor(cfg.connectorId))[ATLASSIAN_SITE_SETTING];
    if (!site) throw new Error(claude ? 'the rule has no Atlassian address' : 'the Jira & Confluence connector has no Atlassian address; add it again');
    const since = new Date(t.state.since ?? t.createdAt);
    const seen = new Set(t.state.seen ?? []);
    // Relative window (minutes) avoids JQL time-zone surprises; the exact check is on "created" below.
    const minutes = Math.min(7 * 24 * 60, Math.ceil((now.getTime() - since.getTime()) / 60_000) + 5);
    // Atlassian's own MCP tool, called by Sebeto itself (not an agent): through the hub (token), or
    // through the owner's Claude Atlassian connector (one locked-down read, no token).
    const args = {
      cloudId: site, jql: `(${cfg.jql}) AND created >= -${minutes}m ORDER BY created ASC`, maxResults: 50,
      fields: ['summary', 'created', 'reporter', 'issuetype', 'priority', 'description'], responseContentFormat: 'markdown',
    };
    let res: { text: string; isError?: boolean };
    if (claude) {
      try { res = { text: await claudeRead(await claudeAtlassianServer(cfg))('searchJiraIssuesUsingJql', args) }; } catch (err) { throw new Error(`Jira search failed: ${(err as Error).message}`); }
    } else res = await hub!.call(cfg.connectorId, 'searchJiraIssuesUsingJql', args);
    if (res.isError) throw new Error(`Jira search failed: ${res.text.slice(0, 300)}`);
    const fresh = parseJiraSearch(res.text)
      .filter((i) => !seen.has(i.key) && (!i.created || new Date(i.created).getTime() >= since.getTime()))
      .slice(0, MAIL_PER_POLL);
    for (const i of fresh) {
      seen.add(i.key);
      const latest = repo.get(t.id) ?? t;
      repo.setState(t.id, { ...latest.state, since: since.toISOString(), seen: [...seen].slice(-SEEN_MAX), lastPollAt: now.toISOString() });
      if (repo.seenKey(t.id, `jira:${i.key}`)) continue;
      if (locked()) return;
      await fire(ctx, t.id, jiraIncoming({ ...i, url: `https://${site}/browse/${i.key}`, channel: '' }, now));
    }
    const latest = repo.get(t.id);
    if (latest) repo.setState(t.id, { ...latest.state, since: since.toISOString(), seen: [...seen].slice(-SEEN_MAX), lastPollAt: now.toISOString() });
  }

  async function pollJira(now: Date): Promise<void> {
    const repo = ctx.repos.triggers;
    if (!repo) return;
    const due = repo.list().filter((t): t is StoredTrigger & { config: JiraTriggerConfig } => t.enabled && t.config.kind === 'jira'
      && (!t.state.lastPollAt || now.getTime() - new Date(t.state.lastPollAt).getTime() >= t.config.pollMinutes * 60_000 - 5_000));
    for (const t of due) {
      if (locked()) return;
      try {
        await pollJiraRule(t, t.config, now);
      } catch (err) {
        ctx.log.warn({ triggerId: t.id, err: (err as Error).message }, 'jira rule poll failed');
        const latest = repo.get(t.id);
        if (latest) repo.setState(t.id, { ...latest.state, lastPollAt: now.toISOString() });
      }
    }
  }

  function startJiraPoll(now: Date): void {
    if (jiraPolling) return;
    jiraPolling = pollJira(now)
      .catch((err) => ctx.log.error({ err: (err as Error).message }, 'jira rules poll failed'))
      .finally(() => { jiraPolling = null; });
  }

  function startSlackPoll(now: Date): void {
    if (slackPolling) return; // never two polls at once
    slackPolling = pollSlack(now)
      .catch((err) => ctx.log.error({ err: (err as Error).message }, 'slack channel rules poll failed'))
      .finally(() => { slackPolling = null; });
  }

  function startPoll(now: Date): void {
    if (polling) return; // never two polls at once
    polling = pollMail(now)
      .catch((err) => ctx.log.error({ err: (err as Error).message }, 'mail rules poll failed'))
      .finally(() => { polling = null; });
  }

  return {
    tick(now) {
      if (!ctx.repos.triggers) return;
      try {
        void runSchedules(now).catch((err) => ctx.log.error({ err: (err as Error).message }, 'scheduled triggers failed'));
        if (!locked()) { startPoll(now); startSlackPoll(now); startJiraPoll(now); }
      } catch (err) {
        ctx.log.error({ err: (err as Error).message }, 'trigger tick failed');
      }
    },
    async idle() {
      await Promise.all([polling, slackPolling, jiraPolling, ...pendingSchedules]);
    },
    pollMail,
    pollSlack,
    pollJira,
    runSchedules,
  };
}
