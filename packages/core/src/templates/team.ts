/**
 * Applying a team template to the workspace, and exporting the current team as one.
 * Pure-ish helpers over Repos + SkillStore + RuntimeRegistry; the service layer adds HTTP errors and events.
 */
import {
  DEFAULT_PERMISSIONS, PERMISSION_KEYS, TEMPLATE_FORMAT,
  type Agent, type Id, type PermissionKey, type PermissionLevel, type RuntimeId, type TeamTemplate, type TemplateAgent, type TemplateSkill,
} from '@sebeto/shared';
import type { Repos, RuntimeRegistry } from '../contracts.js';
import { pickDefaultAgent } from '../default-agent.js';
import type { SkillStore } from '../skills/store.js';
import { slugify } from '../skills/store.js';
import { MAX_TEMPLATE_AGENTS, MAX_TEMPLATE_SKILLS } from './schema.js';

const STRICTNESS: Record<PermissionLevel, number> = { allow: 0, ask: 1, never: 2 };

/**
 * A template can only make an agent stricter than the defaults: a team file from someone else can
 * never give an agent "allow" for email, scripts or the web. The owner loosens permissions on the
 * agent page if they want to. (ALWAYS_ASK is applied again by the agent repo.)
 */
export function safePermissions(input: TemplateAgent['permissions']): Partial<Record<PermissionKey, PermissionLevel>> {
  const out: Partial<Record<PermissionKey, PermissionLevel>> = {};
  for (const key of PERMISSION_KEYS) {
    const wanted = input?.[key];
    if (!wanted) continue;
    const def = DEFAULT_PERMISSIONS[key];
    out[key] = STRICTNESS[wanted] >= STRICTNESS[def] ? wanted : def;
  }
  return out;
}

/** Agents ordered so that every manager comes before its reports (template order kept otherwise). */
export function topoOrder(agents: TemplateAgent[]): TemplateAgent[] {
  const byKey = new Map(agents.map((a) => [a.key, a]));
  const out: TemplateAgent[] = [];
  const done = new Set<string>();
  const visit = (a: TemplateAgent, depth: number) => {
    if (done.has(a.key) || depth > agents.length) return;
    const manager = a.reportsTo ? byKey.get(a.reportsTo) : undefined;
    if (manager) visit(manager, depth + 1);
    if (!done.has(a.key)) {
      done.add(a.key);
      out.push(a);
    }
  };
  for (const a of agents) visit(a, 0);
  return out;
}

/** "Comms Writer" → "Comms Writer 2" when taken (case-insensitive), then 3… */
export function uniqueName(name: string, taken: Set<string>): string {
  const base = name.trim();
  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

export interface RuntimeChoice {
  runtime: RuntimeId;
  /** Models the runtime offers (empty when unknown). */
  models: string[];
}

/**
 * The runtime picker for applied agents, mirroring seedDefaults / pickDefaultAgent: the template's
 * runtime when it is enabled here, else the workspace default: the default agent's real runtime,
 * else an installed real runtime (Claude Code first), else the test agent.
 */
export function createRuntimeChooser(runtimes: RuntimeRegistry, agents: Agent[]) {
  const detected = new Map<string, Promise<boolean>>();
  const models = new Map<string, Promise<string[]>>();
  const installed = (id: string) => {
    if (!detected.has(id)) {
      const a = runtimes.get(id);
      detected.set(id, a ? a.detect().then((d) => d.installed, () => false) : Promise.resolve(false));
    }
    return detected.get(id)!;
  };
  const modelsOf = (id: string) => {
    if (!models.has(id)) {
      const a = runtimes.get(id);
      models.set(id, a ? installed(id).then((ok) => (ok ? a.models().catch(() => [] as string[]) : [])) : Promise.resolve([]));
    }
    return models.get(id)!;
  };
  let fallback: Promise<RuntimeId> | undefined;
  const workspaceDefault = (): Promise<RuntimeId> => {
    fallback ??= (async () => {
      const current = pickDefaultAgent(agents);
      if (current && current.runtime !== 'mock' && runtimes.get(current.runtime)) return current.runtime;
      const real = runtimes.list().filter((a) => a.id !== 'mock').sort((a, b) => Number(b.id === 'claude-cli') - Number(a.id === 'claude-cli'));
      for (const a of real) if (await installed(a.id)) return a.id;
      if (runtimes.get('mock')) return 'mock';
      return runtimes.list()[0]?.id ?? 'mock';
    })();
    return fallback;
  };
  return async (wanted: RuntimeId | null | undefined): Promise<RuntimeChoice> => {
    const runtime = wanted && runtimes.get(wanted) ? wanted : await workspaceDefault();
    return { runtime, models: await modelsOf(runtime) };
  };
}

export interface ApplyPlanItem {
  template: TemplateAgent;
  runtime: RuntimeId;
  model: string | null;
}

/** Create the agents (managers first) and assign their skills. Call inside repos.tx(). */
export function createTeamAgents(repos: Repos, plan: ApplyPlanItem[], topReportsTo: Id | null): Map<string, Agent> {
  const taken = new Set(repos.agents.list().map((a) => a.name.trim().toLowerCase()));
  const byKey = new Map(plan.map((p) => [p.template.key, p]));
  const created = new Map<string, Agent>();
  for (const t of topoOrder(plan.map((p) => p.template))) {
    const item = byKey.get(t.key)!;
    const manager = t.reportsTo ? created.get(t.reportsTo)?.id ?? null : topReportsTo;
    let agent = repos.agents.create({
      name: uniqueName(t.name, taken),
      role: t.role,
      job: t.job,
      runtime: item.runtime,
      model: item.model,
      reportsTo: manager,
      heartbeatMinutes: t.heartbeatMinutes,
      monthlyBudgetUsd: t.monthlyBudgetUsd,
      permissions: safePermissions(t.permissions),
    });
    if (t.skills.length) agent = repos.agents.setSkills(agent.id, [...new Set(t.skills)]);
    created.set(t.key, agent);
  }
  return created;
}

/** The listed agents and everyone below them (all agents when `ids` is empty). */
export function teamBelow(agents: Agent[], ids: Id[]): Agent[] {
  if (ids.length === 0) return agents;
  const reports = new Map<Id, Agent[]>();
  for (const a of agents) if (a.reportsTo) reports.set(a.reportsTo, [...(reports.get(a.reportsTo) ?? []), a]);
  const keep = new Set<Id>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    keep.add(id);
    for (const r of reports.get(id) ?? []) stack.push(r.id);
  }
  return agents.filter((a) => keep.has(a.id));
}

