/**
 * Teams and ticket routing (v0.4, docs/28 v0.4 Plan.md §C).
 *
 * A team is a named group of agents with a lead (Service Desk, DevOps, Infrastructure, Security,
 * Red Team…). Applying a team template creates the team. A ticket can be given to a team:
 *   - manually: the owner picks the team (and optionally the agent) in the new-ticket form or panel;
 *   - automatically: teamId 'auto' → the core routes it: rules first (team routing hints, tags,
 *     project), then the Chief of Staff on the planning model when the rules are not sure. Inside
 *     the team, the agent whose role/skills match best, else the lead.
 * Every routing decision is written to the ticket's activity and the security log, with the reason.
 *
 * API (under /api/v1):
 *   GET    /teams                         → Team[]
 *   POST   /teams      CreateTeamBody     → Team (201)
 *   PATCH  /teams/:id  UpdateTeamBody     → Team
 *   DELETE /teams/:id                     → 204 (agents and tickets stay, without a team)
 *   POST   /routing/preview  RoutePreviewBody → RouteDecision (no side effects)
 *   POST   /tickets/:id/route             → { ticket: Ticket; decision: RouteDecision }
 * Agents: CreateAgentBody / PATCH /agents/:id accept teamId. Tickets: CreateTicketBody /
 * UpdateTicketBody accept teamId (an id, null, or 'auto'). GET /tickets?teamId=<id|none>.
 * WebSocket: { type: 'teams.changed' }
 */
import type { Id, IsoDate, RuntimeId, Ticket } from './types.js';

export interface Team {
  id: Id;
  /** Stable machine name, also the default session-library category ("service-desk"). */
  slug: string;
  name: string;
  description: string;
  color: string;
  leadAgentId: Id | null;
  /** Plain words: what this team handles ("password resets, printers, new laptops"). Used by routing. */
  routingHints: string;
  memberIds: Id[];
  /**
   * v0.4 F: the team's AI. Members joining the team get it; "apply to members" sets it on everyone.
   * null = no team default (each agent keeps its own).
   */
  runtime: RuntimeId | null;
  /** Model for `runtime` (null = the runtime's default). */
  model: string | null;
  /**
   * v0.4 F: when true, the team's work may ONLY run on `runtime` (e.g. a Red Team that must never
   * run on a cloud AI). Enforced in the core, not only in the UI:
   *  - an agent of the team cannot be given another runtime (409 runtime_locked);
   *  - a ticket of the team cannot override the runtime (409 runtime_locked);
   *  - the executor re-checks before every run and refuses (ticket → Blocked, security event critical);
   *  - the Chief of Staff never reads such a team's tickets for routing/notes on another runtime: the
   *    planning turn for them uses the team's runtime, or is skipped.
   * Requires `runtime` to be set.
   */
  lockRuntime: boolean;
  /**
   * v0.4 G: tickets of this team cannot start (by hand, trigger, schedule, heartbeat or reply) until
   * the owner has attached and confirmed a written scope (TicketScope). Red Team default: true.
   */
  requireScope: boolean;
  /**
   * The owner's Claude connectors (names as `claude mcp list` shows them) every member running on
   * Claude Code may use, on top of the agent's own ticks. Every call still goes through the gate.
   */
  claudeConnectors: string[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface TeamAiFields { runtime?: RuntimeId | null; model?: string | null; lockRuntime?: boolean; requireScope?: boolean; claudeConnectors?: string[] }
export interface CreateTeamBody extends TeamAiFields { name: string; slug?: string; description?: string; color?: string; leadAgentId?: Id | null; routingHints?: string }
export interface UpdateTeamBody extends TeamAiFields {
  name?: string; description?: string; color?: string; leadAgentId?: Id | null; routingHints?: string;
  /** Also set runtime + model on every current member (default false; forced true when lockRuntime turns on). */
  applyToMembers?: boolean;
}

/**
 * Error codes (409) the core returns when a policy blocks something: a team policy (runtime lock,
 * written scope) or, since v0.5 I, the emergency stop (`lockdown`: nothing may wake an agent).
 */
export const TEAM_POLICY_ERRORS = { runtimeLocked: 'runtime_locked', scopeRequired: 'scope_required', lockdown: 'lockdown' } as const;

/** v0.5 I: the plain message for 409 `lockdown` (core and mock API use the same words). */
export const LOCKDOWN_MESSAGE = 'The emergency stop is on. Release it on the Security page, then try again.';

/** 'auto' asks the core to choose. */
export type TeamChoice = Id | 'auto' | null;

export interface RoutePreviewBody {
  title: string;
  goal: string;
  tags?: string[];
  projectId?: Id | null;
  /** Rules only, never the Chief of Staff (cheap live suggestions while typing). Not confident → fallback. */
  rulesOnly?: boolean;
}

export interface RouteDecision {
  teamId: Id | null;
  agentId: Id | null;
  /** Plain-language reason shown to the owner ("mentions VPN and firewall → Infrastructure"). */
  reason: string;
  by: 'rules' | 'chief-of-staff' | 'fallback';
  /** 0..1 */
  confidence: number;
}

/** POST /tickets/:id/route */
export interface RouteTicketResponse { ticket: Ticket; decision: RouteDecision }

/** Default of the Team picker in the new-ticket form (AppSettings.newTicketTeam). */
export type NewTicketTeamDefault = 'manual' | 'auto';

/** Built-in team slugs (templates). */
export const BUILTIN_TEAM_SLUGS = ['service-desk', 'devops', 'infrastructure', 'security', 'red-team'] as const;
