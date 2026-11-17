/**
 * Cost report for the mock API (v0.5 §L, v0.6 O): synthetic, deterministic cost lines (agent runs
 * and Chief of Staff calls: routing, memory notes, intake chat, categories) over the last 90 days,
 * aggregated like the core does (UTC days).
 */
import {
  CHIEF_OF_STAFF_COST_KEY, DEFAULT_COST_GROUP_BYS, isPaidRuntime,
  type Agent, type CostAmounts, type CostDay, type CostGroup, type CostGroupBy, type CostPlanningGroup, type CostsQuery, type CostsReport,
  type PlanningPurpose, type Project, type Team, type Ticket,
} from '@sebeto/shared';
import { ApiHttpError } from './types';

const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

interface Line {
  /** null: a Chief of Staff call about no ticket (intake chat, session categories). */
  ticketId: string | null; agentId: string | null; runtime: string; model: string | null; at: string;
  cost: number; runs: number; tin: number; tout: number; planning: boolean;
  /** Planning lines: why the Chief of Staff was called, and the AI it ran on (paid or free). */
  purpose?: PlanningPurpose; realRuntime?: string; ok?: boolean;
}

export interface MockCostsDeps {
  agents: () => Agent[];
  tickets: () => Ticket[];
  projects: () => Project[];
  teams: () => Team[];
  runtimeName: (id: string) => string | null;
}

