/**
 * Teams API (v0.4, packages/shared/src/teams.ts; docs/28 v0.4 Plan.md §C).
 * A team has a name, a unique slug, a colour, a lead (always a member) and routing hints. Members
 * are the agents whose teamId points to it. Deleting a team keeps its agents and tickets (no team).
 */
import { PROJECT_COLORS, type Agent, type CreateTeamBody, type Id, type RuntimeId, type SecuritySeverity, type Team, type TeamAiFields, type UpdateTeamBody, trimChars, trimEndChars } from '@sebeto/shared';
import type { AppContext, TeamRepo } from '../contracts.js';
import { badRequest, conflict, notFound, unavailable } from './errors.js';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MAX_ROUTING_HINTS = 2000;

export function teamRepo(ctx: AppContext): TeamRepo {
  if (!ctx.repos.teams) throw unavailable('Teams are not available in this build');
  return ctx.repos.teams;
}

/** "Service Desk" → "service-desk" (letters and digits, accents removed). */
export function slugifyTeam(name: string): string {
  const s = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return trimEndChars(trimChars(s, '-').slice(0, 50), '-') || 'team';
}

/** A slug that is free: base, base-2, base-3… */
export function uniqueTeamSlug(repo: TeamRepo, base: string): string {
  let slug = base;
  for (let n = 2; repo.bySlug(slug); n++) slug = `${base.slice(0, 55)}-${n}`;
  return slug;
}

/** A name that is free (case-insensitive): name, "name 2", "name 3"… */
export function uniqueTeamName(repo: TeamRepo, name: string): string {
  let candidate = name;
  for (let n = 2; repo.findByName(candidate); n++) candidate = `${name} ${n}`;
  return candidate;
}

export function nextTeamColor(repo: TeamRepo): string {
  return PROJECT_COLORS[repo.list().length % PROJECT_COLORS.length]!;
}

function checkName(repo: TeamRepo, name: string, selfId?: Id): string {
  const n = name.trim();
  if (!n) throw badRequest('Give the team a name.', 'team_name');
  if (n.length > 80) throw badRequest('The team name is too long (80 characters at most).', 'team_name');
  const other = repo.findByName(n);
  if (other && other.id !== selfId) throw conflict(`A team called "${other.name}" already exists.`, 'team_exists');
  return n;
}

function checkColor(color: string | undefined, fallback: string): string {
  if (color === undefined) return fallback;
  if (!COLOR_RE.test(color)) throw badRequest('Colour must look like #0E5A8A.', 'team_color');
  return color.toUpperCase();
}

function checkHints(h: string | undefined): string | undefined {
  if (h === undefined) return undefined;
  const t = h.trim();
  if (t.length > MAX_ROUTING_HINTS) throw badRequest(`Routing hints are too long (${MAX_ROUTING_HINTS} characters at most).`, 'team_hints');
  return t;
}

function requireAgent(ctx: AppContext, id: Id): Agent {
  const a = ctx.repos.agents.get(id);
  if (!a) throw badRequest(`Agent ${id} does not exist`, 'unknown_agent');
  return a;
}

const changed = (ctx: AppContext) => ctx.bus.publish({ type: 'teams.changed' });
/** Team changes are made by the owner (UI or API). */
const OWNER = { type: 'user', id: null, name: 'You' } as const;

export function listTeams(ctx: AppContext): Team[] {
  return ctx.repos.teams?.list() ?? [];
}

export function requireTeam(ctx: AppContext, id: Id): Team {
  const t = teamRepo(ctx).get(id);
  if (!t) throw notFound('Team', id);
  return t;
}

/** For ticket / agent create and update: the team must exist (null clears it). */
export function requireTeamIfSet(ctx: AppContext, teamId: Id | null | undefined): void {
  if (teamId != null && !ctx.repos.teams?.get(teamId)) throw badRequest(`Team ${teamId} does not exist`, 'unknown_team');
}

// ---------------------------------------------------------------- v0.4 F: the team's AI
export const MAX_TEAM_MODEL = 200;

