/**
 * Team templates API (packages/shared/src/templates.ts; docs/17 Agents & Skills.md "Team templates").
 * Built-in templates ship with Sebeto; saved ones are JSON files in <workspace>/templates/.
 * Applying a template creates skills (never overwriting an existing slug) and agents in one go.
 */
import type { Agent, ApplyTemplateBody, ApplyTemplateResponse, Id, RuntimeId, Team, TeamTemplate, TemplateTeam, TemplateTeamWithMembers } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { SkillError } from '../skills/store.js';
import {
  ExportTooBigError, TemplateError, createRuntimeChooser, createTeamAgents, createTemplateStore, exportTeam, parseTemplate, teamBelow,
  type ApplyPlanItem,
} from '../templates/index.js';
import { AppError, badRequest, conflict, notFound, unavailable } from './errors.js';
import { checkTemplateTeamAi, nextTeamColor, recordNewTeamAi, slugifyTeam, uniqueTeamName, uniqueTeamSlug, type TeamAi } from './teams.js';

function templateStore(ctx: AppContext) {
  return createTemplateStore(ctx.config.workspaceDir, (file, reason) => ctx.log.warn({ file, reason }, 'skipped a team template file that is not valid'));
}

export function listTemplates(ctx: AppContext): TeamTemplate[] {
  return templateStore(ctx).list();
}

export function saveTemplate(ctx: AppContext, template: TeamTemplate): TeamTemplate {
  const saved = templateStore(ctx).save(template);
  ctx.bus.publish({ type: 'templates.changed' });
  ctx.securityLog?.record({ category: 'config', action: 'config.template_saved', severity: 'notice', summary: `Team template "${saved.name}" was saved (${saved.agents.length} agents).`, data: { templateId: saved.id, name: saved.name, agents: saved.agents.length } });
  ctx.log.info({ templateId: saved.id, agents: saved.agents.length }, 'saved team template');
  return saved;
}

export function deleteTemplate(ctx: AppContext, id: string): void {
  try {
    templateStore(ctx).remove(id);
  } catch (err) {
    if (err instanceof TemplateError && err.code === 'builtin') throw conflict(err.message, 'template_builtin');
    if (err instanceof TemplateError) throw notFound('Template', id);
    throw err;
  }
  ctx.bus.publish({ type: 'templates.changed' });
  ctx.securityLog?.record({ category: 'config', action: 'config.template_deleted', severity: 'notice', summary: `Team template "${id}" was deleted.`, data: { templateId: id } });
}