/** Stable pseudo-random numbers in [0, 1) from a seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9 >>> 0) / 4294967296);
}

export function mockCostLines(tickets: Ticket[], agents: Agent[], now = Date.now()): Line[] {
  const lines: Line[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const t of tickets) {
    const r = rng(t.number * 7919);
    const agent = t.agentId ? byId.get(t.agentId) : undefined;
    // Every third ticket ran on a local model (free) in this demo.
    const local = t.number % 3 === 0;
    const runtime = local ? 'ollama' : agent?.runtime ?? 'claude-cli';
    const model = local ? 'qwen3-vl:4b-instruct' : agent?.model ?? (r() < 0.5 ? 'sonnet' : 'haiku');
    const n = 2 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const at = new Date(now - Math.floor(r() * 85 * DAY) - Math.floor(r() * DAY)).toISOString();
      lines.push({
        ticketId: t.id, agentId: agent?.id ?? null, runtime, model, at,
        cost: local ? 0 : round(0.02 + r() * 0.6), runs: 1, tin: 2000 + Math.floor(r() * 20000), tout: 300 + Math.floor(r() * 3000), planning: false,
      });
    }
    const cos = (purpose: PlanningPurpose, at: number, cost: number): Line => ({
      ticketId: t.id, agentId: CHIEF_OF_STAFF_COST_KEY, runtime: CHIEF_OF_STAFF_COST_KEY, model: local ? 'qwen3-vl:4b-instruct' : 'haiku',
      at: new Date(at).toISOString(), cost: local ? 0 : cost, runs: 0, tin: 1200, tout: 90, planning: true, purpose,
      realRuntime: local ? 'ollama' : 'claude-cli', ok: true,
    });
    if (t.teamId && t.number % 2 === 0) lines.push(cos('routing', now - Math.floor(r() * 80 * DAY), 0.0021));
    if (t.status === 'done') lines.push(cos('memory_note', now - Math.floor(r() * 20 * DAY), 0.0035));
  }
  // Intake chat turns and session categories: no ticket.
  const rr = rng(424242);
  for (let i = 0; i < 9; i++) {
    lines.push({
      ticketId: null, agentId: CHIEF_OF_STAFF_COST_KEY, runtime: CHIEF_OF_STAFF_COST_KEY, model: 'haiku', at: new Date(now - Math.floor(rr() * 60 * DAY)).toISOString(),
      cost: i < 7 ? 0.0032 : 0.012, runs: 0, tin: 2400, tout: 300, planning: true, purpose: i < 7 ? 'intake' : 'categorise', realRuntime: 'claude-cli', ok: true,
    });
  }
  return lines;
}

const isPaidLine = (l: Line) => isPaidRuntime(l.realRuntime ?? l.runtime);

const sum = (ls: Line[]): CostAmounts => ({
  costUsd: round(ls.reduce((n, l) => n + l.cost, 0)), runs: ls.reduce((n, l) => n + l.runs, 0),
  tokensIn: ls.reduce((n, l) => n + l.tin, 0), tokensOut: ls.reduce((n, l) => n + l.tout, 0),
});

export function mockCostsReport(q: CostsQuery, deps: MockCostsDeps, now = new Date()): CostsReport {
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const to = q.to ?? new Date(tomorrow).toISOString();
  const from = q.from ?? new Date(Date.parse(to) - 30 * DAY).toISOString();
  if (Date.parse(from) >= Date.parse(to)) throw new ApiHttpError(400, 'cost_range', '"from" must be before "to".');
  const tickets = new Map(deps.tickets().map((t) => [t.id, t]));
  const match = (v: string | null | undefined, f: string | undefined) => !f || (f === 'none' ? !v : v === f);
  const all = mockCostLines([...tickets.values()], deps.agents(), now.getTime());
  const ticketOf = (l: Line) => (l.ticketId ? tickets.get(l.ticketId) : undefined);
  const lines = all.filter((l) => {
    const t = ticketOf(l);
    // With a board filter, only costs linked to a ticket count (like the core).
    if ((q.projectId || q.teamId) && !t) return false;
    return l.at >= from && l.at < to && match(t?.projectId, q.projectId) && match(t?.teamId, q.teamId);
  });

  const days: CostDay[] = [];
  for (let d = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`); d < Date.parse(to); d += DAY) {
    const day = new Date(d).toISOString().slice(0, 10);
    const ls = lines.filter((l) => l.at.slice(0, 10) === day);
    const byRuntime: Record<string, number> = {};
    const byProject: Record<string, number> = {};
    for (const l of ls) {
      if (l.cost <= 0) continue;
      byRuntime[l.runtime] = round((byRuntime[l.runtime] ?? 0) + l.cost);
      const p = ticketOf(l)?.projectId ?? 'none';
      byProject[p] = round((byProject[p] ?? 0) + l.cost);
    }
    days.push({ day, ...sum(ls), byRuntime, byProject });
  }

  const projects = new Map(deps.projects().map((p) => [p.id, p.name]));
  const teams = new Map(deps.teams().map((t) => [t.id, t.name]));
  const agents = new Map(deps.agents().map((a) => [a.id, a.name]));
  const keyOf: Record<CostGroupBy, (l: Line) => string | null> = {
    day: (l) => l.at.slice(0, 10), project: (l) => ticketOf(l)?.projectId ?? null, team: (l) => ticketOf(l)?.teamId ?? null,
    agent: (l) => l.agentId, runtime: (l) => l.runtime, model: (l) => l.model,
  };
  const labelOf: Partial<Record<CostGroupBy, (k: string) => string | null>> = {
    project: (k) => projects.get(k) ?? k, team: (k) => teams.get(k) ?? k, agent: (k) => agents.get(k) ?? k, runtime: (k) => deps.runtimeName(k) ?? k,
  };
  const wanted = q.groupBy === undefined ? DEFAULT_COST_GROUP_BYS : Array.isArray(q.groupBy) ? q.groupBy : [q.groupBy];
  const groups: Partial<Record<CostGroupBy, CostGroup[]>> = {};
  for (const by of wanted) {
    const m = new Map<string | null, Line[]>();
    for (const l of lines) { const k = keyOf[by](l); m.set(k, [...(m.get(k) ?? []), l]); }
    groups[by] = [...m.entries()].map(([key, ls]) => ({
      key, label: key === null || key === CHIEF_OF_STAFF_COST_KEY ? null : labelOf[by]?.(key) ?? null, ...sum(ls),
      paidUsd: round(ls.filter(isPaidLine).reduce((n, l) => n + l.cost, 0)),
    })).sort(by === 'day' ? (a, b) => String(a.key).localeCompare(String(b.key)) : (a, b) => b.costUsd - a.costUsd || b.runs - a.runs);
  }

  const perTicket = new Map<string, Line[]>();
  for (const l of lines) if (l.ticketId) perTicket.set(l.ticketId, [...(perTicket.get(l.ticketId) ?? []), l]);
  const topTickets = [...perTicket.entries()].map(([id, ls]) => {
    const t = tickets.get(id)!;
    return {
      ticketId: id, number: t.number, title: t.title, status: t.status, projectId: t.projectId ?? null, teamId: t.teamId ?? null,
      ...(({ costUsd, runs }) => ({ costUsd, runs }))(sum(ls)), planningUsd: round(ls.filter((l) => l.planning).reduce((n, l) => n + l.cost, 0)),
    };
  }).filter((t) => t.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd || a.number - b.number).slice(0, q.top ?? 10);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const budgetAgents = deps.agents().filter((a) => isPaidRuntime(a.runtime)).map((a) => ({
    agentId: a.id, name: a.name, monthlyBudgetUsd: a.monthlyBudgetUsd,
    spentUsd: round(all.filter((l) => l.agentId === a.id && l.at >= monthStart).reduce((n, l) => n + l.cost, 0)),
  })).sort((a, b) => b.spentUsd / (b.monthlyBudgetUsd || 1) - a.spentUsd / (a.monthlyBudgetUsd || 1));
  const planning = lines.filter((l) => l.planning);
  const byPurpose = new Map<PlanningPurpose, Line[]>();
  for (const l of planning) { const k = l.purpose ?? 'other'; byPurpose.set(k, [...(byPurpose.get(k) ?? []), l]); }
  const planningGroups: CostPlanningGroup[] = [...byPurpose.entries()].map(([purpose, ls]) => {
    const s = sum(ls);
    return {
      purpose, costUsd: s.costUsd, paidUsd: round(ls.filter(isPaidLine).reduce((n, l) => n + l.cost, 0)),
      calls: ls.length, failed: ls.filter((l) => l.ok === false).length, tokensIn: s.tokensIn, tokensOut: s.tokensOut,
    };
  }).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  const total = sum(lines);
  return {
    from, to, timezone: 'UTC', filters: { projectId: q.projectId ?? null, teamId: q.teamId ?? null },
    totals: { ...total, tickets: perTicket.size, planningUsd: sum(planning).costUsd, planningCalls: planning.length },
    split: { paid: sum(lines.filter(isPaidLine)), free: sum(lines.filter((l) => !isPaidLine(l))) },
    days, groups, topTickets, planning: planningGroups,
    budget: {
      month: monthStart.slice(0, 7),
      limitUsd: round(budgetAgents.reduce((n, a) => n + a.monthlyBudgetUsd, 0)),
      spentUsd: round(budgetAgents.reduce((n, a) => n + a.spentUsd, 0)),
      agents: budgetAgents,
    },
    notCounted: [],
  };
}
