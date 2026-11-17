/**
 * Memory graph services (v0.4 §E): what the API and the agent tools call.
 *
 *  - Owner (API): create / edit / delete (to .trash/) / approve proposals. Owner text is kept as
 *    written; an edit changes only that note (other notes' provenance never changes).
 *  - Agents (tools/server.ts): proposals only, into proposed/; never visible to agents until the
 *    owner approves them; an approved note is never changed by an agent.
 *  - Every write goes into the security log; every change publishes `memory.changed`.
 */
import {
  MEMORY_FOLDERS, MEMORY_PROPOSED_FOLDER, memoryFileName, memoryKey, normalizeTags,
  type Id, type MemoryBackfillBody, type MemoryBackfillResult, type MemoryGraph, type MemoryInfo, type MemoryKind, type MemoryNote,
  type MemoryNoteDetail, type MemoryReindexResult, type MemoryRelated, type MemoryStatus, type SaveMemoryNoteBody, type SecurityActor,
} from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { AppError, badRequest, conflict, notFound, unavailable } from '../services/errors.js';
import { MAX_NOTE_BYTES, MemoryPathError, TRASH_FOLDER, freeName } from './files.js';
import { backfillTicketNotes, followCompletedTickets, redactNote } from './ticket-notes.js';
import { createMemoryVault, type MemoryVault } from './vault.js';

const OWNER: SecurityActor = { type: 'user', id: null, name: 'You' };

function vaultOf(ctx: AppContext): MemoryVault {
  if (!ctx.memory) throw unavailable('The memory is not available.');
  return ctx.memory;
}

/** Map file errors to API errors. */
function mapError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (err instanceof MemoryPathError) throw badRequest(err.message, 'memory_path');
  if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw conflict('A note with that name already exists.', 'memory_exists');
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('Memory note file', '');
  throw err;
}

const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    return mapError(err);
  }
};

/** Create the vault, scan it, follow completed tickets. Returns a stop function. */
export async function startMemory(ctx: AppContext): Promise<() => void> {
  if (!ctx.repos.memoryIndex) return () => undefined;
  const vault = createMemoryVault(ctx);
  ctx.memory = vault;
  await vault.start();
  const unsubscribe = followCompletedTickets(ctx, vault);
  return () => {
    unsubscribe();
    vault.stop();
  };
}

// ---------------------------------------------------------------- read
export function listMemoryNotes(ctx: AppContext, q: { q?: string; kind?: MemoryKind; team?: string; status?: MemoryStatus; limit?: number }): MemoryNote[] {
  return vaultOf(ctx).list({ ...q, limit: q.limit ?? 200 });
}

export async function getMemoryNote(ctx: AppContext, id: Id): Promise<MemoryNoteDetail> {
  const d = await vaultOf(ctx).detail(id, { includeProposed: true });
  if (!d) throw notFound('Memory note', id);
  return d;
}

export function memoryGraph(ctx: AppContext, q: { team?: string; kind?: MemoryKind; center?: Id; depth?: 1 | 2; limit?: number; includeProposed?: boolean; q?: string }): MemoryGraph {
  return vaultOf(ctx).graph(q);
}

export function memoryRelated(ctx: AppContext, q: { name: string; depth?: 1 | 2; limit?: number }): MemoryRelated {
  return vaultOf(ctx).related(q.name, { ...q, approvedOnly: true });
}

export function memoryInfo(ctx: AppContext): MemoryInfo {
  return vaultOf(ctx).info();
}

export async function reindexMemory(ctx: AppContext): Promise<MemoryReindexResult> {
  return vaultOf(ctx).reindex({ full: true });
}

export async function backfillMemory(ctx: AppContext, body: MemoryBackfillBody): Promise<MemoryBackfillResult> {
  return backfillTicketNotes(ctx, vaultOf(ctx), body);
}

// ---------------------------------------------------------------- owner writes
function cleanTitle(title: string): string {
  // No leading dots or slashes: ".x" would be a hidden file Obsidian and the index ignore.
  const t = memoryFileName(title.replace(/^[\s./\\]+/, '')).replace(/\.md$/, '');
  if (!title.trim() || (t === 'note' && memoryKey(title) !== 'note')) throw badRequest('Give the note a title.', 'memory_title');
  return t;
}