export async function applyTemplate(ctx: AppContext, body: ApplyTemplateBody): Promise<ApplyTemplateResponse> {
  let template: TeamTemplate;
  if (body.templateId !== undefined) {
    const found = templateStore(ctx).get(body.templateId);
    if (!found) throw notFound('Template', body.templateId);
    template = found;
  } else if (body.template !== undefined) {
    template = parseTemplate(body.template);
  } else {
    throw badRequest('Pick a template or send a template file', 'template_missing');
  }
  const top = body.reportsTo ?? null;
  if (top !== null && !ctx.repos.agents.get(top)) throw badRequest(`Agent ${top} does not exist`, 'unknown_agent');
  const lib = ctx.skills;
  const usesSkills = template.agents.some((a) => a.skills.length > 0) || template.skills.length > 0;
  if (!lib && usesSkills) throw unavailable('Skills are not available in this build');

  // Every skill an agent uses must come with the template or already be in the library.
  const offered = new Set(template.skills.map((s) => s.slug));
  for (const a of template.agents) {
    for (const slug of a.skills) {
      if (!offered.has(slug) && !lib?.get(slug)) throw badRequest(`"${a.name}" uses the skill "${slug}", which is neither in the file nor in your library`, 'unknown_skill');
    }
  }

  // v0.4 F/G: the team's AI (the request overrides the template) and its policies.
  // v0.9: a multi-team file has one AI per team (the request's AI applies to single-team files only).
  const warnings: string[] = [];
  const multi = template.teams?.length ? template.teams : null;
  const teamAi = multi ? { runtime: null, model: null, lockRuntime: false, requireScope: false } : await chooseTeamAi(ctx, template.team, body, warnings);
  const teamAis = new Map<string, TeamAi>();
  for (const t of multi ?? []) teamAis.set(t.name, await chooseTeamAi(ctx, t, {}, warnings, t.name));
  const aiOfAgent = (key: string): TeamAi => {
    if (!multi) return teamAi;
    const t = multi.find((x) => x.memberKeys.includes(key));
    return (t && teamAis.get(t.name)) ?? teamAi;
  };

  // Runtime + model per agent (async detection happens before any write). A team AI wins.
  const choose = createRuntimeChooser(ctx.runtimes, ctx.repos.agents.list());
  const plan: ApplyPlanItem[] = [];
  for (const t of template.agents) {
    const ai = aiOfAgent(t.key);
    if (ai.runtime) {
      plan.push({ template: t, runtime: ai.runtime, model: ai.model });
      continue;
    }
    const { runtime, models } = await choose(t.runtime);
    plan.push({ template: t, runtime, model: t.model && runtime === t.runtime && models.includes(t.model) ? t.model : null });
  }

  // Skills first (files on disk), then all agents in one database transaction; undo the new skills on failure.
  const skillsCreated: string[] = [];
  const skillsReused: string[] = [];
  try {
    for (const s of template.skills) {
      if (lib!.get(s.slug)) {
        skillsReused.push(s.slug);
        continue;
      }
      lib!.create({ name: s.name, description: s.description, instructions: s.instructions, needs: s.needs ?? [], connectors: s.connectors ?? [] }, { slug: s.slug });
      skillsCreated.push(s.slug);
    }
  } catch (err) {
    rollbackSkills(ctx, skillsCreated);
    if (err instanceof SkillError) throw badRequest(err.message, 'skill_invalid');
    throw err;
  }
  // Library skills used by agents but not shipped in the file count as reused too.
  for (const a of template.agents) for (const slug of a.skills) if (!offered.has(slug) && !skillsReused.includes(slug)) skillsReused.push(slug);

  let created: Map<string, Agent>;
  let teams: Team[] = [];
  try {
    ({ created, teams } = ctx.repos.tx(() => {
      const made = createTeamAgents(ctx.repos, plan, top);
      if (multi) {
        const out: Team[] = [];
        for (const t of multi) {
          const members = t.memberKeys.map((k) => made.get(k)).filter((a): a is Agent => !!a);
          const lead = t.leadKey ? made.get(t.leadKey) : undefined;
          const made1 = createTemplateTeam(ctx, { ...template, team: t, builtin: false, description: '' }, members, teamAis.get(t.name)!, lead);
          if (made1) out.push(made1);
        }
        return { created: made, teams: out };
      }
      const one = createTemplateTeam(ctx, template, [...made.values()], teamAi);
      return { created: made, teams: one ? [one] : [] };
    }));
  } catch (err) {
    rollbackSkills(ctx, skillsCreated);
    if (err instanceof AppError) throw err;
    throw badRequest((err as Error).message, 'invalid_template');
  }

  const agents = template.agents.map((t) => ctx.repos.agents.get(created.get(t.key)!.id)!);
  for (const agent of agents) ctx.bus.publish({ type: 'agent.updated', agent });
  ctx.bus.publish({ type: 'skills.changed' });
  ctx.securityLog?.record({
    category: 'config', action: body.template !== undefined ? 'config.template_imported' : 'config.template_applied', severity: 'notice',
    summary: `Team template "${template.name}" was ${body.template !== undefined ? 'imported from a file' : 'applied'}: ${agents.length} agent(s), ${skillsCreated.length} new skill(s).`,
    data: { templateId: template.id, name: template.name, builtin: template.builtin, agentIds: agents.map((a) => a.id), skillsCreated, skillsReused },
  });
  if (teams.length) ctx.bus.publish({ type: 'teams.changed' });
  for (const team of teams) {
    ctx.securityLog?.record({
      actor: { type: 'user', id: null, name: 'You' }, category: 'config', action: 'team.created',
      summary: `Team "${team.name}" created from the template "${template.name}"`,
      data: { teamId: team.id, slug: team.slug, templateId: template.id, members: team.memberIds.length, leadAgentId: team.leadAgentId },
    });
    recordNewTeamAi(ctx, team);
  }
  const team = teams[0];
  ctx.log.info(
    { template: template.id, agents: agents.length, skillsCreated: skillsCreated.length, skillsReused: skillsReused.length },
    'applied team template',
  );
  return { agents, skillsCreated, skillsReused, ...(team ? { team } : {}), ...(teams.length > 1 ? { teams } : {}), ...(warnings.length ? { warnings } : {}) };
}

/**
 * v0.4 F: the AI of the team a template creates. The request's runtime / model / lockRuntime override
 * the template's. A runtime that is not enabled here is ignored; the lock is kept only when the runtime
 * is enabled AND installed (otherwise the team is created unlocked); a model the runtime does not
 * offer is dropped. Every such change is explained in `warnings`.
 */