/** The team AI after a create / update, validated (sync part: runtime registered, lock needs a runtime). */
export interface TeamAi { runtime: RuntimeId | null; model: string | null; lockRuntime: boolean; requireScope: boolean }

const NO_AI: TeamAi = { runtime: null, model: null, lockRuntime: false, requireScope: false };

function checkTeamAi(ctx: AppContext, body: TeamAiFields, cur: TeamAi): TeamAi {
  let runtime = cur.runtime;
  if (body.runtime !== undefined) {
    runtime = body.runtime === null || body.runtime.trim() === '' ? null : body.runtime.trim();
    if (runtime !== null && !ctx.runtimes.get(runtime)) throw badRequest(`The AI "${runtime}" is not enabled in Sebeto.`, 'unknown_runtime');
  }
  const runtimeChanged = runtime !== cur.runtime;
  let model = runtimeChanged ? null : cur.model; // a model belongs to its runtime
  if (body.model !== undefined) {
    model = body.model === null || body.model.trim() === '' ? null : body.model.trim();
    if (model !== null && model.length > MAX_TEAM_MODEL) throw badRequest(`The model name is too long (${MAX_TEAM_MODEL} characters at most).`, 'team_model');
  }
  if (runtime === null) model = null;
  const lockRuntime = body.lockRuntime ?? cur.lockRuntime;
  if (lockRuntime && runtime === null) throw badRequest('Choose the team\'s AI before locking the team to it.', 'team_lock_needs_runtime');
  return { runtime, model, lockRuntime, requireScope: body.requireScope ?? cur.requireScope };
}

/**
 * Async part of the validation (the API calls it before createTeam / updateTeam): the model must be
 * one the runtime offers when the runtime can list its models; otherwise any name is accepted.
 */
export async function checkTeamModel(ctx: AppContext, runtime: RuntimeId | null | undefined, model: string | null | undefined): Promise<void> {
  if (!runtime || !model?.trim()) return;
  const adapter = ctx.runtimes.get(runtime);
  if (!adapter) return; // reported by checkTeamAi
  const installed = await adapter.detect().then((d) => d.installed, () => false);
  const offered = installed ? await adapter.models().catch(() => [] as string[]) : [];
  if (offered.length && !offered.includes(model.trim())) {
    throw badRequest(`${adapter.displayName} does not offer the model "${model.trim()}". Pick one of: ${offered.slice(0, 10).join(', ')}.`, 'team_model');
  }
}

/** POST /teams with the model check. */
export async function createTeamChecked(ctx: AppContext, body: CreateTeamBody): Promise<Team> {
  await checkTeamModel(ctx, body.runtime, body.model);
  return createTeam(ctx, body);
}

/** PATCH /teams/:id with the model check (against the runtime the team will have). */
export async function updateTeamChecked(ctx: AppContext, id: Id, body: UpdateTeamBody): Promise<Team> {
  const cur = requireTeam(ctx, id);
  await checkTeamModel(ctx, body.runtime !== undefined ? body.runtime : cur.runtime, body.model);
  return updateTeam(ctx, id, body);
}

/**
 * The runtime + model an agent gets when it joins `team` (null = it keeps its own). A team with a
 * runtime gives it to every member that joins; for a locked team this is mandatory.
 */
export function joiningAi(team: Team | null | undefined): { runtime: RuntimeId; model: string | null } | null {
  return team?.runtime ? { runtime: team.runtime, model: team.model ?? null } : null;
}

/** Set the team's runtime + model on every current member that differs. Returns the changed agents. */
function applyAiToMembers(ctx: AppContext, team: Team): Agent[] {
  if (!team.runtime) return [];
  const changedAgents: Agent[] = [];
  for (const id of team.memberIds) {
    const a = ctx.repos.agents.get(id);
    if (!a || (a.runtime === team.runtime && (a.model ?? null) === (team.model ?? null))) continue;
    changedAgents.push(ctx.repos.agents.update(id, { runtime: team.runtime, model: team.model ?? null }));
  }
  return changedAgents;
}

const runtimeName = (ctx: AppContext, id: RuntimeId | null) => (id ? ctx.runtimes.get(id)?.displayName ?? id : 'none');

