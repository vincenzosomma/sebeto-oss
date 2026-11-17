/**
 * Team policies (v0.4 F/G, docs/28 v0.4 Plan.md §F §G; packages/shared/src/teams.ts).
 *
 *  F. Runtime lock: a team with `lockRuntime` may only run its work on `team.runtime`. "Its work" =
 *     tickets of the team AND tickets assigned to one of its members. The API refuses changes that
 *     would break the lock (409 runtime_locked); the executor re-checks before every run (the real
 *     guarantee, it also catches changes made behind the API's back).
 *  G. Written scope: a team with `requireScope` (the ticket's team, or its agent's team) cannot start
 *     a ticket until the owner has attached and confirmed a scope (409 scope_required in the API;
 *     the executor refuses every run without one).
 *
 * Everything here is synchronous and side-effect free, so other modules (memory notes, routing,
 * executor) can ask "may this ticket's text go to runtime X?" cheaply.
 */
import { TEAM_POLICY_ERRORS, type Agent, type Id, type RuntimeId, type Team, type Ticket } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { AppError } from './errors.js';

export interface TeamAiPolicy {
  /** True when the ticket's team or its agent's team is locked to one runtime. */
  locked: boolean;
  /** The runtime the ticket's work must use when locked (else the team's preferred runtime, or null). */
  runtime: RuntimeId | null;
  model: string | null;
  /** The team the policy comes from (null = no team). */
  team: Team | null;
}

type TicketLike = Pick<Ticket, 'teamId' | 'agentId'>;

function teamOf(ctx: AppContext, id: Id | null | undefined): Team | null {
  return id ? ctx.repos.teams?.get(id) ?? null : null;
}

function agentTeamId(ctx: AppContext, agentId: Id | null | undefined): Id | null {
  return agentId ? ctx.repos.agents.get(agentId)?.teamId ?? null : null;
}

/**
 * The teams whose policies apply to a ticket: its own team, then its agent's team (de-duplicated).
 * `agentId` overrides the ticket's agent (e.g. the agent the executor resolved).
 */
export function ticketTeams(ctx: AppContext, ticket: TicketLike, agentId: Id | null = ticket.agentId ?? null): Team[] {
  const out: Team[] = [];
  for (const id of [ticket.teamId ?? null, agentTeamId(ctx, agentId)]) {
    const t = teamOf(ctx, id);
    if (t && !out.some((x) => x.id === t.id)) out.push(t);
  }
  return out;
}

/** Locked teams that apply to a ticket (normally 0 or 1). */
export function lockedTeams(ctx: AppContext, ticket: TicketLike, agentId?: Id | null): Team[] {
  return ticketTeams(ctx, ticket, agentId === undefined ? ticket.agentId ?? null : agentId).filter((t) => t.lockRuntime); // fail closed: a lock without a runtime (only possible by editing the DB) allows no runtime at all
}

/**
 * Exported helper for other parts (memory notes, routing): may the text of this ticket go to any
 * runtime, or only to `runtime`? When not locked, `runtime`/`model` are the ticket team's preferred AI.
 */
export function teamAiPolicy(ctx: AppContext, ticket: TicketLike): { locked: boolean; runtime: RuntimeId | null; model: string | null } {
  const p = teamAiPolicyDetail(ctx, ticket);
  return { locked: p.locked, runtime: p.runtime, model: p.model };
}

export function teamAiPolicyDetail(ctx: AppContext, ticket: TicketLike): TeamAiPolicy {
  const locked = lockedTeams(ctx, ticket)[0];
  if (locked) return { locked: true, runtime: locked.runtime, model: locked.model, team: locked };
  const team = ticketTeams(ctx, ticket)[0] ?? null;
  return { locked: false, runtime: team?.runtime ?? null, model: team?.model ?? null, team };
}

/** The first locked team whose runtime differs from `runtime`, or null when the runtime is allowed. */
export function lockViolation(ctx: AppContext, ticket: TicketLike, runtime: RuntimeId, agentId?: Id | null): Team | null {
  return lockedTeams(ctx, ticket, agentId).find((t) => t.runtime !== runtime) ?? null;
}

/** The team that requires a written scope for this ticket, or null. */
export function scopeRequiredBy(ctx: AppContext, ticket: TicketLike, agentId?: Id | null): Team | null {
  return ticketTeams(ctx, ticket, agentId === undefined ? ticket.agentId ?? null : agentId).find((t) => t.requireScope) ?? null;
}

const runtimeLabel = (ctx: AppContext, id: RuntimeId | null): string => (id ? ctx.runtimes.get(id)?.displayName ?? id : 'no AI');

/** 409 runtime_locked with plain words. */
export function runtimeLockedError(ctx: AppContext, team: Team, wanted: RuntimeId, what = 'This'): AppError {
  return new AppError(409, TEAM_POLICY_ERRORS.runtimeLocked,
    `${what} belongs to the team "${team.name}", whose AI is locked to ${runtimeLabel(ctx, team.runtime)}. ` +
    `It cannot use ${runtimeLabel(ctx, wanted)}. Turn the lock off in Teams first if you really want this.`);
}

export const SCOPE_REQUIRED_NOTE = 'This team needs a written scope before it can start: add it in the ticket\'s Scope box';

/** 409 scope_required with plain words. */
export function scopeRequiredError(team: Team): AppError {
  return new AppError(409, TEAM_POLICY_ERRORS.scopeRequired,
    `The team "${team.name}" needs a written scope before this ticket can start. Add it in the ticket's Scope box, tick the confirmation, then start again.`);
}

/** API convenience check before a start / reply: throws 409 scope_required when the scope is missing. */
export function assertScopeForStart(ctx: AppContext, ticket: Ticket): void {
  if (ticket.scope) return;
  const team = scopeRequiredBy(ctx, ticket);
  if (team) throw scopeRequiredError(team);
}

/**
 * An agent's runtime must match its team's locked runtime. `teamId` is the agent's team after the
 * change; `runtime` the agent's runtime after the change. Throws 409 runtime_locked.
 */
export function assertAgentRuntime(ctx: AppContext, agent: Pick<Agent, 'name'>, teamId: Id | null, runtime: RuntimeId): void {
  const team = teamOf(ctx, teamId);
  if (team?.lockRuntime && team.runtime && team.runtime !== runtime) throw runtimeLockedError(ctx, team, runtime, agent.name);
}
