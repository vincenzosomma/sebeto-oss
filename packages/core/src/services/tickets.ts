/**
 * Ticket application services. The API never runs agents: it only enqueues jobs
 * (docs/16 Scalability.md, rule 4). Status changes go through the StateMachine.
 */
import fs from 'node:fs';
import { withAutoTags } from './auto-tags.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  CreateTicketBody, Id, Message, TicketOrigin, PermissionDecision, PermissionRequest, RouteDecision, TrustedCommand, Run, Ticket, TicketDetail, TicketStatus, UpdateTicketBody,
  SetTicketScopeBody, TicketScope,
} from '@sebeto/shared';
import type { AppContext, Job } from '../contracts.js';
import { badRequest, conflict, notFound } from './errors.js';
import { requireProjectIfSet } from './projects.js';
import { MAX_SCOPE_CHARS, normalizeTags, nowIso, splitTagQuery } from '@sebeto/shared';
import { assertScopeForStart, lockViolation, lockedTeams, runtimeLockedError, scopeRequiredBy, scopeRequiredError } from './team-policy.js';
import { LOCKDOWN_ROUTES, assertNotLockedDown } from './lockdown.js';
import { pickDefaultAgent } from '../default-agent.js';
import { requestStartWhenReady } from '../scheduler/index.js';
import { agentForTeam, route, routeByRules, routeInputOf } from './routing.js';

export const PRIORITY_NEEDS_YOU_REPLY = 0;
export const PRIORITY_USER_RUN = 10;

const DETAIL_PAGE = 100;
const DETAIL_RUNS = 20;

export function requireTicket(ctx: AppContext, id: Id): Ticket {
  const t = ctx.repos.tickets.get(id);
  if (!t) throw notFound('Ticket', id);
  // Deleted tickets are read-only until restored (no runs, messages or changes).
  if (t.deletedAt) throw conflict('This ticket is in Deleted tickets. Restore it first.', 'ticket_deleted');
  return t;
}

function requireAgentIfSet(ctx: AppContext, agentId: Id | null | undefined): void {
  if (agentId != null && !ctx.repos.agents.get(agentId)) throw badRequest(`Agent ${agentId} does not exist`, 'unknown_agent');
}

function requireRuntimeIfSet(ctx: AppContext, runtime: string | null | undefined): void {
  if (runtime != null && !ctx.runtimes.get(runtime)) throw badRequest(`Runtime ${runtime} is not enabled`, 'unknown_runtime');
}

function audit(ctx: AppContext, input: Parameters<AppContext['repos']['audit']['append']>[0]): void {
  const event = ctx.repos.audit.append(input);
  ctx.bus.publish({ type: 'event.created', event });
}

export interface CreateTicketOptions {
  /**
   * Where the ticket comes from. Internal only: API clients cannot set it (they always get
   * { kind: 'manual', untrusted: false }); triggers pass an untrusted origin for outside content.
   */
  origin?: TicketOrigin;
}

