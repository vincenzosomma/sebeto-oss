import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, uuidv7 } from '@sebeto/shared';
import type { Repos } from '../contracts.js';
import { MIGRATIONS, openDatabase, InvalidCursorError } from './index.js';

let dir: string;
let file: string;
let repos: Repos;
let db: Database.Database;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `sebeto-storage-${uuidv7()}`);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'sebeto.db');
  ({ repos, db } = openDatabase({ file, workspaceDir: dir }));
});

afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('sets pragmas and user_version', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('is idempotent: reopening does not re-run or back up', () => {
    repos.tickets.create({ title: 'a', goal: 'b' });
    repos.close();
    const again = openDatabase({ file, workspaceDir: dir });
    expect(again.migration).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length, backup: null });
    expect(again.repos.tickets.list({}).items).toHaveLength(1);
    again.repos.close();
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
    ({ repos, db } = openDatabase({ file, workspaceDir: dir }));
  });

  it('backs up an existing database with data before migrating', () => {
    repos.close();
    const legacy = path.join(dir, 'legacy.db');
    const raw = new Database(legacy);
    raw.exec('CREATE TABLE old_stuff (x TEXT); INSERT INTO old_stuff VALUES (\'keep me\')');
    raw.close();

    const opened = openDatabase({ file: legacy, workspaceDir: dir });
    expect(opened.migration.from).toBe(0);
    expect(opened.migration.backup).toBe(`${legacy}.bak-v0`);
    opened.repos.close();

    const bak = new Database(`${legacy}.bak-v0`, { readonly: true });
    expect(bak.prepare('SELECT x FROM old_stuff').get()).toEqual({ x: 'keep me' });
    bak.close();
    ({ repos, db } = openDatabase({ file, workspaceDir: dir }));
  });

  it('does not back up a brand new database', () => {
    expect(fs.readdirSync(dir).filter((f) => f.includes('.bak-'))).toEqual([]);
  });

  it('refuses a database newer than the app', () => {
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    repos.close();
    expect(() => openDatabase({ file, workspaceDir: dir })).toThrow(/newer/);
    const raw = new Database(file);
    raw.pragma(`user_version = ${MIGRATIONS.length}`);
    raw.close();
    ({ repos, db } = openDatabase({ file, workspaceDir: dir }));
  });
});

