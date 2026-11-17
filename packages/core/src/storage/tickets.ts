import path from 'node:path';
import type Database from 'better-sqlite3';
import { nowIso, uuidv7, type Id, type Page, type Ticket, type TicketOrigin, type TicketScope, type TicketStatus } from '@sebeto/shared';
import type { NewTicket, TicketQuery, TicketRepo } from '../contracts.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

interface TicketRow {
  id: string;
  number: number;
  title: string;
  goal: string;
  status: TicketStatus;
  agent_id: string | null;
  runtime: string | null;
  model: string | null;
  current_session_id: string | null;
  folder: string;
  cost_cap_usd: number;
  cost_usd: number;
  parent_id: string | null;
  project_id: string | null;
  team_id?: string | null;
  /** v0.4 §D: JSON TicketOrigin or NULL. */
  origin?: string | null;
  /** v0.4 G: JSON TicketScope or NULL. */
  scope?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** A ticket row joined with its latest audit event (see SELECT_TICKET). */
interface TicketWithActivityRow extends TicketRow {
  last_summary: string | null;
  last_at: string | null;
}

/**
 * Ticket columns plus the latest audit event, in one query (no N+1). The correlated subquery
 * walks the audit_events_ticket(ticket_id, id) index backwards and stops at the first row:
 * ids are UUIDv7, so the highest id is the newest event. Every event kind counts, matching what
 * the board shows live from event.created: even 'cost' is the "budget reached" notice, which is
 * exactly what the owner should see on the card.
 */
const SELECT_TICKET = `SELECT t.*, e.summary AS last_summary, e.created_at AS last_at
  FROM tickets t
  LEFT JOIN audit_events e
    ON e.id = (SELECT a.id FROM audit_events a WHERE a.ticket_id = t.id ORDER BY a.id DESC LIMIT 1)`;

/** Default per-ticket cost cap (USD) when none is given. */
export const DEFAULT_TICKET_COST_CAP_USD = 5;

/** Ticket fields that map 1:1 to a column (dependsOn lives in ticket_deps). */
const COLUMN_OF: Partial<Record<keyof Ticket, keyof TicketRow>> = {
  title: 'title',
  goal: 'goal',
  status: 'status',
  agentId: 'agent_id',
  runtime: 'runtime',
  model: 'model',
  currentSessionId: 'current_session_id',
  folder: 'folder',
  costCapUsd: 'cost_cap_usd',
  costUsd: 'cost_usd',
  parentId: 'parent_id',
  projectId: 'project_id',
  teamId: 'team_id',
  origin: 'origin',
  scope: 'scope',
  deletedAt: 'deleted_at',
  updatedAt: 'updated_at',
};

/** scope TEXT (JSON) → TicketScope | null; unreadable JSON counts as "no scope" (fail safe: the ticket cannot start). */
export function parseScope(raw: string | null | undefined): TicketScope | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as TicketScope;
    return s && typeof s === 'object' && typeof s.text === 'string' && s.text.trim() && typeof s.sha256 === 'string'
      ? { text: s.text, fileName: typeof s.fileName === 'string' ? s.fileName : null, sha256: s.sha256, confirmedAt: String(s.confirmedAt ?? '') }
      : null;
  } catch {
    return null;
  }
}

/** origin TEXT (JSON) → TicketOrigin | null; unreadable JSON counts as untrusted (fail safe). */
export function parseOrigin(raw: string | null | undefined): TicketOrigin | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as TicketOrigin;
    return o && typeof o === 'object' && typeof o.kind === 'string' ? { ...o, untrusted: o.untrusted !== false } : null;
  } catch {
    return { kind: 'trigger', untrusted: true, source: 'unknown source' };
  }
}

function toTicket(row: TicketWithActivityRow, dependsOn: Id[], tags: string[] = []): Ticket {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    goal: row.goal,
    status: row.status,
    agentId: row.agent_id,
    runtime: row.runtime,
    model: row.model,
    currentSessionId: row.current_session_id,
    folder: row.folder,
    costCapUsd: row.cost_cap_usd,
    costUsd: row.cost_usd,
    parentId: row.parent_id,
    dependsOn,
    projectId: row.project_id ?? null,
    teamId: row.team_id ?? null,
    tags,
    origin: parseOrigin(row.origin),
    scope: parseScope(row.scope),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivity: row.last_summary !== null && row.last_at !== null ? { summary: row.last_summary, at: row.last_at } : null,
    deletedAt: row.deleted_at ?? null,
  };
}

