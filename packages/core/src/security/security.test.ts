import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENESIS_HASH, uuidv7, type AgentEvent, type RuntimeAdapter, type SecurityEvent, type WsEvent } from '@sebeto/shared';
import type { AppContext, CoreConfig, Snapshots } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createJobQueue } from '../queue/index.js';
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createPermissionGate } from '../gate/index.js';
import { createRuntimeRegistry } from '../runtimes/index.js';
import { createExecutor, type ExecutorHandle } from '../executor/executor.js';
import { createScheduler } from '../scheduler/scheduler.js';
import { createServer } from '../api/server.js';
import { createTicket, decidePermission, updateTicket } from '../services/tickets.js';
import { createAgent, updateAgent } from '../services/agents.js';
import { canonicalJson, eventHash } from './hash.js';
import { createSecurityLog, type SecurityLog } from './log.js';
import { instrumentContext } from './instrument.js';
import { redactData, redactSummary, redactText, isSecretKey } from './redact.js';
import { USER_ACTOR, runWithActor } from './actor.js';
import { createAuthRefusalRecorder, csvCell, emergencyStop, exportSecurityLog, releaseLockdown, verifySecurityLog } from './service.js';

const TOKEN = 'security-test-token-0123456789';

/** Adapter that keeps "working" until it is aborted (to test emergency stop). */
function slowAdapter(): RuntimeAdapter {
  return {
    id: 'mock', displayName: 'Slow', capabilities: { tools: false, resume: true, costReport: true },
    detect: async () => ({ installed: true }), models: async () => [],
    async *run(r): AsyncGenerator<AgentEvent> {
      yield { kind: 'text', text: 'working…' };
      yield { kind: 'tool', name: 'fetch_url', summary: 'Read web page example.com' };
      await new Promise<void>((resolve) => {
        if (r.signal.aborted) return resolve();
        r.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { kind: 'done', costUsd: 0.002, tokensIn: 10, tokensOut: 5 };
    },
  };
}

interface H { dir: string; db: Database.Database; ctx: AppContext; sec: SecurityLog; events: WsEvent[]; executor: ExecutorHandle }

function harness(): H {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-security-'));
  const { repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir });
  const bus = createEventBus();
  const events: WsEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const queue = createJobQueue(db);
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const snapshots: Snapshots = { init: async () => undefined, commit: async () => 'oid-1', restore: async () => 'oid-2', diff: async () => [] };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const config: CoreConfig = { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 2, runtimes: ['mock'], version: 'test' };
  const ctx: AppContext = { config, log, repos, queue, bus, state, gate, snapshots, runtimes: createRuntimeRegistry([slowAdapter()]) };
  ctx.securityLog = createSecurityLog({ db, workspaceDir: dir, bus, log, repos });
  instrumentContext(ctx);
  const executor = createExecutor(ctx, { pollMs: 10_000 });
  ctx.executor = executor;
  return { dir, db, ctx, sec: ctx.securityLog as SecurityLog, events, executor };
}

let h: H;
beforeEach(() => { h = harness(); });
afterEach(async () => {
  await h.executor.stop();
  h.ctx.repos.close();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const all = (sec: SecurityLog) => {
  const out: SecurityEvent[] = [];
  for (const b of sec.batches({})) out.push(...b);
  return out;
};

describe('hash chain and verify', () => {
  it('canonical JSON sorts keys at every level and the chain links every event', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    const a = h.sec.record({ category: 'system', action: 'system.test', summary: 'first' })!;
    const b = h.sec.record({ category: 'config', action: 'config.test', severity: 'notice', summary: 'second', data: { x: 1 } })!;
    expect(a.seq).toBe(1);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    // Re-read from the DB gives the same hash.
    expect(eventHash(h.sec.get(b.id)!)).toBe(b.hash);
    expect(h.events.some((e) => e.type === 'security.event' && e.event.id === b.id)).toBe(true);
    const v = h.sec.verify();
    expect(v).toMatchObject({ ok: true, checked: 2, firstSeq: 1, lastSeq: 2, brokenAtSeq: null });
  });

  it('many records in one transaction stay consistent', () => {
    h.ctx.repos.tx(() => { for (let i = 0; i < 50; i++) h.sec.record({ category: 'tool', action: 'tool.x', summary: `n${i}` }); });
    const evs = all(h.sec);
    expect(evs.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(h.sec.verify().ok).toBe(true);
  });

  it('UPDATE is refused by the database; a deleted middle row and a rewritten row are detected', () => {
    for (let i = 0; i < 5; i++) h.sec.record({ category: 'system', action: 'system.test', summary: `e${i}` });
    expect(() => h.db.prepare("UPDATE security_events SET summary = 'x' WHERE seq = 2").run()).toThrow(/append-only/);

    // Tamper on a copy of the database.
    const copy = path.join(h.dir, 'copy.db');
    h.db.prepare('VACUUM INTO ?').run(copy);
    const db2 = new Database(copy);
    db2.prepare('DELETE FROM security_events WHERE seq = 3').run();
    const sec2 = createSecurityLog({ db: db2 });
    expect(sec2.verify()).toMatchObject({ ok: false, brokenAtSeq: 4 });
    expect(sec2.verify().problem).toMatch(/missing/);

    // Rewrite a row (delete + insert with a changed summary but the old hash).
    const row = db2.prepare('SELECT * FROM security_events WHERE seq = 2').get() as Record<string, unknown>;
    db2.prepare('DELETE FROM security_events WHERE seq = 2').run();
    db2.prepare(`INSERT INTO security_events (seq, id, at, category, action, severity, actor_type, actor_id, actor_name, ticket_id, ticket_number, agent_id, session_id, run_id, summary, data, prev_hash, hash)
      VALUES (@seq, @id, @at, @category, @action, @severity, @actor_type, @actor_id, @actor_name, @ticket_id, @ticket_number, @agent_id, @session_id, @run_id, 'innocent', @data, @prev_hash, @hash)`).run(row);
    expect(sec2.verify()).toMatchObject({ ok: false, brokenAtSeq: 2 });
    expect(sec2.verify().problem).toMatch(/changed/);
    db2.close();

    // The original is still fine.
    expect(verifySecurityLog(h.ctx).ok).toBe(true);
    expect(h.sec.list({ limit: 1 }).items[0]!.action).toBe('system.integrity_checked');
  });

  it('retention deletes only the oldest events, keeps the newest, records the count; verify still passes', () => {
    for (let i = 0; i < 4; i++) h.sec.record({ category: 'system', action: 'system.test', summary: `e${i}` });
    expect(h.sec.prune()).toBe(0); // keep forever by default
    h.sec.updateSettings({ retentionDays: 1 });
    // Pretend the clock is 2 days ahead: everything is old, but the newest event stays.
    const removed = h.sec.prune(Date.now() + 2 * 86_400_000);
    expect(removed).toBe(3);
    const evs = all(h.sec);
    expect(evs[0]!.seq).toBe(4);
    expect(evs.at(-1)!.action).toBe('system.retention_pruned');
    expect(evs.at(-1)!.data).toMatchObject({ removed: 3 });
    expect(h.sec.verify()).toMatchObject({ ok: true, firstSeq: 4 });
  });

  it('scheduler housekeeping runs the retention prune', () => {
    h.sec.record({ category: 'system', action: 'system.test', summary: 'old' });
    h.sec.record({ category: 'system', action: 'system.test', summary: 'new' });
    h.sec.updateSettings({ retentionDays: 1 });
    const sched = createScheduler(h.ctx, { now: () => Date.now() + 3 * 86_400_000 });
    sched.tick();
    expect(all(h.sec).some((e) => e.action === 'system.retention_pruned')).toBe(true);
  });

  it('settings persist with the lockdown state; the daily JSONL mirror writes one line per event', () => {
    h.sec.updateSettings({ jsonlMirror: true });
    h.sec.setLockdown(true, 'test');
    const e = h.sec.record({ category: 'system', action: 'system.test', summary: 'mirrored' })!;
    const file = path.join(h.dir, 'logs', 'security', `${e.at.slice(0, 10)}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1)!).hash).toBe(e.hash);
    const again = createSecurityLog({ db: h.db, workspaceDir: h.dir });
    expect(again.settings()).toEqual({ retentionDays: 0, jsonlMirror: true });
    expect(again.lockdown()).toBe(true);
    expect(() => h.sec.updateSettings({ retentionDays: -1 })).toThrow();
  });

  it('record never throws', () => {
    const broken = createSecurityLog({ db: h.db, log: { info() {}, warn() {}, error() {}, debug() {} } });
    h.db.close();
    expect(broken.record({ category: 'system', action: 'x', summary: 'y' })).toBeNull();
  });
});

describe('redaction', () => {
  it('removes secret values by key and by shape, keeps useful context', () => {
    expect(isSecretKey('password')).toBe(true);
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('client_secret')).toBe(true);
    expect(isSecretKey('Authorization')).toBe(true);
    expect(isSecretKey('accessToken')).toBe(true);
    expect(isSecretKey('tokensIn')).toBe(false);
    expect(isSecretKey('key')).toBe(false);
    const d = redactData({
      password: 'hunter2', nested: { apiKey: 'abc', list: [{ cookie: 'session=1' }] }, tokensIn: 42,
      header: 'Authorization: Bearer abcdefghijklmnop', url: 'https://user:pw@example.com/hook?token=SECRET123&page=2',
      blob: 'key is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ok',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', path: 'tickets/T-12/outbox/2026-11-12-reply.md',
      after: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b', to: ['ops@example.com'],
    })!;
    expect(d['password']).toBe('<redacted>');
    expect(d['nested']).toEqual({ apiKey: '<redacted>', list: [{ cookie: '<redacted>' }] });
    expect(d['tokensIn']).toBe(42);
    expect(d['header']).not.toContain('abcdefghijklmnop');
    expect(d['url']).toBe('https://<redacted>@example.com/hook?token=<redacted>&page=2');
    expect(d['blob']).toBe('key is <redacted> ok');
    expect(d['jwt']).not.toContain('eyJzdWIiOiIxIn0');
    expect(d['path']).toBe('tickets/T-12/outbox/2026-11-12-reply.md');
    expect(d['after']).toBe('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'); // git ids are kept
    expect(d['to']).toEqual(['ops@example.com']);
    expect(redactText('password=abc123 and secret: xyz')).toBe('password=<redacted> and secret: <redacted>');
    expect(redactText('ghp_abcdefghijklmnop1234 sk-ant-abcdefghijklmnop')).toBe('<redacted> <redacted>');
    expect(redactSummary('line1\nline2')).toBe('line1 line2');
    // Huge data is cut down.
    expect(JSON.stringify(redactData({ big: 'x'.repeat(100_000), arr: Array.from({ length: 500 }, (_, i) => i) })).length).toBeLessThan(9000);
  });

  it('record() redacts before hashing and storing', () => {
    const e = h.sec.record({ category: 'auth', action: 'auth.test', summary: 'login with Bearer abcdefghijklmnopqrstu', data: { password: 'p@ss', user: 'alex' } })!;
    const row = h.db.prepare('SELECT summary, data FROM security_events WHERE id = ?').get(e.id) as { summary: string; data: string };
    expect(row.summary).not.toContain('abcdefghijklmnopqrstu');
    expect(row.data).not.toContain('p@ss');
    expect(JSON.parse(row.data)).toEqual({ password: '<redacted>', user: 'alex' });
  });
});

describe('coverage of existing code', () => {
  it('mirrors audit events, sessions and runs with agent/session/run ids', async () => {
    const agent = h.ctx.repos.agents.create({ name: 'Analyst', runtime: 'mock' });
    const ticket = await createTicket(h.ctx, { title: 'Check certificates', goal: 'List expiring certs', agentId: agent.id });
    h.ctx.queue.enqueue('run.start', { ticketId: ticket.id });
    h.executor.tick();
    await new Promise((r) => setTimeout(r, 30));
    h.executor.cancel(ticket.id);
    await h.executor.idle();

    const evs = all(h.sec);
    const actions = evs.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining([
      'agent.created', 'ticket.created', 'session.started', 'session.run_started', 'ticket.status_changed', 'tool.fetch_url', 'session.run_ended',
    ]));
    expect(actions).not.toContain('ticket.activity'); // "Ticket created" audit is not doubled
    const tool = evs.find((e) => e.action === 'tool.fetch_url')!;
    expect(tool).toMatchObject({ category: 'tool', agentId: agent.id, ticketNumber: ticket.number, actor: { type: 'agent', id: agent.id, name: 'Analyst' } });
    expect(tool.runId).toBeTruthy();
    expect(tool.sessionId).toBeTruthy();
    const ended = evs.find((e) => e.action === 'session.run_ended')!;
    expect(ended.data).toMatchObject({ status: 'cancelled', costUsd: 0.002, tokensIn: 10, tokensOut: 5 });
    expect(ended.severity).toBe('notice');
    expect(h.sec.verify().ok).toBe(true);
  });

  it('permission requests: asked (prod = warning), allowed, denied, always allowed, trusted command added/removed', async () => {
    const agent = h.ctx.repos.agents.create({ name: 'Ops', runtime: 'mock' });
    const ticket = await createTicket(h.ctx, { title: 'Restart service', goal: 'x', agentId: agent.id });
    const ask = (key: 'script.run' | 'prod.change', detail: string) => {
      const d = h.ctx.gate.check({ ticketId: ticket.id, runId: null, agentId: agent.id, key, title: `Run ${detail}`, detail, command: key === 'script.run' ? { shell: 'powershell', command: detail } : null });
      if (d.outcome !== 'pending') throw new Error('expected pending');
      return d.request;
    };
    const r1 = ask('prod.change', 'Restart-Service W3SVC');
    const r2 = ask('script.run', 'Get-PSDrive');
    const r3 = ask('script.run', 'Get-Service');
    runWithActor(USER_ACTOR, () => {
      decidePermission(h.ctx, r1.id, 'deny');
      decidePermission(h.ctx, r2.id, 'allow');
      decidePermission(h.ctx, r3.id, 'always');
    });
    const evs = all(h.sec).filter((e) => e.category === 'permission');
    const by = (a: string) => evs.filter((e) => e.action === a);
    expect(by('permission.requested').map((e) => e.severity)).toEqual(['warning', 'notice', 'notice']);
    expect(by('permission.denied')[0]).toMatchObject({ severity: 'warning', actor: { type: 'user' } });
    expect(by('permission.allowed')).toHaveLength(1);
    expect(by('permission.always_allowed')).toHaveLength(1);
    const added = by('permission.trusted_command_added');
    expect(added[0]).toMatchObject({ severity: 'warning' });
    h.ctx.repos.trusted.remove(added[0]!.data!['trustedCommandId'] as string);
    expect(all(h.sec).some((e) => e.action === 'permission.trusted_command_removed')).toBe(true);
    const s = h.sec.summary(24);
    expect(s.deniedPermissions).toBe(1);
  });

  it('agent changes: permissions field by field (loosening = warning), pause/resume, other fields, reassign', async () => {
    const agent = runWithActor(USER_ACTOR, () => createAgent(h.ctx, { name: 'Writer', runtime: 'mock' }));
    runWithActor(USER_ACTOR, () => updateAgent(h.ctx, agent.id, { permissions: { 'email.send': 'allow', 'web.read': 'never' }, monthlyBudgetUsd: 99 }));
    runWithActor(USER_ACTOR, () => updateAgent(h.ctx, agent.id, { paused: true }));
    runWithActor(USER_ACTOR, () => updateAgent(h.ctx, agent.id, { paused: false }));
    const evs = all(h.sec).filter((e) => e.agentId === agent.id);
    const perms = evs.filter((e) => e.action === 'agent.permission_changed');
    expect(perms.map((e) => [e.data!['key'], e.data!['from'], e.data!['to'], e.severity])).toEqual([
      ['web.read', 'ask', 'never', 'notice'],
      ['email.send', 'ask', 'allow', 'warning'],
    ]);
    expect(perms[1]!.summary).toContain('less safe');
    expect(perms[1]!.actor.type).toBe('user');
    expect(evs.find((e) => e.action === 'agent.updated')!.data).toMatchObject({ changes: { monthlyBudgetUsd: { to: 99 } } });
    expect(evs.filter((e) => e.action === 'agent.paused' || e.action === 'agent.resumed').map((e) => e.action)).toEqual(['agent.paused', 'agent.resumed']);

    const other = h.ctx.repos.agents.create({ name: 'Other', runtime: 'mock' });
    const t = await createTicket(h.ctx, { title: 'T', goal: 'g', agentId: agent.id });
    updateTicket(h.ctx, t.id, { agentId: other.id });
    expect(all(h.sec).find((e) => e.action === 'ticket.reassigned')).toMatchObject({ ticketId: t.id, data: { from: agent.id, to: other.id } });
  });

  it('settings store changes are logged', () => {
    const ctx = h.ctx;
    let state = { intakeModel: 'haiku' as string | null, setupCompleted: false };
    ctx.settings = { get: () => ({ ...state }), update: (p) => (state = { ...state, ...p }) };
    (ctx as unknown as Record<symbol, boolean>)[Symbol.for('sebeto.security.instrumented')] = false;
    instrumentContext(ctx);
    ctx.settings.update({ intakeModel: 'sonnet' });
    expect(all(h.sec).find((e) => e.action === 'config.settings_changed')!.data).toMatchObject({ changes: { intakeModel: { from: 'haiku', to: 'sonnet' } } });
  });
});

describe('refused API requests', () => {
  it('records bad tokens and hosts through the server, rate limited per address and reason', async () => {
    const app = await createServer(h.ctx);
    try {
      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ url: '/api/v1/health', headers: { authorization: 'Bearer wrong-token-xxxxxxxx' } })).statusCode).toBe(401);
      }
      expect((await app.inject({ url: '/api/v1/health' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/health', headers: { host: 'evil.example' } })).statusCode).toBe(403);
      const refused = all(h.sec).filter((e) => e.category === 'auth');
      expect(refused.map((e) => e.action).sort()).toEqual(['auth.refused.bad_token', 'auth.refused.forbidden_host', 'auth.refused.missing_token']);
      expect(refused.every((e) => e.severity === 'warning')).toBe(true);
      expect(JSON.stringify(refused)).not.toContain('wrong-token');

      // An authorised request is attributed to the user.
      const res = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: { authorization: `Bearer ${TOKEN}` }, payload: { name: 'Via API' } });
      expect(res.statusCode).toBe(201);
      expect(all(h.sec).find((e) => e.action === 'agent.created' && e.data!['name'] === 'Via API')!.actor.type).toBe('user');
    } finally {
      await app.close();
    }
  });

  it('the recorder sends one event per window and reports the suppressed count', () => {
    let t = 0;
    const rec = createAuthRefusalRecorder(h.ctx, { now: () => t });
    for (let i = 0; i < 100; i++) rec({ reason: 'bad_token', ip: '10.0.0.5', method: 'GET', path: '/api/v1/tickets' });
    rec({ reason: 'bad_token', ip: '10.0.0.6', method: 'GET', path: '/api/v1/tickets' });
    expect(all(h.sec)).toHaveLength(2);
    t = 61_000;
    rec({ reason: 'bad_token', ip: '10.0.0.5', method: 'GET', path: '/api/v1/tickets' });
    const evs = all(h.sec);
    expect(evs).toHaveLength(3);
    expect(evs[2]!.data).toMatchObject({ suppressedBefore: 99 });
  });
});

describe('emergency stop', () => {
  it('cancels runs and queued work, pauses agents, turns off triggers, refuses new runs, then releases', async () => {
    const a1 = h.ctx.repos.agents.create({ name: 'A1', runtime: 'mock' });
    h.ctx.repos.agents.create({ name: 'A2', runtime: 'mock' });
    const t1 = await createTicket(h.ctx, { title: 'Running', goal: 'g', agentId: a1.id });
    const t2 = await createTicket(h.ctx, { title: 'Queued', goal: 'g', agentId: a1.id });
    const now = new Date().toISOString();
    h.db.prepare(`INSERT INTO triggers (id, name, kind, enabled, config, blueprint, created_at, updated_at) VALUES (?, 'alerts', 'webhook', 1, '{}', '{}', ?, ?)`).run(uuidv7(), now, now);
    h.db.prepare(`INSERT INTO triggers (id, name, kind, enabled, config, blueprint, created_at, updated_at) VALUES (?, 'off', 'schedule', 0, '{}', '{}', ?, ?)`).run(uuidv7(), now, now);

    h.ctx.queue.enqueue('run.start', { ticketId: t1.id });
    h.executor.tick();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.executor.activeRuns()).toBe(1);
    h.ctx.queue.enqueue('run.start', { ticketId: t2.id }, { runAfter: new Date(Date.now() + 60_000) });

    const result = runWithActor(USER_ACTOR, () => emergencyStop(h.ctx, 'Suspicious outbound email'));
    expect(result).toEqual({ ok: true, cancelledRuns: 2, pausedAgents: 2, disabledTriggers: 1 });
    await h.executor.idle();
    expect(h.ctx.repos.runs.listForTicket(t1.id)[0]!.status).toBe('cancelled');
    expect(h.ctx.repos.agents.list().every((a) => a.paused)).toBe(true);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM triggers WHERE enabled = 1').get() as { n: number }).n).toBe(0);
    expect(h.ctx.securityLog!.lockdown()).toBe(true);
    expect(h.events.some((e) => e.type === 'security.lockdown' && e.active)).toBe(true);
    const crit = all(h.sec).filter((e) => e.severity === 'critical').map((e) => e.action);
    expect(crit).toEqual(['system.emergency_stop', 'system.emergency_stop.runs_cancelled', 'system.emergency_stop.agents_paused', 'system.emergency_stop.triggers_disabled']);

    // New runs are refused while locked down.
    h.ctx.queue.enqueue('run.start', { ticketId: t2.id });
    expect(h.executor.tick()).toBe(0);
    expect(h.ctx.repos.audit.listForTicket(t2.id).items.at(-1)!.summary).toMatch(/Emergency stop is on/);
    expect(all(h.sec).some((e) => e.action === 'system.run_refused' && e.ticketId === t2.id)).toBe(true);
    expect(h.sec.summary().lockdown).toBe(true);

    // Release: lockdown off, agents stay paused, runs can start again.
    releaseLockdown(h.ctx);
    expect(h.ctx.securityLog!.lockdown()).toBe(false);
    expect(all(h.sec).at(-1)).toMatchObject({ action: 'system.lockdown_released', severity: 'critical' });
    expect(h.ctx.repos.agents.list().every((a) => a.paused)).toBe(true);
    h.ctx.queue.enqueue('run.start', { ticketId: t2.id });
    expect(h.executor.tick()).toBe(1);
    expect(h.sec.verify().ok).toBe(true);
  });
});

describe('API and export', () => {
  it('lists with filters and cursor, summary, verify, export JSONL + CSV, settings', async () => {
    for (let i = 0; i < 7; i++) h.sec.record({ category: i % 2 ? 'tool' : 'config', action: `x.${i}`, severity: i === 3 ? 'warning' : 'info', summary: i === 5 ? '=HYPERLINK("http://evil")' : `event ${i}` });
    const app = await createServer(h.ctx);
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      const p1 = (await app.inject({ url: '/api/v1/security/events?limit=3', headers: auth })).json();
      expect(p1.items.map((e: SecurityEvent) => e.seq)).toEqual([7, 6, 5]);
      const p2 = (await app.inject({ url: `/api/v1/security/events?limit=3&cursor=${p1.nextCursor}`, headers: auth })).json();
      expect(p2.items.map((e: SecurityEvent) => e.seq)).toEqual([4, 3, 2]);
      const tools = (await app.inject({ url: '/api/v1/security/events?category=tool&severity=warning,info', headers: auth })).json();
      expect(tools.items.every((e: SecurityEvent) => e.category === 'tool')).toBe(true);
      expect((await app.inject({ url: '/api/v1/security/events?q=event%203', headers: auth })).json().items).toHaveLength(1);
      expect((await app.inject({ url: '/api/v1/security/events?category=nope', headers: auth })).statusCode).toBe(400);

      const sum = (await app.inject({ url: '/api/v1/security/summary', headers: auth })).json();
      expect(sum).toMatchObject({ hours: 24, total: 7, lockdown: false });
      expect(sum.bySeverity.warning).toBe(1);
      expect((await app.inject({ url: '/api/v1/security/verify', headers: auth })).json()).toMatchObject({ ok: true, checked: 7 });

      const jsonl = await app.inject({ url: '/api/v1/security/export?format=jsonl', headers: auth });
      expect(jsonl.headers['content-disposition']).toMatch(/attachment; filename="sebeto-security-\d{8}-\d{6}\.jsonl"/);
      const lines = jsonl.body.trim().split('\n').map((l) => JSON.parse(l) as SecurityEvent);
      expect(lines[0]!.seq).toBe(1);
      expect(lines.every((e) => eventHash(e) === e.hash)).toBe(true);

      const csv = await app.inject({ url: '/api/v1/security/export?format=csv', headers: auth });
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.body).toContain('"\'=HYPERLINK(""http://evil"")"');
      expect(csv.body.split('\r\n')[0]).toContain('seq,at,severity');

      expect((await app.inject({ method: 'PUT', url: '/api/v1/security/settings', headers: auth, payload: { retentionDays: 90, jsonlMirror: true } })).json()).toEqual({ retentionDays: 90, jsonlMirror: true });
      expect((await app.inject({ url: '/api/v1/security/settings', headers: auth })).json()).toEqual({ retentionDays: 90, jsonlMirror: true });
      expect((await app.inject({ method: 'PUT', url: '/api/v1/security/settings', headers: auth, payload: { retentionDays: -3 } })).statusCode).toBe(400);
      expect(all(h.sec).find((e) => e.action === 'config.security_settings_changed')!.severity).toBe('warning');

      expect((await app.inject({ method: 'POST', url: '/api/v1/security/emergency-stop', headers: auth, payload: {} })).statusCode).toBe(400);
      const stop = await app.inject({ method: 'POST', url: '/api/v1/security/emergency-stop', headers: auth, payload: { reason: 'drill' } });
      expect(stop.json()).toMatchObject({ ok: true });
      expect((await app.inject({ url: '/api/v1/security/status', headers: auth })).json()).toMatchObject({ active: true, reason: 'drill' });
      expect((await app.inject({ method: 'POST', url: '/api/v1/security/emergency-stop/release', headers: auth })).json()).toEqual({ ok: true });

      const spec = (await app.inject({ url: '/api/v1/openapi.json', headers: auth })).json();
      expect(spec.paths['/security/events']).toBeTruthy();
      expect(spec.components.schemas.SecurityEvent).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('CSV cells defuse formulas', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+cmd')).toBe(`"'+cmd"`);
    expect(csvCell('-2')).toBe(`"'-2"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('a "quote"')).toBe('"a ""quote"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    const exp = exportSecurityLog(h.ctx, { format: 'csv' });
    expect(exp.fileName).toMatch(/\.csv$/);
  });
});
