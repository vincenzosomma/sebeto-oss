/**
 * Memory graph (v0.4 E, docs/28 v0.4 Plan.md §E): the team's long-term memory as linked notes.
 *
 * Notes are plain Markdown files in <workspace>/memory/ (Obsidian compatible: open that folder as a
 * vault). YAML frontmatter + body with [[wikilinks]]. Sebeto keeps an index (DB: memory_notes,
 * memory_links, memory_fts) rebuilt from the files: at start-up, on POST /memory/reindex, and after
 * its own writes. The owner may edit the files in Obsidian at any time.
 *
 * Folders (created on first use): systems/ apps/ cves/ runbooks/ decisions/ people/ tickets/ notes/
 * and proposed/ (agent proposals waiting for the owner).
 *
 * Frontmatter written by Sebeto (unknown keys are kept on rewrite):
 *   sebeto: { id, kind, provenance, untrusted, status, team, ticket }   tags: [...]
 * A file without `sebeto:` frontmatter (written by the owner) is: kind from its folder, provenance
 * 'owner', untrusted false, status 'approved'.
 *
 * Where notes come from:
 *  - owner: written in Obsidian or in the Memory page.
 *  - chief-of-staff: when a ticket moves to Completed, a short note tickets/T-<n> <title>.md (what
 *    happened, the fix, the systems) with [[links]] to the entities found; missing entity notes are
 *    created as stubs (kind system/app/cve…). Uses the planning model; a ticket of a team with
 *    lockRuntime is summarised on that team's runtime, or not at all. untrusted = the ticket's origin
 *    is untrusted OR any of its runs read untrusted content.
 *  - agent: the `memory_note` tool writes to proposed/ (status 'proposed'); agents never see proposed
 *    notes until the owner approves them (approve = move into the kind folder, status 'approved').
 *    An agent can never change an existing approved note: it can only propose a new version.
 *
 * Agent tools (Sebeto MCP, behind permissions):
 *   memory_related { name, depth?: 1|2, limit? }   memory.read  → the note for `name` (fuzzy title
 *        match) + its neighbours (links out, backlinks, 2nd hop when depth 2), compact lines.
 *   memory_read_note { title }                     memory.read  → one approved note (trimmed ~6 KB).
 *   memory_note { title, kind, body, links? }      memory.write → a proposal in proposed/.
 *   Untrusted notes in results are labelled and mark the run untrusted (outbound actions ask).
 *   search_memory (part A) also returns matching approved notes.
 *
 * API (under /api/v1):
 *   GET    /memory/notes?q=&kind=&team=&status=&limit=   → MemoryNote[] (newest first)
 *   GET    /memory/notes/:id                              → MemoryNoteDetail
 *   POST   /memory/notes   SaveMemoryNoteBody             → MemoryNoteDetail (201, owner note)
 *   PUT    /memory/notes/:id  SaveMemoryNoteBody          → MemoryNoteDetail (owner edit)
 *   DELETE /memory/notes/:id                              → 204 (moves the file to memory/.trash/)
 *   POST   /memory/notes/:id/approve                      → MemoryNoteDetail (proposal → approved)
 *   GET    /memory/graph?team=&kind=&center=&depth=&limit= → MemoryGraph (for the graph view)
 *   GET    /memory/related?name=&depth=                   → MemoryRelated
 *   POST   /memory/reindex                                → MemoryReindexResult
 *   GET    /memory/info                                   → MemoryInfo
 *   POST   /memory/backfill  MemoryBackfillBody           → MemoryBackfillResult (notes for already
 *          completed tickets; rules only, no AI, unless useModel is true)
 *
 * Ticket notes and owner text: the part of a ticket note above the line `<!-- sebeto:auto-end -->`
 * is Sebeto's and is rewritten when the ticket is completed again; everything below it is the
 * owner's and is kept. Removing the marker stops Sebeto from updating that note.
 * WebSocket: { type: 'memory.changed' }
 */
import type { Id, IsoDate } from './types.js';

