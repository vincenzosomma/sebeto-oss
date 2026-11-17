/**
 * Trigger services (docs/28 v0.4 Plan.md §D): CRUD, secrets, dry runs, and the one place where a
 * fire becomes a ticket, a comment on an open ticket, or nothing.
 *
 * Security:
 *  - Webhook secrets: crypto.randomBytes(32) base64url, shown ONCE (create / rotate). The DB keeps
 *    only sha256(secret) (Bearer check); the HMAC key lives in the secret store as `trigger-<id>`.
 *  - Outside content (webhook body, email) gives the ticket an UNTRUSTED origin: every run of that
 *    ticket starts with untrusted input marked (tools/server.ts), so outbound actions always ask.
 *  - Every fire is a trigger_fires row + a security log event. Emergency stop (lockdown) = no fires.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  SLACK_VIA_CLAUDE, WEBHOOK_PRESET_LABELS, nextRun, normalizeTags, parseCron, uuidv7,
  type CreateTriggerBody, type CreateTriggerResponse, type Id, type TicketBlueprint, type TicketOrigin, type Trigger,
  type TriggerConfig, type TriggerFire, type TriggerFireOutcome, type TriggerTestResult, type UpdateTriggerBody, type WebhookPreset,
} from '@sebeto/shared';
import type { AppContext, StoredTrigger, TriggerRepo, TriggerState } from '../contracts.js';
import { AppError, badRequest, notFound } from '../services/errors.js';
import { createTicket, startTicket } from '../services/tickets.js';
import { requireProjectIfSet } from '../services/projects.js';
import { publicTrigger } from '../storage/triggers.js';
import { PRESET_SAMPLES, parseWithPreset } from './presets.js';
import { cleanText, renderTicket, untrustedBlock } from './template.js';

export const secretName = (triggerId: Id) => `trigger-${triggerId}`;
export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

export function triggerRepo(ctx: AppContext): TriggerRepo {
  if (!ctx.repos.triggers) throw new AppError(503, 'unavailable', 'Triggers are not available in this build');
  return ctx.repos.triggers;
}

export function requireTrigger(ctx: AppContext, id: Id): StoredTrigger {
  const t = triggerRepo(ctx).get(id);
  if (!t) throw notFound('Trigger', id);
  return t;
}

function changed(ctx: AppContext): void {
  ctx.bus.publish({ type: 'triggers.changed' });
}

/** A Slack channel rule must point at an installed Slack connector. */
function validateConfig(ctx: AppContext, config: TriggerConfig): void {
  if (config.kind === 'slack' && config.connectorId !== SLACK_VIA_CLAUDE) {
    const c = ctx.connectors?.get(config.connectorId);
    if (!c || c.catalogId !== 'slack') throw badRequest('Choose a Slack connector (Settings → Connectors → Slack)', 'unknown_connector');
  }
  if (config.kind === 'jira' && config.connectorId === SLACK_VIA_CLAUDE && !/^[a-z0-9-]+\.atlassian\.net$/.test(config.site ?? '')) {
    throw badRequest('Enter your Atlassian address, like acme.atlassian.net', 'invalid_site');
  }
  if (config.kind === 'jira' && config.connectorId !== SLACK_VIA_CLAUDE) {
    const c = ctx.connectors?.get(config.connectorId);
    if (!c || c.catalogId !== 'atlassian') throw badRequest('Choose a Jira & Confluence connector (Settings → Connectors)', 'unknown_connector');
  }
}

function validateRefs(ctx: AppContext, bp: TicketBlueprint): void {
  if (bp.agentId != null && !ctx.repos.agents.get(bp.agentId)) throw badRequest(`Agent ${bp.agentId} does not exist`, 'unknown_agent');
  requireProjectIfSet(ctx, bp.projectId);
}

function normalizeBlueprint(bp: TicketBlueprint): TicketBlueprint {
  return { ...bp, tags: normalizeTags(bp.tags ?? []) };
}

