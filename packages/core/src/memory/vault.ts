/**
 * The memory vault (v0.4 §E, packages/shared/src/memory.ts): Markdown notes in
 * <workspace>/memory/ (open the folder in Obsidian as a vault) and their index in the database.
 *
 *  - Index: rebuilt from the files at start-up (every file read once, so aliases are known), on
 *    POST /memory/reindex, after Sebeto's own writes (just that file), and every few minutes so
 *    edits made in Obsidian are picked up (cheap: unchanged mtime + size = skipped; same sha256 =
 *    only the mtime is stored).
 *  - A file's status comes from where it is: proposed/ = 'proposed', anywhere else = 'approved'.
 *    Kind comes from `sebeto.kind`, else from the first folder (systems/ → system…), else 'note'.
 *    A file without a `sebeto:` block is the owner's: provenance 'owner', untrusted false.
 *  - Links: [[wikilinks]] (extractWikiLinks) to note titles (the file name without .md) or to
 *    `aliases:` from the frontmatter, case-insensitive; a host name with no note of its own links to
 *    the note of its first label ([[fs01.naples.local]] → FS01, v0.5 J, see memoryHostLabel).
 *  - All the vault's own writes go through one queue, so a rescan never sees half a change.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  MEMORY_FOLDERS, MEMORY_KINDS, MEMORY_PROPOSED_FOLDER, extractWikiLinks, isMatchableName, memoryFileName, memoryHostLabel, memoryKey, nowIso, uuidv7,
  type Id, type MemoryGraph, type MemoryGraphNode, type MemoryInfo, type MemoryKind, type MemoryNote, type MemoryNoteDetail,
  type MemoryReindexResult, type MemoryRelated, type MemoryStatus,
} from '@sebeto/shared';
import type { AppContext, IndexedMemoryFile, MemoryIndexRepo, MemoryNoteQuery, MemoryNoteRow } from '../contracts.js';
import { addAliasToText, parseNoteFile, renderNoteFile, type ParsedNoteFile, type SebetoMeta } from './frontmatter.js';
import { MAX_NOTE_BYTES, TRASH_FOLDER, absOf, cleanRel, freeName, listNoteFiles, moveNote, readNote, writeNote } from './files.js';

export const MEMORY_FOLDER = 'memory';
/** Rescan for edits made outside Sebeto (Obsidian) this often. */
export const RESCAN_MS = 3 * 60_000;
export const EXCERPT_CHARS = 200;
export const DEFAULT_GRAPH_LIMIT = 300;
export const MAX_GRAPH_LIMIT = 1000;

const FOLDER_KIND = new Map<string, MemoryKind>(Object.entries(MEMORY_FOLDERS).map(([k, f]) => [f.toLowerCase(), k as MemoryKind]));

