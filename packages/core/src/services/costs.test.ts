import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, type Id, type PlanningPurpose, type RuntimeAdapter } from '@sebeto/shared';
import type { AppContext, PlanningTurnResult, Repos } from '../contracts.js';
import { planningTurnOf } from './planning.js';
import { intakeTurn } from './intake.js';
import { openDatabase } from '../storage/index.js';
import { utcDays } from '../storage/costs.js';
import { costsReport, defaultCostRange } from './costs.js';
import { costsQuery } from '../api/cost-routes.js';
import { openApiSpec } from '../api/openapi.js';

let dir: string;
let repos: Repos;
let db: Database.Database;
let ctx: AppContext;

const NOW = new Date('2026-11-13T15:00:00.000Z');
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-14T00:00:00.000Z';

function runtime(id: string, displayName: string): RuntimeAdapter {
  return { id, displayName } as unknown as RuntimeAdapter;
}

let seq = 0;
function run(ticketId: Id, agentId: Id | null, rt: string, model: string | null, at: string, cost: number, tin = 100, tout = 10): void {
  const sid = uuidv7();
  db.prepare('INSERT INTO sessions (id, ticket_id, agent_id, runtime, model, reason, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sid, ticketId, agentId, rt, model, 'start', at);
  db.prepare(`INSERT INTO runs (id, session_id, ticket_id, trigger, status, started_at, ended_at, tokens_in, tokens_out, cost_usd)
              VALUES (?, ?, ?, 'start', 'succeeded', ?, ?, ?, ?, ?)`).run(uuidv7(), sid, ticketId, at, at, tin, tout, cost);
}

function noteEvent(ticketId: Id | null, at: string, costUsd: number, action = 'memory.note_written'): void {
  seq++;
  db.prepare(`INSERT INTO security_events (seq, id, at, category, action, severity, actor_type, actor_id, actor_name, ticket_id, summary, data, prev_hash, hash)
              VALUES (?, ?, ?, 'ticket', ?, 'info', 'system', NULL, 'Chief of Staff', ?, 'note', ?, 'x', 'y')`)
    .run(seq, uuidv7(), at, action, ticketId, JSON.stringify({ costUsd }));
}

let ids: { claude: Id; local: Id; win11: Id; sec: Id; t1: Id; t2: Id; t3: Id; t4: Id };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-costs-'));
  ({ repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  ctx = {
    repos, runtimes: { get: (id: string) => ({ 'claude-cli': runtime('claude-cli', 'Claude'), ollama: runtime('ollama', 'Ollama') } as Record<string, RuntimeAdapter>)[id], list: () => [] },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as AppContext;

  const claude = repos.agents.create({ name: 'Analyst', runtime: 'claude-cli', model: 'sonnet', monthlyBudgetUsd: 10 });
  const local = repos.agents.create({ name: 'Red teamer', runtime: 'ollama', model: 'qwen3', monthlyBudgetUsd: 20 });
  const win11 = repos.projects.create({ name: 'Windows 11 rollout', description: '', color: '#0E5A8A' });
  const sec = repos.teams!.create({ slug: 'security', name: 'Security', description: '', color: '#B5532C', leadAgentId: null, routingHints: '' });
  const t1 = repos.tickets.create({ title: 'Upgrade laptops', goal: 'g', agentId: claude.id, projectId: win11.id, teamId: sec.id });
  const t2 = repos.tickets.create({ title: 'Check CVE-2026-1234', goal: 'g', agentId: claude.id, teamId: sec.id });
  const t3 = repos.tickets.create({ title: 'Port scan lab', goal: 'g', agentId: local.id, teamId: sec.id });
  const t4 = repos.tickets.create({ title: 'Inventory', goal: 'g', agentId: claude.id, projectId: win11.id });
  ids = { claude: claude.id, local: local.id, win11: win11.id, sec: sec.id, t1: t1.id, t2: t2.id, t3: t3.id, t4: t4.id };

  // In the period (Nov 1 – Nov 13, UTC):
  run(t1.id, claude.id, 'claude-cli', 'sonnet', '2026-11-03T09:00:00.000Z', 0.25, 1000, 200);
  run(t1.id, claude.id, 'claude-cli', 'sonnet', '2026-11-03T23:59:59.999Z', 0.5, 2000, 300); // still Nov 3 in UTC
  run(t2.id, claude.id, 'claude-cli', 'haiku', '2026-11-04T00:00:00.000Z', 0.125, 500, 50);  // first ms of Nov 4
  run(t3.id, local.id, 'ollama', 'qwen3', '2026-11-04T10:00:00.000Z', 0, 4000, 900);
  run(t3.id, local.id, 'ollama', 'qwen3', '2026-11-05T10:00:00.000Z', 0, 3000, 600);
  run(t4.id, claude.id, 'claude-cli', null, '2026-11-13T12:00:00.000Z', 1, 10, 1);
  noteEvent(t2.id, '2026-11-12T08:00:00.000Z', 0.0625);
  noteEvent(t1.id, '2026-11-12T09:00:00.000Z', 0); // a rules-only note: not counted
  noteEvent(t1.id, '2026-11-12T10:00:00.000Z', 99, 'memory.backfill'); // the backfill sum: not counted twice
  // Outside the period:
  run(t1.id, claude.id, 'claude-cli', 'sonnet', '2026-10-31T23:59:59.999Z', 7);
  run(t1.id, claude.id, 'claude-cli', 'sonnet', '2026-11-14T00:00:00.000Z', 9);
  noteEvent(t2.id, '2026-10-20T08:00:00.000Z', 3);
});
afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cost dashboard', () => {
  it('sums runs and Chief of Staff notes exactly, with the paid / local split', () => {
    const r = costsReport(ctx, { from: FROM, to: TO }, NOW);
    expect(r).toMatchObject({ from: FROM, to: TO, timezone: 'UTC', filters: { projectId: null, teamId: null }, notCounted: [] });
    expect(r.totals).toEqual({ costUsd: 1.9375, runs: 6, tokensIn: 10510, tokensOut: 2051, tickets: 4, planningUsd: 0.0625, planningCalls: 1 });
    expect(r.split).toEqual({
      paid: { costUsd: 1.9375, runs: 4, tokensIn: 3510, tokensOut: 551 },
      free: { costUsd: 0, runs: 2, tokensIn: 7000, tokensOut: 1500 },
    });
  });

  it('v0.7: local OpenAI-compatible connections count as free, remote ones as paid', () => {
    run(ids.t3, ids.local, 'openai:lan-1', 'llama', '2026-11-06T10:00:00.000Z', 0, 800, 80);
    run(ids.t2, ids.claude, 'openai:cloud-1', 'gpt', '2026-11-06T11:00:00.000Z', 0.5, 200, 20);
    ctx = { ...ctx, aiConnections: { list: () => [
      { id: 'lan-1', runtimeId: 'openai:lan-1', kind: 'local' },
      { id: 'cloud-1', runtimeId: 'openai:cloud-1', kind: 'remote' },
    ] } } as unknown as AppContext;
    const r = costsReport(ctx, { from: FROM, to: TO }, NOW);
    expect(r.split.free).toEqual({ costUsd: 0, runs: 3, tokensIn: 7800, tokensOut: 1580 });
    expect(r.split.paid).toEqual({ costUsd: 2.4375, runs: 5, tokensIn: 3710, tokensOut: 571 });
    // Without the connection list (older core), the local one would count as paid.
    ctx = { ...ctx, aiConnections: undefined } as unknown as AppContext;
    expect(costsReport(ctx, { from: FROM, to: TO }, NOW).split.paid.runs).toBe(6);
  });

  it('groups by UTC day, filling empty days, stacked by runtime and project', () => {
    const r = costsReport(ctx, { from: FROM, to: TO }, NOW);
    expect(r.days.map((d) => d.day)).toEqual(utcDays(FROM, TO));
    expect(r.days).toHaveLength(13);
    const day = (d: string) => r.days.find((x) => x.day === d)!;
    expect(day('2026-11-03')).toMatchObject({ costUsd: 0.75, runs: 2, byRuntime: { 'claude-cli': 0.75 }, byProject: { [ids.win11]: 0.75 } });
    expect(day('2026-11-04')).toMatchObject({ costUsd: 0.125, runs: 2, tokensIn: 4500, byRuntime: { 'claude-cli': 0.125 }, byProject: { none: 0.125 } });
    expect(day('2026-11-05')).toMatchObject({ costUsd: 0, runs: 1, byRuntime: {}, byProject: {} });
    expect(day('2026-11-12')).toMatchObject({ costUsd: 0.0625, runs: 0, byRuntime: { 'chief-of-staff': 0.0625 } });
    expect(day('2026-11-01')).toEqual({ day: '2026-11-01', costUsd: 0, runs: 0, tokensIn: 0, tokensOut: 0, byRuntime: {}, byProject: {} });
    expect(r.days.reduce((n, d) => n + d.costUsd, 0)).toBeCloseTo(r.totals.costUsd, 9);

    const byDay = costsReport(ctx, { from: FROM, to: TO, groupBy: 'day' }, NOW).groups.day!;
    expect(byDay.map((g) => [g.key, g.costUsd])).toEqual([
      ['2026-11-03', 0.75], ['2026-11-04', 0.125], ['2026-11-05', 0], ['2026-11-12', 0.0625], ['2026-11-13', 1],
    ]);
  });

  it('breaks down by project, team, agent, runtime and model, with names', () => {
    const g = costsReport(ctx, { from: FROM, to: TO }, NOW).groups;
    expect(Object.keys(g).sort()).toEqual(['agent', 'model', 'project', 'runtime', 'team']);
    expect(g.project!.map((x) => [x.key, x.label, x.costUsd, x.runs])).toEqual([
      [ids.win11, 'Windows 11 rollout', 1.75, 3], [null, null, 0.1875, 3],
    ]);
    expect(g.team!.map((x) => [x.key, x.label, x.costUsd])).toEqual([[null, null, 1], [ids.sec, 'Security', 0.9375]]);
    expect(g.agent!.map((x) => [x.key, x.label, x.costUsd, x.runs, x.paidUsd])).toEqual([
      [ids.claude, 'Analyst', 1.875, 4, 1.875], ['chief-of-staff', null, 0.0625, 0, 0.0625], [ids.local, 'Red teamer', 0, 2, 0],
    ]);
    expect(g.runtime!.map((x) => [x.key, x.label, x.costUsd])).toEqual([
      ['claude-cli', 'Claude', 1.875], ['chief-of-staff', null, 0.0625], ['ollama', 'Ollama', 0],
    ]);
    expect(g.model!.map((x) => [x.key, x.costUsd])).toEqual([[null, 1], ['sonnet', 0.75], ['haiku', 0.125], ['chief-of-staff', 0.0625], ['qwen3', 0]]);
  });

  it('lists the top tickets by cost (Chief of Staff part included)', () => {
    const r = costsReport(ctx, { from: FROM, to: TO, top: 2 }, NOW);
    expect(r.topTickets).toEqual([
      { ticketId: ids.t4, number: 4, title: 'Inventory', status: 'backlog', projectId: ids.win11, teamId: null, costUsd: 1, planningUsd: 0, runs: 1 },
      { ticketId: ids.t1, number: 1, title: 'Upgrade laptops', status: 'backlog', projectId: ids.win11, teamId: ids.sec, costUsd: 0.75, planningUsd: 0, runs: 2 },
    ]);
    const all = costsReport(ctx, { from: FROM, to: TO }, NOW).topTickets;
    expect(all.map((t) => [t.number, t.costUsd, t.planningUsd])).toEqual([[4, 1, 0], [1, 0.75, 0], [2, 0.1875, 0.0625]]); // T-3 cost nothing
  });

  it('filters by project and team (including "none")', () => {
    const p = costsReport(ctx, { from: FROM, to: TO, projectId: ids.win11 }, NOW);
    expect(p.totals).toMatchObject({ costUsd: 1.75, runs: 3, tickets: 2 });
    expect(p.filters).toEqual({ projectId: ids.win11, teamId: null });
    const none = costsReport(ctx, { from: FROM, to: TO, projectId: 'none' }, NOW);
    expect(none.totals).toMatchObject({ costUsd: 0.1875, runs: 3, planningUsd: 0.0625 });
    const team = costsReport(ctx, { from: FROM, to: TO, teamId: ids.sec, projectId: 'none' }, NOW);
    expect(team.totals).toMatchObject({ costUsd: 0.1875, tickets: 2 });
    const noTeam = costsReport(ctx, { from: FROM, to: TO, teamId: 'none' }, NOW);
    expect(noTeam.totals.costUsd).toBe(1);
  });

  it('reports this UTC month\'s agent budgets (paid agents, or any agent that spent)', () => {
    const r = costsReport(ctx, { from: '2026-11-10T00:00:00.000Z', to: TO }, NOW);
    // Budget month = November 2026 regardless of the period: 0.25 + 0.5 + 0.125 + 1 + 9 (Nov 14) = 10.875.
    expect(r.budget).toEqual({
      month: '2026-11', limitUsd: 10, spentUsd: 10.875,
      agents: [{ agentId: ids.claude, name: 'Analyst', monthlyBudgetUsd: 10, spentUsd: 10.875 }],
    });
  });

  it('defaults to the last 30 UTC days and validates the period', () => {
    expect(defaultCostRange(NOW)).toEqual({ from: '2026-10-15T00:00:00.000Z', to: '2026-11-14T00:00:00.000Z' });
    const r = costsReport(ctx, {}, NOW);
    expect(r.days).toHaveLength(30);
    expect(r.totals.costUsd).toBe(7 + 3 + 1.9375);
    expect(() => costsReport(ctx, { from: TO, to: FROM }, NOW)).toThrow(/before/);
    expect(() => costsReport(ctx, { from: '2025-01-01T00:00:00.000Z', to: TO }, NOW)).toThrow(/at most/);
  });

  it('parses the query string and is listed in the OpenAPI document', () => {
    expect(costsQuery.parse({ from: '2026-11-01', groupBy: 'day,agent', projectId: 'none', top: '5' }))
      .toEqual({ from: '2026-11-01T00:00:00.000Z', groupBy: ['day', 'agent'], projectId: 'none', top: 5 });
    expect(() => costsQuery.parse({ groupBy: 'day,planet' })).toThrow(/planet/);
    expect(() => costsQuery.parse({ since: 'x' })).toThrow();
    const doc = openApiSpec('0.0.0') as unknown as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
    expect(doc.paths['/costs']).toBeDefined();
    expect(doc.components.schemas.CostsReport).toBeDefined();
  });
});

