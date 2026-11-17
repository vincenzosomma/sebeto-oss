/**
 * Session library (v0.4 §A, packages/shared/src/sessions.ts): one entry per Sebeto ticket session and
 * per Claude Code session found on this computer. Full-text search goes through session_fts (kept in
 * sync by triggers, migration v6). "Removed" entries stay as hidden tombstones (migration v7).
 */
import type Database from 'better-sqlite3';
import { GENERIC_CATEGORIES, nowIso, uuidv7, type Id, type Message, type Page, type SessionCategoryCount, type SessionCategorySource, type SessionEntry, type SessionSource } from '@sebeto/shared';
import type { SebetoTicketFacts, SessionEntryInput, SessionEntryQuery, SessionEntryRepo, StoredSessionEntry } from '../contracts.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';
import { toFtsQuery } from './tickets.js';

interface EntryRow {
  seq: number; id: string; source: SessionSource; external_session_id: string | null; session_id: string | null;
  ticket_id: string | null; ticket_number: number | null; title: string; summary: string; category: string; category_source: SessionCategorySource | null; tags: string;
  cwd: string | null; file_path: string | null; file_mtime: string | null; runtime: string | null; model: string | null;
  message_count: number; cost_usd: number; pinned: number; hidden: number; started_at: string; last_activity_at: string;
}

const SELECT = `SELECT e.*, t.number AS ticket_number FROM session_entries e LEFT JOIN tickets t ON t.id = e.ticket_id`;