/** Initial runtime state for a (re)enabled trigger. */
function freshState(config: TriggerConfig, now: Date, prev: TriggerState = {}): TriggerState {
  if (config.kind === 'schedule') {
    const next = nextRun(parseCron(config.cron), now);
    return { nextRunAt: next ? next.toISOString() : undefined };
  }
  if (config.kind === 'mail') return { since: now.toISOString(), seen: prev.seen ?? [] };
  // Slack: start from "now" (Slack ts = seconds.micro); messages from before are never used.
  if (config.kind === 'slack') return { since: now.toISOString(), seen: prev.seen ?? [], cursor: (now.getTime() / 1000).toFixed(6) };
  if (config.kind === 'jira') return { since: now.toISOString(), seen: prev.seen ?? [] };
  return {};
}

const securityActor = (t: Pick<Trigger, 'id' | 'name'>) => ({ type: 'trigger' as const, id: t.id, name: t.name });

// ------------------------------------------------------------------ CRUD

export function listTriggers(ctx: AppContext): Trigger[] {
  return triggerRepo(ctx).list().map(publicTrigger);
}

export function getTrigger(ctx: AppContext, id: Id): Trigger {
  return publicTrigger(requireTrigger(ctx, id));
}

export async function createTrigger(ctx: AppContext, body: CreateTriggerBody): Promise<CreateTriggerResponse> {
  const repo = triggerRepo(ctx);
  const blueprint = normalizeBlueprint(body.blueprint);
  validateRefs(ctx, blueprint);
  validateConfig(ctx, body.config);
  const id = uuidv7();
  let secret: string | null = null;
  let secretHash: string | null = null;
  if (body.config.kind === 'webhook') {
    secret = newSecret();
    secretHash = sha256Hex(secret);
    // The HMAC key; without a secret store only Bearer works.
    await ctx.secrets?.set(secretName(id), secret);
  }
  const t = repo.create({
    id, name: body.name.trim(), enabled: body.enabled ?? true, config: body.config, blueprint,
    dedupeWindowMinutes: body.dedupeWindowMinutes ?? 60, secretHash, state: freshState(body.config, new Date()),
  });
  ctx.securityLog?.record({ category: 'trigger', action: 'trigger.created', summary: `Trigger "${t.name}" (${t.kind}) created`, data: { triggerId: t.id, kind: t.kind } });
  changed(ctx);
  return { trigger: publicTrigger(t), secret };
}

export function updateTrigger(ctx: AppContext, id: Id, body: UpdateTriggerBody): Trigger {
  const repo = triggerRepo(ctx);
  const cur = requireTrigger(ctx, id);
  if (body.config && body.config.kind !== cur.kind) throw badRequest('A trigger cannot change its kind; create a new one', 'kind_change');
  const blueprint = body.blueprint ? normalizeBlueprint(body.blueprint) : undefined;
  if (blueprint) validateRefs(ctx, blueprint);
  if (body.config) validateConfig(ctx, body.config);
  const config = body.config ?? cur.config;
  const turningOn = body.enabled === true && !cur.enabled;
  const scheduleChanged = body.config !== undefined && (
    (config.kind === 'schedule' && JSON.stringify(body.config) !== JSON.stringify(cur.config))
    // Slack: another channel starts from now; a new filter keeps reading where it was.
    || (config.kind === 'slack' && cur.config.kind === 'slack' && (config.channel !== cur.config.channel || config.connectorId !== cur.config.connectorId))
    || (config.kind === 'jira' && cur.config.kind === 'jira' && config.connectorId !== cur.config.connectorId));
  // Turned back on: don't fire for what happened while it was off. New schedule: next run from now.
  const state = turningOn || scheduleChanged ? freshState(config, new Date(), cur.state) : undefined;
  const t = repo.update(id, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.config ? { config: body.config } : {}),
    ...(blueprint ? { blueprint } : {}),
    ...(body.dedupeWindowMinutes !== undefined ? { dedupeWindowMinutes: body.dedupeWindowMinutes } : {}),
    ...(state ? { state } : {}),
  });
  if (body.enabled !== undefined && body.enabled !== cur.enabled) {
    ctx.securityLog?.record({ category: 'trigger', action: body.enabled ? 'trigger.enabled' : 'trigger.disabled', summary: `Trigger "${t.name}" turned ${body.enabled ? 'on' : 'off'}`, data: { triggerId: id } });
  } else {
    ctx.securityLog?.record({ category: 'trigger', action: 'trigger.updated', summary: `Trigger "${t.name}" changed`, data: { triggerId: id } });
  }
  changed(ctx);
  return publicTrigger(t);
}