export async function createTicket(ctx: AppContext, body: CreateTicketBody, opts: CreateTicketOptions = {}): Promise<Ticket> {
  // v0.5 I: "create and start" during the emergency stop is refused before anything is created.
  // Internal callers (origin set) check the lockdown themselves (triggers, intake accept).
  if (body.start && !opts.origin) assertNotLockedDown(ctx, LOCKDOWN_ROUTES.create);
  // agentId: undefined or null = "Automatic": the default real agent (never the test agent unless it is the only one).
  let agentId = body.agentId ?? null;
  requireAgentIfSet(ctx, agentId);
  // v0.4 team: 'auto' = route (rules now; the Chief of Staff later, in the background, when the
  // rules are not sure), an id = that team (its best member unless an agent is given), null = none.
  // Not given + an explicit agent = the agent's team.
  // Automatic category tags (services/auto-tags.ts) unless the owner turned them off; added before
  // routing so they also help pick the team.
  const ownTags = body.tags ?? [];
  const autoTagged = ctx.settings?.get().autoTags !== false ? withAutoTags(ownTags, body) : ownTags;
  const input = { title: body.title, goal: body.goal, tags: normalizeTags(autoTagged), projectId: body.projectId ?? null };
  let teamId: Id | null = null;
  let routing: RouteDecision | null = null;
  let routeLater = false;
  if (body.teamId === 'auto') {
    const rules = routeByRules(ctx, input);
    if (rules.confident || !ctx.repos.teams?.list().length) {
      routing = rules.decision;
      teamId = rules.decision.teamId;
      if (agentId === null) agentId = rules.decision.agentId;
    } else {
      routeLater = true;
    }
  } else if (body.teamId) {
    const team = requireTeamForTicket(ctx, body.teamId);
    teamId = team.id;
    if (agentId === null) agentId = agentForTeam(ctx, team, input)?.id ?? null;
  } else if (body.teamId === undefined && agentId !== null) {
    teamId = ctx.repos.agents.get(agentId)?.teamId ?? null;
  }
  if (agentId === null) agentId = pickDefaultAgent(ctx.repos.agents.list())?.id ?? null;
  requireRuntimeIfSet(ctx, body.runtime);
  // v0.4 F: a runtime override must match a locked team (the ticket's team or its agent's team).
  if (body.runtime) {
    const locked = lockViolation(ctx, { teamId, agentId }, body.runtime);
    if (locked) throw runtimeLockedError(ctx, locked, body.runtime, 'This ticket');
  }
  // v0.4 G: "create and start" for a team that needs a written scope: a new ticket has no scope yet.
  // API callers (no origin) get 409 before anything is created; internal callers (triggers, intake)
  // create it and the executor refuses the run with a note (ticket → Needs you).
  if (body.start && !opts.origin) {
    const needs = scopeRequiredBy(ctx, { teamId, agentId });
    if (needs) throw scopeRequiredError(needs);
  }
  if (body.parentId != null) requireTicket(ctx, body.parentId);
  for (const dep of body.dependsOn ?? []) requireTicket(ctx, dep);
  requireProjectIfSet(ctx, body.projectId);

  const ticket = ctx.repos.tickets.create({
    title: body.title,
    goal: body.goal,
    agentId,
    runtime: body.runtime ?? null,
    model: body.model ?? null,
    ...(body.costCapUsd !== undefined ? { costCapUsd: body.costCapUsd } : {}),
    parentId: body.parentId ?? null,
    dependsOn: body.dependsOn ?? [],
    projectId: body.projectId ?? null,
    tags: input.tags,
    teamId,
    origin: opts.origin ?? { kind: 'manual', untrusted: false },
  });
  await ctx.snapshots.init(ticket.folder);
  audit(ctx, { ticketId: ticket.id, kind: 'info', summary: 'Ticket created' });
  if (routing) recordRouting(ctx, ticket, routing);
  ctx.bus.publish({ type: 'ticket.updated', ticket });
  if (routeLater) {
    // Do not block ticket creation on the planning model: route in the background, then start.
    track(routeTicket(ctx, ticket.id, { onlyIfNoTeam: true, keepAgent: body.agentId != null })
      .catch((err: unknown) => ctx.log.warn({ ticketId: ticket.id, err: (err as Error).message }, 'background routing failed'))
      .finally(() => { if (body.start && ctx.repos.tickets.get(ticket.id)) enqueueStart(ctx, ticket.id); }));
  } else if (body.start) enqueueStart(ctx, ticket.id);
  return ticket;
}

// ---------------------------------------------------------------- v0.4 routing (teams.ts)
const background = new Set<Promise<unknown>>();
function track(p: Promise<unknown>): void {
  background.add(p);
  void p.finally(() => background.delete(p));
}
/** Tests: wait until background routing (Chief of Staff) has finished. */
export async function settleBackgroundRouting(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}

function requireTeamForTicket(ctx: AppContext, teamId: Id) {
  const team = ctx.repos.teams?.get(teamId);
  if (!team) throw badRequest(`Team ${teamId} does not exist`, 'unknown_team');
  return team;
}