/** Security events for a change of the team's AI policy (lock off / locked runtime changed = warning). */
function recordAiChange(ctx: AppContext, team: Team, before: TeamAi, after: TeamAi, applied: number): void {
  const base = { actor: OWNER, category: 'config' as const, data: { teamId: team.id, slug: team.slug, before, after, membersUpdated: applied } };
  const ev = (action: string, severity: SecuritySeverity, summary: string) => ctx.securityLog?.record({ ...base, action, severity, summary });
  if (after.lockRuntime && !before.lockRuntime) ev('team.runtime_locked', 'notice', `Team "${team.name}" locked to ${runtimeName(ctx, after.runtime)}`);
  else if (!after.lockRuntime && before.lockRuntime) ev('team.runtime_unlocked', 'warning', `Team "${team.name}" is no longer locked to ${runtimeName(ctx, before.runtime)}`);
  else if (after.lockRuntime && before.runtime !== after.runtime) {
    ev('team.locked_runtime_changed', 'warning', `Team "${team.name}" (locked) moved from ${runtimeName(ctx, before.runtime)} to ${runtimeName(ctx, after.runtime)}`);
  } else if (before.runtime !== after.runtime || before.model !== after.model) {
    ev('team.ai_changed', 'info', `Team "${team.name}" AI set to ${runtimeName(ctx, after.runtime)}${after.model ? ` (${after.model})` : ''}`);
  }
  if (after.requireScope !== before.requireScope) {
    if (after.requireScope) ev('team.scope_required', 'notice', `Team "${team.name}" now needs a written scope before its tickets start`);
    else ev('team.scope_not_required', 'warning', `Team "${team.name}" no longer needs a written scope before its tickets start`);
  }
  if (applied > 0) ev('team.ai_applied', 'notice', `${runtimeName(ctx, after.runtime)} set on ${applied} member(s) of the team "${team.name}"`);
}

export const teamAiOf = (t: Team): TeamAi => ({ runtime: t.runtime ?? null, model: t.model ?? null, lockRuntime: !!t.lockRuntime, requireScope: !!t.requireScope });

/** Template apply (services/templates.ts): validate + record the AI of a team it created. */
export function checkTemplateTeamAi(ctx: AppContext, ai: TeamAiFields): TeamAi {
  return checkTeamAi(ctx, ai, NO_AI);
}
export function recordNewTeamAi(ctx: AppContext, team: Team): void {
  recordAiChange(ctx, team, NO_AI, teamAiOf(team), 0);
}

/**
 * Put an agent into a team (or none). When it leaves a team it was leading, that team loses its
 * lead. Returns the updated agent; publishes agent.updated (and teams.changed when something moved).
 */
export function setAgentTeam(ctx: AppContext, agentId: Id, teamId: Id | null): Agent {
  const agent = requireAgent(ctx, agentId);
  const before = agent.teamId ?? null;
  if (before === teamId) return agent;
  const repo = teamRepo(ctx);
  // v0.4 F: joining a team with an AI gives the agent that AI (mandatory for a locked team).
  const ai = joiningAi(teamId ? repo.get(teamId) : null);
  const updated = ctx.repos.agents.update(agentId, { teamId, ...(ai ?? {}) });
  if (before) {
    const old = repo.get(before);
    if (old?.leadAgentId === agentId) repo.update(before, { leadAgentId: null });
  }
  ctx.bus.publish({ type: 'agent.updated', agent: updated });
  changed(ctx);
  return updated;
}