export type MemoryKind = 'system' | 'app' | 'cve' | 'runbook' | 'decision' | 'person' | 'ticket' | 'note';
export const MEMORY_KINDS: readonly MemoryKind[] = ['system', 'app', 'cve', 'runbook', 'decision', 'person', 'ticket', 'note'] as const;
/** Folder of each kind inside <workspace>/memory/. */
export const MEMORY_FOLDERS: Record<MemoryKind, string> = {
  system: 'systems', app: 'apps', cve: 'cves', runbook: 'runbooks', decision: 'decisions', person: 'people', ticket: 'tickets', note: 'notes',
};
export const MEMORY_PROPOSED_FOLDER = 'proposed';

export type MemoryProvenance = 'owner' | 'chief-of-staff' | 'agent';
export type MemoryStatus = 'approved' | 'proposed';

export interface MemoryNote {
  id: Id;
  title: string;
  kind: MemoryKind;
  /** Path relative to the memory folder, '/' separators. */
  path: string;
  provenance: MemoryProvenance;
  /** Made from outside content (alert, email, web page, Claude Code session): read with care. */
  untrusted: boolean;
  status: MemoryStatus;
  teamSlug: string | null;
  ticketId: Id | null;
  tags: string[];
  /** First ~200 characters of the body, plain text. */
  excerpt: string;
  linkCount: number;
  backlinkCount: number;
  updatedAt: IsoDate;
}

export interface MemoryNoteDetail extends MemoryNote {
  body: string;
  links: string[];
  backlinks: Array<{ id: Id; title: string }>;
  /** obsidian://open?path=… link for the desktop app. */
  obsidianUrl: string;
}

export interface SaveMemoryNoteBody {
  title: string;
  kind: MemoryKind;
  body: string;
  tags?: string[];
  teamSlug?: string | null;
  /** Owner only: mark or clear the "made from outside content" flag (default: unchanged / false). */
  untrusted?: boolean;
}

export interface MemoryReindexResult { notes: number; links: number; ms: number }

export interface MemoryBackfillBody {
  /** Most completed tickets to look at (newest first), default 200, max 1000. */
  limit?: number;
  /** Count only; write nothing. */
  dryRun?: boolean;
  /** Use the planning model (costs money) for at most MEMORY_BACKFILL_MAX_MODEL_CALLS tickets; default false = rules only. */
  useModel?: boolean;
}
export const MEMORY_BACKFILL_MAX_MODEL_CALLS = 20;

export interface MemoryBackfillResult {
  /** Completed tickets looked at. */
  considered: number;
  /** Notes written (or that would be written, on a dry run). */
  written: number;
  /** Tickets that already had a note. */
  skipped: number;
  modelCalls: number;
  costUsd: number;
  dryRun: boolean;
}

export interface MemoryGraphNode { id: string; title: string; kind: MemoryKind | 'missing'; untrusted: boolean; status: MemoryStatus | null; teamSlug: string | null; degree: number }
export interface MemoryGraphEdge { from: string; to: string }
export interface MemoryGraph { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[]; truncated: boolean }

export interface MemoryRelated {
  note: MemoryNote | null;
  /** Neighbours with how they connect ('links to', 'linked from', '2 hops'). */
  neighbours: Array<{ note: MemoryNote; via: 'out' | 'in' | 'hop2' }>;
}

export interface MemoryInfo { folder: string; notes: number; proposed: number; links: number; lastIndexedAt: IsoDate | null }

/** Normalised link key: lower case, trimmed, inner spaces collapsed, no `|alias` / `#heading` part. */
export function memoryKey(title: string): string {
  return title.split('|')[0]!.split('#')[0]!.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** All [[wikilink]] targets in a Markdown body (keys, de-duplicated, in order). */
export function extractWikiLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)) {
    const k = memoryKey(m[1]!);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Safe file name for a note title (Windows + Obsidian friendly). */
export function memoryFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/[. ]+$/, '');
  return `${base || 'note'}.md`;
}

// ---------------------------------------------------------------- name matching (v0.5 J)
/**
 * How a name finds its note (v0.5 J, "memory aliases"):
 *  1. the note title, case-insensitive (memoryKey);
 *  2. an `aliases:` entry of the note's frontmatter (Obsidian standard), case-insensitive;
 *  3. a host name's first label: "fs01.naples.local" → the note "FS01" (or a note with alias "fs01").
 * Automatic matching in free text (rules-only ticket notes) also needs whole words and skips names
 * that are too short (< MEMORY_MIN_MATCH_CHARS) or common words, so "app" or "server" never link.
 * When the Chief of Staff links a host spelling to an existing note, that spelling is added to the
 * note's `aliases:` (owner text and other frontmatter keys are kept), instead of a duplicate stub.
 */
