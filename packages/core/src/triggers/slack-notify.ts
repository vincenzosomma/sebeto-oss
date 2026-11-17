/**
 * Slack DM to the owner for tickets opened by a Slack channel rule with `notifyUser` (2026-11-16,
 * replaces the old Help Desk Triage bot's DM). Sebeto's own code, no model call.
 *
 * - ONE message per ticket: posted (one notification) the first time the ticket needs the owner
 *   (Needs you / Blocked), then edited in place as the ticket moves on (edits don't notify).
 * - Buttons (when the connector has an app-level token and the Slack app has Socket Mode on):
 *   Approve / Deny the pending approval, Reply / Revise (a box whose text goes to the agent),
 *   Mark done, Open in Sebeto. Only the rule's `notifyUser` can use them.
 * - The DM message per ticket is remembered in <workspace>/slack-dm.json across restarts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SLACK_VIA_CLAUDE, type PermissionRequest, type SlackTriggerConfig, type Ticket, type WsEvent } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { SLACK_ENV, slackClient, slackToken, type SlackCall } from '../connectors/builtin/slack.js';
import { startSlackSocket, type SlackSocket } from '../connectors/builtin/slack-socket.js';
import type { FetchLike } from '../connectors/builtin/common.js';
import { decidePermission, moveTicket, postMessage } from '../services/tickets.js';

const PING_STATUSES = new Set<Ticket['status']>(['needs_you', 'blocked']);
const MAX_TEXT = 2800;
/** Coalesce bursts of updates (cost, status, message) into one edit. */
export const NOTIFY_DELAY_MS = 3000;
export const ACTIONS = { approve: 'sebeto_approve', deny: 'sebeto_deny', revise: 'sebeto_revise', done: 'sebeto_done', open: 'sebeto_open' } as const;
const REVISE_CALLBACK = 'sebeto_revise_submit';

type Block = Record<string, unknown>;
interface DmRef { connectorId: string; channel: string; ts: string; hash: string }

const LABEL: Partial<Record<Ticket['status'], string>> = {
  backlog: 'Waiting', in_progress: 'Working…', needs_you: 'Needs you', blocked: 'Blocked', done: 'Done ✓',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const mrkdwn = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text: clip(text, MAX_TEXT) } });

/** The DM for a ticket: text fallback + blocks. `buttons` false = no interactive buttons (no app token). */
export function renderTicketDm(input: {
  ticket: Ticket; agentText: string | null; pending: PermissionRequest | null; url: string | null; buttons: boolean;
}): { text: string; blocks: Block[] } {
  const { ticket, agentText, pending, url, buttons } = input;
  const head = `*${LABEL[ticket.status] ?? ticket.status} · T-${ticket.number}* ${ticket.title}`;
  const blocks: Block[] = [mrkdwn(head)];
  if (ticket.lastActivity?.summary) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(ticket.lastActivity.summary, 300) }] });
  if (agentText) blocks.push(mrkdwn(agentText));
  if (pending) blocks.push(mrkdwn(`*Approval needed:* ${pending.title}\n\`\`\`${clip(pending.detail, 1500)}\`\`\``));
  const elements: Block[] = [];
  if (buttons && PING_STATUSES.has(ticket.status)) {
    const value = (p?: string) => JSON.stringify({ t: ticket.id, ...(p ? { p } : {}) });
    if (pending) {
      elements.push({ type: 'button', action_id: ACTIONS.approve, style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: value(pending.id) });
      elements.push({ type: 'button', action_id: ACTIONS.deny, style: 'danger', text: { type: 'plain_text', text: 'Deny' }, value: value(pending.id) });
    }
    elements.push({ type: 'button', action_id: ACTIONS.revise, text: { type: 'plain_text', text: pending ? 'Revise' : 'Reply' }, value: value() });
    elements.push({
      type: 'button', action_id: ACTIONS.done, text: { type: 'plain_text', text: 'Mark done' }, value: value(),
      confirm: { title: { type: 'plain_text', text: 'Mark done?' }, text: { type: 'plain_text', text: `Close T-${ticket.number} in Sebeto. Nothing is posted.` }, confirm: { type: 'plain_text', text: 'Mark done' }, deny: { type: 'plain_text', text: 'Cancel' } },
    });
  }
  if (url && ticket.status !== 'done') elements.push({ type: 'button', action_id: ACTIONS.open, text: { type: 'plain_text', text: 'Open in Sebeto' }, url });
  if (elements.length) blocks.push({ type: 'actions', elements });
  return { text: head.replace(/\*/g, ''), blocks };
}