/** Plain text excerpt of a Markdown body. */
export function excerptOf(body: string, max = EXCERPT_CHARS): string {
  const plain = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Display names of the [[links]] in a body (first spelling wins), keyed like extractWikiLinks. */
export function linkNames(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const raw = m[1]!.split('|')[0]!.split('#')[0]!.trim().replace(/\s+/g, ' ');
    const k = memoryKey(raw);
    if (k && !out.has(k)) out.set(k, raw);
  }
  return out;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const stamp = (mtimeMs: number, size: number) => `${Math.round(mtimeMs)}:${size}`;
const titleOf = (rel: string) => path.posix.basename(rel).replace(/\.md$/i, '');

/** Kind and status of a file from its place in the vault. */
export function placeOf(rel: string): { folderKind: MemoryKind | null; proposed: boolean } {
  const first = rel.includes('/') ? rel.split('/')[0]!.toLowerCase() : '';
  return { folderKind: FOLDER_KIND.get(first) ?? null, proposed: first === MEMORY_PROPOSED_FOLDER };
}

export interface SaveNoteInput {
  title: string;
  kind: MemoryKind;
  body: string;
  tags?: string[];
  teamSlug?: string | null;
  untrusted?: boolean;
}

export interface NoteContent { row: MemoryNoteRow; parsed: ParsedNoteFile; body: string }

export interface MemoryVault {
  /** Absolute path of <workspace>/memory. */
  readonly folder: string;
  /** Re-read changed files (all files when full) and drop removed ones. */
  reindex(opts?: { full?: boolean }): Promise<MemoryReindexResult>;
  /** Index one file Sebeto just wrote, moved away (missing = removed) or changed. */
  indexFile(rel: string): Promise<MemoryNoteRow | undefined>;
  /** Start-up scan + periodic rescans. */
  start(): Promise<void>;
  stop(): void;
  /** Run fn alone (no scan or other write in between). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  list(query: MemoryNoteQuery): MemoryNote[];
  get(id: Id): MemoryNoteRow | undefined;
  /** File content of an indexed note (undefined when the file is gone). */
  content(id: Id): Promise<NoteContent | undefined>;
  detail(id: Id, opts?: { includeProposed?: boolean }): Promise<MemoryNoteDetail | undefined>;
  /** Best note for a name: exact title, alias, host name's first label, title containing it, then full text. */
  resolve(name: string, opts?: { approvedOnly?: boolean; fullText?: boolean }): MemoryNoteRow | undefined;
  /**
   * The note a name means exactly (v0.5 J): the title or an alias (case-insensitive), else the first
   * label of a host name ("fs01.naples.local" → FS01). No fuzzy or full-text step.
   */
  lookup(name: string, opts?: { approvedOnly?: boolean }): { row: MemoryNoteRow; via: 'title' | 'alias' | 'host' } | undefined;
  /** Approved notes a link key points to (title or alias). */
  targets(key: string): MemoryNoteRow[];
  /** Like targets, plus a host name's first label ([[fs01.naples.local]] → FS01) when nothing matches exactly. */
  linkTargets(key: string): MemoryNoteRow[];
  /** Approved notes (not tickets) and the matchable names (titles + aliases) that link them from free text. */
  matchers(): Array<{ key: string; row: MemoryNoteRow }>;
  /**
   * Add a spelling to a note's frontmatter `aliases:` (keeps the owner's text), then re-index it.
   * The caller holds `exclusive`. Returns false when nothing changed.
   */
  addAlias(id: Id, alias: string): Promise<boolean>;
  related(name: string, opts?: { depth?: 1 | 2; limit?: number; approvedOnly?: boolean }): MemoryRelated;
  graph(query: { team?: string; kind?: MemoryKind; center?: Id; depth?: 1 | 2; limit?: number; includeProposed?: boolean; q?: string }): MemoryGraph;
  info(): MemoryInfo;
  /** Create a new file "<dir>/<title>.md" (" 2" etc. on a clash) and index it. */
  create(dir: string, title: string, meta: SebetoMeta, body: string, tags?: string[]): Promise<MemoryNoteRow>;
  /** Rewrite an existing note's file (keeps unknown frontmatter keys) and index it. */
  rewrite(rel: string, meta: SebetoMeta, body: string, tags?: string[]): Promise<MemoryNoteRow>;
  /** Move a note (rename / approve / trash) and re-index both places. */
  move(fromRel: string, toRel: string, opts?: { toHidden?: boolean }): Promise<void>;
  /** Aliases of a note (from its frontmatter) as keys. */
  aliasKeys(id: Id): string[];
  changed(): void;
}

export function createMemoryVault(ctx: Pick<AppContext, 'config' | 'repos' | 'bus' | 'log'>, opts: { folder?: string } = {}): MemoryVault {
  const folder = path.resolve(opts.folder ?? path.join(ctx.config.workspaceDir, MEMORY_FOLDER));
  const repo = (): MemoryIndexRepo => {
    const r = ctx.repos.memoryIndex;
    if (!r) throw new Error('memory index not available');
    return r;
  };
  /** rel path → alias keys (from the last read of the file). */
  const aliasesByPath = new Map<string, string[]>();
  let lastIndexedAt: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  const changed = () => ctx.bus.publish({ type: 'memory.changed' });

  function aliasLookup(key: string): string[] {
    const out: string[] = [];
    for (const [rel, keys] of aliasesByPath) if (keys.includes(key)) out.push(rel);
    return out;
  }

  function targets(key: string): MemoryNoteRow[] {
    const direct = repo().byKeys([key], 'approved');
    if (direct.length) return direct;
    return aliasLookup(key).map((rel) => repo().byPath(rel)).filter((r): r is MemoryNoteRow => !!r && r.status === 'approved');
  }

  function linkTargets(key: string): MemoryNoteRow[] {
    const exact = targets(key);
    if (exact.length) return exact;
    const label = memoryHostLabel(key);
    return label ? targets(label) : [];
  }

  /** Title / alias, then the host label; status filter optional. */
  function lookup(name: string, opts: { approvedOnly?: boolean } = {}): { row: MemoryNoteRow; via: 'title' | 'alias' | 'host' } | undefined {
    const key = memoryKey(name.replace(/^\[\[|\]\]$/g, ''));
    if (!key) return undefined;
    const ok = (n: MemoryNoteRow | undefined): n is MemoryNoteRow => !!n && (!opts.approvedOnly || n.status === 'approved');
    const exactOf = (k: string): { row: MemoryNoteRow; alias: boolean } | undefined => {
      const byTitle = repo().byKeys([k], opts.approvedOnly ? 'approved' : undefined);
      const t = byTitle.find((n) => n.status === 'approved') ?? byTitle[0];
      if (t) return { row: t, alias: false };
      const byAlias = aliasLookup(k).map((rel) => repo().byPath(rel)).filter(ok);
      const a = byAlias.find((n) => n.status === 'approved') ?? byAlias[0];
      return a ? { row: a, alias: true } : undefined;
    };
    const exact = exactOf(key);
    if (exact) return { row: exact.row, via: exact.alias ? 'alias' : 'title' };
    const label = memoryHostLabel(key);
    const host = label ? exactOf(label) : undefined;
    return host ? { row: host.row, via: 'host' } : undefined;
  }

  function matchers(): Array<{ key: string; row: MemoryNoteRow }> {
    const out: Array<{ key: string; row: MemoryNoteRow }> = [];
    const rows = repo().list({ status: 'approved', limit: 5000 }).filter((n) => n.kind !== 'ticket');
    const byPath = new Map(rows.map((n) => [n.path, n]));
    const seen = new Set<string>();
    const add = (key: string, row: MemoryNoteRow) => {
      if (!seen.has(key) && isMatchableName(key)) { seen.add(key); out.push({ key, row }); }
    };
    for (const n of rows) add(n.key, n);
    for (const [rel, keys] of aliasesByPath) {
      const n = byPath.get(rel);
      if (n) for (const k of keys) add(k, n);
    }
    return out;
  }

  async function addAlias(id: Id, alias: string): Promise<boolean> {
    const row = repo().get(id);
    if (!row) return false;
    let text: string;
    try {
      ({ text } = await readNote(folder, row.path));
    } catch {
      return false;
    }
    const next = addAliasToText(text, alias);
    if (next === null) return false;
    await writeNote(folder, row.path, next);
    await indexFile(row.path);
    return true;
  }

  /** Build the index row of a file from its text. */
  function toIndexed(rel: string, text: string, mtime: string, usedIds: Set<string>): { file: IndexedMemoryFile; parsed: ParsedNoteFile } {
    const parsed = parseNoteFile(text);
    const s = parsed.hasSebeto ? parsed.sebeto : {};
    const { folderKind, proposed } = placeOf(rel);
    const existing = repo().byPath(rel);
    let id = s.id && !usedIds.has(s.id) ? s.id : existing?.id ?? uuidv7();
    // An id already used by another file (a copied note) gets a fresh one.
    const other = repo().get(id);
    if (other && other.path !== rel) id = existing && existing.id !== other.id ? existing.id : uuidv7();
    usedIds.add(id);
    const status: MemoryStatus = proposed ? 'proposed' : 'approved';
    const title = titleOf(rel);
    const file: IndexedMemoryFile = {
      id, path: rel, title, key: memoryKey(title),
      kind: s.kind ?? folderKind ?? 'note',
      provenance: parsed.hasSebeto ? s.provenance ?? 'owner' : 'owner',
      untrusted: parsed.hasSebeto ? s.untrusted === true : false,
      status, teamSlug: s.team ?? null, ticketId: s.ticket ?? null, tags: parsed.tags,
      excerpt: excerptOf(parsed.body), sha256: sha256(text), fileMtime: mtime, updatedAt: nowIso(),
      body: parsed.body, links: extractWikiLinks(parsed.body).filter((k) => k !== memoryKey(title)).slice(0, 500),
    };
    return { file, parsed };
  }

  async function indexOne(rel: string, mtimeMs: number, size: number, opts: { force: boolean; usedIds: Set<string> }): Promise<'added' | 'updated' | 'same' | 'skipped'> {
    const r = repo();
    const known = r.byPath(rel);
    const st = stamp(mtimeMs, size);
    if (!opts.force && known && fileStamp.get(rel) === st) {
      opts.usedIds.add(known.id);
      return 'same';
    }
    if (size > MAX_NOTE_BYTES) {
      if (known) r.removePath(rel);
      aliasesByPath.delete(rel);
      ctx.log.warn({ path: rel, size }, 'memory: note too large, left out of the index');
      return 'skipped';
    }
    let text: string;
    try {
      ({ text } = await readNote(folder, rel));
    } catch (err) {
      ctx.log.warn({ path: rel, err: (err as Error).message }, 'memory: cannot read note');
      return 'skipped';
    }
    fileStamp.set(rel, st);
    const hash = sha256(text);
    const parsed = parseNoteFile(text);
    aliasesByPath.set(rel, parsed.aliases.map(memoryKey).filter(Boolean));
    if (known && known.sha256 === hash) {
      r.touch(rel, st);
      opts.usedIds.add(known.id);
      return 'same';
    }
    const { file } = toIndexed(rel, text, st, opts.usedIds);
    r.upsert(file);
    return known ? 'updated' : 'added';
  }

  /** rel → "mtime:size" seen by this process (the DB copy is only used after a restart). */
  const fileStamp = new Map<string, string>();

  async function scan(full: boolean): Promise<MemoryReindexResult & { changes: number }> {
    const started = Date.now();
    await fs.promises.mkdir(folder, { recursive: true });
    const r = repo();
    if (!fileStamp.size && !full) for (const f of r.files()) fileStamp.set(f.path, f.fileMtime);
    const files = await listNoteFiles(folder);
    const seen = new Set(files.map((f) => f.rel));
    let changes = 0;
    // Removed files first, so a note renamed in Obsidian keeps its id at its new path.
    for (const f of r.files()) {
      if (seen.has(f.path)) continue;
      r.removePath(f.path);
      aliasesByPath.delete(f.path);
      fileStamp.delete(f.path);
      changes++;
    }
    const usedIds = new Set<string>();
    for (const f of files) {
      const res = await indexOne(f.rel, f.mtimeMs, f.size, { force: full, usedIds });
      if (res === 'added' || res === 'updated') changes++;
    }
    lastIndexedAt = nowIso();
    const c = r.counts();
    return { notes: c.notes + c.proposed, links: c.links, ms: Date.now() - started, changes };
  }

  async function indexFile(rel: string): Promise<MemoryNoteRow | undefined> {
    const clean = cleanRel(rel);
    let st: fs.Stats | null = null;
    try {
      st = await fs.promises.lstat(absOf(folder, clean));
    } catch { /* removed */ }
    if (!st || !st.isFile()) {
      repo().removePath(clean);
      aliasesByPath.delete(clean);
      fileStamp.delete(clean);
      return undefined;
    }
    await indexOne(clean, st.mtimeMs, st.size, { force: true, usedIds: new Set() });
    return repo().byPath(clean);
  }

  async function content(id: Id): Promise<NoteContent | undefined> {
    const row = repo().get(id);
    if (!row) return undefined;
    try {
      const { text } = await readNote(folder, row.path);
      const parsed = parseNoteFile(text);
      return { row, parsed, body: parsed.body };
    } catch {
      return undefined;
    }
  }

  function backlinkRows(row: MemoryNoteRow, includeProposed: boolean): MemoryNoteRow[] {
    const keys = [row.key, ...(aliasesByPath.get(row.path) ?? [])];
    // Host spellings that resolve to this note only by their first label ([[fs01.naples.local]] → FS01).
    for (const l of repo().allLinks()) {
      if (keys.includes(l.toKey)) continue;
      const label = memoryHostLabel(l.toKey);
      if (label && keys.includes(label) && !targets(l.toKey).length) keys.push(l.toKey);
    }
    const ids = repo().linkingTo(keys).filter((x) => x !== row.id);
    return repo().byIds(ids).filter((n) => includeProposed || n.status === 'approved');
  }

  function resolve(name: string, opts: { approvedOnly?: boolean; fullText?: boolean } = {}): MemoryNoteRow | undefined {
    const key = memoryKey(name.replace(/^\[\[|\]\]$/g, ''));
    if (!key) return undefined;
    const status: MemoryStatus | undefined = opts.approvedOnly ? 'approved' : undefined;
    const hit = lookup(key, { approvedOnly: opts.approvedOnly === true });
    if (hit) return hit.row;
    if (key.length >= 2) {
      const like = repo().titleLike(key, status, 1);
      if (like.length) return like[0];
    }
    if (opts.fullText === false) return undefined;
    return repo().list({ q: key, any: true, ...(status ? { status } : {}), limit: 1 })[0];
  }

  function neighbourRows(row: MemoryNoteRow, approvedOnly: boolean): { out: MemoryNoteRow[]; inn: MemoryNoteRow[] } {
    const out: MemoryNoteRow[] = [];
    for (const k of repo().linksOf(row.id)) {
      for (const t of linkTargets(k)) if (t.id !== row.id && !out.some((o) => o.id === t.id)) out.push(t);
    }
    const inn = backlinkRows(row, !approvedOnly).filter((n) => !out.some((o) => o.id === n.id));
    return { out, inn };
  }

  const strip = (r: MemoryNoteRow): MemoryNote => {
    const { key: _k, sha256: _s, ...note } = r;
    return note;
  };

  function related(name: string, opts: { depth?: 1 | 2; limit?: number; approvedOnly?: boolean } = {}): MemoryRelated {
    const approvedOnly = opts.approvedOnly !== false;
    const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
    const note = resolve(name, { approvedOnly });
    if (!note) return { note: null, neighbours: [] };
    const { out, inn } = neighbourRows(note, approvedOnly);
    const neighbours: MemoryRelated['neighbours'] = [];
    const seen = new Set<string>([note.id]);
    for (const n of out) if (!seen.has(n.id)) { seen.add(n.id); neighbours.push({ note: strip(n), via: 'out' }); }
    // Newest backlinks first (recent incidents matter most).
    for (const n of [...inn].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      if (!seen.has(n.id)) { seen.add(n.id); neighbours.push({ note: strip(n), via: 'in' }); }
    }
    if ((opts.depth ?? 1) === 2) {
      const first = [...out, ...inn];
      for (const f of first) {
        if (neighbours.length >= limit * 2) break;
        const nb = neighbourRows(f, approvedOnly);
        for (const n of [...nb.out, ...nb.inn]) {
          if (!seen.has(n.id)) { seen.add(n.id); neighbours.push({ note: strip(n), via: 'hop2' }); }
        }
      }
    }
    return { note: strip(note), neighbours: neighbours.slice(0, limit) };
  }

  function graph(q: { team?: string; kind?: MemoryKind; center?: Id; depth?: 1 | 2; limit?: number; includeProposed?: boolean; q?: string }): MemoryGraph {
    const r = repo();
    const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT));
    const all = r.list({ limit: 5000, ...(q.includeProposed ? {} : { status: 'approved' as const }) });
    const byId = new Map(all.map((n) => [n.id, n]));
    // key (title or alias) → approved note ids
    const byKey = new Map<string, string[]>();
    const addKey = (k: string, id: string) => byKey.set(k, [...(byKey.get(k) ?? []), id]);
    for (const n of all) if (n.status === 'approved') addKey(n.key, n.id);
    for (const [rel, keys] of aliasesByPath) {
      const n = all.find((x) => x.path === rel);
      if (n && n.status === 'approved') for (const k of keys) if (!byKey.has(k)) addKey(k, n.id);
    }
    const edges: Array<{ from: string; to: string }> = [];
    const missing = new Map<string, string>();
    const edgeSet = new Set<string>();
    for (const l of r.allLinks()) {
      if (!byId.has(l.fromId)) continue;
      const hostLabel = byKey.has(l.toKey) ? null : memoryHostLabel(l.toKey);
      const to = byKey.get(l.toKey) ?? (hostLabel ? byKey.get(hostLabel) : undefined);
      const targetsOf = to?.length ? to : [`missing:${l.toKey}`];
      if (!to?.length) missing.set(`missing:${l.toKey}`, l.toKey);
      for (const t of targetsOf) {
        if (t === l.fromId) continue;
        const k = `${l.fromId}>${t}`;
        if (!edgeSet.has(k)) { edgeSet.add(k); edges.push({ from: l.fromId, to: t }); }
      }
    }
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    let keep = new Set<string>([...byId.keys(), ...missing.keys()]);
    // Filters on real notes; missing targets stay when a kept note links to them.
    const match = (n: MemoryNoteRow) => (!q.team || (q.team === '-' ? !n.teamSlug : n.teamSlug === q.team)) && (!q.kind || n.kind === q.kind);
    if (q.team || q.kind) keep = new Set([...byId.values()].filter(match).map((n) => n.id));
    if (q.q) {
      const hits = new Set(r.list({ q: q.q, any: true, limit: 500, ...(q.includeProposed ? {} : { status: 'approved' as const }) }).map((n) => n.id));
      keep = new Set([...keep].filter((id) => hits.has(id)));
    }
    if (q.center && byId.has(q.center)) {
      const adj = new Map<string, Set<string>>();
      const link = (a: string, b: string) => { adj.set(a, (adj.get(a) ?? new Set()).add(b)); };
      for (const e of edges) { link(e.from, e.to); link(e.to, e.from); }
      const within = new Set<string>([q.center]);
      let frontier = [q.center];
      for (let d = 0; d < (q.depth ?? 1); d++) {
        const next: string[] = [];
        for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!within.has(nb)) { within.add(nb); next.push(nb); }
        frontier = next;
      }
      keep = new Set([...within].filter((id) => keep.has(id) || id === q.center || id.startsWith('missing:')));
    }
    if (!q.center && (q.team || q.kind || q.q)) {
      // Show where the kept notes link to, even when the target itself is filtered out as a note.
      for (const e of edges) if (keep.has(e.from) && e.to.startsWith('missing:')) keep.add(e.to);
    }
    let ids = [...keep];
    let truncated = false;
    if (ids.length > limit) {
      truncated = true;
      ids = ids.sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a === q.center ? -1 : 0)).slice(0, limit);
      if (q.center && !ids.includes(q.center) && keep.has(q.center)) ids[ids.length - 1] = q.center;
    }
    const kept = new Set(ids);
    const nodes: MemoryGraphNode[] = ids.map((id) => {
      const n = byId.get(id);
      if (n) return { id, title: n.title, kind: n.kind, untrusted: n.untrusted, status: n.status, teamSlug: n.teamSlug, degree: degree.get(id) ?? 0 };
      return { id, title: missing.get(id) ?? id.slice(8), kind: 'missing', untrusted: false, status: null, teamSlug: null, degree: degree.get(id) ?? 0 };
    });
    return { nodes, edges: edges.filter((e) => kept.has(e.from) && kept.has(e.to)), truncated };
  }

  async function create(dir: string, title: string, meta: SebetoMeta, body: string, tags?: string[]): Promise<MemoryNoteRow> {
    const rel = await freeName(folder, dir, memoryFileName(title));
    const id = meta.id ?? uuidv7();
    await writeNote(folder, rel, renderNoteFile({ sebeto: { ...meta, id }, ...(tags ? { tags } : {}) }, body), { exclusive: true });
    const row = await indexFile(rel);
    if (!row) throw new Error('note was not indexed');
    return row;
  }

  async function rewrite(rel: string, meta: SebetoMeta, body: string, tags?: string[]): Promise<MemoryNoteRow> {
    let previous: ParsedNoteFile | null = null;
    try {
      previous = parseNoteFile((await readNote(folder, rel)).text);
    } catch { /* new file */ }
    await writeNote(folder, rel, renderNoteFile({ sebeto: meta, ...(tags ? { tags } : {}) }, body, previous));
    const row = await indexFile(rel);
    if (!row) throw new Error('note was not indexed');
    return row;
  }

  async function move(fromRel: string, toRel: string, opts: { toHidden?: boolean } = {}): Promise<void> {
    await moveNote(folder, fromRel, toRel, opts);
    const aliases = aliasesByPath.get(fromRel);
    await indexFile(fromRel);
    if (!opts.toHidden) {
      if (aliases) aliasesByPath.set(toRel, aliases);
      await indexFile(toRel);
    }
  }

  async function detail(id: Id, opts: { includeProposed?: boolean } = {}): Promise<MemoryNoteDetail | undefined> {
    const c = await content(id);
    if (!c) return undefined;
    const names = linkNames(c.body);
    const links = repo().linksOf(id).map((k) => linkTargets(k)[0]?.title ?? names.get(k) ?? k);
    const backlinks = backlinkRows(c.row, opts.includeProposed === true)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((n) => ({ id: n.id, title: n.title }));
    return { ...strip(c.row), body: c.body, links, backlinks, obsidianUrl: `obsidian://open?path=${encodeURIComponent(absOf(folder, c.row.path))}` };
  }

  return {
    folder,
    reindex: (o = {}) => exclusive(async () => {
      const res = await scan(o.full === true);
      if (res.changes) changed();
      return { notes: res.notes, links: res.links, ms: res.ms };
    }),
    indexFile: (rel) => indexFile(rel),
    async start() {
      try {
        // Every file is read once at start-up (aliases live only in the files).
        await exclusive(async () => {
          const res = await scan(true);
          ctx.log.info({ notes: res.notes, links: res.links, ms: res.ms }, 'memory: index ready');
          if (res.changes) changed();
        });
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message }, 'memory: start-up scan failed');
      }
      if (timer) clearInterval(timer);
      timer = setInterval(() => {
        void exclusive(async () => {
          const res = await scan(false);
          if (res.changes) changed();
        }).catch((err: unknown) => ctx.log.warn({ err: (err as Error).message }, 'memory: rescan failed'));
      }, RESCAN_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    exclusive,
    list: (q) => repo().list(q).map(strip),
    get: (id) => repo().get(id),
    content,
    detail,
    resolve,
    targets,
    linkTargets,
    lookup,
    matchers,
    addAlias: (id, alias) => addAlias(id, alias),
    related,
    graph,
    info() {
      const c = repo().counts();
      return { folder, notes: c.notes, proposed: c.proposed, links: c.links, lastIndexedAt };
    },
    create,
    rewrite,
    move,
    aliasKeys: (id) => {
      const row = repo().get(id);
      return row ? aliasesByPath.get(row.path) ?? [] : [];
    },
    changed,
  };
}

export const isMemoryKind = (k: unknown): k is MemoryKind => typeof k === 'string' && (MEMORY_KINDS as readonly string[]).includes(k);
export const folderOfKind = (k: MemoryKind) => MEMORY_FOLDERS[k];
export { TRASH_FOLDER };