function hasStarted(ctx: AppContext, t: Ticket): boolean {
  return t.currentSessionId !== null || ctx.repos.sessions.listForTicket(t.id).length > 0
    || ctx.repos.runs.listForTicket(t.id, DETAIL_RUNS).some((r) => r.status === 'running');
}

/** Audit event + security event for a routing decision (the panel shows the latest one's reason). */
function recordRouting(ctx: AppContext, ticket: Ticket, decision: RouteDecision): void {
  const team = decision.teamId ? ctx.repos.teams?.get(decision.teamId)?.name ?? 'a team' : 'no team';
  const agent = ticket.agentId ? ctx.repos.agents.get(ticket.agentId)?.name ?? 'an agent' : 'nobody';
  const summary = `Routed to ${team} → ${agent}: ${decision.reason}`;
  audit(ctx, { ticketId: ticket.id, kind: 'info', summary, data: { routing: decision } });
  ctx.securityLog?.record({
    // Who decided: the routing rules or the Chief of Staff (not the user whose request started it;
    // background routing would otherwise inherit the request's "You" actor).
    actor: decision.by === 'chief-of-staff' ? { type: 'agent', id: null, name: 'Chief of Staff' } : { type: 'system', id: null, name: 'Sebeto routing' },
    category: 'ticket', action: 'ticket.routed', ticketId: ticket.id, agentId: ticket.agentId, summary,
    data: { teamId: decision.teamId, agentId: ticket.agentId, by: decision.by, confidence: decision.confidence },
  });
}

/**
 * Apply a routing decision: the team always; the agent only while the ticket has not started a
 * session (afterwards the agent keeps its conversation) and unless keepAgent.
 */
function applyRoute(ctx: AppContext, id: Id, decision: RouteDecision, keepAgent = false): Ticket {
  const cur = requireTicket(ctx, id);
  const patch: Partial<Ticket> = { teamId: decision.teamId };
  if (!keepAgent && decision.agentId && decision.agentId !== cur.agentId && !hasStarted(ctx, cur)) {
    patch.agentId = decision.agentId;
    patch.currentSessionId = null;
  }
  const ticket = ctx.repos.tickets.update(id, patch);
  recordRouting(ctx, ticket, decision);
  ctx.bus.publish({ type: 'ticket.updated', ticket });
  return ticket;
}

/** POST /tickets/:id/route (and 'auto' when the rules are not sure). */
export async function routeTicket(ctx: AppContext, id: Id, opts: { onlyIfNoTeam?: boolean; keepAgent?: boolean } = {}): Promise<{ ticket: Ticket; decision: RouteDecision }> {
  const before = requireTicket(ctx, id);
  // v0.4 F: a ticket of a locked team (or of an agent in one) is routed by the rules only.
  const locked = lockedTeams(ctx, before)[0];
  const decision = await route(ctx, routeInputOf(before), {
    ticketId: id,
    ...(locked ? { locked: { team: locked, keep: { teamId: before.teamId ?? null, agentId: before.agentId } } } : {}),
  });
  const now = ctx.repos.tickets.get(id);
  if (!now) throw notFound('Ticket', id);
  // The owner picked a team while the Chief of Staff was thinking: keep their choice.
  if (opts.onlyIfNoTeam && now.teamId) return { ticket: now, decision };
  return { ticket: applyRoute(ctx, id, decision, opts.keepAgent), decision };
}

export function listTickets(ctx: AppContext, query: { status?: TicketStatus; q?: string; cursor?: string; limit?: number; projectId?: string; tag?: string; teamId?: string; deleted?: boolean }) {
  // "#tag" words inside the search text filter by tag; the rest is full-text search.
  const { text, tags } = splitTagQuery(query.q ?? '');
  const allTags = normalizeTags([...(query.tag ? [query.tag] : []), ...tags]);
  return ctx.repos.tickets.list({
    ...(query.status ? { status: query.status } : {}),
    ...(text ? { q: text } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.teamId ? { teamId: query.teamId } : {}),
    ...(allTags.length ? { tags: allTags } : {}),
    cursor: query.cursor ?? null,
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.deleted ? { deleted: true } : {}),
  });
}

