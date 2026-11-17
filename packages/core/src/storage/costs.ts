/**
 * Read-only cost aggregation for the cost dashboard (v0.5 §L, contract packages/shared/src/costs.ts).
 *
 * Every number is one SQL aggregate over "cost lines":
 *   - one line per agent run (runs.cost_usd), with the run's session (agent, runtime, model);
 *   - one line per Chief of Staff planning call (planning_calls, v0.6 O: routing, intake, memory notes,
 *     categories…), paid or free by the runtime it ran on;
 *   - one line per paid Chief of Staff memory note from the security log (security_events
 *     'memory.note_written', data.costUsd), ONLY before planning calls were recorded (the
 *     'tracking_started' row of migration v10), so a note is never counted twice.
 * Lines are joined to their ticket for the project/team (the ticket's current values) and filters.
 *
 * Days are UTC: substr(<ISO-8601 UTC timestamp>, 1, 10). Timestamps are compared as text, which is
 * correct because every timestamp in the DB is `Date.toISOString()` (same length, same zone).
 *
 * Indexes: runs_started (runs.started_at, v10), planning_calls_at, security_events_at (at, seq).
 * Retention: planning_calls rows are kept forever (no text, a few dozen bytes per call).
 */
import type Database from 'better-sqlite3';
import {
  CHIEF_OF_STAFF_COST_KEY, FREE_RUNTIMES, PLANNING_PURPOSES, uuidv7,
  type CostAmounts, type CostBudget, type CostDay, type CostGroup, type CostGroupBy, type CostPlanningGroup, type CostTicket, type CostsReport,
  type PlanningPurpose, type TicketStatus,
} from '@sebeto/shared';
import type { CostsRepo, CostsRepoQuery, PlanningCallRecord } from '../contracts.js';

const round = (n: number): number => Math.round((n || 0) * 1e6) / 1e6;
const sqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const FREE_LIST = FREE_RUNTIMES.map(sqlString).join(', ');
const COS = sqlString(CHIEF_OF_STAFF_COST_KEY);

/** The marker row of migration v10: planning calls are recorded from this moment on. */
export const TRACKING_STARTED_PURPOSE = 'tracking_started';

/**
 * The cost lines of the period, joined to their ticket and filtered. Params: @from @to @projectId @teamId.
 * `runtime` is the breakdown key (the Chief of Staff's own key for planning lines); `real_runtime`
 * decides paid or free. Legacy memory-note lines (security log) count only before tracking started.
 * With a project/team filter, lines without a ticket (intake chat, categories) are left out.
 */
const LINES = `
  WITH cut AS (
    SELECT COALESCE((SELECT MIN(at) FROM planning_calls WHERE purpose = '${TRACKING_STARTED_PURPOSE}'), '9999') AS at
  ),
  lines AS (
    SELECT r.ticket_id AS ticket_id, s.agent_id AS agent_id, s.runtime AS runtime, s.model AS model,
           substr(r.started_at, 1, 10) AS day, r.cost_usd AS cost, 1 AS runs, r.tokens_in AS tin, r.tokens_out AS tout,
           0 AS planning, NULL AS purpose, 0 AS failed, s.runtime AS real_runtime
    FROM runs r JOIN sessions s ON s.id = r.session_id
    WHERE r.started_at >= @from AND r.started_at < @to
    UNION ALL
    SELECT p.ticket_id, ${COS}, ${COS}, p.model,
           substr(p.at, 1, 10), p.cost_usd, 0, p.tokens_in, p.tokens_out,
           1, p.purpose, 1 - p.ok, p.runtime
    FROM planning_calls p
    WHERE p.at >= @from AND p.at < @to AND p.purpose <> '${TRACKING_STARTED_PURPOSE}'
    UNION ALL
    SELECT e.ticket_id, ${COS}, ${COS}, ${COS},
           substr(e.at, 1, 10), CAST(json_extract(e.data, '$.costUsd') AS REAL), 0, 0, 0,
           1, 'memory_note', 0, ${COS}
    FROM security_events e
    WHERE e.at >= @from AND e.at < @to AND e.at < (SELECT at FROM cut) AND e.action = 'memory.note_written'
      AND json_valid(e.data) AND json_extract(e.data, '$.costUsd') > 0
  ),
  f AS (
    SELECT l.*, t.project_id AS project_id, t.team_id AS team_id,
           CASE WHEN l.real_runtime IN (${FREE_LIST}) OR l.real_runtime IN (SELECT value FROM json_each(@free)) THEN 0 ELSE 1 END AS paid
    FROM lines l LEFT JOIN tickets t ON t.id = l.ticket_id
    WHERE (@projectId IS NULL OR (t.id IS NOT NULL AND ((@projectId = 'none' AND t.project_id IS NULL) OR t.project_id = @projectId)))
      AND (@teamId IS NULL OR (t.id IS NOT NULL AND ((@teamId = 'none' AND t.team_id IS NULL) OR t.team_id = @teamId)))
  )`;

