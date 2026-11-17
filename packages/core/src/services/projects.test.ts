import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeTag, normalizeTags, splitTagQuery, uuidv7, type WsEvent } from '@sebeto/shared';
import type { AppContext, Repos } from '../contracts.js';
import { MIGRATIONS, openDatabase } from '../storage/index.js';
import { createProject, deleteProject, listProjects, listTags, updateProject } from './projects.js';
import { createTicket, listTickets, updateTicket } from './tickets.js';
import { buildSystemPrompt } from '../executor/prompts.js';

let dir: string;
let repos: Repos;
let events: WsEvent[];
let ctx: AppContext;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-projects-'));
  ({ repos } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  events = [];
  ctx = {
    repos, bus: { publish: (e: WsEvent) => events.push(e), subscribe: () => () => undefined },
    snapshots: { init: async () => undefined }, runtimes: { get: () => undefined, list: () => [] },
    queue: { enqueue: () => ({ id: 'j' }) }, log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;
});
afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tags helpers', () => {
  it('normalise tags and split #tags from search text', () => {
    expect(normalizeTag('  #Network ')).toBe('network');
    expect(normalizeTag('Office move')).toBe('office-move');
    expect(normalizeTag('città')).toBe('città');
    expect(normalizeTag('###')).toBeNull();
    expect(normalizeTags(['A', 'a', '#b', '', ...Array.from({ length: 20 }, (_, i) => `t${i}`)])).toHaveLength(10);
    expect(splitTagQuery('printer #Network jam #urgent')).toEqual({ text: 'printer jam', tags: ['network', 'urgent'] });
    expect(splitTagQuery('C# question')).toEqual({ text: 'C# question', tags: [] }); // "#" inside a word is not a tag
  });
});

describe('projects and tags', () => {
  it('create, rename, archive, list with counts; unique names; colours validated', async () => {
    const p = createProject(ctx, { name: 'Windows 11 rollout', description: 'Upgrade all laptops by March. Pilot in Naples first.' });
    expect(p.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(() => createProject(ctx, { name: 'windows 11 ROLLOUT' })).toThrow(/already exists/);
    expect(() => createProject(ctx, { name: 'X', color: 'blue' })).toThrow(/Colour/);
    await createTicket(ctx, { title: 'Inventory laptops', goal: 'List models', projectId: p.id, tags: ['#Inventory', 'Naples'] });
    await createTicket(ctx, { title: 'Unrelated', goal: 'x' });
    const [summary] = listProjects(ctx);
    expect(summary).toMatchObject({ name: 'Windows 11 rollout', counts: { backlog: 1 }, costUsd: 0 });
    const renamed = updateProject(ctx, p.id, { name: 'Win11 rollout', archived: true });
    expect(renamed).toMatchObject({ name: 'Win11 rollout', archived: true });
    expect(events.filter((e) => e.type === 'project.updated')).toHaveLength(2);
    await expect(createTicket(ctx, { title: 'Bad', goal: 'x', projectId: 'nope' })).rejects.toThrow(/does not exist/);
  });

  it('tickets carry project and tags; filters by project, none, tag and #tag in search', async () => {
    const p = createProject(ctx, { name: 'Office move' });
    const a = await createTicket(ctx, { title: 'Move printers', goal: 'Plan the printer move', projectId: p.id, tags: ['printers', 'urgent'] });
    const b = await createTicket(ctx, { title: 'Order cables', goal: 'Network cables for the new office', projectId: p.id, tags: ['network'] });
    const c = await createTicket(ctx, { title: 'Printer jam at HQ', goal: 'Fix it', tags: ['printers'] });
    expect(a).toMatchObject({ projectId: p.id, tags: ['printers', 'urgent', 'printer'] }); // + automatic category
    const ids = (q: Parameters<typeof listTickets>[1]) => listTickets(ctx, q).items.map((t) => t.title).sort();
    expect(ids({ projectId: p.id })).toEqual(['Move printers', 'Order cables']);
    expect(ids({ projectId: 'none' })).toEqual(['Printer jam at HQ']);
    expect(ids({ tag: 'printers' })).toEqual(['Move printers', 'Printer jam at HQ']);
    expect(ids({ q: '#printers #urgent' })).toEqual(['Move printers']);
    expect(ids({ q: 'printer #printers', projectId: 'none' })).toEqual(['Printer jam at HQ']);
    expect(listTags(ctx)).toEqual([{ tag: 'printer', count: 2 }, { tag: 'printers', count: 2 }, { tag: 'network', count: 1 }, { tag: 'urgent', count: 1 }]);

    const moved = updateTicket(ctx, c.id, { projectId: p.id, tags: ['Printers', 'HQ'] });
    expect(moved).toMatchObject({ projectId: p.id, tags: ['printers', 'hq'] });
    expect(updateTicket(ctx, b.id, { projectId: null }).projectId).toBeNull();

    // Deleting a project keeps its tickets, without a project.
    deleteProject(ctx, p.id);
    expect(repos.tickets.get(a.id)).toMatchObject({ projectId: null, tags: ['printers', 'urgent', 'printer'] });
    expect(events.some((e) => e.type === 'project.deleted')).toBe(true);
    expect(listProjects(ctx)).toEqual([]);
  });

  it('the project brief and tags reach the agent instructions', async () => {
    const p = createProject(ctx, { name: 'Windows 11 rollout', description: 'Pilot in Naples first. Never touch the CFO laptops.' });
    const t = await createTicket(ctx, { title: 'Pilot plan', goal: 'Plan the pilot', projectId: p.id, tags: ['naples'] });
    const sys = buildSystemPrompt(null, t, [], p);
    expect(sys).toContain('This ticket is part of the project "Windows 11 rollout". Project brief from the owner:\nPilot in Naples first. Never touch the CFO laptops.');
    expect(sys).toContain('Ticket tags: naples');
    expect(buildSystemPrompt(null, { ...t, tags: [] }, [], null)).not.toContain('project');
  });
});

describe('migration v5 on an existing database', () => {
  it('existing tickets get no project and no tags', () => {
    repos.close();
    const file = path.join(dir, 'old.db');
    const D = (require('better-sqlite3') as typeof import('better-sqlite3'));
    const raw = new D(file);
    raw.pragma('synchronous = OFF'); // set-up speed only (slow disks)
    raw.transaction(() => { for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m); })();
    raw.pragma('user_version = 4');
    raw.prepare(`INSERT INTO tickets (id, number, title, goal, status, folder, cost_cap_usd, cost_usd, created_at, updated_at)
      VALUES (?, 1, 'Old ticket', '', 'backlog', '/x', 5, 0, '2026-01-01', '2026-01-01')`).run(uuidv7());
    raw.close();
    const opened = openDatabase({ file, workspaceDir: dir });
    repos = opened.repos;
    expect(opened.migration).toMatchObject({ from: 4, to: MIGRATIONS.length });
    expect(repos.tickets.list({}).items[0]).toMatchObject({ title: 'Old ticket', projectId: null, tags: [] });
  }, 60_000);
});