// ---------------------------------------------------------------- "Deleted tickets"
function hasRunningRun(ctx: AppContext, id: Id): boolean {
  return ctx.repos.runs.listForTicket(id, DETAIL_RUNS).some((r) => r.status === 'running');
}

/** DELETE /tickets/:id → moves the ticket to "Deleted tickets" (restorable). Refused while the agent works. */
export function deleteTicket(ctx: AppContext, id: Id): Ticket {
  const ticket = ctx.repos.tickets.get(id);
  if (!ticket) throw notFound('Ticket', id);
  if (ticket.deletedAt) return ticket;
  if (hasRunningRun(ctx, id)) throw conflict('The agent is working on this ticket. Stop it first, then delete the ticket.', 'run_active');
  const t = ctx.repos.tickets.update(id, { deletedAt: nowIso() });
  ctx.securityLog?.record({ category: 'ticket', action: 'ticket.trashed', severity: 'notice', ticketId: id, summary: `T-${t.number} moved to Deleted tickets: ${t.title}`, data: { number: t.number } });
  ctx.bus.publish({ type: 'ticket.deleted', ticketId: id });
  return t;
}

/** POST /tickets/:id/restore → back on the board, in the same column. */
export function restoreTicket(ctx: AppContext, id: Id): Ticket {
  const ticket = ctx.repos.tickets.get(id);
  if (!ticket) throw notFound('Ticket', id);
  if (!ticket.deletedAt) return ticket;
  const t = ctx.repos.tickets.update(id, { deletedAt: null });
  ctx.securityLog?.record({ category: 'ticket', action: 'ticket.restored', severity: 'info', ticketId: id, summary: `T-${t.number} restored from Deleted tickets: ${t.title}`, data: { number: t.number } });
  ctx.bus.publish({ type: 'ticket.updated', ticket: t });
  return t;
}

/**
 * DELETE /tickets/:id/permanent → only for a ticket already in "Deleted tickets": removes it with its
 * conversation, runs and approvals, and its working folder. Cannot be undone.
 */
export async function purgeTicket(ctx: AppContext, id: Id): Promise<void> {
  const ticket = ctx.repos.tickets.get(id);
  if (!ticket) throw notFound('Ticket', id);
  if (!ticket.deletedAt) throw conflict('Delete the ticket first; only tickets in Deleted tickets can be deleted forever.', 'not_deleted');
  if (hasRunningRun(ctx, id)) throw conflict('The agent is working on this ticket. Stop it first.', 'run_active');
  ctx.repos.tickets.delete(id); // the security log records ticket.deleted (security/instrument.ts)
  // Only ever a folder Sebeto created for the ticket, inside the workspace.
  const root = path.resolve(ctx.config.workspaceDir, 'tickets');
  const folder = path.resolve(ticket.folder);
  if (folder.startsWith(root + path.sep)) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  ctx.bus.publish({ type: 'ticket.deleted', ticketId: id });
}

export function getTicketDetail(ctx: AppContext, id: Id): TicketDetail {
  const ticket = requireTicket(ctx, id);
  // v0.8 delegation: the ticket it was delegated from (omitted when none, so the response serializer
  // need not allow null) and the sub-tickets delegated from this one.
  const parent = ticket.parentId ? ctx.repos.tickets.get(ticket.parentId) : undefined;
  const agent = ticket.agentId ? ctx.repos.agents.get(ticket.agentId) : undefined;
  const agentBudget = agent
    ? { agentId: agent.id, name: agent.name, monthlyBudgetUsd: agent.monthlyBudgetUsd, spentUsd: ctx.repos.agents.monthSpendUsd(agent.id) }
    : undefined;
  return {
    ticket,
    messages: ctx.repos.messages.listForTicket(id, { limit: DETAIL_PAGE }).items,
    events: ctx.repos.audit.listForTicket(id, { limit: DETAIL_PAGE }).items,
    permissions: ctx.repos.permissions.listForTicket(id),
    runs: ctx.repos.runs.listForTicket(id, DETAIL_RUNS),
    children: ctx.repos.tickets.childrenOf(id),
    ...(parent ? { parent } : {}),
    ...(agentBudget ? { agentBudget } : {}),
  };
}

