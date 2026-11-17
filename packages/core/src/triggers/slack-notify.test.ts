import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './testing/harness.js';
import { createTrigger } from './service.js';
import { ACTIONS, renderTicketDm, startSlackNotify } from './slack-notify.js';
import { slackMessageText } from '../connectors/builtin/slack.js';
import { createTicket } from '../services/tickets.js';

let h: Harness;
beforeEach(() => { h = createHarness(); h.ctx.repos.agents.create({ name: 'Ops', runtime: 'mock' }); });
afterEach(() => h.close());

const bp = { title: '{{title}}', goal: 'x', teamId: null, agentId: null, projectId: null, tags: [], costCapUsd: null, autoStart: false };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Slack DM to the owner', () => {
  let calls: Array<{ method: string; body: Record<string, unknown> }>;
  let appToken: string;
  beforeEach(() => {
    calls = [];
    appToken = '';
    (h.ctx as { connectors?: unknown }).connectors = {
      get: () => ({ catalogId: 'slack' }),
      settingsFor: async () => ({ SLACK_TOKEN: 'xoxb-1-test', ...(appToken ? { SLACK_APP_TOKEN: appToken } : {}) }),
    };
  });
  const fetchImpl = (async (input: string | URL, init?: { body?: string }) => {
    const u = new URL(String(input));
    const method = u.pathname.replace('/api/', '');
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : Object.fromEntries(u.searchParams);
    calls.push({ method, body });
    const res = method === 'conversations.open' ? { ok: true, channel: { id: 'DOWNER1' } }
      : method === 'chat.postMessage' ? { ok: true, ts: '111.222', channel: 'DOWNER1' } : { ok: true };
    return new Response(JSON.stringify(res), { status: 200 });
  }) as typeof fetch;

  async function slackTicket(notifyUser: string) {
    const { trigger } = await createTrigger(h.ctx, { name: 'Help Desk', config: { kind: 'slack', connectorId: 'conn', channel: '#help-desk', fromContains: '', textContains: '', includeBots: false, pollMinutes: 2, notifyUser }, blueprint: bp });
    return createTicket(h.ctx, { title: 'HELP-9 VPN', goal: 'x' }, { origin: { kind: 'trigger', triggerId: trigger.id, triggerKind: 'slack', source: 'Slack #help-desk', untrusted: true } });
  }
  const move = (id: string, status: 'needs_you' | 'in_progress' | 'done') => h.ctx.bus.publish({ type: 'ticket.updated', ticket: h.ctx.repos.tickets.update(id, { status }) });

  it('one DM per ticket: posted when it first needs the owner, then edited in place', async () => {
    const n = startSlackNotify(h.ctx, { fetchImpl, baseUrl: 'http://127.0.0.1:7600', delayMs: 0, sockets: false });
    const t = await slackTicket('U0OWNER1');
    move(t.id, 'in_progress');
    await wait(10);
    expect(calls).toHaveLength(0); // working: nothing to tell yet
    h.ctx.repos.messages.create({ ticketId: t.id, role: 'agent', author: 'Service Desk Lead', text: '*self_help* Draft reply: install from Company Portal' });
    move(t.id, 'needs_you');
    await wait(10);
    move(t.id, 'in_progress');
    await wait(10);
    move(t.id, 'needs_you');
    await wait(10);
    n.stop();
    expect(calls.filter((c) => c.method === 'chat.postMessage')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'chat.update').length).toBeGreaterThanOrEqual(1);
    const post = calls.find((c) => c.method === 'chat.postMessage')!;
    expect(post.body.channel).toBe('DOWNER1');
    expect(JSON.stringify(post.body.blocks)).toContain('Draft reply: install from Company Portal');
    expect(JSON.stringify(post.body.blocks)).toContain(`http://127.0.0.1:7600/?ticket=${t.id}`);
  });

  it('stays quiet without notifyUser or for tickets not from a Slack rule', async () => {
    const n = startSlackNotify(h.ctx, { fetchImpl, delayMs: 0, sockets: false });
    const a = await slackTicket('');
    const b = await createTicket(h.ctx, { title: 'Manual', goal: 'x' });
    move(a.id, 'needs_you');
    move(b.id, 'needs_you');
    await wait(10);
    n.stop();
    expect(calls).toHaveLength(0);
  });

  it('buttons: only the owner; Revise sends their text to the agent and turns down the pending approval', async () => {
    appToken = 'xapp-1-test';
    const n = startSlackNotify(h.ctx, { fetchImpl, delayMs: 0, sockets: false });
    const t = await slackTicket('U0OWNER1');
    const perm = h.ctx.repos.permissions.create({ ticketId: t.id, runId: null, agentId: null, key: 'tool.change', title: 'Permission needed: post in Slack', detail: 'reply in thread', provenance: null });
    move(t.id, 'needs_you');
    await wait(10);
    const blocks = JSON.stringify(calls.find((c) => c.method === 'chat.postMessage')!.body.blocks);
    expect(blocks).toContain(ACTIONS.approve);
    expect(blocks).toContain(ACTIONS.revise);

    const value = JSON.stringify({ t: t.id, p: perm.id });
    await n.handleInteractive('conn', { type: 'block_actions', user: { id: 'U0STRANGER' }, channel: { id: 'DOWNER1' }, actions: [{ action_id: ACTIONS.approve, value }] });
    expect(h.ctx.repos.permissions.get(perm.id)!.state).toBe('pending');
    expect(calls.at(-1)!.body.text).toMatch(/Only the owner/);

    await n.handleInteractive('conn', { type: 'view_submission', user: { id: 'U0OWNER1' }, view: { callback_id: 'sebeto_revise_submit', private_metadata: t.id, state: { values: { msg: { text: { value: 'Shorter, and mention the Company Portal' } } } } } });
    expect(h.ctx.repos.permissions.get(perm.id)!.state).toBe('denied');
    expect(h.ctx.repos.messages.listForTicket(t.id, { limit: 10 }).items.some((m) => m.role === 'user' && m.text.includes('Company Portal'))).toBe(true);
    n.stop();
  });

  it('render: no buttons without an app token, done has no actions', () => {
    const ticket = { id: 'x', number: 8, title: 'HELP-9', status: 'needs_you', lastActivity: { summary: 'Permission needed', at: '' } } as never;
    expect(JSON.stringify(renderTicketDm({ ticket, agentText: null, pending: null, url: null, buttons: false }).blocks)).not.toContain('sebeto_');
    const done = renderTicketDm({ ticket: { ...(ticket as object), status: 'done' } as never, agentText: null, pending: null, url: 'http://x', buttons: true });
    expect(done.blocks.some((b) => b.type === 'actions')).toBe(false);
  });
});

describe('forwarded Slack messages', () => {
  it('names the original author', () => {
    const text = slackMessageText({ ts: '1', text: '', attachments: [{ is_share: true, author_name: 'Alex T', from_url: 'https://x.slack.com/archives/D1/p1', text: 'My VPN keeps dropping' }] });
    expect(text).toBe('Forwarded message from Alex T (https://x.slack.com/archives/D1/p1):\nMy VPN keeps dropping');
  });
});