export class ExportTooBigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportTooBigError';
  }
}

/**
 * Export agents as a template: ids become keys made from the names, managers outside the set
 * become null (top of the team), skills carry their full instructions. Never includes secrets,
 * connector settings, connector access or ticket data: only what is listed below.
 */
export function exportTeam(agents: Agent[], skills: SkillStore | undefined, opts: { name?: string; now?: Date } = {}): TeamTemplate {
  if (agents.length > MAX_TEMPLATE_AGENTS) throw new ExportTooBigError(`A team file holds at most ${MAX_TEMPLATE_AGENTS} agents; pick the agents to export`);
  const keyOf = new Map<Id, string>();
  const usedKeys = new Set<string>();
  for (const a of agents) {
    const slug = slugify(a.name).slice(0, 36);
    const base = slug === 'skill' && !/skill/i.test(a.name) ? 'agent' : slug; // slugify's fallback for names without letters
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base}-${n}`;
    usedKeys.add(key);
    keyOf.set(a.id, key);
  }
  const usedSkills: TemplateSkill[] = [];
  const known = new Set<string>();
  const agentSkills = (a: Agent) => a.skills.filter((slug) => {
    if (known.has(slug)) return true;
    const s = skills?.get(slug);
    if (!s) return false; // assigned but missing from the library: left out
    known.add(slug);
    usedSkills.push({ slug: s.slug, name: s.name, description: s.description, instructions: s.instructions, needs: [...s.needs], connectors: [...s.connectors] });
    return true;
  });
  const out: TemplateAgent[] = agents.map((a) => {
    const permissions: Partial<Record<PermissionKey, PermissionLevel>> = {};
    for (const k of PERMISSION_KEYS) if (a.permissions[k] !== DEFAULT_PERMISSIONS[k]) permissions[k] = a.permissions[k];
    return {
      key: keyOf.get(a.id)!,
      name: a.name,
      role: a.role,
      job: a.job,
      reportsTo: a.reportsTo ? keyOf.get(a.reportsTo) ?? null : null,
      runtime: a.runtime,
      model: a.model,
      heartbeatMinutes: a.heartbeatMinutes,
      monthlyBudgetUsd: a.monthlyBudgetUsd,
      ...(Object.keys(permissions).length ? { permissions } : {}),
      skills: agentSkills(a),
    };
  });
  if (usedSkills.length > MAX_TEMPLATE_SKILLS) throw new ExportTooBigError(`A team file holds at most ${MAX_TEMPLATE_SKILLS} skills; pick fewer agents`);
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const connectors = [...new Set(usedSkills.flatMap((s) => s.connectors ?? []).filter((c) => /^[a-z0-9-]{1,40}$/.test(c)))];
  return {
    format: TEMPLATE_FORMAT,
    id: `team-${date}`,
    name: opts.name ?? 'My team',
    description: `Exported from Sebeto on ${date}: ${agents.length} agent${agents.length === 1 ? '' : 's'}, ${usedSkills.length} skill${usedSkills.length === 1 ? '' : 's'}.`,
    builtin: false,
    agents: out,
    skills: usedSkills,
    ...(connectors.length ? { suggestedConnectors: connectors.slice(0, 20) } : {}),
  };
}
