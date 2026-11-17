/**
 * Cost dashboard (v0.5 §L, contract packages/shared/src/costs.ts): validates the period, runs the
 * SQL aggregates (storage/costs.ts) and puts names on the groups. Read-only.
 */
import {
  CHIEF_OF_STAFF_COST_KEY, DEFAULT_COST_GROUP_BYS, DEFAULT_COST_RANGE_DAYS, MAX_COST_RANGE_DAYS, MAX_COST_TOP_TICKETS,
  type CostGroupBy, type CostsQuery, type CostsReport,
} from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { badRequest, unavailable } from './errors.js';

const DAY = 86_400_000;

/**
 * Cost sources that exist but are not stored anywhere aggregatable (shown on the page). Empty since
 * v0.6 O: routing and intake chat turns are recorded in planning_calls like every planning call.
 */
export const COSTS_NOT_COUNTED: readonly string[] = [];

/** Default period: the last DEFAULT_COST_RANGE_DAYS UTC days, today included. */
export function defaultCostRange(now = new Date()): { from: string; to: string } {
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return { from: new Date(tomorrow - DEFAULT_COST_RANGE_DAYS * DAY).toISOString(), to: new Date(tomorrow).toISOString() };
}

export function costsReport(ctx: AppContext, q: CostsQuery = {}, now = new Date()): CostsReport {
  const repo = ctx.repos.costs;
  if (!repo) throw unavailable('Costs are not available in this build.');
  const def = defaultCostRange(now);
  const to = q.to ?? (q.from ? new Date(Math.min(Date.parse(q.from) + DEFAULT_COST_RANGE_DAYS * DAY, Date.parse(def.to))).toISOString() : def.to);
  const from = q.from ?? new Date(Date.parse(to) - DEFAULT_COST_RANGE_DAYS * DAY).toISOString();
  if (Date.parse(from) >= Date.parse(to)) throw badRequest('"from" must be before "to".', 'cost_range');
  if (Date.parse(to) - Date.parse(from) > MAX_COST_RANGE_DAYS * DAY) throw badRequest(`The period can be at most ${MAX_COST_RANGE_DAYS} days.`, 'cost_range');
  const groupBy: CostGroupBy[] = q.groupBy === undefined ? [...DEFAULT_COST_GROUP_BYS] : [...new Set(Array.isArray(q.groupBy) ? q.groupBy : [q.groupBy])];
  const top = Math.max(1, Math.min(q.top ?? 10, MAX_COST_TOP_TICKETS));

  // Local OpenAI-compatible connections (LM Studio, vLLM… on this computer or LAN) are free like Ollama.
  const extraFreeRuntimes = (ctx.aiConnections?.list() ?? []).filter((c) => c.kind === 'local').map((c) => c.runtimeId);
  const report = repo.report({ from, to, groupBy, projectId: q.projectId ?? null, teamId: q.teamId ?? null, top, extraFreeRuntimes }, now);

  const names: Partial<Record<CostGroupBy, (key: string) => string | null>> = {
    project: (k) => ctx.repos.projects.get(k)?.name ?? null,
    team: (k) => ctx.repos.teams?.get(k)?.name ?? null,
    agent: (k) => ctx.repos.agents.get(k)?.name ?? null,
    runtime: (k) => ctx.runtimes.get(k)?.displayName ?? null,
  };
  for (const [by, rows] of Object.entries(report.groups) as Array<[CostGroupBy, CostsReport['groups'][CostGroupBy]]>) {
    const name = names[by];
    if (!name || !rows) continue;
    for (const g of rows) g.label = g.key === null || g.key === CHIEF_OF_STAFF_COST_KEY ? null : name(g.key) ?? g.key;
  }
  return { ...report, notCounted: [...COSTS_NOT_COUNTED] };
}
