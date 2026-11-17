import type Database from 'better-sqlite3';
import {
  ALWAYS_ASK, DEFAULT_PERMISSIONS, PERMISSION_KEYS, nowIso, uuidv7,
  type Agent, type Id, type PermissionKey, type PermissionLevel,
} from '@sebeto/shared';
import type { AgentRepo, AgentWorkload, NewAgent } from '../contracts.js';

interface AgentRow {
  id: string;
  name: string;
  role: string;
  job: string;
  runtime: string;
  model: string | null;
  reports_to: string | null;
  heartbeat_minutes: number;
  monthly_budget_usd: number;
  permissions: string;
  paused: number;
  created_at: string;
  team_id?: string | null;
  claude_connectors?: string | null;
}

function parseConnectors(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
const connectorsJson = (v: string[] | undefined) => (v && v.length ? JSON.stringify([...new Set(v.map((x) => x.trim()).filter(Boolean))].slice(0, 30)) : null);

export const AGENT_DEFAULTS = {
  runtime: 'claude-cli',
  heartbeatMinutes: 60,
  monthlyBudgetUsd: 20,
} as const;

const LEVELS: readonly PermissionLevel[] = ['allow', 'ask', 'never'];

/**
 * Complete a (partial) permission map from DEFAULT_PERMISSIONS, drop unknown keys/levels, and
 * clamp ALWAYS_ASK keys: they can never be 'allow' ('never' is stricter and is kept).
 */
export function normalizePermissions(
  input: Partial<Record<PermissionKey, PermissionLevel>> | undefined,
  base: Record<PermissionKey, PermissionLevel> = DEFAULT_PERMISSIONS,
): Record<PermissionKey, PermissionLevel> {
  const out = { ...DEFAULT_PERMISSIONS, ...base };
  for (const key of PERMISSION_KEYS) {
    const level = input?.[key];
    if (level !== undefined && LEVELS.includes(level)) out[key] = level;
  }
  for (const key of ALWAYS_ASK) if (out[key] === 'allow') out[key] = 'ask';
  return out;
}

function toAgent(row: AgentRow): Agent {
  return {
    skills: [], // filled from agent_skills by the repo below (Skills v1)
    id: row.id,
    name: row.name,
    role: row.role,
    job: row.job,
    runtime: row.runtime,
    model: row.model,
    reportsTo: row.reports_to,
    heartbeatMinutes: row.heartbeat_minutes,
    monthlyBudgetUsd: row.monthly_budget_usd,
    permissions: normalizePermissions(JSON.parse(row.permissions) as Partial<Record<PermissionKey, PermissionLevel>>),
    paused: row.paused !== 0,
    createdAt: row.created_at,
    teamId: row.team_id ?? null,
    claudeConnectors: parseConnectors(row.claude_connectors),
  };
}

/** [start, end) ISO bounds of the current UTC calendar month. */
function currentMonthUtc(now = new Date()): [string, string] {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [start.toISOString(), end.toISOString()];
}

export function createAgentRepo(db: Database.Database): AgentRepo {
  const stmts = {
    get: db.prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?'),
    list: db.prepare<[], AgentRow>('SELECT * FROM agents ORDER BY created_at, id'),
    managerOf: db.prepare<[string], { reports_to: string | null }>('SELECT reports_to FROM agents WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO agents (id, name, role, job, runtime, model, reports_to, heartbeat_minutes,
                          monthly_budget_usd, permissions, paused, created_at, team_id, claude_connectors)
      VALUES (@id, @name, @role, @job, @runtime, @model, @reportsTo, @heartbeatMinutes,
              @monthlyBudgetUsd, @permissions, 0, @createdAt, @teamId, @claudeConnectors)`),
    update: db.prepare(`
      UPDATE agents SET name = @name, role = @role, job = @job, runtime = @runtime, model = @model,
        reports_to = @reportsTo, heartbeat_minutes = @heartbeatMinutes, monthly_budget_usd = @monthlyBudgetUsd,
        permissions = @permissions, paused = @paused, team_id = @teamId, claude_connectors = @claudeConnectors
      WHERE id = @id`),
    skillsOf: db.prepare<[string], { skill_slug: string }>('SELECT skill_slug FROM agent_skills WHERE agent_id = ? ORDER BY position, skill_slug'),
    allSkills: db.prepare<[], { agent_id: string; skill_slug: string }>('SELECT agent_id, skill_slug FROM agent_skills ORDER BY agent_id, position, skill_slug'),
    clearSkills: db.prepare('DELETE FROM agent_skills WHERE agent_id = ?'),
    addSkill: db.prepare('INSERT INTO agent_skills (agent_id, skill_slug, position, assigned_at) VALUES (?, ?, ?, ?)'),
    removeSkill: db.prepare('DELETE FROM agent_skills WHERE skill_slug = ?'),
    remove: db.prepare<[string]>('DELETE FROM agents WHERE id = ?'),
    openTickets: db.prepare<[string], { id: string }>("SELECT id FROM tickets WHERE agent_id = ? AND status <> 'done' AND deleted_at IS NULL ORDER BY number"),
    busy: db.prepare<{ id: string }, { busy: number }>(`
      SELECT EXISTS (
        SELECT 1 FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.status = 'running' AND s.agent_id = @id
        UNION ALL
        SELECT 1 FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE r.status = 'running' AND t.agent_id = @id
        UNION ALL
        SELECT 1 FROM jobs j JOIN tickets t ON t.id = json_extract(j.payload, '$.ticketId')
        WHERE j.state = 'running' AND t.agent_id = @id
      ) AS busy`),
    monthSpend: db.prepare<[string, string, string], { total: number }>(`
      SELECT COALESCE(SUM(r.cost_usd), 0) AS total
      FROM runs r JOIN sessions s ON s.id = r.session_id
      WHERE s.agent_id = ? AND r.started_at >= ? AND r.started_at < ?`),
  };

  function get(id: Id): Agent | undefined {
    const row = stmts.get.get(id);
    if (!row) return undefined;
    return { ...toAgent(row), skills: stmts.skillsOf.all(id).map((r) => r.skill_slug) };
  }

  const setSkills = db.transaction((id: Id, slugs: string[]): Agent => {
    if (!stmts.get.get(id)) throw new Error(`Agent not found: ${id}`);
    stmts.clearSkills.run(id);
    const at = nowIso();
    [...new Set(slugs)].forEach((slug, i) => stmts.addSkill.run(id, slug, i, at));
    return get(id)!;
  });

  /** Throws when making `id` report to `managerId` would create a loop in the org chart. */
  function assertNoCycle(id: Id, managerId: Id): void {
    const seen = new Set<Id>();
    let cur: Id | null = managerId;
    while (cur !== null) {
      if (cur === id) throw new Error('reportsTo would create a cycle in the org chart');
      if (seen.has(cur)) break; // pre-existing loop elsewhere; not ours to report
      seen.add(cur);
      const row = stmts.managerOf.get(cur);
      if (!row) throw new Error(`Manager agent not found: ${cur}`);
      cur = row.reports_to;
    }
  }

  const update = db.transaction((id: Id, patch: Partial<Omit<Agent, 'id' | 'createdAt'>>): Agent => {
    const cur = get(id);
    if (!cur) throw new Error(`Agent not found: ${id}`);
    const next: Agent = { ...cur };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && k !== 'id' && k !== 'createdAt') (next as unknown as Record<string, unknown>)[k] = v;
    }
    if (next.reportsTo !== null && next.reportsTo !== cur.reportsTo) assertNoCycle(id, next.reportsTo);
    next.permissions = normalizePermissions(patch.permissions, cur.permissions);
    stmts.update.run({
      id,
      name: next.name,
      role: next.role,
      job: next.job,
      runtime: next.runtime,
      model: next.model,
      reportsTo: next.reportsTo,
      heartbeatMinutes: next.heartbeatMinutes,
      monthlyBudgetUsd: next.monthlyBudgetUsd,
      permissions: JSON.stringify(next.permissions),
      paused: next.paused ? 1 : 0,
      teamId: next.teamId ?? null,
      claudeConnectors: connectorsJson(next.claudeConnectors),
    });
    return get(id)!;
  });

  return {
    create(input: NewAgent): Agent {
      const id = uuidv7();
      if (input.reportsTo && !stmts.get.get(input.reportsTo)) throw new Error(`Manager agent not found: ${input.reportsTo}`);
      stmts.insert.run({
        id,
        name: input.name,
        role: input.role ?? '',
        job: input.job ?? '',
        runtime: input.runtime ?? AGENT_DEFAULTS.runtime,
        model: input.model ?? null,
        reportsTo: input.reportsTo ?? null,
        heartbeatMinutes: input.heartbeatMinutes ?? AGENT_DEFAULTS.heartbeatMinutes,
        monthlyBudgetUsd: input.monthlyBudgetUsd ?? AGENT_DEFAULTS.monthlyBudgetUsd,
        permissions: JSON.stringify(normalizePermissions(input.permissions)),
        createdAt: nowIso(),
        teamId: input.teamId ?? null,
        claudeConnectors: connectorsJson(input.claudeConnectors),
      });
      return get(id)!;
    },
    get,
    list: () => {
      const bySkill = new Map<Id, string[]>();
      for (const r of stmts.allSkills.all()) bySkill.set(r.agent_id, [...(bySkill.get(r.agent_id) ?? []), r.skill_slug]);
      return stmts.list.all().map((row) => ({ ...toAgent(row), skills: bySkill.get(row.id) ?? [] }));
    },
    setSkills: (id, slugs) => setSkills.immediate(id, slugs),
    removeSkillEverywhere: (slug) => stmts.removeSkill.run(slug).changes,
    update: (id, patch) => update.immediate(id, patch),
    delete: (id) => stmts.remove.run(id).changes > 0,
    workload: (id): AgentWorkload => ({
      openTicketIds: stmts.openTickets.all(id).map((r) => r.id),
      busy: stmts.busy.get({ id })!.busy !== 0,
    }),
    monthSpendUsd(id) {
      const [start, end] = currentMonthUtc();
      return stmts.monthSpend.get(id, start, end)!.total;
    },
  };
}
