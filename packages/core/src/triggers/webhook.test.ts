import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CreateTriggerResponse, Ticket, Trigger, TriggerFire, TriggerTestResult } from '@sebeto/shared';
import { createServer } from '../api/server.js';
import { createHarness, TEST_TOKEN, type Harness } from './testing/harness.js';
import { UNTRUSTED_BEGIN } from './template.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const fx = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
const auth = { authorization: `Bearer ${TEST_TOKEN}` };

let h: Harness;
let app: FastifyInstance;

beforeEach(async () => {
  h = createHarness();
  h.ctx.repos.agents.create({ name: 'Ops agent', runtime: 'mock' });
  app = await createServer(h.ctx);
});
afterEach(async () => {
  await app.close();
  h.close();
});

const blueprint = { title: 'Alert: {{title}}', goal: 'Investigate {{title}} on {{host}} ({{severity}}).', teamId: null, agentId: null, projectId: null, tags: ['alert'], costCapUsd: 0.5, autoStart: false };

async function createWebhook(preset = 'alertmanager', extra: Record<string, unknown> = {}): Promise<CreateTriggerResponse> {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/triggers', headers: auth,
    payload: { name: 'Prometheus', config: { kind: 'webhook', preset, ignoreResolved: true }, blueprint, dedupeWindowMinutes: 60, ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as CreateTriggerResponse;
}

function hook(id: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: `/api/v1/hooks/${id}`, headers: { 'content-type': 'application/json', ...headers }, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}

const fires = (id: string) => h.ctx.repos.triggers!.listFires(id, 200);

describe('trigger API', () => {
  it('CRUD: the secret is shown once at creation and never returned again', async () => {
    const { trigger, secret } = await createWebhook();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(trigger).toMatchObject({ kind: 'webhook', enabled: true, hasSecret: true, hookPath: `/api/v1/hooks/${trigger.id}`, fireCount: 0 });
    expect(JSON.stringify(trigger)).not.toContain(secret!);
    for (const url of ['/api/v1/triggers', `/api/v1/triggers/${trigger.id}`]) {
      const body = (await app.inject({ url, headers: auth })).body;
      expect(body).not.toContain(secret!);
      expect(body).not.toContain('secretHash');
    }
    // The DB keeps only the hash; the HMAC key is in the secret store.
    expect(h.ctx.repos.triggers!.get(trigger.id)!.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.ctx.secrets!.get(`trigger-${trigger.id}`)).toBe(secret);

    const patched = await app.inject({ method: 'PATCH', url: `/api/v1/triggers/${trigger.id}`, headers: auth, payload: { name: 'Prom', enabled: false } });
    expect(patched.json()).toMatchObject({ name: 'Prom', enabled: false });
    expect((await app.inject({ method: 'PATCH', url: `/api/v1/triggers/${trigger.id}`, headers: auth, payload: { config: { kind: 'schedule', cron: '0 8 * * 1' } } })).statusCode).toBe(400);

    const rotated = await app.inject({ method: 'POST', url: `/api/v1/triggers/${trigger.id}/rotate-secret`, headers: auth });
    const newSecret = (rotated.json() as { secret: string }).secret;
    expect(newSecret).not.toBe(secret);
    expect(await h.ctx.secrets!.get(`trigger-${trigger.id}`)).toBe(newSecret);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/triggers/${trigger.id}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/triggers', headers: auth })).json()).toEqual([]);
    expect(await h.ctx.secrets!.get(`trigger-${trigger.id}`)).toBeNull();
    expect(h.events.some((e) => e.type === 'triggers.changed')).toBe(true);
    expect(h.security.map((e) => e.action)).toEqual(expect.arrayContaining(['trigger.created', 'trigger.disabled', 'trigger.secret_rotated', 'trigger.deleted']));
  });

  it('validates: cron must parse, mail needs a filter, poll >= 2, name/title/goal required, refs exist', async () => {
    const bad = async (payload: Record<string, unknown>) => (await app.inject({ method: 'POST', url: '/api/v1/triggers', headers: auth, payload })).statusCode;
    expect(await bad({ name: 'S', config: { kind: 'schedule', cron: '61 * * * *' }, blueprint })).toBe(400);
    expect(await bad({ name: 'S', config: { kind: 'schedule', cron: '0 0 31 2 *' }, blueprint })).toBe(400);
    expect(await bad({ name: 'M', config: { kind: 'mail', from: '', subjectContains: '', folder: '', pollMinutes: 5 }, blueprint })).toBe(400);
    expect(await bad({ name: 'M', config: { kind: 'mail', from: 'x@y.z', pollMinutes: 1 }, blueprint })).toBe(400);
    expect(await bad({ name: ' ', config: { kind: 'schedule', cron: '0 8 * * 1' }, blueprint })).toBe(400);
    expect(await bad({ name: 'S', config: { kind: 'schedule', cron: '0 8 * * 1' }, blueprint: { ...blueprint, goal: '' } })).toBe(400);
    expect(await bad({ name: 'S', config: { kind: 'schedule', cron: '0 8 * * 1' }, blueprint: { ...blueprint, title: 'x'.repeat(301) } })).toBe(400);
    expect(await bad({ name: 'S', config: { kind: 'schedule', cron: '0 8 * * 1' }, blueprint: { ...blueprint, agentId: 'nope' } })).toBe(400);
    expect(await bad({ name: 'S', config: { kind: 'webhook', preset: 'nagios' }, blueprint })).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/triggers', headers: auth, payload: { name: 'Weekly certs', config: { kind: 'schedule', cron: '0 8 * * 1' }, blueprint: { title: 'Certificates', goal: 'Check certificates that expire in 30 days' } } });
    expect(ok.statusCode).toBe(201);
    expect((ok.json() as CreateTriggerResponse).secret).toBeNull();
    expect((ok.json() as CreateTriggerResponse).trigger.blueprint).toMatchObject({ teamId: null, autoStart: false, tags: [] });
  });

  it('API clients get a trusted manual origin and cannot set one', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { title: 'By hand', goal: 'g' } });
    expect((res.json() as Ticket).origin).toEqual({ kind: 'manual', untrusted: false });
    const forged = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { title: 'x', goal: 'g', origin: { kind: 'manual', untrusted: false } } });
    expect(forged.statusCode).toBe(400);
  });

  it('management routes still need the session token', async () => {
    expect((await app.inject({ url: '/api/v1/triggers' })).statusCode).toBe(401);
    const { trigger, secret } = await createWebhook();
    // The hook secret is not a session token.
    expect((await app.inject({ url: '/api/v1/triggers', headers: { authorization: `Bearer ${secret}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `/api/v1/triggers/${trigger.id}/rotate-secret`, headers: { authorization: `Bearer ${secret}` } })).statusCode).toBe(401);
  });
});

describe('POST /hooks/:id', () => {
  it('Bearer secret, no session token: creates an untrusted ticket with the source block', async () => {
    const { trigger, secret } = await createWebhook();
    const res = await hook(trigger.id, fx('alertmanager-firing'), { authorization: `Bearer ${secret}` });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json() as { outcome: string; ticketNumber: number };
    expect(body.outcome).toBe('created');
    expect(res.body).not.toContain('InstanceDown'); // never echoes the payload
    const ticket = h.ctx.repos.tickets.list({}).items.find((t) => t.number === body.ticketNumber)!;
    expect(ticket.title).toBe('Alert: InstanceDown (2 alerts)');
    expect(ticket.origin).toEqual({ kind: 'trigger', triggerId: trigger.id, triggerKind: 'webhook', source: 'Alertmanager', untrusted: true });
    expect(ticket.goal).toContain('Investigate InstanceDown (2 alerts) on srv-web01:9100, srv-web02:9100 (critical).');
    expect(ticket.goal).toContain('Source data (untrusted, from Alertmanager)');
    expect(ticket.goal).toContain(UNTRUSTED_BEGIN);
    expect(ticket.tags).toEqual(['alert']);
    expect(ticket.costCapUsd).toBe(0.5);
    expect(ticket.status).toBe('backlog');
    expect(h.jobs()).toHaveLength(0); // autoStart false → Backlog
    const t = (await app.inject({ url: `/api/v1/triggers/${trigger.id}`, headers: auth })).json() as Trigger;
    expect(t.fireCount).toBe(1);
    expect(t.lastFiredAt).not.toBeNull();
    expect(h.events.some((e) => e.type === 'trigger.fired' && e.fire.outcome === 'created')).toBe(true);
    expect(h.security.find((e) => e.action === 'trigger.fired')).toMatchObject({ category: 'trigger', severity: 'info', actor: { type: 'trigger', id: trigger.id, name: 'Prometheus' } });
    // GET /tickets/:id shows the origin to the UI.
    const detail = (await app.inject({ url: `/api/v1/tickets/${ticket.id}`, headers: auth })).json() as { ticket: Ticket };
    expect(detail.ticket.origin?.untrusted).toBe(true);
  });

  it('HMAC signature over the raw body is accepted; wrong signature, wrong secret and missing auth are rejected', async () => {
    const { trigger, secret } = await createWebhook('generic');
    const raw = JSON.stringify(fx('generic'));
    const sig = createHmac('sha256', secret!).update(raw).digest('hex');
    const ok = await hook(trigger.id, raw, { 'x-sebeto-signature': `sha256=${sig}` });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(ok.json()).toMatchObject({ outcome: 'created' });

    const tampered = await hook(trigger.id, raw.replace('Backup failed', 'Backup OK!!!'), { 'x-sebeto-signature': `sha256=${sig}` });
    expect(tampered.statusCode).toBe(401);
    expect((await hook(trigger.id, raw, { 'x-sebeto-signature': 'sha256=nothex' })).statusCode).toBe(401);
    expect((await hook(trigger.id, raw, { authorization: 'Bearer wrong-secret' })).statusCode).toBe(401);
    expect((await hook(trigger.id, raw, { authorization: `Bearer ${TEST_TOKEN}` })).statusCode).toBe(401); // the session token is not the hook secret
    const missing = await hook(trigger.id, raw);
    expect(missing.statusCode).toBe(401);
    expect(missing.body).not.toContain('Backup');
    const rejected = fires(trigger.id).filter((f) => f.outcome === 'rejected').map((f) => f.detail);
    expect(rejected).toEqual(expect.arrayContaining(['bad signature', 'wrong secret', 'missing secret']));
    expect(h.security.filter((e) => e.action === 'trigger.rejected').every((e) => e.severity === 'warning')).toBe(true);
    // Rejected calls do not count as fires.
    expect(h.ctx.repos.triggers!.get(trigger.id)!.fireCount).toBe(1);
  });

  it('unknown id → 404 without a row; disabled → 404 with a row; lockdown → 503', async () => {
    const { trigger, secret } = await createWebhook();
    const a = { authorization: `Bearer ${secret}` };
    expect((await hook('01900000-0000-7000-8000-000000000000', {}, a)).statusCode).toBe(404);
    h.setLockdown(true);
    const locked = await hook(trigger.id, fx('alertmanager-firing'), a);
    expect(locked.statusCode).toBe(503);
    h.setLockdown(false);
    await app.inject({ method: 'PATCH', url: `/api/v1/triggers/${trigger.id}`, headers: auth, payload: { enabled: false } });
    expect((await hook(trigger.id, fx('alertmanager-firing'), a)).statusCode).toBe(404);
    expect(fires(trigger.id).map((f) => f.detail)).toEqual(['trigger is off', 'emergency stop is on']);
    expect(h.ctx.repos.tickets.list({}).items).toHaveLength(0);
  });

  it('oversize body → 413, not JSON → 415, bad JSON → 400 (all logged)', async () => {
    const { trigger, secret } = await createWebhook('generic');
    const a = { authorization: `Bearer ${secret}` };
    const big = JSON.stringify({ title: 'x', blob: 'y'.repeat(300 * 1024) });
    const tooBig = await hook(trigger.id, big, a);
    expect(tooBig.statusCode).toBe(413);
    const notJson = await app.inject({ method: 'POST', url: `/api/v1/hooks/${trigger.id}`, headers: { ...a, 'content-type': 'text/plain' }, payload: 'hello' });
    expect(notJson.statusCode).toBe(415);
    const badJson = await hook(trigger.id, '{"title": ', a);
    expect(badJson.statusCode).toBe(400);
    expect(fires(trigger.id).map((f) => f.detail).sort()).toEqual(['bad JSON', 'not JSON', 'too large']);
  });

  it('rate limit: 60 accepted calls a minute per trigger; floods of rejected rows are capped', async () => {
    const { trigger, secret } = await createWebhook('generic');
    await app.inject({ method: 'PATCH', url: `/api/v1/triggers/${trigger.id}`, headers: auth, payload: { dedupeWindowMinutes: 60 } });
    const a = { authorization: `Bearer ${secret}` };
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await hook(trigger.id, { title: 'Same alert', id: 'k1' }, a)).statusCode);
    expect(codes.filter((c) => c === 202)).toHaveLength(60);
    expect(codes.slice(-2)).toEqual([429, 429]);
    // One ticket, 59 comments (dedupe).
    expect(h.ctx.repos.tickets.list({}).items).toHaveLength(1);
    // Unauthenticated flood: answered 401 but only REJECT_ROWS_PER_MINUTE rows.
    for (let i = 0; i < 40; i++) await hook(trigger.id, {}, { authorization: 'Bearer nope' });
    const rejected = fires(trigger.id).filter((f) => f.outcome === 'rejected');
    expect(rejected.length).toBeLessThanOrEqual(22);
  });

  it('dedupe: a repeat inside the window comments on the open ticket; resolved comments, or is ignored', async () => {
    const { trigger, secret } = await createWebhook();
    const a = { authorization: `Bearer ${secret}` };
    const first = (await hook(trigger.id, fx('alertmanager-firing'), a)).json() as { outcome: string; ticketNumber: number };
    expect(first.outcome).toBe('created');
    const again = (await hook(trigger.id, fx('alertmanager-firing'), a)).json() as { outcome: string; ticketNumber: number };
    expect(again).toEqual({ outcome: 'commented', ticketNumber: first.ticketNumber });
    const resolved = (await hook(trigger.id, fx('alertmanager-resolved'), a)).json() as { outcome: string; ticketNumber: number };
    expect(resolved).toEqual({ outcome: 'commented', ticketNumber: first.ticketNumber });
    const ticket = h.ctx.repos.tickets.list({}).items[0]!;
    const msgs = h.ctx.repos.messages.listForTicket(ticket.id).items;
    expect(msgs.map((m) => [m.role, m.author])).toEqual([['system', 'Trigger Prometheus'], ['system', 'Trigger Prometheus']]);
    expect(msgs[0]!.text).toMatch(/^Happened again: InstanceDown/);
    expect(msgs[1]!.text).toMatch(/^Resolved: InstanceDown/);
    expect(msgs[1]!.text).toContain(UNTRUSTED_BEGIN);
    expect(fires(trigger.id).map((f) => f.detail)).toEqual([`resolved: comment on T-${first.ticketNumber}`, `repeat of T-${first.ticketNumber}`, `T-${first.ticketNumber}`]);

    // Once the ticket is done, a repeat opens a new ticket and a resolved one is ignored.
    h.ctx.state.transition(ticket.id, 'done', 'user');
    expect((await hook(trigger.id, fx('alertmanager-resolved'), a)).json()).toEqual({ outcome: 'ignored' });
    const second = (await hook(trigger.id, fx('alertmanager-firing'), a)).json() as { outcome: string; ticketNumber: number };
    expect(second.outcome).toBe('created');
    expect(second.ticketNumber).not.toBe(first.ticketNumber);
  });

  it('dedupe window 0 never dedupes; ignoreResolved false creates tickets for resolved payloads', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/triggers', headers: auth,
      payload: { name: 'Kuma', config: { kind: 'webhook', preset: 'uptime-kuma', ignoreResolved: false }, blueprint, dedupeWindowMinutes: 0 },
    });
    const { trigger, secret } = res.json() as CreateTriggerResponse;
    const a = { authorization: `Bearer ${secret}` };
    expect((await hook(trigger.id, fx('uptime-kuma-down'), a)).json()).toMatchObject({ outcome: 'created' });
    expect((await hook(trigger.id, fx('uptime-kuma-down'), a)).json()).toMatchObject({ outcome: 'created' });
    expect((await hook(trigger.id, fx('uptime-kuma-up'), a)).json()).toMatchObject({ outcome: 'created' });
  });

  it('autoStart enqueues a run, except during the emergency stop', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/triggers', headers: auth,
      payload: { name: 'Zabbix', config: { kind: 'webhook', preset: 'zabbix', ignoreResolved: true }, blueprint: { ...blueprint, autoStart: true } },
    });
    const { trigger, secret } = res.json() as CreateTriggerResponse;
    const out = (await hook(trigger.id, fx('zabbix-problem'), { authorization: `Bearer ${secret}` })).json() as { ticketNumber: number };
    expect(h.jobs().map((j) => j.kind)).toEqual(['run.start']);
    expect(out.ticketNumber).toBeGreaterThan(0);
  });

  it('a broken blueprint (deleted agent) gives an error fire, not a crash', async () => {
    const agent = h.ctx.repos.agents.create({ name: 'Temp' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/triggers', headers: auth, payload: { name: 'G', config: { kind: 'webhook', preset: 'generic', ignoreResolved: true }, blueprint: { ...blueprint, agentId: agent.id } } });
    const { trigger, secret } = res.json() as CreateTriggerResponse;
    h.ctx.repos.agents.delete!(agent.id);
    const out = await hook(trigger.id, fx('generic'), { authorization: `Bearer ${secret}` });
    expect(out.statusCode).toBe(202);
    expect(out.json()).toEqual({ outcome: 'error' });
    expect(fires(trigger.id)[0]).toMatchObject({ outcome: 'error' });
  });
});

describe('POST /triggers/:id/test (dry run)', () => {
  it('shows what would happen with the preset sample or a given payload; creates nothing', async () => {
    const { trigger } = await createWebhook('grafana');
    const r = (await app.inject({ method: 'POST', url: `/api/v1/triggers/${trigger.id}/test`, headers: auth, payload: {} })).json() as TriggerTestResult;
    expect(r.outcome).toBe('created');
    expect(r.title).toBe('Alert: High CPU (prod)');
    expect(r.goal).toContain('Source data (untrusted, from Grafana)');
    expect(r.detail).toMatch(/Would create a new ticket in Backlog/);
    const r2 = (await app.inject({ method: 'POST', url: `/api/v1/triggers/${trigger.id}/test`, headers: auth, payload: { payload: fx('grafana-resolved') } })).json() as TriggerTestResult;
    expect(r2.outcome).toBe('ignored');
    expect(h.ctx.repos.tickets.list({}).items).toHaveLength(0);
    expect(fires(trigger.id)).toHaveLength(0);
    const fireList = (await app.inject({ url: `/api/v1/triggers/${trigger.id}/fires`, headers: auth })).json() as TriggerFire[];
    expect(fireList).toEqual([]);
  });

  it('schedule and mail dry runs', async () => {
    const s = (await app.inject({ method: 'POST', url: '/api/v1/triggers', headers: auth, payload: { name: 'Certs', config: { kind: 'schedule', cron: '0 8 * * 1' }, blueprint: { ...blueprint, title: 'Weekly: {{title}}', goal: 'Check certificates ({{date}})', teamId: 'auto' } } })).json() as CreateTriggerResponse;
    const rs = (await app.inject({ method: 'POST', url: `/api/v1/triggers/${s.trigger.id}/test`, headers: auth, payload: {} })).json() as TriggerTestResult;
    expect(rs).toMatchObject({ outcome: 'created', title: 'Weekly: Certs', teamId: null });
    expect(rs.goal).not.toContain('untrusted');
    expect(rs.detail).toContain('automatically');
    const m = (await app.inject({ method: 'POST', url: '/api/v1/triggers', headers: auth, payload: { name: 'Backups', config: { kind: 'mail', from: 'monitoring', subjectContains: '', folder: '', pollMinutes: 5 }, blueprint: { ...blueprint, title: 'Mail: {{subject}}' } } })).json() as CreateTriggerResponse;
    const rm = (await app.inject({ method: 'POST', url: `/api/v1/triggers/${m.trigger.id}/test`, headers: auth, payload: { payload: { from: 'nas@backup.example.org', subject: 'Job failed', text: 'details' } } })).json() as TriggerTestResult;
    expect(rm.title).toBe('Mail: Job failed');
    expect(rm.goal).toContain('Source data (untrusted, from mail from backup.example.org)');
  });
});