function checkBody(body: string): void {
  if (Buffer.byteLength(body, 'utf8') > MAX_NOTE_BYTES - 2048) throw badRequest(`The note is too long (limit about ${MAX_NOTE_BYTES / 1024 - 2} KB).`, 'memory_too_long');
}

function teamOf(ctx: AppContext, slug: string | null | undefined): string | null {
  if (!slug) return null;
  if (ctx.repos.teams && !ctx.repos.teams.bySlug(slug)) throw badRequest(`There is no team "${slug}".`, 'memory_team');
  return slug;
}

export async function createMemoryNote(ctx: AppContext, body: SaveMemoryNoteBody): Promise<MemoryNoteDetail> {
  const vault = vaultOf(ctx);
  const title = cleanTitle(body.title);
  checkBody(body.body);
  const team = teamOf(ctx, body.teamSlug);
  const row = await guard(() => vault.exclusive(async () => {
    if (vault.targets(memoryKey(title)).length) throw conflict(`A note called "${title}" already exists. Open it and edit it instead.`, 'memory_exists');
    return vault.create(MEMORY_FOLDERS[body.kind], title, {
      kind: body.kind, provenance: 'owner', untrusted: body.untrusted === true, status: 'approved', team, ticket: null,
    }, body.body, normalizeTags(body.tags ?? []));
  }));
  ctx.securityLog?.record({ category: 'config', action: 'memory.note_written', actor: OWNER, summary: `Wrote the memory note "${row.title}"`, data: { noteId: row.id, path: row.path, kind: row.kind } });
  vault.changed();
  return getMemoryNote(ctx, row.id);
}

export async function updateMemoryNote(ctx: AppContext, id: Id, body: SaveMemoryNoteBody): Promise<MemoryNoteDetail> {
  const vault = vaultOf(ctx);
  checkBody(body.body);
  const team = body.teamSlug === undefined ? undefined : teamOf(ctx, body.teamSlug);
  const row = await guard(() => vault.exclusive(async () => {
    const c = await vault.content(id);
    if (!c) throw notFound('Memory note', id);
    const cur = c.row;
    const title = cleanTitle(body.title);
    const s = c.parsed.hasSebeto ? c.parsed.sebeto : {};
    const meta = {
      ...s, id: cur.id, kind: body.kind, provenance: cur.provenance, status: cur.status,
      untrusted: body.untrusted ?? cur.untrusted, team: team === undefined ? cur.teamSlug : team, ticket: cur.ticketId,
    };
    // Rename / move when the title or kind changed (approved notes live in their kind folder).
    let rel = cur.path;
    const titleChanged = title !== cur.title;
    const kindChanged = body.kind !== cur.kind && cur.status === 'approved';
    if (titleChanged || kindChanged) {
      if (titleChanged && vault.targets(memoryKey(title)).some((n) => n.id !== cur.id)) throw conflict(`A note called "${title}" already exists.`, 'memory_exists');
      const dir = cur.status === 'proposed' ? MEMORY_PROPOSED_FOLDER : kindChanged ? MEMORY_FOLDERS[body.kind] : cur.path.split('/').slice(0, -1).join('/');
      const target = await freeName(vault.folder, dir, memoryFileName(title), { ignore: cur.path });
      if (target.toLowerCase() !== cur.path.toLowerCase()) {
        await vault.move(cur.path, target);
        rel = target;
      }
    }
    return vault.rewrite(rel, meta, body.body, body.tags !== undefined ? normalizeTags(body.tags) : c.parsed.tags);
  }));
  ctx.securityLog?.record({
    category: 'config', action: 'memory.note_edited', actor: OWNER, summary: `Edited the memory note "${row.title}"`,
    data: { noteId: row.id, path: row.path, kind: row.kind, provenance: row.provenance, untrusted: row.untrusted },
  });
  vault.changed();
  return getMemoryNote(ctx, row.id);
}

