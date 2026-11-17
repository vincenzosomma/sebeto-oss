/** Agent and runtime application services. */
import type { Agent, AuditEvent, CreateAgentBody, DeleteAgentResponse, Id, RuntimeInfo, Ticket, UpdateAgentBody } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { pickDefaultAgent } from '../default-agent.js';
import { badRequest, conflict, notFound, unavailable } from './errors.js';
import { joiningAi, requireTeamIfSet } from './teams.js';
import { assertAgentRuntime } from './team-policy.js';

function requireRuntimeIfSet(ctx: AppContext, runtime: string | undefined): void {
  if (runtime !== undefined && !ctx.runtimes.get(runtime)) throw badRequest(`Runtime ${runtime} is not enabled`, 'unknown_runtime');
}

function requireAgentIfSet(ctx: AppContext, id: Id | null | undefined): void {
  if (id != null && !ctx.repos.agents.get(id)) throw badRequest(`Agent ${id} does not exist`, 'unknown_agent');
}

/** Repo validation errors (e.g. reportsTo cycles) become 400s rather than 500s. */
function asBadRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.name !== 'AppError') throw badRequest(err.message, 'invalid_agent');
    throw err;
  }
}

export function listAgents(ctx: AppContext): Agent[] {
  return ctx.repos.agents.list();
}

export function createAgent(ctx: AppContext, body: CreateAgentBody): Agent {
  requireRuntimeIfSet(ctx, body.runtime);
  requireAgentIfSet(ctx, body.reportsTo);
  requireTeamIfSet(ctx, body.teamId);
  // v0.4 F: an agent created into a team with an AI gets that AI; a locked team refuses another runtime.
  const team = body.teamId ? ctx.repos.teams?.get(body.teamId) : undefined;
  if (team && body.runtime !== undefined) assertAgentRuntime(ctx, { name: body.name }, team.id, body.runtime);
  const ai = joiningAi(team);
  const input = ai && body.runtime === undefined ? { ...body, runtime: ai.runtime, model: body.model !== undefined ? body.model : ai.model } : body;
  const agent = asBadRequest(() => ctx.repos.agents.create(input));
  ctx.bus.publish({ type: 'agent.updated', agent });
  if (agent.teamId) ctx.bus.publish({ type: 'teams.changed' });
  return agent;
}

export function updateAgent(ctx: AppContext, id: Id, body: UpdateAgentBody): Agent {
  const existing = ctx.repos.agents.get(id);
  if (!existing) throw notFound('Agent', id);
  requireRuntimeIfSet(ctx, body.runtime);
  requireAgentIfSet(ctx, body.reportsTo);
  requireTeamIfSet(ctx, body.teamId);
  const { permissions, ...rest } = body;
  const patch: Partial<Omit<Agent, 'id' | 'createdAt'>> = { ...rest };
  if (permissions) patch.permissions = { ...existing.permissions, ...permissions };
  const before = existing.teamId ?? null;
  // v0.4 F (team AI): joining a team that has an AI gives the agent that AI. For a LOCKED team the
  // move always sets the team's runtime (a runtime sent unchanged in the same request, as the agent
  // editor does, is replaced); an explicit different runtime is refused. Inside a locked team the
  // runtime cannot be changed to another one (409 runtime_locked).
  const joining = body.teamId !== undefined && body.teamId !== null && body.teamId !== before;
  const finalTeamId = body.teamId !== undefined ? body.teamId : before;
  const runtimeChange = body.runtime !== undefined && body.runtime !== existing.runtime ? body.runtime : undefined;
  if (joining) {
    const team = ctx.repos.teams?.get(body.teamId!);
    const ai = joiningAi(team);
    if (team?.lockRuntime && runtimeChange !== undefined) assertAgentRuntime(ctx, existing, team.id, runtimeChange);
    if (ai && (team?.lockRuntime || runtimeChange === undefined)) {
      patch.runtime = ai.runtime;
      if (body.model === undefined || runtimeChange === undefined) patch.model = ai.model;
    }
  } else if (runtimeChange !== undefined) {
    assertAgentRuntime(ctx, existing, finalTeamId ?? null, runtimeChange);
  }
  const agent = asBadRequest(() => ctx.repos.tx(() => {
    const a = ctx.repos.agents.update(id, patch);
    // Leaving a team it was leading: that team has no lead any more (the lead is always a member).
    const teams = ctx.repos.teams;
    if (teams && body.teamId !== undefined && before && before !== (a.teamId ?? null) && teams.get(before)?.leadAgentId === id) {
      teams.update(before, { leadAgentId: null });
    }
    return a;
  }));
  ctx.bus.publish({ type: 'agent.updated', agent });
  if (body.teamId !== undefined && before !== (agent.teamId ?? null)) {
    ctx.bus.publish({ type: 'teams.changed' });
    const teamName = agent.teamId ? ctx.repos.teams?.get(agent.teamId)?.name ?? 'a team' : null;
    ctx.securityLog?.record({
      category: 'config', action: 'team.member_changed', agentId: id,
      summary: teamName ? `${agent.name} joined the team "${teamName}"` : `${agent.name} left its team`,
      data: { agentId: id, fromTeamId: before, toTeamId: agent.teamId ?? null },
    });
  }
  return agent;
}