export interface SlackNotifier { stop(): void; handleInteractive(connectorId: string, payload: Record<string, unknown>): Promise<void>; flush(ticketId: string): Promise<void> }

export function startSlackNotify(ctx: AppContext, opts: { fetchImpl?: FetchLike; baseUrl?: string | null; delayMs?: number; sockets?: boolean } = {}): SlackNotifier {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl === undefined
    ? (ctx.config.port ? `http://${ctx.config.host === '0.0.0.0' ? '127.0.0.1' : ctx.config.host}:${ctx.config.port}` : null)
    : opts.baseUrl;
  const file = ctx.config.workspaceDir ? path.join(ctx.config.workspaceDir, 'slack-dm.json') : null;
  const refs = new Map<string, DmRef>(load());
  const dmChannel = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const sockets = new Map<string, SlackSocket>();
  const hasAppToken = new Map<string, boolean>();

  function load(): Array<[string, DmRef]> {
    if (!file) return [];
    try { return Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, DmRef>); } catch { return []; }
  }
  function save(): void {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries([...refs.entries()].slice(-2000))), { encoding: 'utf8', mode: 0o600 });
    } catch (err) { ctx.log.warn({ err: (err as Error).message }, 'could not save slack-dm.json'); }
  }

  function ruleOf(ticket: Ticket): (SlackTriggerConfig & { notifyUser: string }) | null {
    if (ticket.origin?.kind !== 'trigger' || ticket.origin.triggerKind !== 'slack' || !ticket.origin.triggerId) return null;
    const trig = ctx.repos.triggers?.get(ticket.origin.triggerId);
    if (!trig || trig.config.kind !== 'slack' || !trig.config.notifyUser) return null;
    return withDmConnector(trig.config as SlackTriggerConfig & { notifyUser: string });
  }

  /**
   * A rule that reads through the owner's Claude Slack connector cannot DM: a message the owner
   * sends to themselves makes no notification. Its DMs go through the first enabled Slack connector
   * (an app bot), or nowhere when there is none.
   */
  function withDmConnector<T extends SlackTriggerConfig>(cfg: T): T | null {
    if (cfg.connectorId !== SLACK_VIA_CLAUDE) return cfg;
    const bot = ctx.connectors?.list().find((c) => c.catalogId === 'slack' && c.enabled);
    return bot ? { ...cfg, connectorId: bot.id } : null;
  }

  async function clientFor(connectorId: string): Promise<{ call: SlackCall; appToken: string | null }> {
    if (!ctx.connectors) throw new Error('connectors are not available');
    const settings = await ctx.connectors.settingsFor(connectorId);
    const appToken = (settings[SLACK_ENV.appToken] ?? '').trim() || null;
    hasAppToken.set(connectorId, !!appToken);
    return { call: slackClient(slackToken(settings), fetchImpl), appToken };
  }

  async function ensureSocket(connectorId: string): Promise<void> {
    if (opts.sockets === false || sockets.has(connectorId)) return;
    const { appToken } = await clientFor(connectorId);
    if (!appToken || sockets.has(connectorId)) return;
    sockets.set(connectorId, startSlackSocket({
      appToken, fetchImpl, log: ctx.log,
      onInteractive: (payload) => handleInteractive(connectorId, payload),
    }));
    ctx.log.info({ connectorId }, 'slack buttons: socket mode started');
  }

  function render(ticket: Ticket, connectorId: string) {
    const agentMsg = ctx.repos.messages.listForTicket(ticket.id, { limit: 30 }).items.filter((m) => m.role === 'agent').at(-1);
    const pending = ctx.repos.permissions.listForTicket(ticket.id).find((p) => p.state === 'pending') ?? null;
    const url = baseUrl ? `${baseUrl}/?ticket=${encodeURIComponent(ticket.id)}` : null;
    return renderTicketDm({ ticket, agentText: agentMsg?.text ?? null, pending, url, buttons: hasAppToken.get(connectorId) ?? false });
  }

  async function sync(ticketId: string): Promise<void> {
    const ticket = ctx.repos.tickets.get(ticketId);
    if (!ticket) return;
    const rule = ruleOf(ticket);
    if (!rule) return;
    const ref = refs.get(ticket.id);
    if (!ref && !PING_STATUSES.has(ticket.status)) return; // nothing to tell the owner yet
    const { call } = await clientFor(rule.connectorId);
    void ensureSocket(rule.connectorId).catch(() => undefined);
    const msg = render(ticket, rule.connectorId);
    const hash = JSON.stringify(msg.blocks);
    if (ref) {
      if (ref.hash === hash) return;
      await call('chat.update', { channel: ref.channel, ts: ref.ts, text: msg.text, blocks: msg.blocks }, { post: true });
      refs.set(ticket.id, { ...ref, hash });
    } else {
      const key = `${rule.connectorId}:${rule.notifyUser}`;
      let channel = dmChannel.get(key);
      if (!channel) {
        const r = await call<{ channel?: { id?: string } }>('conversations.open', { users: rule.notifyUser });
        channel = r.channel?.id;
        if (!channel) throw new Error('could not open the DM');
        dmChannel.set(key, channel);
      }
      const r = await call<{ ts?: string; channel?: string }>('chat.postMessage', { channel, text: msg.text, blocks: msg.blocks, unfurl_links: false }, { post: true });
      if (r.ts) refs.set(ticket.id, { connectorId: rule.connectorId, channel: r.channel ?? channel, ts: r.ts, hash });
    }
    save();
  }

  function schedule(ticketId: string): void {
    const prev = timers.get(ticketId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      timers.delete(ticketId);
      sync(ticketId).catch((err: Error) => ctx.log.warn({ ticketId, err: err.message }, 'slack DM to the owner failed'));
    }, opts.delayMs ?? NOTIFY_DELAY_MS);
    (t as { unref?: () => void }).unref?.();
    timers.set(ticketId, t);
  }

  async function reply(connectorId: string, payload: Record<string, unknown>, text: string): Promise<void> {
    const ch = (payload.channel as { id?: string } | undefined)?.id ?? (payload.container as { channel_id?: string } | undefined)?.channel_id;
    const ts = (payload.message as { ts?: string } | undefined)?.ts ?? (payload.container as { message_ts?: string } | undefined)?.message_ts;
    if (!ch) return;
    const { call } = await clientFor(connectorId);
    await call('chat.postMessage', { channel: ch, text, ...(ts ? { thread_ts: ts } : {}) }, { post: true });
  }

  async function handleInteractive(connectorId: string, payload: Record<string, unknown>): Promise<void> {
    const userId = (payload.user as { id?: string } | undefined)?.id ?? '';
    if (payload.type === 'block_actions') {
      const action = ((payload.actions as Array<{ action_id?: string; value?: string }> | undefined) ?? [])[0];
      if (!action?.action_id || action.action_id === ACTIONS.open) return;
      let v: { t?: string; p?: string };
      try { v = JSON.parse(action.value ?? '{}') as typeof v; } catch { return; }
      const ticket = v.t ? ctx.repos.tickets.get(v.t) : undefined;
      const rule = ticket ? ruleOf(ticket) : null;
      if (!ticket || !rule || rule.connectorId !== connectorId) return;
      if (userId !== rule.notifyUser) { await reply(connectorId, payload, 'Only the owner of this Sebeto can use these buttons.'); return; }
      ctx.securityLog?.record({
        category: 'ticket', action: 'slack.button', actor: { type: 'user', id: null, name: 'You (Slack)' }, ticketId: ticket.id,
        summary: `Slack button "${action.action_id.replace('sebeto_', '')}" on T-${ticket.number}`, data: { slackUser: userId },
      });
      try {
        if (action.action_id === ACTIONS.approve && v.p) decidePermission(ctx, v.p, 'allow');
        else if (action.action_id === ACTIONS.deny && v.p) decidePermission(ctx, v.p, 'deny');
        else if (action.action_id === ACTIONS.done) moveTicket(ctx, ticket.id, 'done', 'Marked done from Slack');
        else if (action.action_id === ACTIONS.revise) {
          const { call } = await clientFor(connectorId);
          await call('views.open', {
            trigger_id: payload.trigger_id,
            view: {
              type: 'modal', callback_id: REVISE_CALLBACK, private_metadata: ticket.id,
              title: { type: 'plain_text', text: `T-${ticket.number}` },
              submit: { type: 'plain_text', text: 'Send to agent' }, close: { type: 'plain_text', text: 'Cancel' },
              blocks: [{
                type: 'input', block_id: 'msg', label: { type: 'plain_text', text: 'What should the agent change or do?' },
                element: { type: 'plain_text_input', action_id: 'text', multiline: true, max_length: 3000 },
              }],
            },
          }, { post: true });
          return;
        }
      } catch (err) {
        await reply(connectorId, payload, `Could not do that: ${(err as Error).message}`);
      }
      schedule(ticket.id);
      return;
    }
    if (payload.type === 'view_submission') {
      const view = payload.view as { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, Record<string, { value?: string }>> } } | undefined;
      if (view?.callback_id !== REVISE_CALLBACK || !view.private_metadata) return;
      const ticket = ctx.repos.tickets.get(view.private_metadata);
      const rule = ticket ? ruleOf(ticket) : null;
      if (!ticket || !rule || rule.connectorId !== connectorId || userId !== rule.notifyUser) return;
      const text = (view.state?.values?.msg?.text?.value ?? '').trim();
      if (!text) return;
      // A pending approval is turned down first; the agent redoes the draft with the owner's words.
      for (const p of ctx.repos.permissions.listForTicket(ticket.id)) {
        if (p.state === 'pending') { try { decidePermission(ctx, p.id, 'deny'); } catch { /* decided meanwhile */ } }
      }
      postMessage(ctx, ticket.id, text);
      schedule(ticket.id);
    }
  }

  // Start the button connection for every Slack rule that DMs someone, then follow ticket changes.
  for (const t of ctx.repos.triggers?.list() ?? []) {
    const cfg = t.enabled && t.config.kind === 'slack' && t.config.notifyUser ? withDmConnector(t.config) : null;
    if (cfg) {
      void ensureSocket(cfg.connectorId).catch((err: Error) => ctx.log.warn({ err: err.message }, 'slack buttons: not started'));
    }
  }
  const unsubscribe = ctx.bus.subscribe((e: WsEvent) => {
    if (e.type === 'ticket.updated') { if (ruleOf(e.ticket)) schedule(e.ticket.id); return; }
    if (e.type === 'message.created' && refs.has(e.message.ticketId)) schedule(e.message.ticketId);
  });

  return {
    stop() {
      unsubscribe();
      for (const t of timers.values()) clearTimeout(t);
      for (const s of sockets.values()) s.close();
    },
    handleInteractive,
    flush: (ticketId) => sync(ticketId),
  };
}