/** Move the note to memory/.trash/ (never a hard delete). */
export async function deleteMemoryNote(ctx: AppContext, id: Id): Promise<void> {
  const vault = vaultOf(ctx);
  const row = await guard(() => vault.exclusive(async () => {
    const cur = vault.get(id);
    if (!cur) throw notFound('Memory note', id);
    const dir = [TRASH_FOLDER, ...cur.path.split('/').slice(0, -1)].join('/');
    const target = await freeName(vault.folder, dir, cur.path.split('/').pop()!, { allowHidden: true });
    await vault.move(cur.path, target, { toHidden: true });
    return { ...cur, trashed: target };
  }));
  ctx.securityLog?.record({
    category: 'config', action: 'memory.note_deleted', actor: OWNER, summary: `Moved the memory note "${row.title}" to the trash`,
    data: { noteId: row.id, path: row.path, trash: row.trashed, status: row.status, provenance: row.provenance },
  });
  vault.changed();
}

/** Proposal → its kind folder, status approved (a clash gets " 2"). */
export async function approveMemoryNote(ctx: AppContext, id: Id): Promise<MemoryNoteDetail> {
  const vault = vaultOf(ctx);
  const row = await guard(() => vault.exclusive(async () => {
    const c = await vault.content(id);
    if (!c) throw notFound('Memory note', id);
    if (c.row.status !== 'proposed') throw conflict('This note is already approved.', 'memory_not_proposed');
    const target = await freeName(vault.folder, MEMORY_FOLDERS[c.row.kind], `${c.row.title}.md`);
    await vault.move(c.row.path, target);
    return vault.rewrite(target, { ...c.parsed.sebeto, id: c.row.id, kind: c.row.kind, status: 'approved' }, c.body, c.parsed.tags);
  }));
  ctx.securityLog?.record({
    category: 'config', action: 'memory.note_approved', severity: row.untrusted ? 'notice' : 'info', actor: OWNER,
    ticketId: row.ticketId, summary: `Approved the memory note "${row.title}" proposed by ${row.provenance === 'agent' ? 'an agent' : row.provenance}`,
    data: { noteId: row.id, path: row.path, kind: row.kind, provenance: row.provenance, untrusted: row.untrusted, approvedBy: 'owner' },
  });
  vault.changed();
  return getMemoryNote(ctx, row.id);
}

// ---------------------------------------------------------------- agent proposals
export interface ProposalInput { title: string; kind: MemoryKind; body: string; links?: string[] }
export interface ProposalScope { ticketId: Id; runId: Id; sessionId: Id; agentId: Id | null; untrusted: boolean }

/**
 * An agent's note proposal, written into proposed/ only (redacted). It never touches an approved
 * note: a proposal with the title of an existing note is a "new version" the owner can approve
 * (it then becomes "<title> 2") or delete.
 */
export async function proposeMemoryNote(ctx: AppContext, scope: ProposalScope, input: ProposalInput): Promise<{ note: MemoryNote; replaces: boolean }> {
  const vault = vaultOf(ctx);
  const title = cleanTitle(redactNote(ctx, input.title));
  const links = (input.links ?? []).map((l) => l.replace(/[[\]|#\r\n]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 20);
  let body = redactNote(ctx, input.body.trim());
  if (links.length) body += `\n\nRelated: ${links.map((l) => `[[${redactNote(ctx, l)}]]`).join(', ')}`;
  checkBody(body);
  const agent = scope.agentId ? ctx.repos.agents.get(scope.agentId) : undefined;
  const teamSlug = agent?.teamId ? ctx.repos.teams?.get(agent.teamId)?.slug ?? null : null;
  const replaces = vault.targets(memoryKey(title)).length > 0;
  const row = await vault.exclusive(() => vault.create(MEMORY_PROPOSED_FOLDER, title, {
    kind: input.kind, provenance: 'agent', untrusted: scope.untrusted, status: 'proposed', team: teamSlug, ticket: scope.ticketId,
    proposedBy: agent?.name ?? 'Agent',
  }, `${body}\n`));
  ctx.securityLog?.record({
    category: 'tool', action: 'memory.note_proposed', severity: scope.untrusted ? 'notice' : 'info',
    actor: { type: 'agent', id: scope.agentId, name: agent?.name ?? 'Agent' },
    ticketId: scope.ticketId, agentId: scope.agentId, sessionId: scope.sessionId, runId: scope.runId,
    summary: `Proposed the memory note "${row.title}" (waits for your approval)`,
    data: { noteId: row.id, path: row.path, kind: row.kind, untrusted: scope.untrusted, replacesExisting: replaces, bytes: Buffer.byteLength(body) },
  });
  vault.changed();
  const { key: _k, sha256: _s, ...note } = row;
  return { note, replaces };
}