describe('tickets', () => {
  it('numbers tickets sequentially and sets the folder', () => {
    const a = repos.tickets.create({ title: 'One', goal: 'g' });
    const b = repos.tickets.create({ title: 'Two', goal: 'g' });
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(a.status).toBe('backlog');
    expect(b.folder).toBe(path.join(dir, 'tickets', 'T-2'));
    expect(fs.existsSync(b.folder)).toBe(false);
  });

  it('stores dependencies and updates them', () => {
    const a = repos.tickets.create({ title: 'A', goal: 'g' });
    const b = repos.tickets.create({ title: 'B', goal: 'g', dependsOn: [a.id], parentId: a.id });
    expect(b.dependsOn).toEqual([a.id]);
    expect(b.parentId).toBe(a.id);
    const c = repos.tickets.create({ title: 'C', goal: 'g' });
    expect(repos.tickets.update(b.id, { dependsOn: [a.id, c.id] }).dependsOn.sort()).toEqual([a.id, c.id].sort());
    expect(repos.tickets.list({}).items.find((t) => t.id === b.id)?.dependsOn).toHaveLength(2);
    expect(() => repos.tickets.update(a.id, { dependsOn: [a.id] })).toThrow();
  });

  it('updates fields and accumulates cost', () => {
    const t = repos.tickets.create({ title: 'A', goal: 'g', costCapUsd: 3 });
    expect(t.costCapUsd).toBe(3);
    const u = repos.tickets.update(t.id, { title: 'B' });
    expect(u.title).toBe('B');
    expect(u.updatedAt >= t.updatedAt).toBe(true);
    repos.tickets.addCost(t.id, 0.25);
    expect(repos.tickets.addCost(t.id, 0.5).costUsd).toBeCloseTo(0.75);
    expect(() => repos.tickets.update(uuidv7(), { title: 'x' })).toThrow(/not found/);
  });

  it('full-text search matches title/goal and message text, each ticket once', () => {
    const a = repos.tickets.create({ title: 'Quarterly report', goal: 'Summarise revenue' });
    const b = repos.tickets.create({ title: 'Website', goal: 'Fix the footer' });
    repos.tickets.create({ title: 'Unrelated', goal: 'nothing' });
    repos.messages.create({ ticketId: b.id, role: 'agent', author: 'Dev', text: 'The revenue chart is broken' });
    repos.messages.create({ ticketId: b.id, role: 'user', author: 'You', text: 'revenue again' });
    repos.messages.create({ ticketId: a.id, role: 'user', author: 'You', text: 'revenue numbers attached' });

    const ids = repos.tickets.list({ q: 'revenue' }).items.map((t) => t.id);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
    expect(repos.tickets.list({ q: 'footer' }).items.map((t) => t.id)).toEqual([b.id]);
    expect(repos.tickets.list({ q: 'quart' }).items.map((t) => t.id)).toEqual([a.id]); // prefix match
    expect(repos.tickets.list({ q: 'chart broken' }).items.map((t) => t.id)).toEqual([b.id]);
    expect(repos.tickets.list({ q: '"*)(' }).items).toEqual([]); // garbage input is safe

    // title edits re-index
    repos.tickets.update(a.id, { title: 'Annual summary' });
    expect(repos.tickets.list({ q: 'quarterly' }).items).toEqual([]);
    expect(repos.tickets.list({ q: 'annual' }).items.map((t) => t.id)).toEqual([a.id]);
  });

  it('filters by status and paginates by updatedAt desc with a cursor', () => {
    const created = Array.from({ length: 7 }, (_, i) => repos.tickets.create({ title: `T${i}`, goal: 'g' }));
    // Ensure the update lands in a later millisecond than the last create (ties are broken by id).
    const until = Date.now() + 3;
    while (Date.now() < until) { /* spin */ }
    repos.tickets.update(created[0]!.id, { status: 'done' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = repos.tickets.list({ cursor, limit: 3 });
      seen.push(...page.items.map((t) => t.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe(created[0]!.id); // most recently updated first
    expect(repos.tickets.list({ status: 'done' }).items.map((t) => t.id)).toEqual([created[0]!.id]);
    expect(() => repos.tickets.list({ cursor: 'garbage' })).toThrow(InvalidCursorError);
  });

  it('list and get carry the latest audit event as lastActivity (null without events)', () => {
    const a = repos.tickets.create({ title: 'a', goal: 'g' });
    const b = repos.tickets.create({ title: 'b', goal: 'g' });
    expect(a.lastActivity).toBeNull();
    repos.audit.append({ ticketId: a.id, kind: 'status', summary: 'Started' });
    const last = repos.audit.append({ ticketId: a.id, kind: 'tool', summary: 'Scanned 86 hosts' });

    expect(repos.tickets.get(a.id)?.lastActivity).toEqual({ summary: 'Scanned 86 hosts', at: last.createdAt });
    expect(repos.tickets.get(b.id)?.lastActivity).toBeNull();
    const byId = new Map(repos.tickets.list({}).items.map((t) => [t.id, t]));
    expect(byId.get(a.id)?.lastActivity).toEqual({ summary: 'Scanned 86 hosts', at: last.createdAt });
    expect(byId.get(b.id)?.lastActivity).toBeNull();
    // Search and status filters still work with the join.
    expect(repos.tickets.list({ status: 'backlog', q: 'a' }).items.map((t) => t.lastActivity?.summary)).toEqual(['Scanned 86 hosts']);
  });

  it('caps the page size', () => {
    for (let i = 0; i < 205; i++) repos.tickets.create({ title: `T${i}`, goal: 'g' });
    expect(repos.tickets.list({}).items).toHaveLength(50);
    expect(repos.tickets.list({ limit: 1000 }).items).toHaveLength(200);
  });
});

describe('agents', () => {
  it('fills defaults and clamps ALWAYS_ASK permissions', () => {
    const a = repos.agents.create({ name: 'Ops', permissions: { 'prod.change': 'allow', 'web.read': 'allow' } });
    expect(a.permissions['prod.change']).toBe('ask');
    expect(a.permissions['web.read']).toBe('allow');
    expect(a.permissions['email.send']).toBe(DEFAULT_PERMISSIONS['email.send']);
    expect(a.paused).toBe(false);

    const u = repos.agents.update(a.id, { permissions: { ...a.permissions, 'prod.change': 'allow', 'fs.write': 'never' } });
    expect(u.permissions['prod.change']).toBe('ask');
    expect(u.permissions['fs.write']).toBe('never');
    expect(u.permissions['web.read']).toBe('allow');
    expect(repos.agents.update(a.id, { permissions: { ...u.permissions, 'prod.change': 'never' } }).permissions['prod.change']).toBe('never');
  });

  it('rejects reportsTo cycles', () => {
    const ceo = repos.agents.create({ name: 'CEO' });
    const mgr = repos.agents.create({ name: 'Mgr', reportsTo: ceo.id });
    const dev = repos.agents.create({ name: 'Dev', reportsTo: mgr.id });
    expect(() => repos.agents.update(ceo.id, { reportsTo: dev.id })).toThrow(/cycle/);
    expect(() => repos.agents.update(ceo.id, { reportsTo: ceo.id })).toThrow(/cycle/);
    expect(repos.agents.get(ceo.id)!.reportsTo).toBeNull();
    expect(repos.agents.update(dev.id, { reportsTo: ceo.id, paused: true })).toMatchObject({ reportsTo: ceo.id, paused: true });
    expect(repos.agents.update(dev.id, { reportsTo: null }).reportsTo).toBeNull();
    expect(repos.agents.list().map((x) => x.name)).toEqual(['CEO', 'Mgr', 'Dev']);
  });

  it('sums this month run costs for the agent', () => {
    const a = repos.agents.create({ name: 'A' });
    const other = repos.agents.create({ name: 'B' });
    const t = repos.tickets.create({ title: 'x', goal: 'y', agentId: a.id });
    const s = repos.sessions.create({ ticketId: t.id, agentId: a.id, runtime: 'mock', model: null, reason: 'new' });
    const s2 = repos.sessions.create({ ticketId: t.id, agentId: other.id, runtime: 'mock', model: null, reason: 'handoff' });
    const r1 = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'start' });
    const r2 = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'user' });
    const r3 = repos.runs.create({ sessionId: s2.id, ticketId: t.id, jobId: null, trigger: 'message' });
    repos.runs.update(r1.id, { costUsd: 1.5 });
    repos.runs.update(r2.id, { costUsd: 0.5 });
    repos.runs.update(r3.id, { costUsd: 9 });
    // a run from last month does not count
    const old = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'heartbeat' });
    db.prepare('UPDATE runs SET cost_usd = 100, started_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', old.id);
    expect(repos.agents.monthSpendUsd(a.id)).toBeCloseTo(2);
    expect(repos.agents.monthSpendUsd(other.id)).toBeCloseTo(9);
  });
});