function parseTags(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toStored(r: EntryRow): StoredSessionEntry {
  return {
    id: r.id, source: r.source, externalSessionId: r.external_session_id, sessionId: r.session_id, ticketId: r.ticket_id,
    ticketNumber: r.ticket_number ?? null, title: r.title, summary: r.summary, category: r.category, categorySource: r.category_source ?? null, tags: parseTags(r.tags),
    cwd: r.cwd, runtime: r.runtime, model: r.model, messageCount: r.message_count, costUsd: r.cost_usd,
    startedAt: r.started_at, lastActivityAt: r.last_activity_at, pinned: r.pinned === 1,
    filePath: r.file_path, fileMtime: r.file_mtime, hidden: r.hidden === 1,
  };
}

/** The public shape: internal fields (file path, tombstone) stripped. */
export function publicEntry(e: StoredSessionEntry): SessionEntry {
  const { filePath: _f, fileMtime: _m, hidden: _h, ...pub } = e;
  return pub;
}

/** OR-ed variant of toFtsQuery (agent memory: find something rather than nothing). */
function toFtsAnyQuery(q: string): string | null {
  const and = toFtsQuery(q);
  return and ? and.split(' ').join(' OR ') : null;
}

const COLUMNS: Record<string, string> = {
  source: 'source', externalSessionId: 'external_session_id', sessionId: 'session_id', ticketId: 'ticket_id', title: 'title',
  summary: 'summary', category: 'category', categorySource: 'category_source', tags: 'tags', cwd: 'cwd', filePath: 'file_path', fileMtime: 'file_mtime',
  runtime: 'runtime', model: 'model', messageCount: 'message_count', costUsd: 'cost_usd', pinned: 'pinned', hidden: 'hidden',
  startedAt: 'started_at', lastActivityAt: 'last_activity_at',
};

export function createSessionEntryRepo(db: Database.Database): SessionEntryRepo {
  const stmts = {
    get: db.prepare<[string], EntryRow>(`${SELECT} WHERE e.id = ?`),
    external: db.prepare<[string, string], EntryRow>(`${SELECT} WHERE e.source = ? AND e.external_session_id = ?`),
    sebeto: db.prepare<[string], EntryRow>(`${SELECT} WHERE e.source = 'sebeto' AND e.ticket_id = ? ORDER BY e.seq LIMIT 1`),
    categories: db.prepare<[], { category: string; n: number }>(
      'SELECT category, COUNT(*) AS n FROM session_entries WHERE hidden = 0 GROUP BY category ORDER BY n DESC, category'),
    insert: db.prepare(`
      INSERT INTO session_entries (id, source, external_session_id, session_id, ticket_id, title, summary, category, category_source, tags, cwd,
        file_path, file_mtime, runtime, model, message_count, cost_usd, pinned, hidden, started_at, last_activity_at, created_at, updated_at)
      VALUES (@id, @source, @externalSessionId, @sessionId, @ticketId, @title, @summary, @category, @categorySource, @tags, @cwd,
        @filePath, @fileMtime, @runtime, @model, @messageCount, @costUsd, @pinned, 0, @startedAt, @lastActivityAt, @now, @now)`),
    sessionsOf: db.prepare<[string], { id: string; external_session_id: string | null; runtime: string; model: string | null; started_at: string }>(
      'SELECT id, external_session_id, runtime, model, started_at FROM sessions WHERE ticket_id = ? ORDER BY id'),
    ticketRow: db.prepare<[string], { updated_at: string; team_slug: string | null }>(
      `SELECT t.updated_at, (SELECT slug FROM teams WHERE id = t.team_id) AS team_slug FROM tickets t WHERE t.id = ?`),
    msgCount: db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE ticket_id = ? AND role IN ('user', 'agent')`),
    runCost: db.prepare<[string], { c: number }>('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM runs WHERE ticket_id = ?'),
    lastAgent: db.prepare<[string], { text: string }>(`SELECT text FROM messages WHERE ticket_id = ? AND role = 'agent' ORDER BY id DESC LIMIT 1`),
    lastNote: db.prepare<[string], { note: string | null }>('SELECT note FROM status_transitions WHERE ticket_id = ? ORDER BY id DESC LIMIT 1'),
    byExternal: db.prepare<[string], { id: string; ticket_id: string }>('SELECT id, ticket_id FROM sessions WHERE external_session_id = ? ORDER BY id DESC LIMIT 1'),
    withSessions: db.prepare<[], { ticket_id: string }>('SELECT DISTINCT ticket_id FROM sessions'),
    teamSlug: db.prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?'),
    teamLead: db.prepare<[string], { lead: string | null }>('SELECT lead_agent_id AS lead FROM teams WHERE id = ?'),
    bySlug: db.prepare<[string], { id: string }>('SELECT id FROM teams WHERE slug = ?'),
    agentTeam: db.prepare<[string], { slug: string }>('SELECT t.slug FROM agents a JOIN teams t ON t.id = a.team_id WHERE a.id = ?'),
    recent: db.prepare<[string, number], { role: Message['role']; author: string; text: string; created_at: string }>(
      'SELECT role, author, text, created_at FROM messages WHERE ticket_id = ? ORDER BY id DESC LIMIT ?'),
  };

  const getStored = (id: Id): StoredSessionEntry | undefined => {
    const r = stmts.get.get(id);
    return r ? toStored(r) : undefined;
  };

  function searchRows(match: string | null, category: string | undefined, prefer: string | null, limit: number): EntryRow[] {
    const where = ['e.hidden = 0'];
    const params: unknown[] = [];
    if (match) {
      where.push('e.seq IN (SELECT rowid FROM session_fts WHERE session_fts MATCH ?)');
      params.push(match);
    }
    if (category) {
      where.push('e.category = ?');
      params.push(category);
    }
    const p = prefer ?? '';
    const sql = `${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY (e.pinned = 1 AND e.category = ? AND ? <> '') DESC, (e.category = ? AND ? <> '') DESC, e.pinned DESC,
               e.last_activity_at DESC, e.id DESC LIMIT ?`;
    return db.prepare<unknown[], EntryRow>(sql).all(...params, p, p, p, p, limit);
  }

  return {
    get(id) {
      const e = getStored(id);
      return e && !e.hidden ? publicEntry(e) : undefined;
    },
    getStored,
    findExternal(source, ext) {
      const r = stmts.external.get(source, ext);
      return r ? toStored(r) : undefined;
    },
    findSebeto(ticketId) {
      const r = stmts.sebeto.get(ticketId);
      return r ? toStored(r) : undefined;
    },

    list(query: SessionEntryQuery): Page<SessionEntry> {
      const limit = clampLimit(query.limit);
      const where = ['e.hidden = 0'];
      const params: unknown[] = [];
      if (query.source) {
        where.push('e.source = ?');
        params.push(query.source);
      }
      if (query.category === '-') where.push(`e.category = ''`);
      else if (query.category) {
        where.push('e.category = ?');
        params.push(query.category);
      }
      if (query.q !== undefined && query.q.trim() !== '') {
        const fts = toFtsQuery(query.q);
        if (fts === null) return { items: [], nextCursor: null };
        where.push('e.seq IN (SELECT rowid FROM session_fts WHERE session_fts MATCH ?)');
        params.push(fts);
      }
      if (query.cursor) {
        const [at, id] = decodeCursor(query.cursor, 2) as [string, string];
        where.push('(e.last_activity_at < ? OR (e.last_activity_at = ? AND e.id < ?))');
        params.push(at, at, id);
      }
      const rows = db.prepare<unknown[], EntryRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.last_activity_at DESC, e.id DESC LIMIT ?`)
        .all(...params, limit + 1);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map((r) => publicEntry(toStored(r))),
        nextCursor: hasMore && last ? encodeCursor([last.last_activity_at, last.id]) : null,
      };
    },

    search({ q, category, preferCategory, limit }) {
      const text = q?.trim() ?? '';
      let rows: EntryRow[];
      if (!text) rows = searchRows(null, category, preferCategory ?? null, limit);
      else {
        const all = toFtsQuery(text);
        if (!all) return [];
        rows = searchRows(all, category, preferCategory ?? null, limit);
        if (!rows.length && all.includes(' ')) rows = searchRows(toFtsAnyQuery(text), category, preferCategory ?? null, limit);
      }
      return rows.map((r) => publicEntry(toStored(r)));
    },

    categories: (): SessionCategoryCount[] => stmts.categories.all().map((r) => ({ category: r.category, count: r.n })),

    uncategorised({ limit, ids }) {
      // Not chosen by the owner, and either empty or a generic category nobody chose yet.
      const generic = GENERIC_CATEGORIES.filter(Boolean);
      const where = [
        'e.hidden = 0', "(e.category_source IS NULL OR e.category_source <> 'owner')",
        `(e.category = '' OR (e.category_source IS NULL AND e.category IN (${generic.map(() => '?').join(',')})))`,
      ];
      const params: unknown[] = [...generic];
      if (ids) {
        if (!ids.length) return [];
        where.push(`e.id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      }
      return db.prepare<unknown[], EntryRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.last_activity_at DESC, e.id DESC LIMIT ?`)
        .all(...params, limit).map(toStored);
    },

    insert(input) {
      const id = uuidv7();
      stmts.insert.run({
        id, source: input.source, externalSessionId: input.externalSessionId, sessionId: input.sessionId, ticketId: input.ticketId,
        title: input.title, summary: input.summary, category: input.category, categorySource: input.categorySource ?? null, tags: JSON.stringify(input.tags), cwd: input.cwd,
        filePath: input.filePath ?? null, fileMtime: input.fileMtime ?? null, runtime: input.runtime, model: input.model,
        messageCount: input.messageCount, costUsd: input.costUsd, pinned: input.pinned ? 1 : 0,
        startedAt: input.startedAt, lastActivityAt: input.lastActivityAt, now: nowIso(),
      });
      return getStored(id)!;
    },

    patch(id, patch) {
      const sets: string[] = [];
      const values: Record<string, unknown> = { id, now: nowIso() };
      for (const [key, value] of Object.entries(patch)) {
        const col = COLUMNS[key];
        if (!col || value === undefined) continue;
        sets.push(`${col} = @${col}`);
        values[col] = key === 'tags' ? JSON.stringify(value) : typeof value === 'boolean' ? (value ? 1 : 0) : value;
      }
      if (sets.length) db.prepare(`UPDATE session_entries SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(values);
      const e = getStored(id);
      if (!e) throw new Error(`Session entry not found: ${id}`);
      return e;
    },

    ticketFacts(ticketId): SebetoTicketFacts | undefined {
      const sessions = stmts.sessionsOf.all(ticketId);
      const latest = sessions[sessions.length - 1];
      const ticket = stmts.ticketRow.get(ticketId);
      if (!latest || !ticket) return undefined;
      return {
        latestSessionId: latest.id,
        externalSessionId: latest.external_session_id,
        runtime: latest.runtime,
        model: latest.model,
        startedAt: sessions[0]!.started_at,
        lastActivityAt: ticket.updated_at,
        messageCount: stmts.msgCount.get(ticketId)?.n ?? 0,
        costUsd: stmts.runCost.get(ticketId)?.c ?? 0,
        lastAgentText: stmts.lastAgent.get(ticketId)?.text ?? null,
        lastStatusNote: stmts.lastNote.get(ticketId)?.note ?? null,
        teamSlug: ticket.team_slug,
      };
    },

    sebetoSessionByExternal(ext) {
      const r = stmts.byExternal.get(ext);
      return r ? { sessionId: r.id, ticketId: r.ticket_id } : undefined;
    },
    ticketsWithSessions: () => stmts.withSessions.all().map((r) => r.ticket_id),
    teamSlug: (teamId) => stmts.teamSlug.get(teamId)?.slug ?? null,
    teamLead: (teamId) => stmts.teamLead.get(teamId)?.lead ?? null,
    isTeamSlug: (slug) => !!slug && !!stmts.bySlug.get(slug),
    agentTeamSlug: (agentId) => stmts.agentTeam.get(agentId)?.slug ?? null,
    recentMessages: (ticketId, limit) =>
      stmts.recent.all(ticketId, limit).reverse().map((r) => ({ role: r.role, author: r.author, text: r.text, at: r.created_at })),
  };
}