export const MEMORY_MIN_MATCH_CHARS = 3;

/** Words that never match automatically (English, Italian and generic IT words, DNS suffixes). */
export const MEMORY_COMMON_WORDS: ReadonlySet<string> = new Set([
  // English
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'not', 'are', 'was', 'were', 'has', 'have', 'had', 'but', 'all', 'any', 'can',
  'out', 'new', 'old', 'one', 'two', 'yes', 'its', 'our', 'you', 'your', 'they', 'them', 'then', 'than', 'when', 'what', 'who', 'how',
  'why', 'where', 'which', 'will', 'would', 'should', 'could', 'into', 'onto', 'over', 'under', 'about', 'after', 'before', 'also',
  'just', 'only', 'some', 'more', 'most', 'other', 'there', 'here', 'please', 'thanks', 'done', 'fixed', 'fix', 'note', 'notes',
  // Italian
  'che', 'non', 'per', 'con', 'una', 'uno', 'del', 'della', 'delle', 'dei', 'degli', 'gli', 'nel', 'nella', 'sul', 'sulla', 'come',
  'anche', 'sono', 'era', 'fatto', 'questo', 'questa', 'quello', 'quella', 'grazie', 'ciao',
  // generic IT words
  'server', 'servers', 'client', 'clients', 'user', 'users', 'admin', 'host', 'hosts', 'system', 'systems', 'service', 'services', 'app',
  'apps', 'web', 'api', 'data', 'file', 'files', 'disk', 'disks', 'mail', 'email', 'network', 'backup', 'backups', 'update', 'updates',
  'patch', 'error', 'errors', 'issue', 'issues', 'ticket', 'tickets', 'test', 'tests', 'prod', 'production', 'dev', 'log', 'logs',
  'config', 'setup', 'install', 'login', 'password', 'account', 'database', 'storage', 'printer', 'laptop', 'windows', 'linux',
  'share', 'folder', 'team', 'agent', 'task', 'job', 'run', 'restart', 'reboot', 'access', 'www', 'http', 'https',
  'localhost', 'local', 'lan', 'corp', 'home', 'internal', 'intranet', 'domain', 'com', 'net', 'org', 'info',
]);

/** File extensions: "report.pdf" is a file, not a host. */
const FILE_EXTENSIONS = new Set([
  'md', 'txt', 'pdf', 'log', 'exe', 'dll', 'msi', 'ps1', 'psm1', 'bat', 'cmd', 'sh', 'py', 'js', 'ts', 'json', 'yml', 'yaml', 'xml',
  'csv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', '7z', 'tar', 'gz', 'conf', 'cfg', 'ini', 'config', 'html', 'htm', 'png',
  'jpg', 'jpeg', 'gif', 'svg', 'iso', 'vhd', 'vhdx', 'bak', 'sql', 'db', 'eml', 'msg', 'jsonl',
]);

/** Whether a normalised name may match automatically (length, not a common word, not just digits). */
export function isMatchableName(key: string): boolean {
  const k = memoryKey(key);
  return k.length >= MEMORY_MIN_MATCH_CHARS && !MEMORY_COMMON_WORDS.has(k) && !/^[\d\s._-]+$/.test(k);
}

/**
 * The first label of a host name ("FS01.naples.local" → "fs01"), or null when the name is not a
 * dotted host name (an IP address, a file name, one label) or the label is not matchable.
 */
export function memoryHostLabel(name: string): string | null {
  const k = memoryKey(name);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)+\.?$/u.test(k)) return null;
  const labels = k.replace(/\.$/, '').split('.');
  if (labels.every((l) => /^\d+$/.test(l))) return null; // IPv4
  if (FILE_EXTENSIONS.has(labels[labels.length - 1]!)) return null;
  const first = labels[0]!;
  return isMatchableName(first) ? first : null;
}

/** Dotted host-like tokens in free text ("fs01.naples.local"), lower case, de-duplicated. */
export function hostTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_.-])[\p{L}\p{N}][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)+/gu)) {
    const tok = m[0].toLowerCase();
    if (memoryHostLabel(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}