export function updateTicket(ctx: AppContext, id: Id, body: UpdateTicketBody): Ticket {
  const current = requireTicket(ctx, id);
  requireAgentIfSet(ctx, body.agentId);
  requireProjectIfSet(ctx, body.projectId);
  const patch: Partial<Ticket> = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.projectId !== undefined) patch.projectId = body.projectId;
  if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
  if (body.goal !== undefined) patch.goal = body.goal;
  if (body.costCapUsd !== undefined) patch.costCapUsd = body.costCapUsd;
  // v0.4 team: an id → that team (and, when no agent is given and the ticket has not started, its
  // best member unless the current agent is already in it); null → none; 'auto' → route.
  let teamNote: string | null = null;
  let autoRoute: RouteDecision | null = null;
  let routeLater = false;
  if (body.teamId === 'auto') {
    const rules = routeByRules(ctx, routeInputOf({ ...current, ...patch }));
    if (rules.confident || !ctx.repos.teams?.list().length) autoRoute = rules.decision;
    else routeLater = true;
  } else if (body.teamId !== undefined && body.teamId !== (current.teamId ?? null)) {
    if (body.teamId === null) {
      patch.teamId = null;
      teamNote = 'Team removed';
    } else {
      const team = requireTeamForTicket(ctx, body.teamId);
      patch.teamId = team.id;
      teamNote = `Given to the ${team.name} team`;
      const agentNow = body.agentId !== undefined ? body.agentId : current.agentId;
      const inTeam = agentNow ? ctx.repos.agents.get(agentNow)?.teamId === team.id : false;
      if (body.agentId === undefined && !inTeam && !hasStarted(ctx, current)) {
        const best = agentForTeam(ctx, team, routeInputOf({ ...current, ...patch }));
        if (best) body = { ...body, agentId: best.id };
      }
    }
  }
  const reassigned = body.agentId !== undefined && body.agentId !== current.agentId;
  // v0.4 F: a change of team or agent must not take a locked team's work to another runtime.
  if (reassigned || (patch.teamId !== undefined && patch.teamId !== (current.teamId ?? null))) {
    const next = { teamId: patch.teamId !== undefined ? patch.teamId : current.teamId ?? null, agentId: reassigned ? body.agentId ?? null : current.agentId };
    const agent = next.agentId ? ctx.repos.agents.get(next.agentId) : undefined;
    const runtime = current.runtime ?? agent?.runtime;
    // A locked team that applies now OR applied before (taking a ticket out of a locked team to an
    // agent on another runtime is refused too).
    const teams = [...lockedTeams(ctx, next), ...lockedTeams(ctx, current).filter((t) => t.id === current.teamId)];
    const bad = runtime ? teams.find((t) => t.runtime !== runtime) : undefined;
    if (bad && runtime) throw runtimeLockedError(ctx, bad, runtime, 'This ticket');
  }
  if (reassigned) {
    if (ctx.repos.runs.listForTicket(id, DETAIL_RUNS).some((r) => r.status === 'running')) {
      throw conflict('Stop the running agent before changing the agent', 'run_active');
    }
    patch.agentId = body.agentId;
    // The new agent starts its own session (with its own role and instructions) instead of
    // continuing the previous agent's conversation. The chat history stays on the ticket.
    patch.currentSessionId = null;
  }
  let ticket = ctx.repos.tickets.update(id, patch);
  if (teamNote) audit(ctx, { ticketId: id, kind: 'info', summary: teamNote, data: { teamId: ticket.teamId ?? null } });
  if (reassigned) {
    const before = current.agentId ? ctx.repos.agents.get(current.agentId)?.name ?? 'the previous agent' : 'nobody';
    const after = ticket.agentId ? ctx.repos.agents.get(ticket.agentId)?.name ?? 'another agent' : 'nobody';
    audit(ctx, { ticketId: id, kind: 'info', summary: `Reassigned from ${before} to ${after}. The new agent starts a fresh session.` });
  }
  if (autoRoute) ticket = applyRoute(ctx, id, autoRoute, body.agentId !== undefined);
  else ctx.bus.publish({ type: 'ticket.updated', ticket });
  if (routeLater) {
    track(routeTicket(ctx, id, { keepAgent: body.agentId !== undefined })
      .catch((err: unknown) => ctx.log.warn({ ticketId: id, err: (err as Error).message }, 'background routing failed')));
  }
  return ticket;
}

