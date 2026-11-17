/**
 * Memory graph index (v0.4 §E, packages/shared/src/memory.ts). The Markdown files in
 * <workspace>/memory/ are the source; these tables (migration v8) are only an index rebuilt from
 * them: memory_notes (one row per file), memory_links (note → normalised target title) and
 * memory_fts (title + body, rowid = memory_notes.seq).
 */
import type Database from 'better-sqlite3';
import type { Id, MemoryKind, MemoryNote, MemoryProvenance, MemoryStatus } from '@sebeto/shared';
import type { IndexedMemoryFile, MemoryIndexRepo, MemoryNoteQuery, MemoryNoteRow } from '../contracts.js';
import { toFtsQuery } from './tickets.js';

interface NoteRow {
  seq: number; id: string; path: string; title: string; key: string; kind: string; provenance: string; untrusted: number;
  status: string; team_slug: string | null; ticket_id: string | null; tags: string; excerpt: string; sha256: string;
  file_mtime: string; created_at: string; updated_at: string; link_count: number; backlink_count: number;
}

const SELECT = `SELECT n.*,
  (SELECT COUNT(*) FROM memory_links l WHERE l.from_id = n.id) AS link_count,
  (SELECT COUNT(*) FROM memory_links l JOIN memory_notes s ON s.id = l.from_id WHERE l.to_key = n.key AND s.status = 'approved' AND s.id <> n.id) AS backlink_count
  FROM memory_notes n`;

