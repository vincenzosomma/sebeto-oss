/** Teams (v0.4, packages/shared/src/teams.ts). Members are the agents whose team_id points here. */
import type Database from 'better-sqlite3';
import { nowIso, uuidv7, type Id, type Team } from '@sebeto/shared';
import type { TeamRepo } from '../contracts.js';

interface TeamRow {
  id: string; slug: string; name: string; description: string; color: string; lead_agent_id: string | null;
  routing_hints: string; created_at: string; updated_at: string;
  runtime?: string | null; model?: string | null; lock_runtime?: number; require_scope?: number; claude_connectors?: string | null;
}

function parseConnectors(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}
const connectorsJson = (v: string[] | undefined) => (v && v.length ? JSON.stringify([...new Set(v.map((x) => x.trim()).filter(Boolean))].slice(0, 30)) : null);

const toTeam = (r: TeamRow, memberIds: Id[]): Team => ({
  id: r.id, slug: r.slug, name: r.name, description: r.description, color: r.color, leadAgentId: r.lead_agent_id,
  routingHints: r.routing_hints, memberIds, createdAt: r.created_at, updatedAt: r.updated_at,
  runtime: r.runtime ?? null, model: r.model ?? null, lockRuntime: r.lock_runtime === 1, requireScope: r.require_scope === 1,
  claudeConnectors: parseConnectors(r.claude_connectors),
});

export function createTeamRepo(db: Database.Database): TeamRepo {
  const stmts = {
    get: db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE id = ?'),
    bySlug: db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE slug = ?'),
    byName: db.prepare<[string], TeamRow>('SELECT * FROM teams WHERE name = ? COLLATE NOCASE'),
    list: db.prepare<[], TeamRow>('SELECT * FROM teams ORDER BY name COLLATE NOCASE'),
    members: db.prepare<[string], { id: string }>('SELECT id FROM agents WHERE team_id = ? ORDER BY created_at, id'),
    allMembers: db.prepare<[], { id: string; team_id: string }>('SELECT id, team_id FROM agents WHERE team_id IS NOT NULL ORDER BY created_at, id'),
    insert: db.prepare(`INSERT INTO teams (id, slug, name, description, color, lead_agent_id, routing_hints, runtime, model, lock_runtime, require_scope, claude_connectors, created_at, updated_at)
      VALUES (@id, @slug, @name, @description, @color, @leadAgentId, @routingHints, @runtime, @model, @lockRuntime, @requireScope, @claudeConnectors, @now, @now)`),
    update: db.prepare(`UPDATE teams SET name = @name, description = @description, color = @color, lead_agent_id = @leadAgentId,
      routing_hints = @routingHints, runtime = @runtime, model = @model, lock_runtime = @lockRuntime, require_scope = @requireScope,
      claude_connectors = @claudeConnectors, updated_at = @now WHERE id = @id`),
    remove: db.prepare('DELETE FROM teams WHERE id = ?'),
    projectCounts: db.prepare<[string], { team_id: string; n: number }>(
      'SELECT team_id, COUNT(*) AS n FROM tickets WHERE project_id = ? AND team_id IS NOT NULL AND deleted_at IS NULL GROUP BY team_id ORDER BY n DESC'),
  };
  const one = (r: TeamRow | undefined) => (r ? toTeam(r, stmts.members.all(r.id).map((m) => m.id)) : undefined);
  const get = (id: Id) => one(stmts.get.get(id));
  return {
    get,
    bySlug: (slug) => one(stmts.bySlug.get(slug)),
    findByName: (name) => one(stmts.byName.get(name.trim())),
    list() {
      const byTeam = new Map<Id, Id[]>();
      for (const m of stmts.allMembers.all()) byTeam.set(m.team_id, [...(byTeam.get(m.team_id) ?? []), m.id]);
      return stmts.list.all().map((r) => toTeam(r, byTeam.get(r.id) ?? []));
    },
    create(input) {
      const id = uuidv7();
      stmts.insert.run({
        id, slug: input.slug, name: input.name, description: input.description, color: input.color, leadAgentId: input.leadAgentId,
        routingHints: input.routingHints, runtime: input.runtime ?? null, model: input.model ?? null,
        lockRuntime: input.lockRuntime ? 1 : 0, requireScope: input.requireScope ? 1 : 0, claudeConnectors: connectorsJson(input.claudeConnectors), now: nowIso(),
      });
      return get(id)!;
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) throw new Error(`Team not found: ${id}`);
      const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Team;
      stmts.update.run({
        id, name: next.name, description: next.description, color: next.color, leadAgentId: next.leadAgentId, routingHints: next.routingHints,
        runtime: next.runtime ?? null, model: next.model ?? null, lockRuntime: next.lockRuntime ? 1 : 0, requireScope: next.requireScope ? 1 : 0, claudeConnectors: connectorsJson(next.claudeConnectors), now: nowIso(),
      });
      return get(id)!;
    },
    remove: (id) => stmts.remove.run(id).changes > 0,
    projectTeamCounts: (projectId) => stmts.projectCounts.all(projectId).map((r) => ({ teamId: r.team_id, count: r.n })),
  };
}