export function moveTicket(ctx: AppContext, id: Id, status: TicketStatus, note?: string): Ticket {
  requireTicket(ctx, id);
  return ctx.state.transition(id, status, 'user', note !== undefined ? { note } : undefined);
}

export function postMessage(ctx: AppContext, id: Id, text: string): { message: Message; job: Job } {
  const ticket = requireTicket(ctx, id);
  // v0.5 I: a reply wakes the agent: refused (409 lockdown) during the emergency stop.
  assertNotLockedDown(ctx, LOCKDOWN_ROUTES.message, id);
  // A reply starts a run: refused (409 scope_required) while a required scope is missing.
  assertScopeForStart(ctx, ticket);
  const message = ctx.repos.messages.create({ ticketId: id, role: 'user', author: 'You', text });
  ctx.bus.publish({ type: 'message.created', message });
  const job = ctx.queue.enqueue(
    'run.reply',
    { ticketId: id, text },
    { priority: ticket.status === 'needs_you' ? PRIORITY_NEEDS_YOU_REPLY : PRIORITY_USER_RUN, dedupeKey: `reply:${id}` },
  );
  return { message, job };
}

/**
 * Start a ticket now, or, when it depends on tickets that are not completed yet,
 * mark it to start automatically once they are (the scheduler picks it up).
 * Returns the queued job, or null when the start was deferred.
 */
function enqueueStart(ctx: AppContext, ticketId: Id): Job | null {
  const ticket = requireTicket(ctx, ticketId);
  const waiting = ticket.dependsOn.some((dep) => ctx.repos.tickets.get(dep)?.status !== 'done');
  if (waiting) {
    requestStartWhenReady(ctx, ticketId);
    return null;
  }
  return ctx.queue.enqueue('run.start', { ticketId }, { priority: PRIORITY_USER_RUN, dedupeKey: `start:${ticketId}` });
}

/**
 * POST /tickets/:id/start. Refused (409 scope_required) when the ticket's team needs a written scope
 * and none is set. Internal callers (triggers) pass checkScope: false: the executor then refuses the
 * run with a note on the ticket, so nothing can bypass the rule.
 */
export function startTicket(ctx: AppContext, id: Id, opts: { checkScope?: boolean } = {}): Job | null {
  const ticket = requireTicket(ctx, id);
  // v0.5 I: refused (409 lockdown) during the emergency stop, also when the start would be deferred.
  assertNotLockedDown(ctx, LOCKDOWN_ROUTES.start, id);
  if (opts.checkScope !== false) assertScopeForStart(ctx, ticket);
  return enqueueStart(ctx, id);
}

// ---------------------------------------------------------------- v0.4 G: written scope
export const SCOPE_FILE = 'SCOPE.md';
const MAX_SCOPE_FILE_NAME = 200;

function runActive(ctx: AppContext, id: Id): boolean {
  return ctx.repos.runs.listForTicket(id, DETAIL_RUNS).some((r) => r.status === 'running');
}

/** The reference copy in the ticket folder (the DB text is what counts). */
function scopeMarkdown(ticket: Ticket, scope: TicketScope): string {
  return [
    `# Authorised scope for T-${ticket.number}: ${ticket.title}`,
    '',
    `Confirmed by the owner on ${scope.confirmedAt}${scope.fileName ? ` (loaded from ${scope.fileName})` : ''}.`,
    `sha256: ${scope.sha256}`,
    '',
    'This file is only a copy for reference: Sebeto uses the text saved in its database.',
    '',
    '---',
    '',
    scope.text,
    '',
  ].join('\n');
}