/**
 * Delete an agent (DeleteAgentResponse in @sebeto/shared). Refused while it is working (409
 * agent_busy) or when it is the last agent (409 last_agent). In one transaction: its open tickets
 * move to the default agent of the remaining team (fresh session, audit note), its direct reports
 * move up to its manager, the row is deleted (skill assignments cascade; old sessions keep NULL).
 * Then custom connectors that listed it drop it (an emptied list stays empty: nobody, not everyone).
 */
export function deleteAgent(ctx: AppContext, id: Id): DeleteAgentResponse {
  const repo = ctx.repos.agents;
  const agent = repo.get(id);
  if (!agent) throw notFound('Agent', id);
  if (!repo.delete || !repo.workload) throw unavailable('Deleting agents is not available in this build');
  const remove = repo.delete.bind(repo);
  const workload = repo.workload.bind(repo);

  const tickets: Ticket[] = [];
  const events: AuditEvent[] = [];
  const moved: Agent[] = [];
  ctx.repos.tx(() => {
    const all = repo.list();
    if (all.length <= 1) throw conflict(`${agent.name} is your only agent. Add another agent before deleting this one.`, 'last_agent');
    const work = workload(id);
    if (work.busy) throw conflict(`${agent.name} is working on a ticket right now. Stop it or wait until it finishes, then try again.`, 'agent_busy');

    const target = pickDefaultAgent(all.filter((a) => a.id !== id))!;
    for (const ticketId of work.openTicketIds) {
      tickets.push(ctx.repos.tickets.update(ticketId, { agentId: target.id, currentSessionId: null }));
      events.push(ctx.repos.audit.append({
        ticketId, kind: 'info',
        summary: `Agent ${agent.name} was removed; reassigned to ${target.name}. The new agent starts a fresh session.`,
        data: { removedAgentId: id, agentId: target.id },
      }));
    }
    for (const report of all.filter((a) => a.reportsTo === id)) moved.push(repo.update(report.id, { reportsTo: agent.reportsTo }));
    remove(id);
  });

  ctx.bus.publish({ type: 'agent.deleted', agentId: id });
  if (agent.teamId) ctx.bus.publish({ type: 'teams.changed' });
  for (const a of moved) ctx.bus.publish({ type: 'agent.updated', agent: a });
  for (const t of tickets) ctx.bus.publish({ type: 'ticket.updated', ticket: t });
  for (const e of events) ctx.bus.publish({ type: 'event.created', event: e });

  let connectorsChanged = false;
  for (const c of ctx.connectors?.list() ?? []) {
    if (!c.allowedAgents?.includes(id)) continue;
    try {
      ctx.connectors!.update(c.id, { allowedAgents: c.allowedAgents.filter((x) => x !== id) });
      connectorsChanged = true;
    } catch (err) {
      ctx.log.warn({ connectorId: c.id, err: (err as Error).message }, 'could not remove a deleted agent from a connector');
    }
  }
  if (connectorsChanged) ctx.bus.publish({ type: 'connectors.changed' });

  ctx.log.info({ agentId: id, reassignedTickets: tickets.length, movedReports: moved.length }, 'agent deleted');
  return { ok: true, reassignedTickets: tickets.length, movedReports: moved.length };
}

export async function listRuntimes(ctx: AppContext): Promise<RuntimeInfo[]> {
  return Promise.all(
    ctx.runtimes.list().map(async (a): Promise<RuntimeInfo> => {
      const detection = await a.detect().catch((err: unknown) => ({ installed: false, problem: (err as Error).message }));
      const models = detection.installed ? await a.models().catch(() => [] as string[]) : [];
      return { id: a.id, displayName: a.displayName, detection, models };
    }),
  );
}

export const DEFAULT_AGENT_NAME = 'Assistant';

/** First launch: create one general-purpose agent. Uses Claude Code when it is installed, else the mock runtime. */
export async function seedDefaults(ctx: AppContext): Promise<Agent | undefined> {
  if (ctx.repos.agents.list().length > 0) return undefined;
  const claude = ctx.runtimes.get('claude-cli');
  const claudeOk = claude ? await claude.detect().then((d) => d.installed, () => false) : false;
  const runtime = claudeOk ? 'claude-cli' : ctx.runtimes.get('mock') ? 'mock' : ctx.runtimes.list()[0]?.id ?? 'mock';
  const agent = ctx.repos.agents.create({
    name: DEFAULT_AGENT_NAME,
    role: 'General assistant',
    job: 'Help with whatever the ticket asks. Work inside the ticket folder, explain what you did in plain language, and ask when something is unclear.',
    runtime,
  });
  ctx.bus.publish({ type: 'agent.updated', agent });
  ctx.log.info({ agentId: agent.id, runtime }, 'seeded default agent');
  return agent;
}