function parseTags(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toNote(r: NoteRow): MemoryNote {
  return {
    id: r.id, title: r.title, kind: r.kind as MemoryKind, path: r.path, provenance: r.provenance as MemoryProvenance,
    untrusted: r.untrusted === 1, status: r.status as MemoryStatus, teamSlug: r.team_slug, ticketId: r.ticket_id,
    tags: parseTags(r.tags), excerpt: r.excerpt, linkCount: r.link_count, backlinkCount: r.backlink_count, updatedAt: r.updated_at,
  };
}

const toRow = (r: NoteRow): MemoryNoteRow => ({ ...toNote(r), key: r.key, sha256: r.sha256 });

/** OR-ed FTS query (find something rather than nothing). */
function anyQuery(q: string): string | null {
  const and = toFtsQuery(q);
  return and ? and.split(' ').join(' OR ') : null;
}

export function createMemoryIndexRepo(db: Database.Database): MemoryIndexRepo {
  const stmts = {
    files: db.prepare<[], { id: string; path: string; sha256: string; file_mtime: string }>('SELECT id, path, sha256, file_mtime FROM memory_notes'),
    byId: db.prepare<[string], NoteRow>(`${SELECT} WHERE n.id = ?`),
    byPath: db.prepare<[string], NoteRow>(`${SELECT} WHERE n.path = ?`),
    seqOfPath: db.prepare<[string], { seq: number; id: string }>('SELECT seq, id FROM memory_notes WHERE path = ?'),
    seqOfId: db.prepare<[string], { seq: number; path: string }>('SELECT seq, path FROM memory_notes WHERE id = ?'),
    byTicket: db.prepare<[string], NoteRow>(`${SELECT} WHERE n.ticket_id = ? AND n.kind = 'ticket' AND n.provenance = 'chief-of-staff' ORDER BY n.seq LIMIT 1`),
    ticketExists: db.prepare<[string], { id: string }>('SELECT id FROM tickets WHERE id = ?'),
    insert: db.prepare(`INSERT INTO memory_notes (id, path, title, key, kind, provenance, untrusted, status, team_slug, ticket_id, tags, excerpt,
        sha256, file_mtime, created_at, updated_at)
      VALUES (@id, @path, @title, @key, @kind, @provenance, @untrusted, @status, @teamSlug, @ticketId, @tags, @excerpt, @sha256, @fileMtime, @updatedAt, @updatedAt)`),
    update: db.prepare(`UPDATE memory_notes SET id = @id, title = @title, key = @key, kind = @kind, provenance = @provenance, untrusted = @untrusted,
        status = @status, team_slug = @teamSlug, ticket_id = @ticketId, tags = @tags, excerpt = @excerpt, sha256 = @sha256,
        file_mtime = @fileMtime, updated_at = @updatedAt WHERE path = @path`),
    touch: db.prepare<[string, string]>('UPDATE memory_notes SET file_mtime = ? WHERE path = ?'),
    removeByPath: db.prepare<[string]>('DELETE FROM memory_notes WHERE path = ?'),
    ftsDelete: db.prepare<[number]>('DELETE FROM memory_fts WHERE rowid = ?'),
    ftsInsert: db.prepare<[number, string]>('INSERT INTO memory_fts (rowid, body) VALUES (?, ?)'),
    linksDelete: db.prepare<[string]>('DELETE FROM memory_links WHERE from_id = ?'),
    linkInsert: db.prepare<[string, string]>('INSERT OR IGNORE INTO memory_links (from_id, to_key) VALUES (?, ?)'),
    linksOf: db.prepare<[string], { to_key: string }>('SELECT to_key FROM memory_links WHERE from_id = ? ORDER BY rowid'),
    allLinks: db.prepare<[], { from_id: string; to_key: string }>('SELECT from_id, to_key FROM memory_links'),
    counts: db.prepare<[], { notes: number; proposed: number }>(
      `SELECT COALESCE(SUM(status = 'approved'), 0) AS notes, COALESCE(SUM(status = 'proposed'), 0) AS proposed FROM memory_notes`),
    linkCount: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM memory_links'),
  };

  const upsert = db.transaction((f: IndexedMemoryFile) => {
    const ticketId = f.ticketId && stmts.ticketExists.get(f.ticketId) ? f.ticketId : null;
    const params = {
      id: f.id, path: f.path, title: f.title, key: f.key, kind: f.kind, provenance: f.provenance, untrusted: f.untrusted ? 1 : 0,
      status: f.status, teamSlug: f.teamSlug, ticketId, tags: JSON.stringify(f.tags), excerpt: f.excerpt, sha256: f.sha256,
      fileMtime: f.fileMtime, updatedAt: f.updatedAt,
    };
    const cur = stmts.seqOfPath.get(f.path);
    // Another file already uses this id (a copied file): the caller gives a fresh id, but be safe.
    const clash = stmts.seqOfId.get(f.id);
    if (clash && clash.path !== f.path) throw new Error(`memory note id already used by ${clash.path}`);
    if (cur) {
      if (cur.id !== f.id) stmts.linksDelete.run(cur.id);
      stmts.update.run(params);
    } else {
      stmts.insert.run(params);
    }
    const seq = stmts.seqOfPath.get(f.path)!.seq;
    stmts.ftsDelete.run(seq);
    stmts.ftsInsert.run(seq, `${f.title}\n${f.body}`);
    stmts.linksDelete.run(f.id);
    for (const k of f.links) stmts.linkInsert.run(f.id, k);
  });

  const removePath = db.transaction((p: string) => {
    const cur = stmts.seqOfPath.get(p);
    if (!cur) return false;
    stmts.ftsDelete.run(cur.seq);
    stmts.linksDelete.run(cur.id);
    stmts.removeByPath.run(p);
    return true;
  });

  return {
    files: () => stmts.files.all().map((r) => ({ id: r.id, path: r.path, sha256: r.sha256, fileMtime: r.file_mtime })),
    upsert: (f) => upsert(f),
    touch: (p, mtime) => { stmts.touch.run(mtime, p); },
    removePath: (p) => removePath(p),
    get: (id) => { const r = stmts.byId.get(id); return r ? toRow(r) : undefined; },
    byPath: (p) => { const r = stmts.byPath.get(p); return r ? toRow(r) : undefined; },
    ticketNote: (ticketId) => { const r = stmts.byTicket.get(ticketId); return r ? toRow(r) : undefined; },
    byKeys(keys, status) {
      if (!keys.length) return [];
      const marks = keys.map(() => '?').join(',');
      const rows = db.prepare<unknown[], NoteRow>(
        `${SELECT} WHERE n.key IN (${marks})${status ? ' AND n.status = ?' : ''} ORDER BY n.updated_at DESC`,
      ).all(...keys, ...(status ? [status] : []));
      return rows.map(toRow);
    },
    byIds(ids) {
      if (!ids.length) return [];
      const out: MemoryNoteRow[] = [];
      for (let i = 0; i < ids.length; i += 400) {
        const part = ids.slice(i, i + 400);
        out.push(...db.prepare<unknown[], NoteRow>(`${SELECT} WHERE n.id IN (${part.map(() => '?').join(',')})`).all(...part).map(toRow));
      }
      return out;
    },
    list(q: MemoryNoteQuery) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.kind) { where.push('n.kind = ?'); params.push(q.kind); }
      if (q.team) { where.push(q.team === '-' ? 'n.team_slug IS NULL' : 'n.team_slug = ?'); if (q.team !== '-') params.push(q.team); }
      if (q.status) { where.push('n.status = ?'); params.push(q.status); }
      if (q.ticketId) { where.push('n.ticket_id = ?'); params.push(q.ticketId); }
      const limit = Math.max(1, Math.min(q.limit ?? 50, 2000));
      if (q.q) {
        const fts = (q.any ? anyQuery(q.q) : toFtsQuery(q.q));
        if (!fts) return [];
        const sql = `${SELECT} JOIN memory_fts f ON f.rowid = n.seq WHERE memory_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
          ORDER BY bm25(memory_fts), n.updated_at DESC LIMIT ?`;
        return db.prepare<unknown[], NoteRow>(sql).all(fts, ...params, limit).map(toRow);
      }
      const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY n.updated_at DESC, n.seq DESC LIMIT ?`;
      return db.prepare<unknown[], NoteRow>(sql).all(...params, limit).map(toRow);
    },
    titleLike(fragment, status, limit) {
      const like = `%${fragment.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return db.prepare<unknown[], NoteRow>(`${SELECT} WHERE n.key LIKE ? ESCAPE '\\'${status ? ' AND n.status = ?' : ''} ORDER BY length(n.key), n.updated_at DESC LIMIT ?`)
        .all(like, ...(status ? [status] : []), limit).map(toRow);
    },
    linksOf: (id) => stmts.linksOf.all(id).map((r) => r.to_key),
    allLinks: () => stmts.allLinks.all().map((r) => ({ fromId: r.from_id, toKey: r.to_key })),
    linkingTo(keys) {
      if (!keys.length) return [];
      const marks = keys.map(() => '?').join(',');
      return db.prepare<unknown[], { from_id: string }>(`SELECT DISTINCT from_id FROM memory_links WHERE to_key IN (${marks})`).all(...keys).map((r) => r.from_id as Id);
    },
    counts() {
      const c = stmts.counts.get()!;
      return { notes: c.notes, proposed: c.proposed, links: stmts.linkCount.get()!.n };
    },
  };
}