/**
 * Turn free user text into a safe FTS5 query: every word becomes a quoted prefix term,
 * terms are AND-ed. Returns null when nothing searchable remains.
 */
export function toFtsQuery(q: string): string | null {
  const terms = q
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"*`);
  return terms.length > 0 ? terms.join(' ') : null;
}

export function createTicketRepo(db: Database.Database, workspaceDir: string): TicketRepo {
  const stmts = {
    get: db.prepare<[string], TicketWithActivityRow>(`${SELECT_TICKET} WHERE t.id = ?`),
    nextNumber: db.prepare<[], { n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tickets'),
    insert: db.prepare(`
      INSERT INTO tickets (id, number, title, goal, status, agent_id, runtime, model, current_session_id,
                           folder, cost_cap_usd, cost_usd, parent_id, project_id, team_id, origin, created_at, updated_at)
      VALUES (@id, @number, @title, @goal, 'backlog', @agentId, @runtime, @model, NULL,
              @folder, @costCapUsd, 0, @parentId, @projectId, @teamId, @origin, @now, @now)`),
    tags: db.prepare<[string], { tag: string }>('SELECT tag FROM ticket_tags WHERE ticket_id = ? ORDER BY rowid'),
    tagsMany: db.prepare<[string], { ticket_id: string; tag: string }>(
      `SELECT ticket_id, tag FROM ticket_tags WHERE ticket_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`),
    insertTag: db.prepare('INSERT OR IGNORE INTO ticket_tags (ticket_id, tag) VALUES (?, ?)'),
    clearTags: db.prepare('DELETE FROM ticket_tags WHERE ticket_id = ?'),
    deps: db.prepare<[string], { depends_on_id: string }>(
      'SELECT depends_on_id FROM ticket_deps WHERE ticket_id = ? ORDER BY depends_on_id'),
    depsMany: db.prepare<[string], { ticket_id: string; depends_on_id: string }>(
      `SELECT ticket_id, depends_on_id FROM ticket_deps
       WHERE ticket_id IN (SELECT value FROM json_each(?)) ORDER BY depends_on_id`),
    insertDep: db.prepare('INSERT OR IGNORE INTO ticket_deps (ticket_id, depends_on_id) VALUES (?, ?)'),
    clearDeps: db.prepare('DELETE FROM ticket_deps WHERE ticket_id = ?'),
    addCost: db.prepare('UPDATE tickets SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?'),
  };

  function load(id: Id): Ticket | undefined {
    const row = stmts.get.get(id);
    return row ? toTicket(row, stmts.deps.all(id).map((d) => d.depends_on_id), stmts.tags.all(id).map((t) => t.tag)) : undefined;
  }

  function mustLoad(id: Id): Ticket {
    const t = load(id);
    if (!t) throw new Error(`Ticket not found: ${id}`);
    return t;
  }

  function setDeps(id: Id, dependsOn: readonly Id[]): void {
    stmts.clearDeps.run(id);
    for (const dep of new Set(dependsOn)) {
      if (dep === id) throw new Error('A ticket cannot depend on itself');
      stmts.insertDep.run(id, dep);
    }
  }

  /** Tags are stored normalised; the service validates and normalises them first. */
  function setTags(id: Id, tags: readonly string[]): void {
    stmts.clearTags.run(id);
    for (const t of new Set(tags)) stmts.insertTag.run(id, t);
  }

  const create = db.transaction((input: NewTicket): Ticket => {
    const id = uuidv7();
    // Numbering inside the write transaction: MAX+1 cannot race with another writer.
    const number = stmts.nextNumber.get()!.n;
    stmts.insert.run({
      id,
      number,
      title: input.title,
      goal: input.goal,
      agentId: input.agentId ?? null,
      runtime: input.runtime ?? null,
      model: input.model ?? null,
      folder: path.join(workspaceDir, 'tickets', `T-${number}`),
      costCapUsd: input.costCapUsd ?? DEFAULT_TICKET_COST_CAP_USD,
      parentId: input.parentId ?? null,
      projectId: input.projectId ?? null,
      origin: input.origin ? JSON.stringify(input.origin) : null,
      teamId: input.teamId ?? null,
      now: nowIso(),
    });
    setDeps(id, input.dependsOn ?? []);
    setTags(id, input.tags ?? []);
    return mustLoad(id);
  });

  const update = db.transaction((id: Id, patch: Partial<Omit<Ticket, 'id' | 'number' | 'createdAt'>>): Ticket => {
    mustLoad(id);
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };
    for (const [key, value] of Object.entries(patch)) {
      const col = COLUMN_OF[key as keyof Ticket];
      if (!col || value === undefined) continue;
      sets.push(`${col} = @${col}`);
      values[col] = key === 'origin' || key === 'scope' ? (value === null ? null : JSON.stringify(value)) : value;
    }
    if (!('updated_at' in values)) {
      sets.push('updated_at = @updated_at');
      values.updated_at = nowIso();
    }
    db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = @id`).run(values);
    if (patch.dependsOn) setDeps(id, patch.dependsOn);
    if (patch.tags) setTags(id, patch.tags);
    return mustLoad(id);
  });

  return {
    create: (input) => create.immediate(input),
    get: load,
    update: (id, patch) => update.immediate(id, patch),

    childrenOf(parentId: Id): Ticket[] {
      const rows = db.prepare<[string], { id: string }>('SELECT id FROM tickets WHERE parent_id = ? ORDER BY number DESC').all(parentId);
      return rows.map((r) => mustLoad(r.id));
    },

    addCost(id, usd) {
      const res = stmts.addCost.run(usd, nowIso(), id);
      if (res.changes === 0) throw new Error(`Ticket not found: ${id}`);
      return mustLoad(id);
    },

    /** "Delete forever": removes the row; messages, runs, permissions… cascade (see migrations). */
    delete(id: Id): boolean {
      return db.prepare('DELETE FROM tickets WHERE id = ?').run(id).changes > 0;
    },

    list(query: TicketQuery): Page<Ticket> {
      const limit = clampLimit(query.limit);
      const where: string[] = [query.deleted ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL'];
      const params: unknown[] = [];
      if (query.status) {
        where.push('t.status = ?');
        params.push(query.status);
      }
      if (query.projectId === 'none') where.push('t.project_id IS NULL');
      else if (query.projectId) {
        where.push('t.project_id = ?');
        params.push(query.projectId);
      }
      if (query.teamId === 'none') where.push('t.team_id IS NULL');
      else if (query.teamId) {
        where.push('t.team_id = ?');
        params.push(query.teamId);
      }
      for (const tag of query.tags ?? []) {
        where.push('t.id IN (SELECT ticket_id FROM ticket_tags WHERE tag = ?)');
        params.push(tag);
      }
      if (query.q !== undefined && query.q.trim() !== '') {
        const fts = toFtsQuery(query.q);
        if (fts === null) return { items: [], nextCursor: null };
        // IN (subquery) returns each ticket once even when many messages match.
        where.push('t.id IN (SELECT ticket_id FROM search_fts WHERE search_fts MATCH ?)');
        params.push(fts);
      }
      if (query.cursor) {
        const [updatedAt, id] = decodeCursor(query.cursor, 2) as [string, string];
        where.push('(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))');
        params.push(updatedAt, updatedAt, id);
      }
      const sql = `${SELECT_TICKET} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY t.updated_at DESC, t.id DESC LIMIT ?`;
      const rows = db.prepare<unknown[], TicketWithActivityRow>(sql).all(...params, limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const deps = new Map<string, Id[]>();
      const tags = new Map<string, string[]>();
      if (pageRows.length > 0) {
        const ids = JSON.stringify(pageRows.map((r) => r.id));
        for (const d of stmts.depsMany.all(ids)) {
          const list = deps.get(d.ticket_id) ?? [];
          list.push(d.depends_on_id);
          deps.set(d.ticket_id, list);
        }
        for (const t of stmts.tagsMany.all(ids)) tags.set(t.ticket_id, [...(tags.get(t.ticket_id) ?? []), t.tag]);
      }
      const items = pageRows.map((r) => toTicket(r, deps.get(r.id) ?? [], tags.get(r.id) ?? []));
      const last = pageRows[pageRows.length - 1];
      return { items, nextCursor: hasMore && last ? encodeCursor([last.updated_at, last.id]) : null };
    },
  };
}