/** PUT /tickets/:id/scope: store the owner's confirmed scope (DB) and write SCOPE.md. */
export async function setTicketScope(ctx: AppContext, id: Id, body: SetTicketScopeBody): Promise<Ticket> {
  const ticket = requireTicket(ctx, id);
  if (body.confirm !== true) throw badRequest('Tick "I confirm this scope is written and authorised" to save it.', 'scope_not_confirmed');
  const text = body.text.replace(/\r\n/g, '\n');
  if (!text.trim()) throw badRequest('Write the scope, or load it from a file.', 'scope_empty');
  if (text.length > MAX_SCOPE_CHARS) throw badRequest(`The scope is too long (${MAX_SCOPE_CHARS} characters at most).`, 'scope_too_long');
  const fileName = body.fileName?.trim() || null;
  if (fileName && fileName.length > MAX_SCOPE_FILE_NAME) throw badRequest(`The file name is too long (${MAX_SCOPE_FILE_NAME} characters at most).`, 'scope_file_name');
  if (runActive(ctx, id)) throw conflict('Stop the running agent before changing the scope.', 'run_active');
  const scope: TicketScope = { text, fileName, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), confirmedAt: nowIso() };
  const replaced = !!ticket.scope;
  const updated = ctx.repos.tickets.update(id, { scope });
  try {
    await fs.promises.mkdir(ticket.folder, { recursive: true });
    await fs.promises.writeFile(path.join(ticket.folder, SCOPE_FILE), scopeMarkdown(updated, scope), 'utf8');
  } catch (err) {
    ctx.log.warn({ ticketId: id, err: (err as Error).message }, 'could not write SCOPE.md (the scope is saved in the database)');
  }
  const meta = { sha256: scope.sha256, length: text.length, fileName };
  // Never the text itself: only its hash, size and file name (the audit data is mirrored to the security log).
  audit(ctx, { ticketId: id, kind: 'info', summary: `${replaced ? 'Scope replaced' : 'Scope added'} and confirmed by you (sha256 ${scope.sha256.slice(0, 12)}…, ${text.length} characters)`, data: { scope: meta } });
  ctx.securityLog?.record({
    actor: { type: 'user', id: null, name: 'You' }, category: 'ticket', action: 'ticket.scope_set', severity: 'notice', ticketId: id, agentId: updated.agentId,
    summary: `Written scope ${replaced ? 'replaced' : 'added'} on T-${updated.number}`, data: { ...meta, replaced },
  });
  ctx.bus.publish({ type: 'ticket.updated', ticket: updated });
  return updated;
}

/** DELETE /tickets/:id/scope. */
export async function clearTicketScope(ctx: AppContext, id: Id): Promise<Ticket> {
  const ticket = requireTicket(ctx, id);
  if (!ticket.scope) return ticket;
  if (runActive(ctx, id)) throw conflict('Stop the running agent before removing the scope.', 'run_active');
  const updated = ctx.repos.tickets.update(id, { scope: null });
  try {
    await fs.promises.rm(path.join(ticket.folder, SCOPE_FILE), { force: true });
  } catch (err) {
    ctx.log.warn({ ticketId: id, err: (err as Error).message }, 'could not remove SCOPE.md');
  }
  const meta = { sha256: ticket.scope.sha256, length: ticket.scope.text.length, fileName: ticket.scope.fileName };
  audit(ctx, { ticketId: id, kind: 'info', summary: 'Scope removed by you', data: { scope: meta } });
  ctx.securityLog?.record({
    actor: { type: 'user', id: null, name: 'You' }, category: 'ticket', action: 'ticket.scope_cleared', severity: 'notice', ticketId: id, agentId: updated.agentId,
    summary: `Written scope removed from T-${updated.number}`, data: meta,
  });
  ctx.bus.publish({ type: 'ticket.updated', ticket: updated });
  return updated;
}

export function cancelTicket(ctx: AppContext, id: Id): boolean {
  requireTicket(ctx, id);
  return ctx.executor?.cancel(id) ?? false;
}

