/**
 * Allow-once consumption against the real SQLite repos: it is stored on the request
 * (`permission_requests.consumed_at`), so it survives a restart, and the v4 migration backfills
 * it from the audit markers written by older versions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, uuidv7 } from '@sebeto/shared';
import type { Repos } from '../contracts.js';
import { MIGRATIONS, openDatabase } from '../storage/index.js';
import { createPermissionGate } from './index.js';
import { createFakes } from './test-fakes.js';

let dir: string;
let file: string;
let repos: Repos;
let db: Database.Database;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `sebeto-gate-${uuidv7()}`);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'sebeto.db');
  ({ repos, db } = openDatabase({ file, workspaceDir: dir }));
});

afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A gate over the given repos; state/queue/bus are fakes (they don't matter here). */
function gateOver(r: Repos) {
  const f = createFakes();
  return createPermissionGate({ repos: r, state: f.state, queue: f.queue, bus: f.bus });
}

function seed(r: Repos) {
  const agent = r.agents.create({ name: 'Ops', runtime: 'mock', permissions: { ...DEFAULT_PERMISSIONS } });
  const ticket = r.tickets.create({ title: 'Disk space report', goal: 'Check free space', agentId: agent.id });
  const session = r.sessions.create({ ticketId: ticket.id, agentId: agent.id, runtime: 'mock', model: null, reason: 'new' });
  const run = r.runs.create({ sessionId: session.id, ticketId: ticket.id, jobId: null, trigger: 'start' });
  return { ticketId: ticket.id, runId: run.id, agentId: agent.id, title: 'Read a page', detail: 'https://example.com/cve' };
}

function reopen() {
  repos.close();
  ({ repos, db } = openDatabase({ file, workspaceDir: dir }));
}

