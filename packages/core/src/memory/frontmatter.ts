/**
 * YAML frontmatter of memory notes (Obsidian style):
 *
 *   ---
 *   sebeto:
 *     id: 0193…
 *     kind: system
 *     provenance: owner
 *     untrusted: false
 *     status: approved
 *     team: service-desk
 *     ticket: null
 *   tags: [fileserver, naples]
 *   aliases: [FS-01]
 *   ---
 *   body…
 *
 * Parsed with the `yaml` package (already a core dependency) on its core schema: no custom tags,
 * so a `!!python/object` or any other tag is never executed (it stays an inert string), aliases are
 * capped, and a broken block simply means "no frontmatter". Rewrites go through the YAML Document,
 * so keys Sebeto does not know (and their comments) are kept as they were.
 */
import { Document, isMap, parseDocument, type DocumentOptions, type ParseOptions, type SchemaOptions } from 'yaml';
import { MEMORY_KINDS, type MemoryKind, type MemoryProvenance, type MemoryStatus } from '@sebeto/shared';

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const EMPTY_FM_RE = /^﻿?---[ \t]*\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const PARSE_OPTS: ParseOptions & DocumentOptions & SchemaOptions = { schema: 'core', customTags: [], prettyErrors: false, uniqueKeys: false };

/** The `sebeto:` block. Every field is optional when read (owner files may have none). */
export interface SebetoMeta {
  id?: string;
  kind?: MemoryKind;
  provenance?: MemoryProvenance;
  untrusted?: boolean;
  status?: MemoryStatus;
  team?: string | null;
  ticket?: string | null;
  /** Ticket notes: when the ticket was completed (idempotent updates). */
  completed?: string | null;
  /** Proposals: the agent that proposed the note. */
  proposedBy?: string | null;
}

export interface ParsedNoteFile {
  /** The YAML document (null = the file had no usable frontmatter). */
  doc: Document | null;
  /** Whether a `sebeto:` block exists (otherwise the file is the owner's). */
  hasSebeto: boolean;
  sebeto: SebetoMeta;
  tags: string[];
  aliases: string[];
  body: string;
}

const PROVENANCES: readonly MemoryProvenance[] = ['owner', 'chief-of-staff', 'agent'];
const STATUSES: readonly MemoryStatus[] = ['approved', 'proposed'];

const strOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim().replace(/^#/, '') : '')).filter(Boolean).slice(0, 50);
}

function readSebeto(v: unknown): SebetoMeta {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const o = v as Record<string, unknown>;
  const meta: SebetoMeta = {};
  if (typeof o.id === 'string' && /^[0-9A-Za-z-]{8,64}$/.test(o.id)) meta.id = o.id;
  if (typeof o.kind === 'string' && (MEMORY_KINDS as readonly string[]).includes(o.kind)) meta.kind = o.kind as MemoryKind;
  if (typeof o.provenance === 'string' && (PROVENANCES as readonly string[]).includes(o.provenance)) meta.provenance = o.provenance as MemoryProvenance;
  if (typeof o.untrusted === 'boolean') meta.untrusted = o.untrusted;
  if (typeof o.status === 'string' && (STATUSES as readonly string[]).includes(o.status)) meta.status = o.status as MemoryStatus;
  for (const k of ['team', 'ticket', 'completed', 'proposedBy'] as const) {
    const s = strOrNull(o[k]);
    if (s !== undefined) meta[k] = s ? s.slice(0, 200) : null;
  }
  return meta;
}