export async function undoRun(ctx: AppContext, ticketId: Id, runId: Id): Promise<{ run: Run; snapshot: string }> {
  const ticket = requireTicket(ctx, ticketId);
  const run = ctx.repos.runs.get(runId);
  if (!run || run.ticketId !== ticketId) throw notFound('Run', runId);
  if (!run.snapshotBefore) throw conflict('This run has no snapshot to restore', 'no_snapshot');
  if (ctx.repos.runs.listForTicket(ticketId, DETAIL_RUNS).some((r) => r.status === 'running')) {
    throw conflict('Stop the running agent before undoing changes', 'run_active');
  }
  const snapshot = await ctx.snapshots.restore(ticket.folder, run.snapshotBefore);
  audit(ctx, {
    ticketId,
    runId,
    kind: 'snapshot',
    summary: 'Undid the changes made by this run',
    data: { restoredTo: run.snapshotBefore, snapshot },
  });
  return { run, snapshot };
}

export function decidePermission(ctx: AppContext, requestId: Id, decision: PermissionDecision): PermissionRequest {
  const req = ctx.repos.permissions.get(requestId);
  if (!req) throw notFound('Permission request', requestId);
  if (req.state !== 'pending') throw conflict('This permission request was already decided', 'already_decided');
  // v0.5 I: every decision resumes the agent (run.permission): refused during the emergency stop.
  // The request stays pending, so the owner can decide after releasing the stop.
  assertNotLockedDown(ctx, LOCKDOWN_ROUTES.decide, req.ticketId);
  if (decision === 'always' && (req.key !== 'script.run' || !req.command)) {
    throw badRequest('Only a plain system command (not a production change) can be always allowed', 'not_trustable');
  }
  if (req.connector) {
    if (decision === 'task' || decision === 'always') throw badRequest('Turn the connector on for the agent or its team, or deny.', 'not_applicable');
    if (decision === 'team' && !req.connector.teamId) throw badRequest('This agent has no team.', 'no_team');
    if (decision !== 'deny') turnOnConnector(ctx, req, decision === 'team');
  } else if (decision === 'team') {
    throw badRequest('Only a connector request can be turned on for a team.', 'not_applicable');
  }
  return ctx.gate.decide(requestId, decision);
}

/** v0.9: the owner allowed an agent's request for a Claude connector: add it to the agent or its team. */
function turnOnConnector(ctx: AppContext, req: PermissionRequest, forTeam: boolean): void {
  const name = req.connector!.name;
  const OWNER = { type: 'user', id: null, name: 'You' } as const;
  if (forTeam) {
    const team = ctx.repos.teams?.get(req.connector!.teamId!);
    if (!team) throw notFound('Team', req.connector!.teamId!);
    if (!team.claudeConnectors.includes(name)) ctx.repos.teams!.update(team.id, { claudeConnectors: [...team.claudeConnectors, name] });
    ctx.bus.publish({ type: 'teams.changed' });
    ctx.securityLog?.record({ actor: OWNER, category: 'config', action: 'team.claude_connector_on', summary: `Claude connector "${name}" turned on for the team "${team.name}"`, data: { teamId: team.id, connector: name, requestId: req.id } });
    return;
  }
  const agent = req.agentId ? ctx.repos.agents.get(req.agentId) : undefined;
  if (!agent) throw notFound('Agent', req.agentId ?? '');
  const cur = agent.claudeConnectors ?? [];
  const updated = cur.includes(name) ? agent : ctx.repos.agents.update(agent.id, { claudeConnectors: [...cur, name] });
  ctx.bus.publish({ type: 'agent.updated', agent: updated });
  ctx.securityLog?.record({ actor: OWNER, category: 'config', action: 'agent.claude_connector_on', agentId: agent.id, summary: `Claude connector "${name}" turned on for ${agent.name}`, data: { agentId: agent.id, connector: name, requestId: req.id } });
}

// ---- trusted commands ("Always allow this command")
export function listTrustedCommands(ctx: AppContext): TrustedCommand[] {
  return ctx.repos.trusted.list();
}

export function removeTrustedCommand(ctx: AppContext, id: Id): void {
  if (!ctx.repos.trusted.remove(id)) throw notFound('Trusted command', id);
  ctx.bus.publish({ type: 'trusted.changed', commands: ctx.repos.trusted.list() });
}
