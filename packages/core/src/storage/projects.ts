/** Projects (v0.3): groups of tickets with a shared brief for agents. */
import type Database from 'better-sqlite3';
import { nowIso, uuidv7, type Id, type Project, type ProjectSummary, type TagCount, type TicketStatus } from '@sebeto/shared';
import type { ProjectRepo } from '../contracts.js';

interface ProjectRow {
  id: string; name: string; description: string; color: string; archived: number; created_at: string; updated_at: string;
}
const toProject = (r: ProjectRow): Project => ({
  id: r.id, name: r.name, description: r.description, color: r.color, archived: r.archived === 1, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function createProjectRepo(db: Database.Database): ProjectRepo {
  const stmts = {
    get: db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?'),
    byName: db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE name = ? COLLATE NOCASE'),
    list: db.prepare<[], ProjectRow>('SELECT * FROM projects ORDER BY archived, name COLLATE NOCASE'),
    counts: db.prepare<[], { project_id: string; status: TicketStatus; n: number; cost: number }>(
      'SELECT project_id, status, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS cost FROM tickets WHERE project_id IS NOT NULL AND deleted_at IS NULL GROUP BY project_id, status'),
    insert: db.prepare('INSERT INTO projects (id, name, description, color, archived, created_at, updated_at) VALUES (@id, @name, @description, @color, 0, @now, @now)'),
    update: db.prepare('UPDATE projects SET name = @name, description = @description, color = @color, archived = @archived, updated_at = @now WHERE id = @id'),
    remove: db.prepare('DELETE FROM projects WHERE id = ?'),
    tags: db.prepare<[], { tag: string; n: number }>('SELECT tag, COUNT(*) AS n FROM ticket_tags GROUP BY tag ORDER BY n DESC, tag LIMIT 500'),
  };
  const get = (id: Id) => {
    const r = stmts.get.get(id);
    return r ? toProject(r) : undefined;
  };
  return {
    get,
    findByName: (name) => {
      const r = stmts.byName.get(name.trim());
      return r ? toProject(r) : undefined;
    },
    list(): ProjectSummary[] {
      const byProject = new Map<string, { counts: Partial<Record<TicketStatus, number>>; costUsd: number }>();
      for (const c of stmts.counts.all()) {
        const e = byProject.get(c.project_id) ?? { counts: {}, costUsd: 0 };
        e.counts[c.status] = c.n;
        e.costUsd += c.cost;
        byProject.set(c.project_id, e);
      }
      return stmts.list.all().map((r) => ({ ...toProject(r), ...(byProject.get(r.id) ?? { counts: {}, costUsd: 0 }) }));
    },
    create(input) {
      const id = uuidv7();
      stmts.insert.run({ id, name: input.name, description: input.description, color: input.color, now: nowIso() });
      return get(id)!;
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) throw new Error(`Project not found: ${id}`);
      const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Project;
      stmts.update.run({ id, name: next.name, description: next.description, color: next.color, archived: next.archived ? 1 : 0, now: nowIso() });
      return get(id)!;
    },
    remove: (id) => stmts.remove.run(id).changes > 0,
    tags: (): TagCount[] => stmts.tags.all().map((r) => ({ tag: r.tag, count: r.n })),
  };
}