export async function deleteTrigger(ctx: AppContext, id: Id): Promise<void> {
  const t = requireTrigger(ctx, id);
  triggerRepo(ctx).remove(id);
  await ctx.secrets?.delete(secretName(id));
  ctx.securityLog?.record({ category: 'trigger', action: 'trigger.deleted', summary: `Trigger "${t.name}" deleted`, data: { triggerId: id, kind: t.kind } });
  changed(ctx);
}

export async function rotateSecret(ctx: AppContext, id: Id): Promise<{ secret: string }> {
  const t = requireTrigger(ctx, id);
  if (t.kind !== 'webhook') throw badRequest('Only webhooks have a secret', 'not_webhook');
  const secret = newSecret();
  await ctx.secrets?.set(secretName(id), secret);
  triggerRepo(ctx).update(id, { secretHash: sha256Hex(secret) });
  ctx.securityLog?.record({ category: 'trigger', action: 'trigger.secret_rotated', summary: `New secret for trigger "${t.name}"`, data: { triggerId: id } });
  changed(ctx);
  return { secret };
}

export function listFires(ctx: AppContext, id: Id, limit?: number): TriggerFire[] {
  requireTrigger(ctx, id);
  return triggerRepo(ctx).listFires(id, limit);
}

// ------------------------------------------------------------------ incoming events

/** One thing that happened (an alert, an email, a due schedule), ready to become a ticket. */
export interface Incoming {
  /** Template values: title, summary, severity, host, from, subject, date… */
  values: Record<string, string>;
  /** For {{payload.path}}. */
  payload: unknown;
  /** Untrusted data shown in the goal's source block; null = trusted (schedules). */
  data: unknown | null;
  /** Short source label ("Alertmanager", "mail from example.com", "schedule"). */
  source: string;
  /** null = never dedupe. */
  dedupeKey: string | null;
  resolved: boolean;
  /** Use the trigger's dedupe window for repeats (webhooks). */
  useWindow: boolean;
  /** One line for comments ("DiskFull (critical) on fs01"). */
  line: string;
}

export function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function webhookIncoming(preset: WebhookPreset, payload: unknown, dedupeField: string | undefined, now = new Date()): Incoming {
  const ev = parseWithPreset(preset, payload, dedupeField);
  const label = WEBHOOK_PRESET_LABELS[preset];
  const line = cleanText(`${ev.title}${ev.severity ? ` (${ev.severity})` : ''}${ev.host ? ` on ${ev.host}` : ''}`, 300, false);
  return {
    values: { title: ev.title, summary: ev.summary, severity: ev.severity, host: ev.host, status: ev.status, date: localStamp(now), source: label, from: '', subject: '' },
    payload, data: payload, source: label, dedupeKey: ev.dedupeKey || null, resolved: ev.status === 'resolved', useWindow: true, line,
  };
}

/** The sender's domain ("it-alerts@corp.example" / "Name <a@b.c>" → "corp.example"). */
export function senderDomain(from: string): string {
  const m = /@([A-Za-z0-9.-]+)/.exec(from);
  return m ? m[1]!.toLowerCase().replace(/\.$/, '') : 'unknown sender';
}

export function mailIncoming(mail: { id: string; from: string; subject: string; date: string | null; text: string }, now = new Date()): Incoming {
  const domain = senderDomain(mail.from);
  const excerpt = mail.text.slice(0, 3000);
  return {
    values: {
      title: mail.subject, subject: mail.subject, from: mail.from, summary: excerpt.slice(0, 300), host: domain,
      date: mail.date ? localStamp(new Date(mail.date)) : localStamp(now), severity: '', status: 'new', source: `mail from ${domain}`,
    },
    payload: { from: mail.from, subject: mail.subject, date: mail.date },
    data: `From: ${mail.from}\nSubject: ${mail.subject}\nDate: ${mail.date ?? ''}\n\n${excerpt}`,
    source: `mail from ${domain}`, dedupeKey: `mail:${mail.id}`, resolved: false, useWindow: false,
    line: cleanText(`${mail.subject} (from ${mail.from})`, 300, false),
  };
}

