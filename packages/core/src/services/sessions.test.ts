import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, type AgentEvent, type RuntimeAdapter, type SessionEntry, type TicketRun, type WsEvent } from '@sebeto/shared';
import type { AppContext, NewSecurityEvent, Repos, SessionEntryRepo } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createJobQueue } from '../queue/index.js';
import { createExecutor } from '../executor/index.js';
import { createServer } from '../api/index.js';
import { createTicket, updateTicket } from './tickets.js';
import {
  backfillSessionLibrary, deleteSession, fileTicketSession, listSessions, openSession, scanSessions, searchMemory, sessionCategories,
  sessionTranscript, startSessionLibrary, updateSession,
} from './sessions.js';
import { encodeProjectDir, readClaudeSession } from './claude-sessions.js';

const TOKEN = 'session-library-test-token-0123456789';
let dir: string;
let claudeDir: string;
let workspace: string;
let repos: Repos;
let db: Database.Database;
let lib: SessionEntryRepo;
let events: WsEvent[];
let security: NewSecurityEvent[];
let ctx: AppContext;
let ran: TicketRun[];

/** Fake Claude Code runtime: records what the executor asked for. */
function fakeClaude(): RuntimeAdapter {
  return {
    id: 'claude-cli', displayName: 'Claude Code', capabilities: { tools: true, resume: true, costReport: true },
    detect: async () => ({ installed: true }), models: async () => [],
    async *run(r: TicketRun): AsyncGenerator<AgentEvent> {
      ran.push(r);
      yield { kind: 'session', externalSessionId: r.externalSessionId ?? r.newExternalSessionId! };
      yield { kind: 'text', text: 'Continued where we left off.' };
      yield { kind: 'done', costUsd: 0.02 };
    },
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-sessions-'));
  claudeDir = path.join(dir, 'claude');
  workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  ({ repos, db } = openDatabase({ file: path.join(workspace, 'sebeto.db'), workspaceDir: workspace }));
  lib = repos.sessionLibrary!;
  events = [];
  security = [];
  ran = [];
  const bus = createEventBus();
  bus.subscribe((e) => events.push(e));
  const adapters = [fakeClaude()];
  ctx = {
    config: { workspaceDir: workspace, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 2, runtimes: ['mock', 'claude-cli'], version: '0.4.0-test' },
    repos, bus, state: createStateMachine(repos, bus), queue: createJobQueue(db),
    snapshots: { init: async (f: string) => { fs.mkdirSync(f, { recursive: true }); }, commit: async () => 'oid', restore: async () => 'oid', diff: async () => [] },
    runtimes: { get: (id: string) => adapters.find((a) => a.id === id), list: () => adapters },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    securityLog: { record: (e: NewSecurityEvent) => { security.push(e); return null; }, lockdown: () => false },
  } as unknown as AppContext;
});

afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures
interface FixtureOpts { id?: string; cwd?: string; prompt?: string; answer?: string; summary?: string; extraLines?: object[]; at?: string }
function writeClaudeSession(projectDir: string, o: FixtureOpts = {}): { id: string; file: string } {
  const id = o.id ?? crypto.randomUUID();
  const cwd = o.cwd ?? 'C:\\Work\\inventory';
  const at = o.at ?? '2026-11-01T09:00:00.000Z';
  const later = '2026-11-01T09:05:00.000Z';
  const lines: object[] = [
    { type: 'session-owner', sessionId: id },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, cwd, sessionId: id, timestamp: at },
    { type: 'user', message: { role: 'user', content: o.prompt ?? 'Check which laptops in Naples have warranty ending this year' }, cwd, sessionId: id, timestamp: at },
    { type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] }, cwd, sessionId: id, timestamp: at },
    { type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: 't1', input: {} }] }, cwd, sessionId: id, timestamp: at },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'serials…' }] }, cwd, sessionId: id, timestamp: at },
    { type: 'assistant', message: { id: 'msg_2', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: o.answer ?? '12 laptops expire in 2026; list saved to warranty.csv.' }] }, cwd, sessionId: id, timestamp: later },
    ...(o.summary ? [{ type: 'summary', summary: o.summary }] : []),
    ...(o.extraLines ?? []),
  ];
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { id, file };
}
const projectsDir = () => path.join(claudeDir, 'projects');
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function addEntry(p: Partial<Parameters<SessionEntryRepo['insert']>[0]> = {}) {
  return lib.insert({
    source: 'claude-code', externalSessionId: crypto.randomUUID(), sessionId: null, ticketId: null, title: 'Untitled', summary: '',
    category: '', tags: [], cwd: null, runtime: 'claude-cli', model: null, messageCount: 1, costUsd: 0,
    startedAt: '2026-11-01T00:00:00.000Z', lastActivityAt: '2026-11-01T00:00:00.000Z', ...p,
  });
}