describe('v0.6 O: the Chief of Staff\'s planning calls', () => {
  const CUT = '2026-11-10T00:00:00.000Z';
  function call(purpose: PlanningPurpose, ticketId: Id | null, rt: string, model: string | null, at: string, costUsd: number, tokensIn = 0, tokensOut = 0, ok = true): void {
    repos.costs!.recordPlanningCall({ at, purpose, ticketId, runtime: rt, model, costUsd, tokensIn, tokensOut, ok });
  }
  /** Recording "started" on Nov 10: the security log's memory-note costs count only before that. */
  function seed(): void {
    db.prepare("UPDATE planning_calls SET at = ? WHERE purpose = 'tracking_started'").run(CUT);
    noteEvent(ids.t2, '2026-11-09T08:00:00.000Z', 0.03125); // before recording: counted from the log
    // (the beforeEach note of Nov 12 for $0.0625 is after recording started: NOT counted any more)
    call('routing', ids.t2, 'claude-cli', 'haiku', '2026-11-11T08:00:00.000Z', 0.002, 1000, 50);
    call('intake', null, 'claude-cli', 'haiku', '2026-11-11T09:00:00.000Z', 0.004, 2000, 300);
    call('memory_note', ids.t1, 'ollama', 'qwen3', '2026-11-12T08:30:00.000Z', 0, 3000, 200); // free (local AI)
    call('categorise', null, 'claude-cli', 'haiku', '2026-11-13T10:00:00.000Z', 0.01, 500, 100);
    call('routing', ids.t3, '', null, '2026-11-13T11:00:00.000Z', 0, 0, 0, false); // failed: no agent
    call('intake', null, 'claude-cli', 'haiku', '2026-10-31T23:59:59.999Z', 5); // outside the period
  }

  it('the migration adds the table, the marker row and the runs_started index', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all().map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['planning_calls', 'planning_calls_at', 'runs_started']));
    const marker = db.prepare("SELECT * FROM planning_calls WHERE purpose = 'tracking_started'").all() as Array<{ at: string; cost_usd: number }>;
    expect(marker).toHaveLength(1);
    expect(marker[0]!.cost_usd).toBe(0);
    expect(marker[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); // same format as Date.toISOString()
    // The marker never shows up as a call.
    expect(costsReport(ctx, { from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' }, NOW).planning.map((g) => g.purpose)).toEqual(['memory_note']);
  });

  it('sums every purpose exactly, by the AI it ran on, without counting memory notes twice', () => {
    seed();
    const r = costsReport(ctx, { from: FROM, to: TO }, NOW);
    expect(r.notCounted).toEqual([]);
    // Runs 1.875 + calls 0.016 + the pre-recording log note 0.03125 (the Nov 12 log note is not counted).
    expect(r.totals).toEqual({ costUsd: 1.92225, runs: 6, tokensIn: 17010, tokensOut: 2701, tickets: 4, planningUsd: 0.04725, planningCalls: 6 });
    expect(r.split).toEqual({
      paid: { costUsd: 1.92225, runs: 4, tokensIn: 7010, tokensOut: 1001 },
      free: { costUsd: 0, runs: 2, tokensIn: 10000, tokensOut: 1700 }, // the Ollama memory note is local work
    });
    expect(r.planning).toEqual([
      { purpose: 'memory_note', costUsd: 0.03125, paidUsd: 0.03125, calls: 2, failed: 0, tokensIn: 3000, tokensOut: 200 },
      { purpose: 'categorise', costUsd: 0.01, paidUsd: 0.01, calls: 1, failed: 0, tokensIn: 500, tokensOut: 100 },
      { purpose: 'intake', costUsd: 0.004, paidUsd: 0.004, calls: 1, failed: 0, tokensIn: 2000, tokensOut: 300 },
      { purpose: 'routing', costUsd: 0.002, paidUsd: 0.002, calls: 2, failed: 1, tokensIn: 1000, tokensOut: 50 },
    ]);
    expect(r.planning.reduce((n, g) => n + g.costUsd, 0)).toBeCloseTo(r.totals.planningUsd, 9);
  });

  it('puts the calls in the daily series, the breakdowns and the tickets', () => {
    seed();
    const r = costsReport(ctx, { from: FROM, to: TO, groupBy: ['runtime', 'agent'] }, NOW);
    const day = (d: string) => r.days.find((x) => x.day === d)!;
    expect(day('2026-11-09')).toMatchObject({ costUsd: 0.03125, byRuntime: { 'chief-of-staff': 0.03125 } });
    expect(day('2026-11-11')).toMatchObject({ costUsd: 0.006, runs: 0, tokensIn: 3000, byRuntime: { 'chief-of-staff': 0.006 }, byProject: { none: 0.006 } });
    expect(day('2026-11-12')).toMatchObject({ costUsd: 0, tokensIn: 3000, byRuntime: {} });
    expect(day('2026-11-13')).toMatchObject({ costUsd: 1.01, byRuntime: { 'claude-cli': 1, 'chief-of-staff': 0.01 } });
    expect(r.days.reduce((n, d) => n + d.costUsd, 0)).toBeCloseTo(r.totals.costUsd, 9);
    expect(r.groups.runtime!.find((g) => g.key === 'chief-of-staff')).toMatchObject({ costUsd: 0.04725, runs: 0, paidUsd: 0.04725 });
    expect(r.groups.agent!.find((g) => g.key === 'chief-of-staff')!.costUsd).toBe(0.04725);
    const t2 = r.topTickets.find((t) => t.ticketId === ids.t2)!;
    expect(t2).toMatchObject({ costUsd: 0.15825, planningUsd: 0.03325, runs: 1 }); // run 0.125 + routing 0.002 + old note 0.03125
  });

  it('with a board filter, counts only calls linked to a ticket', () => {
    seed();
    const none = costsReport(ctx, { from: FROM, to: TO, projectId: 'none' }, NOW);
    expect(none.totals).toMatchObject({ costUsd: 0.15825, planningUsd: 0.03325, planningCalls: 3 }); // T-2 and T-3: no intake, no categories
    expect(none.planning.map((g) => g.purpose).sort()).toEqual(['memory_note', 'routing']);
    const sec = costsReport(ctx, { from: FROM, to: TO, teamId: ids.sec }, NOW);
    expect(sec.totals.costUsd).toBe(0.90825); // runs 0.875 + routing 0.002 + old note 0.03125
  });

  it('keeps the rows (retention: forever) and the ticket\'s calls when the ticket is deleted', () => {
    seed();
    call('routing', ids.t4, 'claude-cli', 'haiku', '2024-01-01T00:00:00.000Z', 0.5);
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ids.t4);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM planning_calls WHERE purpose <> 'tracking_started'").get() as { n: number }).n;
    expect(n).toBe(7);
    // The deleted ticket's call stays, without the ticket (still in the totals of its day).
    expect(db.prepare("SELECT ticket_id FROM planning_calls WHERE at = '2024-01-01T00:00:00.000Z'").get()).toEqual({ ticket_id: null });
    // An unknown ticket id is stored without the ticket.
    call('routing', 'no-such-ticket', 'claude-cli', 'haiku', '2026-11-13T12:00:00.000Z', 0.001);
    expect((db.prepare('SELECT ticket_id FROM planning_calls WHERE cost_usd = 0.001').get() as { ticket_id: string | null }).ticket_id).toBeNull();
  });

  it('planningTurnOf records every call (ok or failed) in one place, never the text', async () => {
    const answers: Array<PlanningTurnResult | Error> = [
      { text: 'SECRET-ANSWER {"teamSlug":"security"}', costUsd: 0.003, model: 'haiku', runtime: 'claude-cli', tokensIn: 900, tokensOut: 40 },
      new Error('the planning model took too long'),
      { text: 'ok', costUsd: 0, model: 'qwen3', tokensIn: 50, tokensOut: 5 }, // a fake without runtime: input.runtime is used
    ];
    const withTurn: AppContext = { ...ctx, planningTurn: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; } };
    const turn = planningTurnOf(withTurn);
    const input = { systemPrompt: 'SECRET-SYSTEM', prompt: 'SECRET-PROMPT', budgetUsd: 0.02, timeoutMs: 1000 };
    await turn({ ...input, purpose: 'routing', ticketId: ids.t1 });
    await expect(turn({ ...input, purpose: 'intake' })).rejects.toThrow(/too long/);
    await turn({ ...input, purpose: 'memory_note', ticketId: ids.t3, runtime: 'ollama', model: 'qwen3' });
    const rows = db.prepare("SELECT purpose, ticket_id, runtime, model, cost_usd, tokens_in, tokens_out, ok FROM planning_calls WHERE purpose <> 'tracking_started' ORDER BY rowid").all();
    expect(rows).toEqual([
      { purpose: 'routing', ticket_id: ids.t1, runtime: 'claude-cli', model: 'haiku', cost_usd: 0.003, tokens_in: 900, tokens_out: 40, ok: 1 },
      { purpose: 'intake', ticket_id: null, runtime: '', model: null, cost_usd: 0, tokens_in: 0, tokens_out: 0, ok: 0 },
      { purpose: 'memory_note', ticket_id: ids.t3, runtime: 'ollama', model: 'qwen3', cost_usd: 0, tokens_in: 50, tokens_out: 5, ok: 1 },
    ]);
    expect(JSON.stringify(db.prepare('SELECT * FROM planning_calls').all())).not.toMatch(/SECRET/);
  });

  it('the intake chat goes through the same recorded turn', async () => {
    const adapter = {
      id: 'claude-cli', displayName: 'Claude', capabilities: { tools: true, resume: true, costReport: true },
      detect: async () => ({ installed: true }), models: async () => [],
      async *run() { yield { kind: 'text', text: '{"reply":"ok","proposals":[]}' }; yield { kind: 'done', costUsd: 0.0042, tokensIn: 1500, tokensOut: 80 }; },
    } as unknown as RuntimeAdapter;
    const withRuntime: AppContext = { ...ctx, config: { workspaceDir: dir } as AppContext['config'], runtimes: { get: (id: string) => (id === 'claude-cli' ? adapter : undefined), list: () => [adapter] } as unknown as AppContext['runtimes'] };
    const res = await intakeTurn(withRuntime, { messages: [{ role: 'user', text: 'Check the certificates' }] });
    expect(res.costUsd).toBe(0.0042);
    const r = costsReport(ctx, { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });
    expect(r.planning).toEqual([{ purpose: 'intake', costUsd: 0.0042, paidUsd: 0.0042, calls: 1, failed: 0, tokensIn: 1500, tokensOut: 80 }]);
  });
});