export function createTeam(ctx: AppContext, body: CreateTeamBody): Team {
  const repo = teamRepo(ctx);
  const name = checkName(repo, body.name);
  let slug: string;
  if (body.slug !== undefined) {
    slug = body.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw badRequest('The short name may use lowercase letters, digits and dashes.', 'team_slug');
    if (repo.bySlug(slug)) throw conflict(`The short name "${slug}" is already used by another team.`, 'team_slug_exists');
  } else {
    slug = uniqueTeamSlug(repo, slugifyTeam(name));
  }
  const lead = body.leadAgentId ?? null;
  if (lead) requireAgent(ctx, lead);
  const ai = checkTeamAi(ctx, body, NO_AI);
  const team = ctx.repos.tx(() => {
    const t = repo.create({
      slug, name, description: (body.description ?? '').trim(), color: checkColor(body.color, nextTeamColor(repo)),
      leadAgentId: lead, routingHints: checkHints(body.routingHints) ?? '', ...ai,
      ...(body.claudeConnectors ? { claudeConnectors: body.claudeConnectors } : {}),
    });
    return t;
  });
  // The lead must be a member: setting a lead adds it to the team.
  if (lead) setAgentTeam(ctx, lead, team.id);
  const fresh = repo.get(team.id)!;
  changed(ctx);
  ctx.securityLog?.record({ actor: OWNER, category: 'config', action: 'team.created', summary: `Team "${fresh.name}" created`, data: { teamId: fresh.id, slug: fresh.slug, leadAgentId: fresh.leadAgentId } });
  recordAiChange(ctx, fresh, NO_AI, teamAiOf(fresh), 0);
  return fresh;
}

export function updateTeam(ctx: AppContext, id: Id, body: UpdateTeamBody): Team {
  const repo = teamRepo(ctx);
  const cur = requireTeam(ctx, id);
  if (body.leadAgentId) requireAgent(ctx, body.leadAgentId);
  const hints = checkHints(body.routingHints);
  const before = teamAiOf(cur);
  const ai = checkTeamAi(ctx, body, before);
  // Forced when the lock turns on, or when a locked team moves to another runtime: every member
  // must then run on the team's AI.
  const apply = !!ai.runtime && (body.applyToMembers === true || (ai.lockRuntime && (!before.lockRuntime || ai.runtime !== before.runtime)));
  const name = body.name !== undefined ? checkName(repo, body.name, id) : undefined;
  const color = body.color !== undefined ? checkColor(body.color, cur.color) : undefined;
  const changedAgents = ctx.repos.tx(() => {
    repo.update(id, {
      ...(name !== undefined ? { name } : {}),
      ...(body.description !== undefined ? { description: body.description.trim() } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(hints !== undefined ? { routingHints: hints } : {}),
      ...(body.claudeConnectors !== undefined ? { claudeConnectors: body.claudeConnectors } : {}),
      ...ai,
    });
    return apply ? applyAiToMembers(ctx, repo.get(id)!) : [];
  });
  for (const agent of changedAgents) ctx.bus.publish({ type: 'agent.updated', agent });
  if (body.leadAgentId !== undefined) {
    if (body.leadAgentId) setAgentTeam(ctx, body.leadAgentId, id); // the lead joins the team first
    repo.update(id, { leadAgentId: body.leadAgentId });
  }
  const team = repo.get(id)!;
  changed(ctx);
  recordAiChange(ctx, team, before, ai, changedAgents.length);
  ctx.securityLog?.record({
    actor: OWNER, category: 'config', action: 'team.updated', summary: `Team "${team.name}" changed`,
    data: { teamId: id, fields: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined) },
  });
  return team;
}

export function deleteTeam(ctx: AppContext, id: Id): void {
  const repo = teamRepo(ctx);
  const team = requireTeam(ctx, id);
  const tickets = ctx.repos.tickets.list({ teamId: id, limit: 200 }).items;
  if (!repo.remove(id)) throw notFound('Team', id);
  changed(ctx);
  // Its agents and tickets stay, without a team (ON DELETE SET NULL): refresh them in the UI.
  for (const agentId of team.memberIds) {
    const a = ctx.repos.agents.get(agentId);
    if (a) ctx.bus.publish({ type: 'agent.updated', agent: a });
  }
  for (const t of tickets) {
    const fresh = ctx.repos.tickets.get(t.id);
    if (fresh) ctx.bus.publish({ type: 'ticket.updated', ticket: fresh });
  }
  ctx.securityLog?.record({ actor: OWNER, category: 'config', action: 'team.deleted', summary: `Team "${team.name}" deleted`, data: { teamId: id, slug: team.slug, members: team.memberIds.length } });
}