export interface SlackIncomingMessage { channel: string; channelId: string; ts: string; from: string; text: string; link: string | null; bot: boolean; issue?: { key: string; url: string | null } | null; groupKey?: string | null }

/** Key of "the same thing" for a Slack rule's dedupeOn regex: its capture groups, normalised. null = no match / off. */
export function slackGroupKey(pattern: string | undefined, text: string): string | null {
  if (!pattern) return null;
  let m: RegExpMatchArray | null;
  try { m = text.match(new RegExp(pattern)); } catch { return null; }
  if (!m) return null;
  const parts = (m.length > 1 ? m.slice(1) : [m[0]]).map((g) => (g ?? '').trim().toLowerCase().replace(/\s+/g, ' '));
  const key = parts.join('|').slice(0, 300);
  return key.replace(/\|/g, '') ? key : null;
}

export function slackIncoming(m: SlackIncomingMessage, now = new Date()): Incoming {
  const channel = m.channel.startsWith('#') ? m.channel : `#${m.channel}`;
  // Title: first line without leading emoji codes (":red_circle:") and Slack bold/italic markers.
  const firstLine = (m.text.split('\n').find((l) => l.trim()) ?? '').trim()
    .replace(/^(?::[a-z0-9_+'-]+:\s*)+/i, '').replace(/[*_~]/g, '').trim();
  const title = cleanText(firstLine || `Message from ${m.from}`, 150, false);
  const excerpt = m.text.slice(0, 3000);
  const when = Number.isFinite(Number(m.ts)) ? new Date(Number(m.ts) * 1000) : now;
  return {
    values: {
      title, subject: title, from: m.from, summary: excerpt.slice(0, 300), host: channel,
      date: localStamp(when), severity: '', status: 'new', source: `Slack ${channel}`, channel, link: m.link ?? '',
      issue: m.issue?.key ?? '', issue_url: m.issue?.url ?? '',
    },
    payload: { channel, channelId: m.channelId, ts: m.ts, from: m.from, link: m.link, bot: m.bot, issue: m.issue ?? null },
    data: `Slack channel: ${channel} (id ${m.channelId})\nFrom: ${m.from}${m.bot ? ' (app)' : ''}\nTime: ${when.toISOString()}\nMessage ts: ${m.ts}${m.link ? `\nLink: ${m.link}` : ''}${m.issue ? `\nTicket: ${m.issue.key}${m.issue.url ? ` ${m.issue.url}` : ''}` : ''}\n\n${excerpt}`,
    source: `Slack ${channel}`,
    // groupKey (rule option dedupeOn): repeats of the same thing comment on the open ticket.
    dedupeKey: m.groupKey ? `slack:${m.channelId}:k:${m.groupKey}` : `slack:${m.channelId}:${m.ts}`, resolved: false, useWindow: !!m.groupKey,
    line: cleanText(`${title} (from ${m.from} in ${channel})`, 300, false),
  };
}

export interface JiraIncomingIssue { key: string; url: string; summary: string; reporter: string; created: string; type: string; priority: string; channel: string; description: string }

export function jiraIncoming(i: JiraIncomingIssue, now = new Date()): Incoming {
  const excerpt = i.description.slice(0, 3000);
  const project = i.key.split('-')[0] ?? '';
  return {
    values: {
      title: cleanText(i.summary, 200, false), subject: i.summary, from: i.reporter, summary: excerpt.slice(0, 300), host: project,
      date: localStamp(new Date(i.created || now)), severity: i.priority, status: 'new', source: `Jira ${project}`,
      issue: i.key, issue_url: i.url, channel: i.channel, link: i.url, type: i.type,
    },
    payload: { key: i.key, url: i.url, reporter: i.reporter, created: i.created, type: i.type, priority: i.priority, channel: i.channel },
    data: `Jira issue: ${i.key} ${i.url}\nType: ${i.type}\nPriority: ${i.priority}\nReporter: ${i.reporter}\nCreated: ${i.created}\nRaised via: ${i.channel || 'unknown'}\nSummary: ${i.summary}\n\n${excerpt}`,
    source: `Jira ${project}`, dedupeKey: `jira:${i.key}`, resolved: false, useWindow: false,
    line: cleanText(`${i.key} ${i.summary} (from ${i.reporter})`, 300, false),
  };
}

export function scheduleIncoming(t: Pick<Trigger, 'name'>, now: Date): Incoming {
  return {
    values: { title: t.name, name: t.name, date: localStamp(now), summary: '', severity: '', host: '', from: '', subject: '', status: '', source: 'schedule' },
    payload: {}, data: null, source: 'schedule', dedupeKey: null, resolved: false, useWindow: false, line: t.name,
  };
}

type Decision = { action: 'create' } | { action: 'comment'; ticketId: Id; ticketNumber: number; detail: string } | { action: 'ignore'; detail: string };

function openTicketFor(ctx: AppContext, t: StoredTrigger, key: string, sinceIso: string): { id: Id; number: number } | null {
  for (const ticketId of triggerRepo(ctx).createdTicketsFor(t.id, key, sinceIso)) {
    const ticket = ctx.repos.tickets.get(ticketId);
    if (ticket && ticket.status !== 'done') return { id: ticket.id, number: ticket.number };
  }
  return null;
}

export function decide(ctx: AppContext, t: StoredTrigger, inc: Incoming, now = new Date()): Decision {
  const ignoreResolved = t.config.kind === 'webhook' && t.config.ignoreResolved;
  if (inc.resolved && ignoreResolved) {
    const open = inc.dedupeKey ? openTicketFor(ctx, t, inc.dedupeKey, '') : null;
    return open
      ? { action: 'comment', ticketId: open.id, ticketNumber: open.number, detail: `resolved: comment on T-${open.number}` }
      : { action: 'ignore', detail: 'resolved alert, no open ticket' };
  }
  if (inc.useWindow && inc.dedupeKey && t.dedupeWindowMinutes > 0) {
    const since = new Date(now.getTime() - t.dedupeWindowMinutes * 60_000).toISOString();
    const open = openTicketFor(ctx, t, inc.dedupeKey, since);
    if (open) return { action: 'comment', ticketId: open.id, ticketNumber: open.number, detail: `repeat of T-${open.number}` };
  }
  return { action: 'create' };
}

function originFor(t: StoredTrigger, inc: Incoming): TicketOrigin {
  return { kind: 'trigger', triggerId: t.id, triggerKind: t.kind, source: inc.source, untrusted: inc.data !== null };
}

/** Per-trigger serialisation: two copies of the same alert arriving together must not make two tickets. */
const chains = new WeakMap<AppContext, Map<Id, Promise<unknown>>>();
function serial<T>(ctx: AppContext, id: Id, fn: () => Promise<T>): Promise<T> {
  let m = chains.get(ctx);
  if (!m) chains.set(ctx, (m = new Map()));
  const prev = m.get(id) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  m.set(id, tail);
  void tail.then(() => { if (m!.get(id) === tail) m!.delete(id); });
  return run;
}

export interface FireResult { outcome: TriggerFireOutcome; ticketId: Id | null; ticketNumber: number | null; detail: string; fire: TriggerFire | null }

function publishFire(ctx: AppContext, t: StoredTrigger, fire: TriggerFire): void {
  const rejected = fire.outcome === 'rejected' || fire.outcome === 'error';
  ctx.securityLog?.record({
    category: 'trigger', action: rejected ? 'trigger.rejected' : 'trigger.fired', severity: rejected ? 'warning' : 'info',
    actor: securityActor(t), ticketId: fire.ticketId,
    summary: `Trigger "${t.name}": ${fire.outcome}${fire.detail ? ` (${fire.detail})` : ''}`,
    data: { triggerId: t.id, kind: t.kind, outcome: fire.outcome, ticketNumber: fire.ticketNumber },
  });
  ctx.bus.publish({ type: 'trigger.fired', fire });
  changed(ctx);
}

/** Record a fire that was refused before any processing (webhook auth, limits…). */
export function recordRejected(ctx: AppContext, t: StoredTrigger, detail: string, opts: { log?: boolean } = {}): TriggerFire | null {
  const fire = triggerRepo(ctx).recordFire({ triggerId: t.id, outcome: 'rejected', detail });
  if (opts.log !== false) publishFire(ctx, t, fire);
  return fire;
}

/** Record a fire outcome that needs no ticket (e.g. a schedule missed while Sebeto was off). */
export function recordOutcome(ctx: AppContext, t: StoredTrigger, outcome: TriggerFireOutcome, detail: string): TriggerFire {
  const fire = triggerRepo(ctx).recordFire({ triggerId: t.id, outcome, detail });
  publishFire(ctx, t, fire);
  return fire;
}

/** Turn an incoming event into a ticket / comment / nothing. Never throws (errors become an 'error' fire). */
export function fire(ctx: AppContext, triggerId: Id, inc: Incoming): Promise<FireResult> {
  return serial(ctx, triggerId, async () => {
    const t = triggerRepo(ctx).get(triggerId);
    if (!t) return { outcome: 'error', ticketId: null, ticketNumber: null, detail: 'trigger deleted', fire: null };
    const repo = triggerRepo(ctx);
    const dedupeKey = inc.dedupeKey;
    try {
      const d = decide(ctx, t, inc);
      if (d.action === 'ignore') {
        const f = repo.recordFire({ triggerId: t.id, outcome: 'ignored', dedupeKey, detail: d.detail });
        publishFire(ctx, t, f);
        return { outcome: 'ignored', ticketId: null, ticketNumber: null, detail: d.detail, fire: f };
      }
      if (d.action === 'comment') {
        const head = inc.resolved ? `Resolved: ${inc.line}` : `Happened again: ${inc.line}`;
        const text = inc.data !== null ? `${head}\n\n${untrustedBlock(inc.source, inc.data)}` : head;
        const message = ctx.repos.messages.create({ ticketId: d.ticketId, role: 'system', author: `Trigger ${t.name}`, text });
        ctx.bus.publish({ type: 'message.created', message });
        const f = repo.recordFire({ triggerId: t.id, outcome: 'commented', ticketId: d.ticketId, dedupeKey, detail: d.detail });
        publishFire(ctx, t, f);
        return { outcome: 'commented', ticketId: d.ticketId, ticketNumber: d.ticketNumber, detail: d.detail, fire: f };
      }
      const bp = t.blueprint;
      const { title, goal } = renderTicket({ title: bp.title, goal: bp.goal, values: inc.values, payload: inc.payload, source: inc.source, data: inc.data });
      const ticket = await createTicket(ctx, {
        title, goal, agentId: bp.agentId, projectId: bp.projectId, tags: bp.tags, teamId: bp.teamId,
        ...(bp.costCapUsd !== null ? { costCapUsd: bp.costCapUsd } : {}),
      }, { origin: originFor(t, inc) });
      const event = ctx.repos.audit.append({
        ticketId: ticket.id, kind: 'info',
        summary: `Opened by the trigger "${t.name}" (${inc.source})${inc.data !== null ? '. Outside content: outbound actions always ask.' : ''}`,
        data: { triggerId: t.id },
      });
      ctx.bus.publish({ type: 'event.created', event });
      const f = repo.recordFire({ triggerId: t.id, outcome: 'created', ticketId: ticket.id, dedupeKey, detail: `T-${ticket.number}` });
      if (bp.autoStart) {
        if (ctx.securityLog?.lockdown()) {
          const ev = ctx.repos.audit.append({ ticketId: ticket.id, kind: 'info', summary: 'Not started: the emergency stop is on.' });
          ctx.bus.publish({ type: 'event.created', event: ev });
        } else {
          startTicket(ctx, ticket.id, { checkScope: false }); // the executor enforces a required scope (v0.4 G)
        }
      }
      publishFire(ctx, t, f);
      return { outcome: 'created', ticketId: ticket.id, ticketNumber: ticket.number, detail: f.detail, fire: f };
    } catch (err) {
      const detail = cleanText(`could not create the ticket: ${(err as Error).message ?? String(err)}`, 300, false);
      ctx.log.warn({ triggerId: t.id, err: (err as Error).message }, 'trigger fire failed');
      const f = repo.recordFire({ triggerId: t.id, outcome: 'error', dedupeKey, detail });
      publishFire(ctx, t, f);
      return { outcome: 'error', ticketId: null, ticketNumber: null, detail, fire: f };
    }
  });
}

// ------------------------------------------------------------------ dry run

const SAMPLE_MAIL = { id: 'sample', from: 'Monitoring <alerts@monitoring.example.com>', subject: 'Backup job failed on SRV-FS01', date: null, text: 'The nightly backup of SRV-FS01 failed at 02:14 with error 0x80070005 (access denied).' };

const SAMPLE_SLACK = { from: 'Jane Doe', text: 'My laptop cannot connect to the VPN since this morning, error "credential or SSL VPN configuration is wrong".' };

/** What a fire WOULD do (creates nothing, no fire row). */
export function testTrigger(ctx: AppContext, id: Id, payload: unknown): TriggerTestResult {
  const t = requireTrigger(ctx, id);
  let inc: Incoming;
  if (t.config.kind === 'webhook') {
    inc = webhookIncoming(t.config.preset, payload === undefined ? PRESET_SAMPLES[t.config.preset] : payload, t.config.dedupeField);
  } else if (t.config.kind === 'mail') {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const s = (k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
    inc = mailIncoming({ id: 'test', from: s('from', SAMPLE_MAIL.from), subject: s('subject', SAMPLE_MAIL.subject), date: null, text: s('text', SAMPLE_MAIL.text) });
  } else if (t.config.kind === 'jira') {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const s = (k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
    inc = jiraIncoming({ key: s('key', 'HELP-123'), url: 'https://example.atlassian.net/browse/HELP-123', summary: s('summary', 'Laptop will not connect to the office Wi-Fi'), reporter: s('reporter', 'Jane Doe'), created: new Date().toISOString(), type: 'Task', priority: 'Medium', channel: 'email', description: s('description', 'Since this morning my laptop cannot join the office Wi-Fi.') });
  } else if (t.config.kind === 'slack') {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const s = (k: string, d: string) => (typeof p[k] === 'string' ? (p[k] as string) : d);
    inc = slackIncoming({ channel: t.config.channel, channelId: 'C0TEST', ts: 'test', from: s('from', SAMPLE_SLACK.from), text: s('text', SAMPLE_SLACK.text), link: null, bot: false,
      issue: t.config.waitForTicket ? { key: s('issue', 'HELP-123'), url: null } : null });
  } else {
    inc = scheduleIncoming(t, new Date());
  }
  const d = decide(ctx, t, inc);
  const bp = t.blueprint;
  const { title, goal } = renderTicket({ title: bp.title, goal: bp.goal, values: inc.values, payload: inc.payload, source: inc.source, data: inc.data });
  const team = bp.teamId === 'auto' ? 'the team is chosen automatically' : bp.teamId ? '' : 'no team';
  const lock = ctx.securityLog?.lockdown() ? 'The emergency stop is on: nothing would happen now. ' : '';
  const off = t.enabled ? '' : 'This trigger is off: turn it on first. ';
  const what = d.action === 'create'
    ? `Would create a new ticket${bp.autoStart ? ' and start it' : ' in Backlog'}${team ? ` (${team})` : ''}.`
    : d.action === 'comment' ? `Would add a comment to T-${d.ticketNumber} (${d.detail}).` : `Would do nothing (${d.detail}).`;
  return {
    outcome: d.action === 'create' ? 'created' : d.action === 'comment' ? 'commented' : 'ignored',
    title, goal,
    teamId: bp.teamId === 'auto' ? null : bp.teamId,
    agentId: bp.agentId, tags: bp.tags,
    detail: `${off}${lock}${what}${inc.data !== null ? ' The content is from outside: outbound actions will always ask.' : ''}`,
  };
}