async function startedTicket(title: string, goal: string, tags: string[] = []) {
  const agent = repos.agents.create({ name: `Analyst ${uuidv7().slice(-4)}`, runtime: 'claude-cli' });
  const t = await createTicket(ctx, { title, goal, agentId: agent.id, tags });
  const s = repos.sessions.create({ ticketId: t.id, agentId: agent.id, runtime: 'claude-cli', model: 'haiku', reason: 'new', externalSessionId: crypto.randomUUID() });
  repos.tickets.update(t.id, { currentSessionId: s.id });
  const run = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'start' });
  repos.runs.update(run.id, { status: 'succeeded', costUsd: 0.12 });
  repos.messages.create({ ticketId: t.id, role: 'user', author: 'You', text: goal });
  return { ticket: repos.tickets.get(t.id)!, session: s, agent };
}

// ------------------------------------------------------------------ storage
describe('session library storage', () => {
  it('lists latest first with cursor pagination, FTS search, categories and hidden tombstones', () => {
    for (let i = 0; i < 5; i++) {
      addEntry({ title: `Certificate renewal ${i}`, category: i < 3 ? 'infrastructure' : '', lastActivityAt: `2026-11-0${i + 1}T00:00:00.000Z` });
    }
    addEntry({ title: 'Printer jam on floor 3', summary: 'Città di Napoli office', category: 'service-desk', lastActivityAt: '2026-11-08T00:00:00.000Z' });
    const p1 = lib.list({ limit: 4 });
    expect(p1.items.map((e) => e.title)[0]).toBe('Printer jam on floor 3');
    expect(p1.items).toHaveLength(4);
    const p2 = lib.list({ limit: 4, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((e) => e.id)).size).toBe(6);

    expect(lib.list({ q: 'renew' }).items).toHaveLength(5); // prefix match
    expect(lib.list({ q: 'citta' }).items).toHaveLength(1); // diacritics removed
    expect(lib.list({ q: 'renewal printer' }).items).toHaveLength(0); // AND
    expect(lib.list({ q: '"; DROP TABLE x; -- *' }).items).toHaveLength(0); // escaped, no FTS syntax error
    expect(lib.list({ q: 'NEAR(' }).items).toHaveLength(0);
    expect(lib.list({ category: 'infrastructure' }).items).toHaveLength(3);
    expect(lib.list({ category: '-' }).items).toHaveLength(2);
    expect(lib.list({ source: 'sebeto' }).items).toHaveLength(0);
    expect(lib.categories()).toEqual([{ category: 'infrastructure', count: 3 }, { category: '', count: 2 }, { category: 'service-desk', count: 1 }]);

    const printer = p1.items[0]!;
    lib.patch(printer.id, { hidden: true });
    expect(lib.get(printer.id)).toBeUndefined();
    expect(lib.getStored(printer.id)?.hidden).toBe(true);
    expect(lib.list({ q: 'printer' }).items).toHaveLength(0);
    expect(lib.categories().find((c) => c.category === 'service-desk')).toBeUndefined();
  });

  it('memory search: pinned entries of the preferred category first, OR fallback, internal fields never in public entries', () => {
    addEntry({ title: 'VPN outage runbook', category: 'infrastructure', lastActivityAt: '2026-11-09T00:00:00.000Z' });
    const pinned = addEntry({ title: 'VPN certificate rotation', category: 'security', lastActivityAt: '2026-11-01T00:00:00.000Z', pinned: true, filePath: 'C:\\secret\\path.jsonl' });
    addEntry({ title: 'VPN client install', category: 'security', lastActivityAt: '2026-11-05T00:00:00.000Z' });
    const res = lib.search({ q: 'vpn', preferCategory: 'security', limit: 10 });
    expect(res.map((e) => e.title)).toEqual(['VPN certificate rotation', 'VPN client install', 'VPN outage runbook']);
    expect(res[0]!.id).toBe(pinned.id);
    expect(JSON.stringify(res)).not.toContain('secret');
    expect(Object.keys(res[0]!)).not.toContain('filePath');
    expect(lib.search({ q: 'vpn runbook', limit: 10 }).map((e) => e.title)).toEqual(['VPN outage runbook']);
    expect(lib.search({ q: 'runbook zebra', limit: 10 }).map((e) => e.title)).toEqual(['VPN outage runbook']); // OR fallback
    expect(lib.search({ q: 'vpn', category: 'infrastructure', limit: 10 })).toHaveLength(1);
    expect(lib.search({ q: '', limit: 2 })).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ auto-filing
describe('auto-filing of Sebeto sessions', () => {
  it('files a started ticket with goal + latest outcome, first tag as category, cost; never-started tickets are skipped', async () => {
    const idle = await createTicket(ctx, { title: 'Not started', goal: 'x' });
    expect(fileTicketSession(ctx, idle.id)).toBe(false);

    const { ticket, session } = await startedTicket('Disk space report', 'List servers under 10% free disk. password=hunter2secret', ['Naples', 'storage']);
    repos.messages.create({ ticketId: ticket.id, role: 'agent', author: 'Analyst', text: 'Done: 3 servers are low, see report.md' });
    expect(fileTicketSession(ctx, ticket.id)).toBe(true);
    const [e] = listSessions(ctx, {}).items;
    expect(e).toMatchObject({
      source: 'sebeto', sessionId: session.id, ticketId: ticket.id, ticketNumber: ticket.number, title: 'Disk space report',
      category: 'naples', tags: ['naples', 'storage', 'access'], runtime: 'claude-cli', model: 'haiku', costUsd: 0.12, messageCount: 2,
      externalSessionId: session.externalSessionId,
    });
    expect(e!.summary).toContain('List servers under 10% free disk');
    expect(e!.summary).toContain('Outcome: Done: 3 servers are low');
    expect(e!.summary).not.toContain('hunter2secret'); // redacted
    expect(fileTicketSession(ctx, ticket.id)).toBe(false); // idempotent
    expect(backfillSessionLibrary(ctx)).toBe(0);
  });

  it('uses the team slug as category, keeps a category the owner typed, follows title/tags changes via ticket.updated', async () => {
    const { ticket } = await startedTicket('Patch Exchange', 'Apply the CU', ['urgent']);
    const teamId = uuidv7();
    db.prepare(`INSERT INTO teams (id, slug, name, color, created_at, updated_at) VALUES (?, 'infrastructure', 'Infrastructure', '#0E5A8A', 'x', 'x')`).run(teamId);
    repos.tickets.update(ticket.id, { teamId });
    const stop = startSessionLibrary(ctx); // backfill
    let entry = listSessions(ctx, {}).items[0]!;
    expect(entry.category).toBe('infrastructure');

    events.length = 0;
    updateTicket(ctx, ticket.id, { title: 'Patch Exchange 2019', tags: ['urgent', 'mail'] });
    entry = listSessions(ctx, {}).items[0]!;
    expect(entry.title).toBe('Patch Exchange 2019');
    expect(entry.tags).toEqual(['urgent', 'mail']);
    expect(events.some((e) => e.type === 'sessions.changed')).toBe(true);

    updateSession(ctx, entry.id, { category: 'Red Team' });
    updateTicket(ctx, ticket.id, { title: 'Patch Exchange 2019 CU14' });
    entry = listSessions(ctx, {}).items[0]!;
    expect(entry).toMatchObject({ title: 'Patch Exchange 2019 CU14', category: 'red-team' });
    stop();
  });
});

// ------------------------------------------------------------------ scan
describe('scan of Claude Code sessions', () => {
  it('adds sessions read-only, skips unchanged files, Sebeto folders and removed entries, links Sebeto sessions, redacts secrets', async () => {
    const proj = path.join(projectsDir(), 'C--Work-inventory');
    const a = writeClaudeSession(proj, {
      prompt: 'Rotate the API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and update the vault, my password=Sup3rSecret!',
      extraLines: [{ type: 'user', message: { role: 'user', content: 'thanks' }, sessionId: 'x', timestamp: '2026-11-01T09:06:00.000Z' }],
    });
    const b = writeClaudeSession(proj, { summary: 'Warranty report for Naples laptops' });
    // Sebeto's own ticket session folder (under the workspace): ignored entirely.
    writeClaudeSession(path.join(projectsDir(), encodeProjectDir(path.join(workspace, 'tickets', 'T-1'))));
    // Agent runs of another Sebeto workspace: also not the owner's own chats.
    writeClaudeSession(path.join(projectsDir(), 'C--Users-me--sebeto-dev-ws-tickets-T-2'));
    writeClaudeSession(path.join(projectsDir(), 'C--Users-me--sebeto-workspace-intake'));
    // A Sebeto session started elsewhere with a known id: linked, not duplicated.
    const { ticket } = await startedTicket('Inventory', 'Count laptops');
    fileTicketSession(ctx, ticket.id);
    const sebetoSession = repos.sessions.create({ ticketId: ticket.id, agentId: null, runtime: 'claude-cli', model: null, reason: 'compaction' });
    const linkedId = crypto.randomUUID();
    db.prepare('UPDATE sessions SET external_session_id = ? WHERE id = ?').run(linkedId, sebetoSession.id);
    writeClaudeSession(proj, { id: linkedId });
    fs.writeFileSync(path.join(proj, 'not-a-session.txt'), 'x');
    const before = sha(a.file);

    const r1 = await scanSessions(ctx, { claudeDir });
    expect(r1).toEqual({ found: 3, added: 2, updated: 0, skipped: 1 });
    expect(sha(a.file)).toBe(before); // never modified
    const entries = listSessions(ctx, { source: 'claude-code' }).items;
    expect(entries).toHaveLength(2);
    const ea = entries.find((e) => e.externalSessionId === a.id)!;
    expect(ea.title.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(ea)).not.toMatch(/abcdefghijklmnop|Sup3rSecret/);
    expect(ea).toMatchObject({ cwd: 'C:\\Work\\inventory', model: 'claude-haiku-4-5', messageCount: 3, startedAt: '2026-11-01T09:00:00.000Z', lastActivityAt: '2026-11-01T09:06:00.000Z', category: '' });
    expect(ea.summary).toContain('Last answer: 12 laptops expire');
    const eb = entries.find((e) => e.externalSessionId === b.id)!;
    expect(eb.summary).toBe('Warranty report for Naples laptops');
    expect(security.some((s) => s.action === 'session.scanned')).toBe(true);
    expect(events.some((e) => e.type === 'sessions.changed')).toBe(true);

    // Unchanged: skipped. Changed: updated, owner's title and category kept.
    updateSession(ctx, eb.id, { title: 'Naples warranty', category: 'service-desk' });
    expect(await scanSessions(ctx, { claudeDir })).toEqual({ found: 3, added: 0, updated: 0, skipped: 3 });
    fs.appendFileSync(b.file, JSON.stringify({ type: 'summary', summary: 'Updated summary' }) + '\n');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(b.file, future, future);
    expect(await scanSessions(ctx, { claudeDir })).toMatchObject({ added: 0, updated: 1 });
    expect(listSessions(ctx, { q: 'naples warranty' }).items[0]).toMatchObject({ title: 'Naples warranty', category: 'service-desk', summary: 'Updated summary' });

    // Removed from the library: a rescan does not bring it back.
    deleteSession(ctx, ea.id);
    fs.utimesSync(a.file, future, future);
    expect((await scanSessions(ctx, { claudeDir })).added).toBe(0);
    expect(listSessions(ctx, { source: 'claude-code' }).items).toHaveLength(1);
    expect(fs.existsSync(a.file)).toBe(true); // the file stays

    expect(await scanSessions(ctx, { claudeDir: path.join(dir, 'nowhere') })).toEqual({ found: 0, added: 0, updated: 0, skipped: 0 });
  });

  it('reads only the head and tail of very large files', async () => {
    const proj = path.join(projectsDir(), 'C--big');
    const filler = Array.from({ length: 3000 }, (_, i) => ({ type: 'attachment', pad: 'x'.repeat(400), i }));
    const { file } = writeClaudeSession(proj, { extraLines: [...filler, { type: 'assistant', message: { id: 'msg_last', model: 'claude-opus', content: [{ type: 'text', text: 'Final answer at the end' }] }, timestamp: '2026-11-02T00:00:00.000Z' }] });
    expect(fs.statSync(file).size).toBeGreaterThan(1024 * 1024);
    const info = await readClaudeSession(file);
    expect(info).toMatchObject({ partial: true, model: 'claude-opus', lastActivityAt: '2026-11-02T00:00:00.000Z' });
    expect(info.summary).toContain('Final answer at the end');
    expect(info.title).toContain('Check which laptops');
  });
});

// ------------------------------------------------------------------ transcript
describe('transcript preview', () => {
  it('claude-code: user/agent text and one-line tool turns, last N; sebeto: ticket messages', async () => {
    writeClaudeSession(path.join(projectsDir(), 'C--x'));
    await scanSessions(ctx, { claudeDir });
    const e = listSessions(ctx, {}).items[0]!;
    const all = await sessionTranscript(ctx, e.id, 50);
    expect(all.turns.map((t) => t.role)).toEqual(['user', 'tool', 'agent']);
    expect(all.turns[1]!.text).toBe('Used tool Read');
    const last = await sessionTranscript(ctx, e.id, 1);
    expect(last).toMatchObject({ truncated: true, turns: [{ role: 'agent' }] });

    const { ticket } = await startedTicket('Chat', 'Hello');
    repos.messages.create({ ticketId: ticket.id, role: 'agent', author: 'A', text: 'Hi there' });
    fileTicketSession(ctx, ticket.id);
    const seb = listSessions(ctx, { source: 'sebeto' }).items[0]!;
    expect((await sessionTranscript(ctx, seb.id)).turns.map((t) => [t.role, t.text])).toEqual([['user', 'Hello'], ['agent', 'Hi there']]);
  });
});

// ------------------------------------------------------------------ open
describe('open from the library', () => {
  it('claude-code: new ticket that resumes the session (import session, copy into the ticket folder\'s project dir, origin, link)', async () => {
    const { id, file } = writeClaudeSession(path.join(projectsDir(), 'C--Work-inventory'));
    await scanSessions(ctx, { claudeDir });
    const entry = listSessions(ctx, {}).items[0]!;
    const agent = repos.agents.create({ name: 'Assistant', runtime: 'mock' }); // the ticket's runtime override wins
    const res = await openSession(ctx, entry.id, { title: 'Continue warranty check' }, { claudeDir });
    expect(res.ticket.agentId).toBe(agent.id);
    expect(res.action).toBe('created');
    const t = res.ticket;
    expect(t).toMatchObject({ title: 'Continue warranty check', runtime: 'claude-cli', status: 'backlog' });
    expect(t.goal).toMatch(/^Continue the earlier Claude Code session: /);
    expect(t.origin).toEqual({ kind: 'session', sessionEntryId: entry.id, source: 'Claude Code session', untrusted: true });
    const session = repos.sessions.get(t.currentSessionId!)!;
    expect(session).toMatchObject({ reason: 'import', externalSessionId: id, runtime: 'claude-cli', endedAt: null });
    const copy = path.join(claudeDir, 'projects', encodeProjectDir(t.folder), `${id}.jsonl`);
    expect(fs.readFileSync(copy, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
    expect(path.basename(path.dirname(copy))).toMatch(/^[A-Za-z0-9-]+$/);
    expect(repos.sessionLibrary!.get(entry.id)!.ticketId).toBe(t.id);
    expect(security.find((s) => s.action === 'session.imported')).toMatchObject({ category: 'session', ticketId: t.id });
    expect(events.some((e) => e.type === 'sessions.changed')).toBe(true);
    // Opening again goes to the same ticket.
    expect((await openSession(ctx, entry.id, {}, { claudeDir })).action).toBe('existing');

    // The first run resumes the imported session (claude --resume <id>), in the ticket folder.
    ctx.queue.enqueue('run.start', { ticketId: t.id });
    const ex = createExecutor(ctx, { pollMs: 10_000 });
    ex.tick();
    await ex.idle();
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ externalSessionId: id, newExternalSessionId: undefined, cwd: t.folder });
    expect(repos.tickets.get(t.id)!.currentSessionId).toBe(session.id);
  });

  it('claude-code: refused when Claude Code is not enabled or the file is gone', async () => {
    const { file } = writeClaudeSession(path.join(projectsDir(), 'C--y'));
    await scanSessions(ctx, { claudeDir });
    const entry = listSessions(ctx, {}).items[0]!;
    const noClaude = { ...ctx, runtimes: { get: () => undefined, list: () => [] } } as unknown as AppContext;
    await expect(openSession(noClaude, entry.id, {}, { claudeDir })).rejects.toMatchObject({ statusCode: 409, code: 'runtime_unavailable' });
    fs.rmSync(file);
    await expect(openSession(ctx, entry.id, {}, { claudeDir })).rejects.toMatchObject({ statusCode: 409, code: 'session_file_missing' });
  });

  it('sebeto: a Completed ticket is reopened (Needs you, cause user); an open one is returned as is', async () => {
    const { ticket } = await startedTicket('Old incident', 'Write the postmortem');
    ctx.state.transition(ticket.id, 'done', 'user');
    fileTicketSession(ctx, ticket.id);
    const entry = listSessions(ctx, { source: 'sebeto' }).items[0]!;
    const res = await openSession(ctx, entry.id);
    expect(res).toMatchObject({ action: 'reopened', ticket: { id: ticket.id, status: 'needs_you' } });
    expect(repos.transitions.listForTicket(ticket.id).at(-1)).toMatchObject({ from: 'done', to: 'needs_you', cause: 'user' });
    expect(security.find((s) => s.action === 'session.reopened')).toMatchObject({ ticketId: ticket.id });
    expect((await openSession(ctx, entry.id)).action).toBe('existing');
  });
});

// ------------------------------------------------------------------ memory helpers
describe('memory helpers', () => {
  it('prefers the agent\'s team category and caps results', async () => {
    const teamId = uuidv7();
    db.prepare(`INSERT INTO teams (id, slug, name, color, created_at, updated_at) VALUES (?, 'security', 'Security', '#000000', 'x', 'x')`).run(teamId);
    const agent = repos.agents.create({ name: 'Sec' });
    db.prepare('UPDATE agents SET team_id = ? WHERE id = ?').run(teamId, agent.id);
    for (let i = 0; i < 12; i++) addEntry({ title: `Firewall change ${i}`, lastActivityAt: `2026-11-1${i % 10}T00:00:00.000Z` });
    addEntry({ title: 'Firewall audit', category: 'security', pinned: true, lastActivityAt: '2026-01-01T00:00:00.000Z' });
    const res = searchMemory(ctx, { query: 'firewall', agentId: agent.id, limit: 50 });
    expect(res).toHaveLength(10);
    expect(res[0]!.title).toBe('Firewall audit');
  });
});

// ------------------------------------------------------------------ API
describe('sessions API', () => {
  it('list, categories, get, patch, transcript, scan, open, delete; OpenAPI lists every route', async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    const app = await createServer(ctx);
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      writeClaudeSession(path.join(projectsDir(), 'C--api'));
      const scan = await app.inject({ method: 'POST', url: '/api/v1/sessions/scan', headers: auth });
      expect(scan.json()).toMatchObject({ found: 1, added: 1 });
      const list = await app.inject({ url: '/api/v1/sessions?q=laptops&source=claude-code&limit=5', headers: auth });
      expect(list.statusCode).toBe(200);
      const entry = (list.json() as { items: SessionEntry[] }).items[0]!;
      expect(entry).not.toHaveProperty('filePath');
      expect((await app.inject({ url: `/api/v1/sessions/${entry.id}`, headers: auth })).json()).toMatchObject({ id: entry.id });
      const patched = await app.inject({ method: 'PATCH', url: `/api/v1/sessions/${entry.id}`, headers: auth, payload: { category: '#Service Desk', pinned: true, tags: ['Naples'] } });
      expect(patched.json()).toMatchObject({ category: 'service-desk', pinned: true, tags: ['naples'] });
      expect((await app.inject({ method: 'PATCH', url: `/api/v1/sessions/${entry.id}`, headers: auth, payload: { bogus: 1 } })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/v1/sessions/categories', headers: auth })).json()).toEqual([{ category: 'service-desk', count: 1 }]);
      expect((await app.inject({ url: '/api/v1/sessions?category=service-desk', headers: auth })).json().items).toHaveLength(1);
      const tr = await app.inject({ url: `/api/v1/sessions/${entry.id}/transcript?limit=2`, headers: auth });
      expect(tr.json()).toMatchObject({ entryId: entry.id, truncated: true });
      const opened = await app.inject({ method: 'POST', url: `/api/v1/sessions/${entry.id}/open`, headers: auth, payload: {} });
      expect(opened.statusCode).toBe(201);
      expect(opened.json()).toMatchObject({ action: 'created', ticket: { runtime: 'claude-cli' } });
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/sessions/${entry.id}`, headers: auth })).statusCode).toBe(204);
      expect((await app.inject({ url: `/api/v1/sessions/${entry.id}`, headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ url: '/api/v1/sessions', headers: {} })).statusCode).toBe(401);
      const spec = (await app.inject({ url: '/api/v1/openapi.json', headers: auth })).json();
      for (const p of ['/sessions', '/sessions/categories', '/sessions/scan', '/sessions/{id}', '/sessions/{id}/transcript', '/sessions/{id}/open']) expect(spec.paths[p], p).toBeDefined();
    } finally {
      await app.close();
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe('categories', () => {
  it('counts per category, latest first by count', () => {
    addEntry({ category: 'devops' });
    addEntry({ category: 'devops' });
    addEntry({ category: 'security' });
    expect(sessionCategories(ctx)).toEqual([{ category: 'devops', count: 2 }, { category: 'security', count: 1 }]);
  });
});
