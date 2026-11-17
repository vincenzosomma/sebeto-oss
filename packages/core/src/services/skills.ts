/** Skills API (docs/17 Agents & Skills.md): the library on disk + assignment to agents. */
import type { Agent, Id, Skill, SkillBody } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { SkillError } from '../skills/store.js';
import { badRequest, conflict, notFound, unavailable } from './errors.js';

function store(ctx: AppContext) {
  if (!ctx.skills) throw unavailable('Skills are not available in this build');
  return ctx.skills;
}

function mapErr(err: unknown, slug?: string): never {
  if (err instanceof SkillError) {
    if (err.code === 'not_found') throw notFound('Skill', slug ?? '');
    if (err.code === 'exists') throw conflict(err.message, 'skill_exists');
    throw badRequest(err.message, 'skill_invalid');
  }
  throw err;
}

const changed = (ctx: AppContext) => ctx.bus.publish({ type: 'skills.changed' });

export function listSkills(ctx: AppContext): Skill[] {
  return ctx.skills?.list() ?? [];
}

export function createSkill(ctx: AppContext, body: SkillBody): Skill {
  try {
    const s = store(ctx).create(body);
    changed(ctx);
    return s;
  } catch (err) { return mapErr(err); }
}

export function updateSkill(ctx: AppContext, slug: string, body: SkillBody): Skill {
  try {
    const s = store(ctx).update(slug, body);
    changed(ctx);
    return s;
  } catch (err) { return mapErr(err, slug); }
}

export function deleteSkill(ctx: AppContext, slug: string): void {
  try {
    store(ctx).remove(slug);
  } catch (err) { mapErr(err, slug); }
  const affected = ctx.repos.agents.list().filter((a) => a.skills.includes(slug));
  ctx.repos.agents.removeSkillEverywhere(slug);
  for (const a of affected) {
    const agent = ctx.repos.agents.get(a.id);
    if (agent) ctx.bus.publish({ type: 'agent.updated', agent });
  }
  changed(ctx);
}

export function assignSkills(ctx: AppContext, agentId: Id, slugs: string[]): Agent {
  if (!ctx.repos.agents.get(agentId)) throw notFound('Agent', agentId);
  const lib = store(ctx);
  for (const slug of slugs) if (!lib.get(slug)) throw badRequest(`Skill "${slug}" does not exist`, 'unknown_skill');
  const agent = ctx.repos.agents.setSkills(agentId, slugs);
  ctx.bus.publish({ type: 'agent.updated', agent });
  changed(ctx);
  return agent;
}