async function chooseTeamAi(ctx: AppContext, t: TemplateTeam | undefined, body: Pick<ApplyTemplateBody, 'runtime' | 'model' | 'lockRuntime'>, warnings: string[], teamName?: string): Promise<TeamAi> {
  const startLen = warnings.length;
  let runtime: RuntimeId | null = body.runtime !== undefined ? body.runtime : t?.runtime ?? null;
  let model: string | null = body.model !== undefined ? body.model : body.runtime !== undefined ? null : t?.model ?? null;
  let lockRuntime = body.lockRuntime ?? t?.lockRuntime ?? false;
  const requireScope = t?.requireScope ?? false;
  const adapter = runtime ? ctx.runtimes.get(runtime) : undefined;
  if (runtime && !adapter) {
    warnings.push(`The AI "${runtime}" is not enabled in Sebeto, so the team uses the usual AI${lockRuntime ? ' and is not locked' : ''}.`);
    runtime = null;
  }
  if (runtime && adapter) {
    const installed = await adapter.detect().then((d) => d.installed, () => false);
    if (!installed && lockRuntime) {
      warnings.push(`${adapter.displayName} is not installed on this computer, so the team was created without the lock. Install it, then lock the team in Teams.`);
      lockRuntime = false;
    }
    const offered = installed ? await adapter.models().catch(() => [] as string[]) : [];
    if (model && offered.length && !offered.includes(model)) {
      warnings.push(`${adapter.displayName} does not offer the model "${model}", so the team uses its default model.`);
      model = null;
    }
  }
  if (!runtime) {
    model = null;
    lockRuntime = false;
  }
  // Several teams: say which team each warning is about.
  if (teamName) for (let i = startLen; i < warnings.length; i++) warnings[i] = `${teamName}: ${warnings[i]}`;
  return checkTemplateTeamAi(ctx, { runtime, model, lockRuntime, requireScope });
}

/**
 * v0.4: applying a template creates a team: slug = the template's team slug, else the template id
 * for built-ins, else a slug of the name (made unique); name = the team name or the template name
 * (" 2" on a clash); lead = the template's top agent; members = every created agent. Call inside
 * repos.tx(). Returns undefined when this build has no teams.
 */
function createTemplateTeam(ctx: AppContext, template: TeamTemplate, agents: Agent[], ai: TeamAi, leadAgent?: Agent): Team | undefined {
  const repo = ctx.repos.teams;
  if (!repo || agents.length === 0) return undefined;
  const wanted = template.team?.slug ?? (template.builtin ? template.id : slugifyTeam(template.team?.name ?? template.name));
  const createdIds = new Set(agents.map((a) => a.id));
  const lead = leadAgent ?? agents.find((a) => a.reportsTo === null || !createdIds.has(a.reportsTo)) ?? agents[0]!;
  const team = repo.create({
    slug: uniqueTeamSlug(repo, wanted),
    name: uniqueTeamName(repo, (template.team?.name ?? template.name).trim().slice(0, 80)),
    description: template.description.slice(0, 2000),
    color: template.team?.color?.toUpperCase() ?? nextTeamColor(repo),
    leadAgentId: lead.id,
    routingHints: (template.team?.routingHints ?? '').trim(),
    ...ai,
  });
  for (const a of agents) ctx.repos.agents.update(a.id, { teamId: team.id });
  return repo.get(team.id)!;
}

function rollbackSkills(ctx: AppContext, slugs: string[]): void {
  for (const slug of slugs) {
    try { ctx.skills?.remove(slug); } catch { /* best effort */ }
  }
}

export function exportTemplate(ctx: AppContext, agentIds: Id[]): TeamTemplate {
  const all = ctx.repos.agents.list();
  for (const id of agentIds) if (!all.some((a) => a.id === id)) throw notFound('Agent', id);
  const team = teamBelow(all, agentIds);
  if (team.length === 0) throw badRequest('There are no agents to export', 'empty_team');
  try {
    const out = exportTeam(team, ctx.skills);
    // v0.4: when every exported agent is in the same team, the file carries that team.
    const teamIds = new Set(team.map((a) => a.teamId ?? null));
    const only = teamIds.size === 1 ? [...teamIds][0] : null;
    const t = only ? ctx.repos.teams?.get(only) : undefined;
    if (!t && ctx.repos.teams) {
      // v0.9: agents from several teams → the file carries every team, so an import rebuilds them.
      const keyOf = new Map(team.map((a, i) => [a.id, out.agents[i]!.key]));
      const teams: TemplateTeamWithMembers[] = [];
      for (const id of [...teamIds].filter((x): x is Id => !!x)) {
        const tm = ctx.repos.teams.get(id);
        if (!tm) continue;
        const memberKeys = team.filter((a) => a.teamId === id).map((a) => keyOf.get(a.id)!);
        teams.push({
          name: tm.name, slug: tm.slug, color: tm.color, routingHints: tm.routingHints, memberKeys,
          leadKey: tm.leadAgentId ? keyOf.get(tm.leadAgentId) ?? null : null,
          ...(tm.runtime ? { runtime: tm.runtime, model: tm.model ?? null, lockRuntime: !!tm.lockRuntime } : {}),
          ...(tm.requireScope ? { requireScope: true } : {}),
        });
      }
      if (teams.length) return { ...out, teams };
    }
    if (t) {
      return {
        ...out, name: t.name,
        team: {
          name: t.name, slug: t.slug, color: t.color, routingHints: t.routingHints,
          // v0.4 F/G: the team's AI and policies travel with the file.
          ...(t.runtime ? { runtime: t.runtime, model: t.model ?? null, lockRuntime: !!t.lockRuntime } : {}),
          ...(t.requireScope ? { requireScope: true } : {}),
        },
      };
    }
    return out;
  } catch (err) {
    if (err instanceof ExportTooBigError) throw badRequest(err.message, 'too_big');
    throw err;
  }
}