describe('history repos', () => {
  it('sessions, runs and orphan recovery', () => {
    const t = repos.tickets.create({ title: 'x', goal: 'y' });
    const s = repos.sessions.create({ ticketId: t.id, agentId: null, runtime: 'mock', model: null, reason: 'new' });
    expect(repos.sessions.setExternalId(s.id, 'ext-1').externalSessionId).toBe('ext-1');
    expect(repos.sessions.end(s.id).endedAt).not.toBeNull();
    expect(repos.sessions.listForTicket(t.id)).toHaveLength(1);

    const r1 = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'start' });
    const r2 = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'user' });
    expect(r1.status).toBe('running');
    repos.runs.update(r1.id, { status: 'succeeded', tokensIn: 10, snapshotAfter: 'abc' });
    expect(repos.runs.failOrphans('crash')).toBe(1);
    expect(repos.runs.get(r2.id)).toMatchObject({ status: 'failed', exitReason: 'crash' });
    expect(repos.runs.get(r1.id)).toMatchObject({ status: 'succeeded', tokensIn: 10, snapshotAfter: 'abc' });
    expect(repos.runs.listForTicket(t.id).map((r) => r.id)).toEqual([r2.id, r1.id]);
  });

  it('messages page newest-first, items oldest-first within a page', () => {
    const t = repos.tickets.create({ title: 'x', goal: 'y' });
    const msgs = Array.from({ length: 5 }, (_, i) => repos.messages.create({ ticketId: t.id, role: 'user', author: 'You', text: `m${i}` }));
    const p1 = repos.messages.listForTicket(t.id, { limit: 2 });
    expect(p1.items.map((m) => m.text)).toEqual(['m3', 'm4']);
    const p2 = repos.messages.listForTicket(t.id, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((m) => m.text)).toEqual(['m1', 'm2']);
    const p3 = repos.messages.listForTicket(t.id, { limit: 2, cursor: p2.nextCursor });
    expect(p3.items.map((m) => m.id)).toEqual([msgs[0]!.id]);
    expect(p3.nextCursor).toBeNull();
  });

  it('audit events, permissions and transitions', () => {
    const t = repos.tickets.create({ title: 'x', goal: 'y' });
    const e = repos.audit.append({ ticketId: t.id, kind: 'tool', summary: 'Read a file', data: { path: 'a.txt' } });
    expect(e.data).toEqual({ path: 'a.txt' });
    expect(repos.audit.listForTicket(t.id).items).toHaveLength(1);

    const p = repos.permissions.create({
      ticketId: t.id, runId: null, agentId: null, key: 'email.send', title: 'Permission needed: send email', detail: 'to bob', provenance: null,
    });
    expect(repos.permissions.pendingForTicket(t.id)).toHaveLength(1);
    expect(repos.permissions.decide(p.id, 'allowed')).toMatchObject({ state: 'allowed' });
    expect(repos.permissions.pendingForTicket(t.id)).toHaveLength(0);
    expect(() => repos.permissions.decide(p.id, 'denied')).toThrow(/already decided/);

    repos.transitions.append({ ticketId: t.id, from: 'backlog', to: 'in_progress', cause: 'user', runId: null, note: null });
    expect(repos.transitions.listForTicket(t.id)[0]).toMatchObject({ from: 'backlog', to: 'in_progress' });
  });

  it('tx rolls back all writes on error', () => {
    expect(() => repos.tx(() => {
      repos.tickets.create({ title: 'x', goal: 'y' });
      throw new Error('boom');
    })).toThrow('boom');
    expect(repos.tickets.list({}).items).toHaveLength(0);
  });
});