const SUMS = 'COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(runs), 0) AS runs, COALESCE(SUM(tin), 0) AS tin, COALESCE(SUM(tout), 0) AS tout';

const GROUP_EXPR: Record<CostGroupBy, string> = {
  day: 'day', project: 'project_id', team: 'team_id', agent: 'agent_id', runtime: 'runtime', model: 'model',
};

interface SumRow { cost: number; runs: number; tin: number; tout: number }
const amounts = (r: SumRow | undefined): CostAmounts => ({
  costUsd: round(r?.cost ?? 0), runs: r?.runs ?? 0, tokensIn: r?.tin ?? 0, tokensOut: r?.tout ?? 0,
});

/** UTC "YYYY-MM-DD" of every day from `from` (inclusive) to `to` (exclusive). */
export function utcDays(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to);
  for (let d = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`); d < end; d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

export function createCostsRepo(db: Database.Database): CostsRepo {
  const stmts = {
    totals: db.prepare(`${LINES}
      SELECT ${SUMS}, COUNT(DISTINCT ticket_id) AS tickets,
             COALESCE(SUM(CASE WHEN planning = 1 THEN cost ELSE 0 END), 0) AS planningUsd,
             COALESCE(SUM(planning), 0) AS planningCalls
      FROM f`),
    split: db.prepare(`${LINES} SELECT paid, ${SUMS} FROM f GROUP BY paid`),
    days: db.prepare(`${LINES}
      SELECT day, runtime, COALESCE(project_id, 'none') AS project, ${SUMS} FROM f GROUP BY day, runtime, project`),
    top: db.prepare(`${LINES}
      SELECT t.id AS id, t.number AS number, t.title AS title, t.status AS status, t.project_id AS projectId, t.team_id AS teamId,
             SUM(f.cost) AS cost, SUM(CASE WHEN f.planning = 1 THEN f.cost ELSE 0 END) AS planningUsd, SUM(f.runs) AS runs
      FROM f JOIN tickets t ON t.id = f.ticket_id
      GROUP BY t.id HAVING SUM(f.cost) > 0
      ORDER BY SUM(f.cost) DESC, t.number ASC LIMIT @top`),
    groups: Object.fromEntries(Object.entries(GROUP_EXPR).map(([by, expr]) => [by, db.prepare(`${LINES}
      SELECT ${expr} AS k, ${SUMS}, COALESCE(SUM(CASE WHEN paid = 1 THEN cost ELSE 0 END), 0) AS paid
      FROM f GROUP BY ${expr}
      ORDER BY ${by === 'day' ? 'k ASC' : 'cost DESC, runs DESC, k ASC'}`)])) as Record<CostGroupBy, Database.Statement>,
    planning: db.prepare(`${LINES}
      SELECT purpose, ${SUMS}, COALESCE(SUM(CASE WHEN paid = 1 THEN cost ELSE 0 END), 0) AS paid,
             COUNT(*) AS calls, COALESCE(SUM(failed), 0) AS failed
      FROM f WHERE planning = 1 GROUP BY purpose`),
    record: db.prepare(`
      INSERT INTO planning_calls (id, at, purpose, ticket_id, runtime, model, cost_usd, tokens_in, tokens_out, ok)
      VALUES (@id, @at, @purpose, (SELECT id FROM tickets WHERE id = @ticketId), @runtime, @model, @costUsd, @tokensIn, @tokensOut, @ok)`),
    budget: db.prepare<[string, string], { id: string; name: string; runtime: string; budget: number; spent: number }>(`
      SELECT a.id AS id, a.name AS name, a.runtime AS runtime, a.monthly_budget_usd AS budget,
             COALESCE((SELECT SUM(r.cost_usd) FROM sessions s JOIN runs r ON r.session_id = s.id
                       WHERE s.agent_id = a.id AND r.started_at >= ? AND r.started_at < ?), 0) AS spent
      FROM agents a`),
  };

  function budget(now: Date, extraFree: string[] = []): CostBudget {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    // Agents on a paid runtime, plus any agent that spent something (e.g. it changed runtime).
    const rows = stmts.budget.all(start, end).filter((r) => r.spent > 0 || !(FREE_RUNTIMES.includes(r.runtime) || extraFree.includes(r.runtime)));
    const ratio = (r: { budget: number; spent: number }) => (r.budget > 0 ? r.spent / r.budget : r.spent > 0 ? Infinity : 0);
    rows.sort((a, b) => ratio(b) - ratio(a) || b.spent - a.spent || a.name.localeCompare(b.name));
    return {
      month: start.slice(0, 7),
      limitUsd: round(rows.reduce((n, r) => n + r.budget, 0)),
      spentUsd: round(rows.reduce((n, r) => n + r.spent, 0)),
      agents: rows.map((r) => ({ agentId: r.id, name: r.name, monthlyBudgetUsd: round(r.budget), spentUsd: round(r.spent) })),
    };
  }

  return {
    report(q: CostsRepoQuery, now = new Date()): CostsReport {
      const extraFree = (q.extraFreeRuntimes ?? []).filter((r) => typeof r === 'string');
      const p = { from: q.from, to: q.to, projectId: q.projectId ?? null, teamId: q.teamId ?? null, free: JSON.stringify(extraFree) };
      const totals = stmts.totals.get(p) as SumRow & { tickets: number; planningUsd: number; planningCalls: number };
      const split = stmts.split.all(p) as Array<SumRow & { paid: number }>;

      const dayMap = new Map<string, CostDay>(utcDays(q.from, q.to).map((day) => [day, { day, costUsd: 0, runs: 0, tokensIn: 0, tokensOut: 0, byRuntime: {}, byProject: {} }]));
      for (const r of stmts.days.all(p) as Array<SumRow & { day: string; runtime: string; project: string }>) {
        const d = dayMap.get(r.day);
        if (!d) continue;
        d.costUsd += r.cost; d.runs += r.runs; d.tokensIn += r.tin; d.tokensOut += r.tout;
        if (r.cost > 0) {
          d.byRuntime[r.runtime] = round((d.byRuntime[r.runtime] ?? 0) + r.cost);
          d.byProject[r.project] = round((d.byProject[r.project] ?? 0) + r.cost);
        }
      }
      const days = [...dayMap.values()].map((d) => ({ ...d, costUsd: round(d.costUsd) }));

      const groups: Partial<Record<CostGroupBy, CostGroup[]>> = {};
      for (const by of q.groupBy) {
        groups[by] = (stmts.groups[by].all(p) as Array<SumRow & { k: string | null; paid: number }>).map((r) => ({
          key: r.k, label: null, ...amounts(r), paidUsd: round(r.paid),
        }));
      }

      const topTickets: CostTicket[] = (stmts.top.all({ ...p, top: q.top }) as Array<{
        id: string; number: number; title: string; status: TicketStatus; projectId: string | null; teamId: string | null; cost: number; planningUsd: number; runs: number;
      }>).map((r) => ({
        ticketId: r.id, number: r.number, title: r.title, status: r.status, projectId: r.projectId, teamId: r.teamId,
        costUsd: round(r.cost), planningUsd: round(r.planningUsd), runs: r.runs,
      }));

      const byPurpose = new Map<PlanningPurpose, CostPlanningGroup>();
      for (const r of stmts.planning.all(p) as Array<SumRow & { purpose: string; paid: number; calls: number; failed: number }>) {
        const purpose: PlanningPurpose = (PLANNING_PURPOSES as readonly string[]).includes(r.purpose) ? r.purpose as PlanningPurpose : 'other';
        const g = byPurpose.get(purpose) ?? { purpose, costUsd: 0, paidUsd: 0, calls: 0, failed: 0, tokensIn: 0, tokensOut: 0 };
        g.costUsd += r.cost; g.paidUsd += r.paid; g.calls += r.calls; g.failed += r.failed; g.tokensIn += r.tin; g.tokensOut += r.tout;
        byPurpose.set(purpose, g);
      }
      const planning = [...byPurpose.values()]
        .map((g) => ({ ...g, costUsd: round(g.costUsd), paidUsd: round(g.paidUsd) }))
        .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls || a.purpose.localeCompare(b.purpose));

      return {
        from: q.from, to: q.to, timezone: 'UTC',
        filters: { projectId: p.projectId, teamId: p.teamId },
        totals: { ...amounts(totals), tickets: totals.tickets, planningUsd: round(totals.planningUsd), planningCalls: totals.planningCalls },
        split: { paid: amounts(split.find((s) => s.paid === 1)), free: amounts(split.find((s) => s.paid === 0)) },
        days, groups, topTickets, planning, budget: budget(now, extraFree), notCounted: [],
      };
    },

    recordPlanningCall(call: PlanningCallRecord): void {
      stmts.record.run({
        id: uuidv7(), at: call.at, purpose: call.purpose, ticketId: call.ticketId, runtime: call.runtime, model: call.model,
        costUsd: call.costUsd, tokensIn: Math.max(0, Math.round(call.tokensIn)), tokensOut: Math.max(0, Math.round(call.tokensOut)), ok: call.ok ? 1 : 0,
      });
    },
  };
}
