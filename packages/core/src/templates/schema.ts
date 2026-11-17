/**
 * Validation of team templates (packages/shared/src/templates.ts). Used by the API (request bodies)
 * and by the template store (files on disk), so a broken or hostile file never reaches the database.
 * Strict: unknown keys are rejected; sizes are capped; reporting lines must form a tree.
 */
import { z } from 'zod';
import { PERMISSION_KEYS, TEMPLATE_FORMAT, type PermissionKey, type TeamTemplate } from '@sebeto/shared';

export const MAX_TEMPLATE_AGENTS = 30;
export const MAX_TEMPLATE_SKILLS = 50;
export const MAX_SKILL_INSTRUCTIONS = 20_000;

const permKeyEnum = z.enum(PERMISSION_KEYS as unknown as [PermissionKey, ...PermissionKey[]]);
const level = z.enum(['allow', 'ask', 'never']);
export const SKILL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const slug = z.string().regex(SKILL_SLUG_RE, 'Use lowercase letters, digits and dashes');
const agentKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/, 'Use letters, digits, dots, dashes or underscores');

export const templateAgentSchema = z.object({
  key: agentKey,
  name: z.string().trim().min(1).max(100),
  role: z.string().max(200),
  job: z.string().max(20_000),
  reportsTo: agentKey.nullable(),
  runtime: z.string().min(1).max(64).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  heartbeatMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
  monthlyBudgetUsd: z.number().finite().min(0).max(1_000_000).optional(),
  permissions: z.partialRecord(permKeyEnum, level).optional(),
  skills: z.array(slug).max(MAX_TEMPLATE_SKILLS),
}).strict();

export const templateSkillSchema = z.object({
  slug,
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500),
  instructions: z.string().trim().min(1).max(MAX_SKILL_INSTRUCTIONS),
  needs: z.array(permKeyEnum).max(20).optional(),
  connectors: z.array(z.string().max(60)).max(20).optional(),
}).strict();

/** Problems a schema cannot express: duplicate keys/slugs, unknown managers, reporting loops. */
export function templateProblems(t: Pick<TeamTemplate, 'agents' | 'skills'>): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const a of t.agents) {
    if (keys.has(a.key)) problems.push(`Two agents use the key "${a.key}"`);
    keys.add(a.key);
  }
  const slugs = new Set<string>();
  for (const s of t.skills) {
    if (slugs.has(s.slug)) problems.push(`Two skills use the id "${s.slug}"`);
    slugs.add(s.slug);
  }
  const managerOf = new Map(t.agents.map((a) => [a.key, a.reportsTo] as const));
  for (const a of t.agents) {
    if (a.reportsTo !== null && !keys.has(a.reportsTo)) problems.push(`"${a.key}" reports to "${a.reportsTo}", which is not in the team`);
  }
  for (const a of t.agents) {
    const seen = new Set<string>([a.key]);
    let cur = a.reportsTo;
    while (cur !== null && cur !== undefined && keys.has(cur)) {
      if (seen.has(cur)) {
        problems.push(`The reporting lines of "${a.key}" go round in a circle`);
        break;
      }
      seen.add(cur);
      cur = managerOf.get(cur) ?? null;
    }
  }
  return [...new Set(problems)];
}

const templateTeamFields = {
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lowercase letters, digits and dashes').optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must look like #0E5A8A').optional(),
  routingHints: z.string().max(2000).optional(),
  runtime: z.string().min(1).max(64).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  lockRuntime: z.boolean().optional(),
  requireScope: z.boolean().optional(),
};

/** Problems with the teams of a multi-team file (unknown or shared members, lead outside the team). */
export function teamsProblems(t: Pick<TeamTemplate, 'agents' | 'teams'>): string[] {
  const problems: string[] = [];
  const keys = new Set(t.agents.map((a) => a.key));
  const owner = new Map<string, string>();
  const names = new Set<string>();
  for (const team of t.teams ?? []) {
    const n = team.name.trim().toLowerCase();
    if (names.has(n)) problems.push(`Two teams are called "${team.name}"`);
    names.add(n);
    for (const k of team.memberKeys) {
      if (!keys.has(k)) problems.push(`Team "${team.name}" lists "${k}", which is not an agent in the file`);
      const other = owner.get(k);
      if (other && other !== team.name) problems.push(`"${k}" is in two teams ("${other}" and "${team.name}")`);
      owner.set(k, team.name);
    }
    if (team.leadKey && !team.memberKeys.includes(team.leadKey)) problems.push(`The lead of "${team.name}" is not one of its members`);
  }
  return [...new Set(problems)];
}

export const teamTemplateSchema = z.object({
  format: z.literal(TEMPLATE_FORMAT),
  id: z.string().max(100),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000),
  builtin: z.boolean(),
  agents: z.array(templateAgentSchema).min(1).max(MAX_TEMPLATE_AGENTS),
  skills: z.array(templateSkillSchema).max(MAX_TEMPLATE_SKILLS),
  suggestedConnectors: z.array(z.string().max(60)).max(20).optional(),
  // v0.4: the team created when the template is applied.
  team: z.object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Use lowercase letters, digits and dashes').optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must look like #0E5A8A').optional(),
    routingHints: z.string().max(2000).optional(),
    // v0.4 F/G: the team's AI and policies.
    runtime: z.string().min(1).max(64).nullable().optional(),
    model: z.string().max(200).nullable().optional(),
    lockRuntime: z.boolean().optional(),
    requireScope: z.boolean().optional(),
  }).strict().optional(),
  // v0.9: several teams (a whole workspace export).
  teams: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    ...templateTeamFields,
    memberKeys: z.array(z.string().max(80)).max(MAX_TEMPLATE_AGENTS),
    leadKey: z.string().max(80).nullable().optional(),
  }).strict()).max(50).optional(),
}).strict().superRefine((t, ctx) => {
  for (const message of templateProblems(t)) ctx.addIssue({ code: 'custom', message, path: ['agents'] });
  for (const message of teamsProblems(t as TeamTemplate)) ctx.addIssue({ code: 'custom', message, path: ['teams'] });
});

/** Parse unknown data as a template; throws a ZodError (→ 400 in the API). */
export function parseTemplate(data: unknown): TeamTemplate {
  return teamTemplateSchema.parse(data) as TeamTemplate;
}