/** Split a note file into frontmatter + body. Never throws. */
export function parseNoteFile(text: string): ParsedNoteFile {
  const empty = EMPTY_FM_RE.exec(text);
  if (empty) return { doc: null, hasSebeto: false, sebeto: {}, tags: [], aliases: [], body: text.slice(empty[0].length) };
  const m = FM_RE.exec(text);
  if (!m) return { doc: null, hasSebeto: false, sebeto: {}, tags: [], aliases: [], body: text.replace(/^﻿/, '') };
  const body = text.slice(m[0].length);
  let doc: Document;
  try {
    doc = parseDocument(m[1]!, PARSE_OPTS);
  } catch {
    return { doc: null, hasSebeto: false, sebeto: {}, tags: [], aliases: [], body };
  }
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) {
    // Not a key/value block we understand: treat it as text the owner wrote, keep it untouched.
    return { doc: null, hasSebeto: false, sebeto: {}, tags: [], aliases: [], body: text.replace(/^﻿/, '') };
  }
  let js: Record<string, unknown> = {};
  try {
    const v: unknown = doc.toJS({ maxAliasCount: 20 });
    if (v && typeof v === 'object' && !Array.isArray(v)) js = v as Record<string, unknown>;
  } catch {
    return { doc: null, hasSebeto: false, sebeto: {}, tags: [], aliases: [], body: text.replace(/^﻿/, '') };
  }
  return {
    doc, hasSebeto: js.sebeto !== undefined && js.sebeto !== null && typeof js.sebeto === 'object',
    sebeto: readSebeto(js.sebeto), tags: stringList(js.tags), aliases: stringList(js.aliases), body,
  };
}

export interface WriteMeta {
  sebeto: SebetoMeta;
  tags?: string[];
}

/**
 * Render a note file. `previous` (the parsed old file) keeps its unknown keys; `sebeto` and `tags`
 * are set from `meta` (aliases and everything else stay as the owner wrote them).
 */
export function renderNoteFile(meta: WriteMeta, body: string, previous?: ParsedNoteFile | null): string {
  const doc = previous?.doc ? previous.doc.clone() : new Document({}, PARSE_OPTS);
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as typeof doc.contents;
  const s = meta.sebeto;
  const block: Record<string, unknown> = {};
  for (const k of ['id', 'kind', 'provenance', 'untrusted', 'status', 'team', 'ticket', 'completed', 'proposedBy'] as const) {
    if (s[k] !== undefined) block[k] = s[k];
  }
  doc.set('sebeto', doc.createNode(block));
  if (meta.tags !== undefined) {
    if (meta.tags.length) {
      const node = doc.createNode(meta.tags);
      (node as { flow?: boolean }).flow = true;
      doc.set('tags', node);
    } else doc.delete('tags');
  }
  const yaml = doc.toString({ lineWidth: 0 }).trimEnd();
  const text = body.replace(/^\s*\n/, '');
  return `---\n${yaml}\n---\n${text.endsWith('\n') ? text : `${text}\n`}`;
}

/** Most aliases a note may get automatically (the owner may write more by hand). */
export const MAX_AUTO_ALIASES = 30;

/**
 * Add one spelling to a note's `aliases:` list (v0.5 J), keeping everything else exactly as the owner
 * wrote it: the body, other keys and their comments; no `sebeto:` block is added to an owner note.
 * Returns the new file text, or null when nothing should change: the alias is already there (any
 * case), the list is full, or the frontmatter is broken (never rewrite what we cannot parse).
 */
export function addAliasToText(text: string, alias: string): string | null {
  const clean = alias.replace(/[\r\n\t]/g, ' ').trim().slice(0, 120);
  if (!clean) return null;
  const parsed = parseNoteFile(text);
  if (parsed.aliases.some((a) => a.toLowerCase() === clean.toLowerCase())) return null;
  if (parsed.aliases.length >= MAX_AUTO_ALIASES) return null;
  let doc: Document;
  if (parsed.doc) doc = parsed.doc.clone();
  else {
    // Frontmatter we could not parse: leave the file alone (an empty block is fine).
    if (/^﻿?---[ \t]*\r?\n/.test(text) && !EMPTY_FM_RE.test(text)) return null;
    doc = new Document({}, PARSE_OPTS);
  }
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as typeof doc.contents;
  const node = doc.createNode([...parsed.aliases, clean]);
  (node as { flow?: boolean }).flow = true;
  doc.set('aliases', node);
  return `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${parsed.body}`;
}
