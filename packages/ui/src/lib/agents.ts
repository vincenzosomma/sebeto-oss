/**
 * Pure helpers for the "Agents & skills" page (docs/17 Agents & Skills.md).
 * No React here, so they are easy to test.
 */
import {
  ALWAYS_ASK, PERMISSION_KEYS,
  type Agent, type ConnectorInfo, type Id, type PermissionKey, type PermissionLevel, type Skill, type Ticket,
} from '@sebeto/shared';
import type { MessageKey } from '../i18n/catalog';

export interface TreeRow {
  agent: Agent;
  /** 0 = reports directly to you. */
  depth: number;
  /** Number of agents that report directly to this one. */
  directReports: number;
}

const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);

/**
 * Flattens the org chart into rows in display order (depth-first, siblings by name).
 * Agents whose manager is unknown (or who sit in a cycle) are shown at the top level, so nobody disappears.
 */
export function buildTree(agents: Agent[]): TreeRow[] {
  const ids = new Set(agents.map((a) => a.id));
  const children = new Map<Id | null, Agent[]>();
  for (const a of agents) {
    const parent = a.reportsTo && ids.has(a.reportsTo) && a.reportsTo !== a.id ? a.reportsTo : null;
    const list = children.get(parent) ?? [];
    list.push(a);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(byName);

  const rows: TreeRow[] = [];
  const seen = new Set<Id>();
  const walk = (parent: Id | null, depth: number) => {
    for (const a of children.get(parent) ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      rows.push({ agent: a, depth, directReports: (children.get(a.id) ?? []).length });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  // Agents caught in a reporting cycle are unreachable from the top: list them at the top level.
  for (const a of [...agents].sort(byName)) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    rows.push({ agent: a, depth: 0, directReports: (children.get(a.id) ?? []).length });
    walk(a.id, 1);
  }
  return rows;
}

/** Ids of every agent below `id` in the org chart (not including `id`). */
export function descendantIds(agents: Agent[], id: Id): Set<Id> {
  const out = new Set<Id>();
  const queue: Id[] = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const a of agents) {
      if (a.reportsTo === cur && a.id !== id && !out.has(a.id)) {
        out.add(a.id);
        queue.push(a.id);
      }
    }
  }
  return out;
}

/** Who `id` may report to: everyone except itself and the agents below it (that would make a loop). */
export function reportsToOptions(agents: Agent[], id: Id | null): Agent[] {
  if (!id) return [...agents].sort(byName);
  const below = descendantIds(agents, id);
  return agents.filter((a) => a.id !== id && !below.has(a.id)).sort(byName);
}

/** Union of the permissions the given skills need, in the standard key order. */
export function skillNeeds(skills: Skill[], slugs: string[]): PermissionKey[] {
  const wanted = new Set(slugs);
  const needs = new Set<PermissionKey>();
  for (const s of skills) if (wanted.has(s.slug)) for (const k of s.needs) needs.add(k);
  return PERMISSION_KEYS.filter((k) => needs.has(k));
}

export interface NeedStatus {
  key: PermissionKey;
  level: PermissionLevel;
  /** True when the agent is set to Never for something its skills need. */
  blocked: boolean;
}

/** For each permission the agent's skills need: the agent's own level, and whether it blocks the skill. */
export function needStatuses(skills: Skill[], agent: Pick<Agent, 'skills' | 'permissions'>): NeedStatus[] {
  return skillNeeds(skills, agent.skills).map((key) => {
    const level = agent.permissions[key] ?? 'ask';
    return { key, level, blocked: level === 'never' };
  });
}

/** The levels a permission may be set to (production changes can never be Allow). */
export function allowedLevels(key: PermissionKey): PermissionLevel[] {
  return ALWAYS_ASK.includes(key) ? ['ask', 'never'] : ['allow', 'ask', 'never'];
}

/**
 * New allowedAgents after ticking/unticking one agent on a connector. null = every agent (also future
 * ones): unticking from "everyone" lists all the others; ticking the last missing agent goes back to
 * "everyone". Exported for tests.
 */
export function toggleConnectorAccess(allowed: Id[] | null, agentId: Id, allAgentIds: Id[], on: boolean): Id[] | null {
  const current = allowed ?? allAgentIds;
  const next = on ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId);
  return allAgentIds.every((id) => next.includes(id)) ? null : next;
}

/** Connectors this agent may use (allowedAgents null = every agent). Disabled ones are left out. */
export function connectorsForAgent(connectors: ConnectorInfo[], agentId: Id): ConnectorInfo[] {
  return connectors.filter((c) => c.enabled && (c.allowedAgents === null || c.allowedAgents.includes(agentId)));
}