describe('allow-once consumption (SQLite)', () => {
  it('consume() is atomic: only allowed, only once', () => {
    const base = seed(repos);
    const req = repos.permissions.create({ ...base, key: 'web.read', provenance: null });
    expect(repos.permissions.consume(req.id)).toBe(false); // still pending
    repos.permissions.decide(req.id, 'allowed');
    expect(repos.permissions.consumedAt(req.id)).toBeNull();
    expect(repos.permissions.consume(req.id)).toBe(true);
    expect(repos.permissions.consume(req.id)).toBe(false);
    expect(repos.permissions.consumedAt(req.id)).toEqual(expect.any(String));
    expect(repos.permissions.consumedAt('missing')).toBeUndefined();
    // Not part of the public request shape.
    expect(repos.permissions.get(req.id)).not.toHaveProperty('consumedAt');
  });

  it('allow once -> consume -> new gate over the same DB -> still consumed', () => {
    const base = seed(repos);
    const gate = gateOver(repos);
    const d = gate.check({ ...base, key: 'web.read' });
    if (d.outcome !== 'pending') throw new Error('expected pending');
    gate.decide(d.request.id, 'allow');
    expect(gate.check({ ...base, key: 'web.read' }).outcome).toBe('allow');
    expect(repos.audit.listForTicket(base.ticketId).items.some((e) => e.summary.startsWith('Used permission:'))).toBe(true);

    reopen();
    const restarted = gateOver(repos);
    const again = restarted.check({ ...base, key: 'web.read' });
    expect(again.outcome).toBe('pending');
    expect(again.outcome === 'pending' && again.request.id).not.toBe(d.request.id);
  });

  it('ticket-scoped keys are not consumed', () => {
    const base = seed(repos);
    const gate = gateOver(repos);
    const d = gate.check({ ...base, key: 'email.read', detail: 'mailbox' });
    if (d.outcome !== 'pending') throw new Error('expected pending');
    gate.decide(d.request.id, 'allow');
    for (let i = 0; i < 3; i++) expect(gate.check({ ...base, key: 'email.read', detail: 'mailbox' }).outcome).toBe('allow');
    expect(repos.permissions.consumedAt(d.request.id)).toBeNull();
    reopen();
    expect(gateOver(repos).check({ ...base, key: 'email.read', detail: 'mailbox' }).outcome).toBe('allow');
  });

  it('migration v4 backfills consumed_at from the old audit markers', async () => {
    // Build a genuine v3 database (migrations 1-3 only), with rows written the way v3 wrote them,
    // so the test stays valid whatever later migrations add.
    repos.close();
    fs.rmSync(file, { force: true });
    const BetterSqlite = (await import('better-sqlite3')).default;
    const raw = new BetterSqlite(file);
    raw.pragma('synchronous = OFF'); // set-up speed only (slow disks)
    raw.transaction(() => { for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m); })();
    raw.pragma('user_version = 3');
    const at = '2026-11-01T00:00:00.000Z';
    const agentId = uuidv7(); const ticketId = uuidv7(); const sessionId = uuidv7(); const runId = uuidv7();
    const used = { id: uuidv7(), title: 'Read a page' };
    const unused = { id: uuidv7(), title: 'Read a page' };
    raw.prepare(`INSERT INTO agents (id, name, role, job, runtime, model, reports_to, heartbeat_minutes, monthly_budget_usd, permissions, paused, created_at)
      VALUES (?, 'Ops', '', '', 'mock', NULL, NULL, 15, 20, ?, 0, ?)`).run(agentId, JSON.stringify(DEFAULT_PERMISSIONS), at);
    raw.prepare(`INSERT INTO tickets (id, number, title, goal, status, agent_id, folder, cost_cap_usd, cost_usd, created_at, updated_at)
      VALUES (?, 1, 'Disk space report', 'Check free space', 'in_progress', ?, ?, 5, 0, ?, ?)`).run(ticketId, agentId, path.join(dir, 'tickets', 'T-1'), at, at);
    raw.prepare(`INSERT INTO sessions (id, ticket_id, agent_id, runtime, model, external_session_id, reason, started_at)
      VALUES (?, ?, ?, 'mock', NULL, NULL, 'new', ?)`).run(sessionId, ticketId, agentId, at);
    raw.prepare(`INSERT INTO runs (id, session_id, ticket_id, job_id, trigger, status, started_at, tokens_in, tokens_out, cost_usd)
      VALUES (?, ?, ?, NULL, 'start', 'running', ?, 0, 0, 0)`).run(runId, sessionId, ticketId, at);
    const perm = raw.prepare(`INSERT INTO permission_requests (id, ticket_id, run_id, agent_id, key, title, detail, provenance, state, created_at, decided_at)
      VALUES (?, ?, ?, ?, 'web.read', ?, ?, NULL, 'allowed', ?, ?)`);
    perm.run(used.id, ticketId, runId, agentId, used.title, 'https://example.com/cve', at, at);
    perm.run(unused.id, ticketId, runId, agentId, unused.title, 'other', at, at);
    // What the pre-v4 gate wrote when a grant was used (and when one was only allowed).
    const auditRow = raw.prepare(`INSERT INTO audit_events (id, ticket_id, run_id, kind, summary, data, created_at) VALUES (?, ?, ?, 'permission', ?, ?, ?)`);
    auditRow.run(uuidv7(), ticketId, runId, `Used permission: ${used.title}`, JSON.stringify({ requestId: used.id, key: 'web.read', consumed: true }), at);
    auditRow.run(uuidv7(), ticketId, runId, `Allowed once: ${unused.title}`, JSON.stringify({ requestId: unused.id, key: 'web.read', decision: 'allow' }), at);
    raw.close();
    const base = { ticketId, runId, agentId, title: 'Read a page', detail: 'https://example.com/cve' };

    const opened = openDatabase({ file, workspaceDir: dir });
    ({ repos, db } = opened);
    expect(opened.migration).toMatchObject({ from: 3, to: MIGRATIONS.length });
    expect(repos.permissions.consumedAt(used.id)).toEqual(expect.any(String));
    expect(repos.permissions.consumedAt(unused.id)).toBeNull();

    const gate = gateOver(repos);
    expect(gate.check({ ...base, key: 'web.read' }).outcome).toBe('pending'); // used before the upgrade
    expect(gate.check({ ...base, key: 'web.read', detail: 'other' }).outcome).toBe('allow');
  }, 60_000); // rebuilds a v3 DB through every migration: slow when the machine is busy
});
