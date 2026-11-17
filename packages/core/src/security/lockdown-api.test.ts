/** v0.5 I: the emergency stop is enforced at the API too (409 lockdown + one security event per refusal). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LOCKDOWN_MESSAGE, type AgentEvent, type RuntimeAdapter, type SecurityEvent, type Ticket } from '@sebeto/shared';
import type { AppContext, CoreConfig, Snapshots } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createJobQueue } from '../queue/index.js';
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createPermissionGate } from '../gate/index.js';
import { createRuntimeRegistry } from '../runtimes/index.js';
import { createScheduler } from '../scheduler/scheduler.js';
import { createServer } from '../api/server.js';
import { createTicket, startTicket } from '../services/tickets.js';
import { createSecurityLog, type SecurityLog } from './log.js';
import { instrumentContext } from './instrument.js';
import { USER_ACTOR, runWithActor } from './actor.js';
import { emergencyStop, releaseLockdown } from './service.js';

const TOKEN = 'lockdown-api-test-token-0123456789';
const auth = { authorization: `Bearer ${TOKEN}` };

const quietAdapter: RuntimeAdapter = {
  id: 'mock', displayName: 'Mock', capabilities: { tools: false, resume: true, costReport: true },
  detect: async () => ({ installed: true }), models: async () => [],
  async *run(): AsyncGenerator<AgentEvent> { yield { kind: 'done', costUsd: 0 }; },
};

let dir: string;
let db: Database.Database;
let ctx: AppContext;
let sec: SecurityLog;
let app: FastifyInstance;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-lockdown-'));
  const opened = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir });
  db = opened.db;
  const { repos } = opened;
  const bus = createEventBus();
  const queue = createJobQueue(db);
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const snapshots: Snapshots = { init: async () => undefined, commit: async () => 'oid-1', restore: async () => 'oid-2', diff: async () => [] };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const config: CoreConfig = { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 2, runtimes: ['mock'], version: 'test' };
  ctx = { config, log, repos, queue, bus, state, gate, snapshots, runtimes: createRuntimeRegistry([quietAdapter]) };
  ctx.securityLog = createSecurityLog({ db, workspaceDir: dir, bus, log, repos });
  sec = ctx.securityLog as SecurityLog;
  instrumentContext(ctx);
  app = await createServer(ctx);
});

afterEach(async () => {
  await app.close();
  ctx.repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: auth, ...(payload !== undefined ? { payload: payload as object } : {}) });

const events = (): SecurityEvent[] => {
  const out: SecurityEvent[] = [];
  for (const b of sec.batches({})) out.push(...b);
  return out;
};
const refusals = () => events().filter((e) => e.action === 'system.run_refused');
const queued = () => (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'`).get() as { n: number }).n;

describe('emergency stop at the API (v0.5 I)', () => {
  it('refuses every path that would wake an agent with 409 lockdown, one security event each; reading and plain create still work', async () => {
    const agent = ctx.repos.agents.create({ name: 'Ops', runtime: 'mock' });
    const t = (await req('POST', '/tickets', { title: 'Printer offline', goal: 'Check the spooler', agentId: agent.id })).json() as Ticket;
    const perm = ctx.gate.check({ ticketId: t.id, runId: null, agentId: agent.id, key: 'script.run', title: 'Run Get-Service', detail: 'Get-Service', command: { shell: 'powershell', command: 'Get-Service' } });
    if (perm.outcome !== 'pending') throw new Error('expected pending');

    runWithActor(USER_ACTOR, () => emergencyStop(ctx, 'drill'));
    const jobsBefore = queued();
    const ticketsBefore = ctx.repos.tickets.list({ limit: 100 }).items.length;

    const refused = [
      { route: 'POST /tickets/:id/start', res: await req('POST', `/tickets/${t.id}/start`) },
      { route: 'POST /tickets (start)', res: await req('POST', '/tickets', { title: 'Go now', goal: 'x', agentId: agent.id, start: true }) },
      { route: 'POST /tickets/:id/messages', res: await req('POST', `/tickets/${t.id}/messages`, { text: 'please continue' }) },
      { route: 'POST /permissions/:id/decide', res: await req('POST', `/permissions/${perm.request.id}/decide`, { decision: 'allow' }) },
      { route: 'POST /intake/accept (start)', res: await req('POST', '/intake/accept', { start: true, proposals: [{ key: 'a', title: 'Backup check', goal: 'x', agentId: agent.id, costCapUsd: 0.3, dependsOn: [] }] }) },
    ];
    for (const { route, res } of refused) {
      expect([route, res.statusCode, res.json().error?.message]).toEqual([route, 409, LOCKDOWN_MESSAGE]);
      expect(res.json()).toEqual({ error: { code: 'lockdown', message: LOCKDOWN_MESSAGE } });
    }
    // Nothing was created or queued; the permission request is still pending; no message was saved.
    expect(queued()).toBe(jobsBefore);
    expect(ctx.repos.tickets.list({ limit: 100 }).items.length).toBe(ticketsBefore);
    expect(ctx.repos.permissions.get(perm.request.id)!.state).toBe('pending');
    expect(ctx.repos.messages.listForTicket(t.id, { limit: 10 }).items).toHaveLength(0);

    // One security event per refusal, with the route.
    const evs = refusals();
    expect(evs.map((e) => e.data?.['route'])).toEqual(refused.map((r) => r.route));
    for (const e of evs) expect(e).toMatchObject({ category: 'system', severity: 'warning', actor: { type: 'user' }, data: { reason: 'lockdown' } });
    expect(evs[0]).toMatchObject({ ticketId: t.id, agentId: agent.id });
    expect(evs[0]!.summary).toMatch(/T-\d+/);
    expect(sec.verify().ok).toBe(true);

    // Still allowed: create without start, intake accept without start, reads, moving, editing.
    const plain = await req('POST', '/tickets', { title: 'Later', goal: 'x', agentId: agent.id });
    expect(plain.statusCode).toBe(201);
    expect((await req('POST', '/intake/accept', { proposals: [{ key: 'a', title: 'Later too', goal: 'x', agentId: agent.id, costCapUsd: 0.3, dependsOn: [] }] })).statusCode).toBe(201);
    expect((await req('GET', `/tickets/${t.id}`)).statusCode).toBe(200);
    expect((await req('GET', '/tickets')).statusCode).toBe(200);
    expect((await req('PATCH', `/tickets/${t.id}`, { title: 'Printer offline (2nd floor)' })).statusCode).toBe(200);
    expect(queued()).toBe(jobsBefore);
    expect(refusals()).toHaveLength(refused.length);

    // Released: the same requests work again.
    releaseLockdown(ctx);
    expect((await req('POST', `/tickets/${t.id}/start`)).statusCode).toBe(202);
    expect((await req('POST', `/permissions/${perm.request.id}/decide`, { decision: 'deny' })).statusCode).toBe(200);
    expect(refusals()).toHaveLength(refused.length);
  });

  it('internal callers: startTicket is refused too; the scheduler enqueues no check-ins or deferred starts', async () => {
    const agent = ctx.repos.agents.create({ name: 'Ops', runtime: 'mock', heartbeatMinutes: 1 });
    const t = await createTicket(ctx, { title: 'Disk full on FS01', goal: 'x', agentId: agent.id });
    ctx.repos.tickets.update(t.id, { status: 'in_progress' });
    ctx.repos.messages.create({ ticketId: t.id, role: 'user', author: 'You', text: 'any news?' });
    runWithActor(USER_ACTOR, () => emergencyStop(ctx, 'drill'));
    ctx.repos.agents.update(agent.id, { paused: false }); // resumed by hand during the stop
    expect(() => startTicket(ctx, t.id)).toThrow(expect.objectContaining({ statusCode: 409, code: 'lockdown' }));
    const scheduler = createScheduler(ctx, { intervalMs: 60_000 });
    expect(scheduler.tick()).toEqual({ heartbeats: [], starts: [] });
    releaseLockdown(ctx);
    expect(scheduler.tick().heartbeats).toEqual([t.id]);
  });
});