/**
 * Connectors the agent's skills expect but the agent cannot use. A skill names a connector by catalog id
 * or by name (case-insensitive); "gmail" is the built-in mailbox.
 */
export function missingConnectors(skills: Skill[], slugs: string[], usable: ConnectorInfo[], mailConnected: boolean): string[] {
  const have = new Set<string>();
  for (const c of usable) { have.add(c.catalogId.toLowerCase()); have.add(c.name.toLowerCase()); }
  if (mailConnected) have.add('gmail');
  const wanted = new Set(slugs);
  const out: string[] = [];
  for (const s of skills) {
    if (!wanted.has(s.slug)) continue;
    for (const c of s.connectors) {
      if (!have.has(c.toLowerCase()) && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
    }
  }
  return out;
}

/** Case-insensitive search on name, description and slug. */
export function filterSkills(skills: Skill[], query: string): Skill[] {
  const q = query.trim().toLowerCase();
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  if (!q) return sorted;
  return sorted.filter((s) => `${s.name} ${s.description} ${s.slug}`.toLowerCase().includes(q));
}

/** "gmail, Runbooks share" → ['gmail', 'Runbooks share'] (trimmed, no empties, no duplicates). */
export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(',')) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Picks the singular message for 1 and the plural one otherwise; both get {count}. */
export function plural(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  count: number, one: MessageKey, other: MessageKey, vars: Record<string, string | number> = {},
): string {
  return t(count === 1 ? one : other, { ...vars, count });
}

/** The folder name for a skill: lowercase a-z0-9 and dashes (what the core derives from the name). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ---------- Org chart editor (v0.3): drag and drop, chart layout, delete agent

/** Whether `id` may be moved under `managerId` (null = top level, reports to you). */
export type MoveCheck = { ok: true } | { ok: false; reason: 'self' | 'same' | 'loop' | 'unknown' };

export function checkMove(agents: Agent[], id: Id, managerId: Id | null): MoveCheck {
  const agent = agents.find((a) => a.id === id);
  if (!agent) return { ok: false, reason: 'unknown' };
  if (managerId === id) return { ok: false, reason: 'self' };
  if ((agent.reportsTo ?? null) === managerId) return { ok: false, reason: 'same' };
  if (managerId === null) return { ok: true };
  if (!agents.some((a) => a.id === managerId)) return { ok: false, reason: 'unknown' };
  // Moving an agent under one of its own reports would close a loop.
  if (descendantIds(agents, id).has(managerId)) return { ok: false, reason: 'loop' };
  return { ok: true };
}

/** One box of the org chart and the boxes below it. */
export interface ChartNode {
  agent: Agent;
  children: ChartNode[];
}

/** The org chart as a forest under "You", in the same order and with the same rules as buildTree. */
export function buildChart(agents: Agent[]): ChartNode[] {
  const roots: ChartNode[] = [];
  const path: ChartNode[] = [];
  for (const row of buildTree(agents)) {
    const node: ChartNode = { agent: row.agent, children: [] };
    path.length = row.depth;
    const parent = path[row.depth - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    path.push(node);
  }
  return roots;
}

/**
 * The agent used for "Automatic" (same rule as the core's pickDefaultAgent): the oldest active agent
 * with a real AI runtime; the free test agent only when nothing else exists.
 */
export function pickDefaultAgent(agents: Agent[]): Agent | undefined {
  const byAge = [...agents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return byAge.find((a) => !a.paused && a.runtime !== 'mock')
    ?? byAge.find((a) => a.runtime !== 'mock')
    ?? byAge.find((a) => !a.paused)
    ?? byAge[0];
}

/** What deleting an agent will do (shown in the confirmation before calling DELETE). */
export interface DeletePlan {
  /** Open (not done) tickets of the agent among the tickets the app has loaded. */
  openTickets: number;
  /** Who gets them: the default agent of the remaining team. */
  target: Agent | undefined;
  /** Direct reports that move up. */
  reports: number;
  /** Where they move: the deleted agent's manager, or null for you (top level). */
  manager: Agent | null;
  /** True when this is the only agent (the core refuses). */
  last: boolean;
}

export function deletePlan(agents: Agent[], tickets: Ticket[], id: Id): DeletePlan {
  const agent = agents.find((a) => a.id === id);
  const rest = agents.filter((a) => a.id !== id);
  return {
    openTickets: tickets.filter((tk) => tk.agentId === id && tk.status !== 'done').length,
    target: pickDefaultAgent(rest),
    reports: agents.filter((a) => a.reportsTo === id).length,
    manager: (agent?.reportsTo && rest.find((a) => a.id === agent.reportsTo)) || null,
    last: rest.length === 0,
  };
}
