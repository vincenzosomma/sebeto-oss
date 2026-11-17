/** Memory graph (v0.4 §E): frontmatter, path safety, index, ticket notes, backfill, API. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostTokens, isMatchableName, memoryHostLabel, type MemoryGraph, type MemoryNoteDetail, type WsEvent } from '@sebeto/shared';
import type { AppContext, NewSecurityEvent, PlanningTurnInput, PlanningTurnResult, Repos } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createJobQueue } from '../queue/index.js';
import { createServer } from '../api/index.js';
import { addAliasToText, parseNoteFile, renderNoteFile } from './frontmatter.js';
import { MemoryPathError, absOf, cleanRel, writeNote } from './files.js';
import { createMemoryVault, type MemoryVault } from './vault.js';
import { AUTO_END, backfillTicketNotes, followCompletedTickets, parsePlan, writeTicketNote } from './ticket-notes.js';
import { approveMemoryNote, createMemoryNote, deleteMemoryNote, proposeMemoryNote, updateMemoryNote } from './service.js';

const TOKEN = 'memory-graph-test-token-0123456789abcdef';
let dir: string;
let repos: Repos;
let ctx: AppContext;
let vault: MemoryVault;
let events: WsEvent[];
let security: NewSecurityEvent[];
let turns: PlanningTurnInput[];
let reply: (input: PlanningTurnInput) => Promise<PlanningTurnResult>;

const mem = () => path.join(dir, 'memory');
const put = (rel: string, text: string) => {
  const abs = path.join(mem(), ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};
const read = (rel: string) => fs.readFileSync(path.join(mem(), ...rel.split('/')), 'utf8');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-memory-graph-'));
  let db;
  ({ repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  const bus = createEventBus();
  events = [];
  security = [];
  turns = [];
  reply = async () => ({ text: '{"summary":"x","fix":"","entities":[]}', costUsd: 0.001, model: 'cheap' });
  bus.subscribe((e) => events.push(e));
  ctx = {
    config: { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 1, runtimes: ['mock'], version: '0.4.0-test' },
    repos, bus, state: createStateMachine(repos, bus), queue: createJobQueue(db),
    runtimes: { get: () => undefined, list: () => [] },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    securityLog: { record: (e: NewSecurityEvent) => { security.push(e); return null; }, lockdown: () => false },
    planningTurn: (input: PlanningTurnInput) => { turns.push(input); return reply(input); },
  } as unknown as AppContext;
  vault = createMemoryVault(ctx);
  ctx.memory = vault;
});

afterEach(() => {
  vault.stop();
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function doneTicket(title: string, goal: string, opts: { agentText?: string; untrustedOrigin?: boolean; teamId?: string } = {}) {
  const agent = repos.agents.create({ name: 'Analyst', runtime: 'claude-cli', ...(opts.teamId ? { teamId: opts.teamId } : {}) });
  const t = repos.tickets.create({
    title, goal, agentId: agent.id, ...(opts.teamId ? { teamId: opts.teamId } : {}),
    ...(opts.untrustedOrigin ? { origin: { kind: 'trigger', source: 'Alertmanager', untrusted: true } } : {}),
  });
  if (opts.agentText) repos.messages.create({ ticketId: t.id, role: 'agent', author: 'Analyst', text: opts.agentText });
  ctx.state.transition(t.id, 'done', 'user');
  return repos.tickets.get(t.id)!;
}

// ------------------------------------------------------------------ frontmatter
describe('frontmatter', () => {
  it('round-trips and keeps unknown keys, comments and aliases', () => {
    const src = '---\n# owner comment\ncssclass: wide\naliases: [FS-01, fileserver]\ntags: [a]\nnested:\n  deep: [1, 2]\n---\nBody [[VPN]]\n';
    const p = parseNoteFile(src);
    expect(p.hasSebeto).toBe(false);
    expect(p.aliases).toEqual(['FS-01', 'fileserver']);
    expect(p.tags).toEqual(['a']);
    const out = renderNoteFile({ sebeto: { id: '0193aaaa-bbbb', kind: 'system', provenance: 'owner', untrusted: false, status: 'approved', team: null, ticket: null }, tags: ['a', 'b'] }, p.body, p);
    expect(out).toContain('# owner comment');
    expect(out).toContain('cssclass: wide');
    expect(out).toContain('deep: [ 1, 2 ]');
    expect(out).toContain('aliases: [ FS-01, fileserver ]');
    const again = parseNoteFile(out);
    expect(again.sebeto).toMatchObject({ id: '0193aaaa-bbbb', kind: 'system', provenance: 'owner', untrusted: false, status: 'approved', team: null });
    expect(again.tags).toEqual(['a', 'b']);
    expect(again.body).toBe('Body [[VPN]]\n');
  });

  it('never executes tags and treats broken YAML as body text', () => {
    const evil = parseNoteFile('---\nx: !!js/function "function(){ throw 1 }"\ny: !!python/object:os.system [rm]\n---\nhi');
    expect(evil.body).toBe('hi');
    const broken = parseNoteFile('---\n: : [\n---\ntext');
    expect(broken.doc).toBeNull();
    expect(broken.body).toContain('text');
    expect(parseNoteFile('no frontmatter').body).toBe('no frontmatter');
    expect(parseNoteFile('---\nsebeto:\n  kind: bogus\n  untrusted: yes\n---\nb').sebeto).toEqual({});
  });

  it('parses the plan JSON strictly', () => {
    expect(parsePlan('Sure! {"summary":"Disk full on FS01","fix":"Cleaned","entities":[{"name":"FS01","kind":"system"}]} done')).toMatchObject({ summary: 'Disk full on FS01' });
    expect(parsePlan('{"summary":"x","entities":[{"name":"a","kind":"rocket"}]}')).toBeNull();
    expect(parsePlan('not json')).toBeNull();
  });
});

// ------------------------------------------------------------------ paths
describe('path safety', () => {
  it('rejects paths that leave the folder, hidden folders and links', async () => {
    for (const bad of ['../x.md', 'a/../../x.md', '/etc/x.md', 'C:/x.md', 'C:\\x.md', '.obsidian/x.md', 'a/.trash/x.md', '', 'a//b.md']) {
      expect(() => cleanRel(bad), bad).toThrow(MemoryPathError);
    }
    expect(cleanRel('systems\\FS01.md')).toBe('systems/FS01.md');
    expect(absOf(mem(), '.trash/x.md', { allowHidden: true })).toBe(path.join(mem(), '.trash', 'x.md'));
    await expect(writeNote(mem(), 'notes/big.md', 'x'.repeat(70 * 1024))).rejects.toThrow(/too long/);
    // A folder link pointing outside the vault is never written through.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-outside-'));
    fs.mkdirSync(mem(), { recursive: true });
    let linked = true;
    try { fs.symlinkSync(outside, path.join(mem(), 'apps'), 'junction'); } catch { linked = false; }
    if (linked) {
      await expect(writeNote(mem(), 'apps/evil.md', 'x')).rejects.toThrow(MemoryPathError);
      expect(fs.readdirSync(outside)).toEqual([]);
      fs.writeFileSync(path.join(outside, 'secret.md'), 'secret [[x]]');
      await vault.reindex({ full: true });
      expect(vault.list({}).map((n) => n.path)).not.toContain('apps/secret.md');
    }
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

// ------------------------------------------------------------------ index
describe('index', () => {
  it('builds notes, links, aliases and backlinks from files; skips .obsidian/.trash and big files', async () => {
    put('systems/FS01.md', '---\naliases: [fileserver]\ntags: [naples]\n---\nMain file server. Restore with [[Restore FS01]].\nVPN: [[VPN gateway|the gateway]]\n');
    put('runbooks/Restore FS01.md', 'Steps to restore [[fs01]].');
    put('tickets/T-1 Disk full.md', 'Disk was full on [[FileServer]].');
    put('.obsidian/workspace.md', '[[FS01]]');
    put('.trash/old.md', '[[FS01]]');
    put('notes/huge.md', 'x'.repeat(65 * 1024 + 10));
    const res = await vault.reindex({ full: true });
    expect(res.notes).toBe(3);
    const fs01 = vault.resolve('fs01')!;
    expect(fs01).toMatchObject({ title: 'FS01', kind: 'system', provenance: 'owner', status: 'approved', untrusted: false, tags: ['naples'] });
    expect(vault.resolve('fileserver')!.id).toBe(fs01.id);
    const d = (await vault.detail(fs01.id))!;
    expect(d.links).toEqual(['Restore FS01', 'VPN gateway']);
    expect(d.backlinks.map((b) => b.title).sort()).toEqual(['Restore FS01', 'T-1 Disk full']);
    expect(d.obsidianUrl).toMatch(/^obsidian:\/\/open\?path=/);
    expect(vault.list({ q: 'restore' }).map((n) => n.title)).toContain('Restore FS01');
    // the FTS query escapes user text
    expect(() => vault.list({ q: '"; DROP TABLE x; -- NEAR(' })).not.toThrow();
    const g = vault.graph({});
    expect(g.nodes.find((n) => n.id === 'missing:vpn gateway')).toMatchObject({ kind: 'missing', title: 'vpn gateway' });
    expect(g.edges).toEqual(expect.arrayContaining([{ from: fs01.id, to: vault.resolve('Restore FS01')!.id }]));
    const rel = vault.related('FS01', { depth: 1 });
    expect(rel.neighbours.map((n) => [n.note.title, n.via])).toEqual(expect.arrayContaining([['Restore FS01', 'out'], ['T-1 Disk full', 'in']]));
  });

  it('picks up an owner edit on rescan, a rename keeps the id, a removed file leaves the index', async () => {
    put('systems/FS01.md', '---\nsebeto:\n  id: 0193f0f0-aaaa-7bbb-8ccc-000000000001\n  kind: system\n---\nOld text');
    await vault.reindex({ full: true });
    const id = vault.resolve('FS01')!.id;
    expect(id).toBe('0193f0f0-aaaa-7bbb-8ccc-000000000001');
    const abs = put('systems/FS01.md', '---\nsebeto:\n  id: 0193f0f0-aaaa-7bbb-8ccc-000000000001\n  kind: system\n---\nNew text links [[DC01]]');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(abs, later, later);
    events.length = 0;
    await vault.reindex();
    expect(vault.get(id)!.excerpt).toBe('New text links DC01');
    expect(events).toContainEqual({ type: 'memory.changed' });
    fs.renameSync(abs, path.join(mem(), 'systems', 'FS01 Naples.md'));
    await vault.reindex();
    expect(vault.get(id)!.path).toBe('systems/FS01 Naples.md');
    fs.rmSync(path.join(mem(), 'systems', 'FS01 Naples.md'));
    await vault.reindex();
    expect(vault.get(id)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ owner API services
describe('owner notes', () => {
  it('create, edit (keeps unknown keys, other notes untouched), approve a proposal, delete to trash', async () => {
    put('systems/DC01.md', '---\nsebeto:\n  provenance: chief-of-staff\n  untrusted: true\n---\nDomain controller');
    await vault.reindex({ full: true });
    const created = await createMemoryNote(ctx, { title: 'FS01', kind: 'system', body: 'File server, see [[DC01]]', tags: ['Naples'] });
    expect(created).toMatchObject({ path: 'systems/FS01.md', provenance: 'owner', status: 'approved', tags: ['naples'], links: ['DC01'] });
    await expect(createMemoryNote(ctx, { title: 'fs01', kind: 'system', body: '' })).rejects.toMatchObject({ statusCode: 409 });
    fs.writeFileSync(path.join(mem(), 'systems', 'FS01.md'), read('systems/FS01.md').replace('---\n', '---\ncssclass: wide\n'));
    await vault.indexFile('systems/FS01.md');
    const edited = await updateMemoryNote(ctx, created.id, { title: 'FS01 Naples', kind: 'system', body: 'Edited', tags: [] });
    expect(edited.path).toBe('systems/FS01 Naples.md');
    expect(read('systems/FS01 Naples.md')).toContain('cssclass: wide');
    expect(vault.resolve('DC01')).toMatchObject({ provenance: 'chief-of-staff', untrusted: true });

    const proposal = await proposeMemoryNote(ctx, { ticketId: doneTicket('x', 'y').id, runId: 'r', sessionId: 's', agentId: null, untrusted: false }, { title: 'DC01', kind: 'system', body: 'New version' });
    expect(proposal.replaces).toBe(true);
    expect(proposal.note.path).toBe('proposed/DC01.md');
    const approved = await approveMemoryNote(ctx, proposal.note.id);
    expect(approved).toMatchObject({ path: 'systems/DC01 2.md', status: 'approved', provenance: 'agent' });
    expect(read('systems/DC01.md')).toContain('Domain controller');
    expect(parseNoteFile(read('systems/DC01 2.md')).sebeto.status).toBe('approved');
    await expect(approveMemoryNote(ctx, approved.id)).rejects.toMatchObject({ statusCode: 409 });

    await deleteMemoryNote(ctx, approved.id);
    expect(fs.existsSync(path.join(mem(), '.trash', 'systems', 'DC01 2.md'))).toBe(true);
    expect(vault.get(approved.id)).toBeUndefined();
    expect(security.map((e) => e.action)).toEqual(expect.arrayContaining(['memory.note_written', 'memory.note_edited', 'memory.note_proposed', 'memory.note_approved', 'memory.note_deleted']));
    expect(security.find((e) => e.action === 'memory.note_approved')!.actor).toMatchObject({ type: 'user' });
  });
});

// ------------------------------------------------------------------ ticket notes
describe('ticket notes', () => {
  it('writes the note with links + stubs, redacts secrets, and updates idempotently keeping owner text', async () => {
    put('runbooks/Restore FS01.md', 'steps');
    await vault.reindex({ full: true });
    reply = async () => ({
      text: JSON.stringify({ summary: 'Disk full on FS01, password=hunter2secret', fix: `Cleaned logs with token ${TOKEN}`, entities: [{ name: 'FS01', kind: 'system' }, { name: 'CVE-2024-3400', kind: 'cve' }, { name: 'Restore FS01', kind: 'runbook' }] }),
      costUsd: 0.004, model: 'cheap',
    });
    const t = doneTicket('Disk full', 'FS01 is full', { agentText: 'Done' });
    const r = await writeTicketNote(ctx, vault, t.id);
    expect(r).toMatchObject({ written: true, outcome: 'created', usedModel: true, stubs: 2, costUsd: 0.004 });
    expect(turns[0]!.budgetUsd).toBeLessThanOrEqual(0.01);
    expect(turns[0]!.runtime).toBeUndefined();
    const rel = `tickets/T-${t.number} Disk full.md`;
    const text = read(rel);
    expect(text).toContain('[[FS01]]');
    expect(text).toContain('[[CVE-2024-3400]]');
    expect(text).not.toContain('hunter2secret');
    expect(text).not.toContain(TOKEN);
    expect(parseNoteFile(text).sebeto).toMatchObject({ kind: 'ticket', provenance: 'chief-of-staff', untrusted: false, ticket: t.id });
    expect(vault.resolve('FS01')).toMatchObject({ path: 'systems/FS01.md', provenance: 'chief-of-staff', status: 'approved' });
    expect(vault.resolve('CVE-2024-3400')!.path).toBe('cves/CVE-2024-3400.md');
    expect(vault.related('FS01').neighbours.map((n) => n.note.title)).toContain(`T-${t.number} Disk full`);

    // already up to date → unchanged; owner text below the marker survives a re-completion
    expect((await writeTicketNote(ctx, vault, t.id)).outcome).toBe('unchanged');
    fs.writeFileSync(path.join(mem(), ...rel.split('/')), `${text}\nOWNER LINE\n`);
    await vault.reindex();
    ctx.state.transition(t.id, 'needs_you', 'user');
    ctx.state.transition(t.id, 'done', 'user');
    reply = async () => ({ text: '{"summary":"Second time","fix":"","entities":[]}', costUsd: 0, model: 'cheap' });
    const again = await writeTicketNote(ctx, vault, t.id);
    expect(again.outcome).toBe('updated');
    const updated = read(rel);
    expect(updated).toContain('Second time');
    expect(updated).toContain('OWNER LINE');
    expect(updated.indexOf('OWNER LINE')).toBeGreaterThan(updated.indexOf(AUTO_END));
    expect(vault.list({ kind: 'ticket' })).toHaveLength(1);
  });

  it('falls back to rules on invalid JSON (goal + last message, existing notes and CVEs linked) and propagates untrusted', async () => {
    put('systems/VPN gateway.md', 'the gateway');
    await vault.reindex({ full: true });
    reply = async () => ({ text: 'I think it was the VPN.', costUsd: 0.001, model: 'cheap' });
    const t = doneTicket('VPN down', 'Users cannot reach the vpn gateway, see CVE-2023-1111', { agentText: 'Restarted the service', untrustedOrigin: true });
    const r = await writeTicketNote(ctx, vault, t.id);
    expect(r).toMatchObject({ written: true, usedModel: false, modelCalled: true });
    const text = read(`tickets/T-${t.number} VPN down.md`);
    expect(text).toContain('Users cannot reach the vpn gateway');
    expect(text).toContain('Restarted the service');
    expect(text).toContain('[[VPN gateway]]');
    expect(text).toContain('[[CVE-2023-1111]]');
    expect(parseNoteFile(text).sebeto.untrusted).toBe(true);
    expect(vault.resolve('CVE-2023-1111')).toMatchObject({ untrusted: true, provenance: 'chief-of-staff' });
    expect(vault.resolve('VPN gateway')).toMatchObject({ untrusted: false, provenance: 'owner' });
  });

  it('marks the note untrusted when a run of the ticket read outside content', async () => {
    const t = doneTicket('Phish check', 'check the mail');
    repos.audit.append({ ticketId: t.id, kind: 'tool', summary: 'Read email', data: { tool: 'read_email', untrusted: true } });
    await writeTicketNote(ctx, vault, t.id);
    expect(vault.list({ kind: 'ticket' })[0]!.untrusted).toBe(true);
  });

  it('never sends a locked team\'s ticket to another runtime', async () => {
    const red = repos.teams!.create({ slug: 'red-team', name: 'Red Team', description: '', color: '#f00', leadAgentId: null, routingHints: '' });
    // Lock the team to Ollama (columns from v8; part F adds the API).
    const db = (repos as unknown as { db?: unknown }).db;
    void db;
    const sqlite = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir });
    sqlite.db.prepare("UPDATE teams SET runtime = 'ollama', model = 'llama3', lock_runtime = 1 WHERE id = ?").run(red.id);
    sqlite.repos.close();
    const t = doneTicket('Pentest web', 'Scope: 10.0.0.0/24', { teamId: red.id });
    await writeTicketNote(ctx, vault, t.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ runtime: 'ollama', model: 'llama3' });

    // Locked without an AI: no model call at all, a rules-only note.
    const sqlite2 = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir });
    sqlite2.db.prepare('UPDATE teams SET runtime = NULL WHERE id = ?').run(red.id);
    sqlite2.repos.close();
    const t2 = doneTicket('Pentest 2', 'more', { teamId: red.id });
    const r2 = await writeTicketNote(ctx, vault, t2.id);
    expect(r2).toMatchObject({ written: true, modelCalled: false, usedModel: false });
    expect(turns).toHaveLength(1);

    // The default planning turn refuses to fall back to another runtime when the team's one is missing.
    const { runPlanningTurn } = await import('../services/planning.js');
    await expect(runPlanningTurn(ctx, { purpose: 'memory_note', systemPrompt: 's', prompt: 'p', budgetUsd: 0.01, timeoutMs: 1000, runtime: 'ollama' })).rejects.toThrow(/not available/);
  });

  it('follows completed tickets on the bus', async () => {
    const stop = followCompletedTickets(ctx, vault);
    doneTicket('Printer jam', 'Clear the jam');
    await new Promise((r) => setTimeout(r, 50));
    await vault.exclusive(async () => undefined);
    expect(vault.list({ kind: 'ticket' }).map((n) => n.title)).toEqual([expect.stringMatching(/Printer jam$/)]);
    expect(events).toContainEqual({ type: 'memory.changed' });
    stop();
  });

  it('backfill is rules-only by default (no model calls), skips existing notes, supports dry run and a capped model mode', async () => {
    doneTicket('A', 'goal a');
    doneTicket('B', 'goal b');
    const dry = await backfillTicketNotes(ctx, vault, { dryRun: true });
    expect(dry).toMatchObject({ considered: 2, written: 2, dryRun: true, modelCalls: 0 });
    expect(vault.list({})).toHaveLength(0);
    const res = await backfillTicketNotes(ctx, vault, {});
    expect(res).toMatchObject({ considered: 2, written: 2, skipped: 0, modelCalls: 0, costUsd: 0 });
    expect(turns).toHaveLength(0);
    expect((await backfillTicketNotes(ctx, vault, {})).skipped).toBe(2);
    doneTicket('C', 'goal c');
    const withModel = await backfillTicketNotes(ctx, vault, { useModel: true });
    expect(withModel).toMatchObject({ written: 1, modelCalls: 1, costUsd: 0.001 });
  });
});

// ------------------------------------------------------------------ API
describe('memory API', () => {
  it('notes CRUD, approve, delete to trash, graph shape + truncation, related, reindex, backfill, info, openapi', async () => {
    const app = await createServer(ctx);
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      const c = await app.inject({ method: 'POST', url: '/api/v1/memory/notes', headers: auth, payload: { title: 'FS01', kind: 'system', body: 'see [[Restore FS01]] and [[DC01]]' } });
      expect(c.statusCode).toBe(201);
      const fs01 = c.json() as MemoryNoteDetail;
      await app.inject({ method: 'POST', url: '/api/v1/memory/notes', headers: auth, payload: { title: 'Restore FS01', kind: 'runbook', body: 'steps for [[FS01]]' } });
      expect((await app.inject({ method: 'POST', url: '/api/v1/memory/notes', headers: auth, payload: { title: 'x', kind: 'rocket', body: '' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/memory/notes', headers: auth, payload: { title: '../../evil', kind: 'note', body: '' } })).json().path).toBe('notes/evil.md');
      const list = (await app.inject({ url: '/api/v1/memory/notes?kind=system', headers: auth })).json();
      expect(list.map((n: { title: string }) => n.title)).toEqual(['FS01']);
      expect(list[0]).not.toHaveProperty('sha256');
      const got = (await app.inject({ url: `/api/v1/memory/notes/${fs01.id}`, headers: auth })).json();
      expect(got.backlinks.map((b: { title: string }) => b.title)).toEqual(['Restore FS01']);
      const put1 = await app.inject({ method: 'PUT', url: `/api/v1/memory/notes/${fs01.id}`, headers: auth, payload: { title: 'FS01', kind: 'system', body: 'edited [[DC01]]' } });
      expect(put1.json().body).toBe('edited [[DC01]]\n');

      const g = (await app.inject({ url: '/api/v1/memory/graph', headers: auth })).json() as MemoryGraph;
      expect(g.truncated).toBe(false);
      expect(g.nodes.map((n) => n.kind).sort()).toEqual(['missing', 'note', 'runbook', 'system']);
      expect(g.nodes[0]).toEqual(expect.objectContaining({ id: expect.any(String), title: expect.any(String), degree: expect.any(Number) }));
      const small = (await app.inject({ url: '/api/v1/memory/graph?limit=2', headers: auth })).json() as MemoryGraph;
      expect(small.truncated).toBe(true);
      expect(small.nodes).toHaveLength(2);
      for (const e of small.edges) expect(small.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([e.from, e.to]));
      const centred = (await app.inject({ url: `/api/v1/memory/graph?center=${fs01.id}&depth=1`, headers: auth })).json() as MemoryGraph;
      expect(centred.nodes.map((n) => n.title).sort()).toEqual(['FS01', 'Restore FS01', 'dc01']);

      const rel = (await app.inject({ url: '/api/v1/memory/related?name=fs01', headers: auth })).json();
      expect(rel.note.title).toBe('FS01');
      expect((await app.inject({ url: '/api/v1/memory/related', headers: auth })).statusCode).toBe(400);

      // proposal → approve; proposals hidden from the graph unless asked
      const t = doneTicket('t', 'g');
      const p = await proposeMemoryNote(ctx, { ticketId: t.id, runId: 'r', sessionId: 's', agentId: null, untrusted: true }, { title: 'Proxy', kind: 'app', body: 'proxy' });
      expect(((await app.inject({ url: '/api/v1/memory/graph', headers: auth })).json() as MemoryGraph).nodes.some((n) => n.id === p.note.id)).toBe(false);
      expect(((await app.inject({ url: '/api/v1/memory/graph?proposed=1', headers: auth })).json() as MemoryGraph).nodes.find((n) => n.id === p.note.id)).toMatchObject({ status: 'proposed', untrusted: true });
      const ap = await app.inject({ method: 'POST', url: `/api/v1/memory/notes/${p.note.id}/approve`, headers: auth });
      expect(ap.json()).toMatchObject({ path: 'apps/Proxy.md', status: 'approved', untrusted: true });
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/memory/notes/${p.note.id}`, headers: auth })).statusCode).toBe(204);
      expect(fs.existsSync(path.join(mem(), '.trash', 'apps', 'Proxy.md'))).toBe(true);
      expect((await app.inject({ url: `/api/v1/memory/notes/${p.note.id}`, headers: auth })).statusCode).toBe(404);

      const ri = (await app.inject({ method: 'POST', url: '/api/v1/memory/reindex', headers: auth })).json();
      expect(ri).toMatchObject({ notes: 3, links: expect.any(Number), ms: expect.any(Number) });
      const bf = (await app.inject({ method: 'POST', url: '/api/v1/memory/backfill', headers: auth, payload: {} })).json();
      expect(bf).toMatchObject({ considered: 1, written: 1, modelCalls: 0 });
      expect(turns).toHaveLength(0);
      expect((await app.inject({ method: 'POST', url: '/api/v1/memory/backfill', headers: auth, payload: { bogus: true } })).statusCode).toBe(400);
      const info = (await app.inject({ url: '/api/v1/memory/info', headers: auth })).json();
      expect(info).toMatchObject({ folder: mem(), notes: 4, proposed: 0 });
      expect((await app.inject({ url: '/api/v1/memory/info' })).statusCode).toBe(401);
      const spec = (await app.inject({ url: '/api/v1/openapi.json', headers: auth })).json();
      for (const p2 of ['/memory/notes', '/memory/notes/{id}', '/memory/notes/{id}/approve', '/memory/graph', '/memory/related', '/memory/reindex', '/memory/backfill', '/memory/info']) {
        expect(spec.paths[p2], p2).toBeDefined();
      }
    } finally {
      await app.close();
    }
  });
});

// ------------------------------------------------------------------ v0.5 J: aliases and host names
describe('memory aliases (v0.5 J)', () => {
  it('host labels, matchable names and adding an alias to the frontmatter', async () => {
    expect(memoryHostLabel('FS01.naples.local')).toBe('fs01');
    expect(memoryHostLabel('fs01.naples.local.')).toBe('fs01');
    for (const no of ['fs01', '10.0.0.12', 'report.pdf', 'web.config', 'db.naples.local', 'e.g', 'app.naples.local']) expect(memoryHostLabel(no), no).toBeNull();
    expect(isMatchableName('FS01')).toBe(true);
    for (const no of ['dc', 'the', 'server', 'Backup', '1234', 'che']) expect(isMatchableName(no), no).toBe(false);
    expect(hostTokens('Ping FS01.naples.local and 10.1.2.3, see report.pdf; dc02.corp.example.')).toEqual(['fs01.naples.local', 'dc02.corp.example']);

    const owner = '---\n# my comment\ncssclass: wide\naliases: [FileServer]\n---\nOwner text [[DC01]]\n';
    const out = addAliasToText(owner, 'fs01.naples.local')!;
    expect(out).toContain('# my comment');
    expect(out).toContain('cssclass: wide');
    expect(out).toContain('aliases: [ FileServer, fs01.naples.local ]');
    expect(out.endsWith('---\nOwner text [[DC01]]\n')).toBe(true);
    expect(parseNoteFile(out).hasSebeto).toBe(false);
    expect(addAliasToText(out, 'FS01.NAPLES.LOCAL')).toBeNull();
    expect(addAliasToText('plain body', 'x.y.z')).toBe('---\naliases: [ x.y.z ]\n---\nplain body');
    expect(addAliasToText('---\n: : [\n---\ntext', 'a.b.c')).toBeNull();
  });

  it('resolves host names, aliases and case in lookup, related, links, backlinks and the graph', async () => {
    put('systems/FS01.md', '---\naliases: [FileServer, dc]\n---\nMain file server.');
    put('tickets/T-1 Share down.md', 'The share on [[fs01.naples.local]] was down.');
    put('runbooks/Night reboot.md', 'Reboot [[FILESERVER]] at night.');
    await vault.reindex({ full: true });
    const fs01 = vault.resolve('FS01')!;
    expect(vault.lookup('fs01.naples.local')).toMatchObject({ via: 'host', row: { id: fs01.id } });
    expect(vault.lookup('fileserver')).toMatchObject({ via: 'alias', row: { id: fs01.id } });
    expect(vault.lookup('fs01')).toMatchObject({ via: 'title' });
    expect(vault.lookup('fs02.naples.local')).toBeUndefined();
    expect(vault.resolve('FS01.Naples.Local')!.id).toBe(fs01.id);
    const rel = vault.related('fs01.naples.local');
    expect(rel.note!.title).toBe('FS01');
    expect(rel.neighbours.map((n) => n.note.title).sort()).toEqual(['Night reboot', 'T-1 Share down']);
    const ticketNote = vault.resolve('T-1 Share down')!;
    expect((await vault.detail(ticketNote.id))!.links).toEqual(['FS01']);
    const g = vault.graph({});
    expect(g.nodes.some((n) => n.kind === 'missing')).toBe(false);
    expect(g.edges).toContainEqual({ from: ticketNote.id, to: fs01.id });
    // the short alias "dc" never matches free text; the title, the long alias and other titles do
    expect(vault.matchers().map((m) => m.key).sort()).toEqual(['fileserver', 'fs01', 'night reboot']);
  });

  it('rules-only notes link host names, aliases and titles as whole words, never short or common names', async () => {
    put('systems/FS01.md', 'File server');
    put('systems/Naples.md', 'The site');
    put('systems/DC.md', 'Short name');
    put('apps/Backup.md', 'A common word');
    put('apps/Veeam.md', '---\naliases: [VBR]\n---\nBackup software');
    put('systems/Proxy.md', 'web proxy');
    await vault.reindex({ full: true });
    reply = async () => ({ text: 'no json', costUsd: 0, model: 'cheap' });
    const t = doneTicket('Share down', 'Users cannot open \\\\fs01.naples.local\\share. The DC said ok. Backup via vbr worked. proxy-pac and reverseproxy are fine.');
    const r = await writeTicketNote(ctx, vault, t.id);
    expect(r).toMatchObject({ written: true, usedModel: false, stubs: 0, aliases: 1 });
    const text = read(`tickets/T-${t.number} Share down.md`);
    expect(text).toContain('[[FS01|fs01.naples.local]] (system)');
    expect(text).toContain('[[Veeam]] (app)');
    for (const no of ['[[Naples', '[[DC', '[[Backup', '[[Proxy']) expect(text, no).not.toContain(no);
    expect(parseNoteFile(read('systems/FS01.md')).aliases).toEqual(['fs01.naples.local']);
    expect(vault.list({}).map((n) => n.title)).not.toContain('fs01.naples.local');
  });

  it('the Chief of Staff\'s links reuse the existing note, add the spelling as an alias, keep the owner\'s text', async () => {
    put('systems/FS01.md', '---\ncssclass: wide # keep me\n---\nOwner text about FS01.\n');
    await vault.reindex({ full: true });
    const id = vault.resolve('FS01')!.id;
    reply = async () => ({
      text: JSON.stringify({ summary: 'Share down', fix: 'Restarted', entities: [{ name: 'fs01.naples.local', kind: 'system' }, { name: 'FS01', kind: 'system' }, { name: 'dc02.naples.local', kind: 'system' }] }),
      costUsd: 0.002, model: 'cheap',
    });
    const t = doneTicket('Share down', 'fs01.naples.local share');
    const r = await writeTicketNote(ctx, vault, t.id);
    expect(r).toMatchObject({ stubs: 1, aliases: 1 });
    const fsText = read('systems/FS01.md');
    expect(fsText).toContain('cssclass: wide # keep me');
    expect(fsText).toContain('aliases: [ fs01.naples.local ]');
    expect(fsText.endsWith('Owner text about FS01.\n')).toBe(true);
    expect(parseNoteFile(fsText).hasSebeto).toBe(false);
    expect(vault.get(id)).toMatchObject({ provenance: 'owner', path: 'systems/FS01.md' });
    const note = read(`tickets/T-${t.number} Share down.md`);
    expect(note).toContain('[[FS01|fs01.naples.local]]');
    expect(note.match(/\[\[FS01/g)).toHaveLength(1);
    expect(note).toContain('[[dc02.naples.local]]'); // no DC02 note: a stub with that spelling
    expect(vault.list({}).map((n) => n.title).sort()).toEqual([`T-${t.number} Share down`, 'FS01', 'dc02.naples.local'].sort());
    expect(security.find((e) => e.action === 'memory.alias_added')).toMatchObject({ data: { noteId: id, alias: 'fs01.naples.local' } });
    expect(vault.lookup('fs01.naples.local')).toMatchObject({ via: 'alias' });

    // Outside (untrusted) content links the note but never writes an alias.
    reply = async () => ({ text: JSON.stringify({ summary: 'x', entities: [{ name: 'fs01.evil.example', kind: 'system' }] }), costUsd: 0, model: 'cheap' });
    const t2 = doneTicket('Alert', 'from outside', { untrustedOrigin: true });
    const r2 = await writeTicketNote(ctx, vault, t2.id);
    expect(r2).toMatchObject({ stubs: 0, aliases: 0 });
    expect(read(`tickets/T-${t2.number} Alert.md`)).toContain('[[FS01|fs01.evil.example]]');
    expect(parseNoteFile(read('systems/FS01.md')).aliases).toEqual(['fs01.naples.local']);
  });
});
