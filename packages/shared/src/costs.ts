/**
 * Cost dashboard (v0.5 §L): one read-only view of what the AI costs.
 *
 * API (under /api/v1):
 *   GET /costs?from=&to=&groupBy=&projectId=&teamId=&top=   → CostsReport
 *
 * Where the numbers come from:
 *   - agent runs: `runs.cost_usd`, attributed through the run's session (agent, runtime, model) and its
 *     ticket (project, team: the ticket's CURRENT project/team);
 *   - the Chief of Staff's planning calls (v0.6 O, table `planning_calls`): routing, intake chat, memory
 *     notes, session categories… one row per call with its purpose, AI, cost and tokens (never any
 *     text), attributed to its ticket when it has one. Shown as the runtime/agent key `chief-of-staff`;
 *     paid or free follows the AI the call really ran on;
 *   - before planning calls were recorded (schema v10): memory-note costs from the security log event
 *     `memory.note_written` (its `data.costUsd`), counted as paid. From that moment on only the table
 *     counts, so nothing is counted twice.
 *   With a project or team filter, only costs linked to a ticket count (the intake chat and session
 *   categories have no ticket).
 *
 * Days are UTC calendar days ("YYYY-MM-DD"), the same clock as the agents' monthly budgets.
 * `from` is inclusive, `to` exclusive.
 */
import type { Id, IsoDate, RuntimeId, TicketStatus } from './types.js';

export const COST_GROUP_BYS = ['day', 'project', 'team', 'agent', 'runtime', 'model'] as const;
export type CostGroupBy = (typeof COST_GROUP_BYS)[number];

/** Breakdowns returned when the request names none. */
export const DEFAULT_COST_GROUP_BYS: readonly CostGroupBy[] = ['project', 'team', 'agent', 'runtime', 'model'];

/** Runtimes that run on this computer and cost nothing. Every other runtime counts as paid. */
export const FREE_RUNTIMES: readonly RuntimeId[] = ['mock', 'ollama'];
export const isPaidRuntime = (runtime: string | null | undefined): boolean => !!runtime && !FREE_RUNTIMES.includes(runtime);

/** Key used for the Chief of Staff's planning costs in the runtime and agent breakdowns. */
export const CHIEF_OF_STAFF_COST_KEY = 'chief-of-staff';

/** Why the Chief of Staff called the planning model (v0.6 O). 'other' = any future caller. */
export const PLANNING_PURPOSES = ['routing', 'intake', 'memory_note', 'categorise', 'other'] as const;
export type PlanningPurpose = (typeof PLANNING_PURPOSES)[number];

/** Longest period one request may cover. */
export const MAX_COST_RANGE_DAYS = 400;
export const DEFAULT_COST_RANGE_DAYS = 30;
export const MAX_COST_TOP_TICKETS = 50;

export interface CostsQuery {
  from?: IsoDate;
  to?: IsoDate;
  /** One or more breakdowns (comma-separated in the URL). Default: DEFAULT_COST_GROUP_BYS. */
  groupBy?: CostGroupBy | CostGroupBy[];
  /** Only tickets of this project ('none' = tickets without a project). */
  projectId?: Id | 'none';
  /** Only tickets of this team ('none' = tickets without a team). */
  teamId?: Id | 'none';
  /** How many top tickets (default 10, max MAX_COST_TOP_TICKETS). */
  top?: number;
}

export interface CostAmounts {
  costUsd: number;
  /** Agent runs (planning calls are not runs). */
  runs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface CostGroup extends CostAmounts {
  /**
   * day: "YYYY-MM-DD"; project/team/agent: the id, null = none; runtime: the runtime id or
   * CHIEF_OF_STAFF_COST_KEY; model: the model name, null = the runtime default; agent: an id,
   * null = no agent, or CHIEF_OF_STAFF_COST_KEY.
   */
  key: string | null;
  /** Display name resolved by the core (project/team/agent/runtime name); null when the UI should name it. */
  label: string | null;
  /** Part of costUsd spent on paid runtimes. */
  paidUsd: number;
}

export interface CostDay extends CostAmounts {
  /** UTC day, "YYYY-MM-DD". Every day of the period is present (zeros included). */
  day: string;
  /** costUsd by runtime id (and CHIEF_OF_STAFF_COST_KEY). Only non-zero entries. */
  byRuntime: Record<string, number>;
  /** costUsd by project id ('none' = no project). Only non-zero entries. */
  byProject: Record<string, number>;
}

export interface CostTicket {
  ticketId: Id;
  number: number;
  title: string;
  status: TicketStatus;
  projectId: Id | null;
  teamId: Id | null;
  costUsd: number;
  /** Part of costUsd that came from the Chief of Staff (routing, memory notes… of this ticket). */
  planningUsd: number;
  runs: number;
}

export interface CostSplit {
  /** Claude and any other runtime not in FREE_RUNTIMES (the Chief of Staff's calls by the AI they ran on). */
  paid: CostAmounts;
  /** Ollama, mock: cost 0, but the runs and tokens show how much work ran locally. */
  free: CostAmounts;
}

export interface CostAgentBudget {
  agentId: Id;
  name: string;
  monthlyBudgetUsd: number;
  spentUsd: number;
}

/** The agents' monthly budgets for the CURRENT UTC month (independent of the requested period and filters). */
export interface CostBudget {
  /** "YYYY-MM" (UTC). */
  month: string;
  /** Sum of every agent's monthly budget. */
  limitUsd: number;
  /** Spent this month by agent runs. */
  spentUsd: number;
  /** Agents that spent something or have a budget, most used first (by spent / budget). */
  agents: CostAgentBudget[];
}

/** The Chief of Staff's planning calls of one purpose in the period (v0.6 O). */
export interface CostPlanningGroup {
  purpose: PlanningPurpose;
  costUsd: number;
  /** Part of costUsd spent on paid runtimes. */
  paidUsd: number;
  /** Calls made (failed ones included). */
  calls: number;
  /** Calls that failed (no usable answer: timeout, AI not available…). */
  failed: number;
  tokensIn: number;
  tokensOut: number;
}

export interface CostsReport {
  from: IsoDate;
  to: IsoDate;
  /** Always 'UTC' for now (see the header). */
  timezone: 'UTC';
  filters: { projectId: Id | 'none' | null; teamId: Id | 'none' | null };
  totals: CostAmounts & {
    /** Distinct tickets with a cost line in the period. */
    tickets: number;
    /** Chief of Staff part of costUsd, and how many planning calls (every purpose, free ones included). */
    planningUsd: number;
    planningCalls: number;
  };
  split: CostSplit;
  days: CostDay[];
  /** The requested breakdowns, most expensive first ('day' in date order). */
  groups: Partial<Record<CostGroupBy, CostGroup[]>>;
  topTickets: CostTicket[];
  /** The Chief of Staff by purpose (routing, intake, memory notes, categories…), most expensive first. */
  planning: CostPlanningGroup[];
  budget: CostBudget;
  /** Cost sources that exist but are not stored, so they are missing from these numbers (empty since v0.6 O). */
  notCounted: string[];
}
