/**
 * Session library and agent memory (v0.4 §A, packages/shared/src/sessions.ts).
 *
 *  - Auto-filing: every Sebeto ticket that has a session gets one 'sebeto' entry that follows the
 *    ticket (title, goal + latest outcome, team/tag category, tags, cost). Refreshed on ticket.updated
 *    and backfilled once at startup (idempotent).
 *  - Discovery: POST /sessions/scan reads Claude Code session files READ-ONLY (claude-sessions.ts).
 *  - Open: an external session becomes a new ticket that resumes it (claude --resume); a Completed
 *    Sebeto ticket is moved back to Needs you.
 *  - Memory: search/read helpers used by the search_memory / read_memory agent tools.
 * Everything that goes into a title or summary passes through the diagnostics redactor first.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_MEMORY_RESULTS, normalizeTag, normalizeTags,
  type Id, type OpenSessionBody, type OpenSessionResponse, type Page, type SessionCategoryCount, type SessionEntry,
  type SessionScanResult, type SessionSource, type SessionTranscript, type SessionTranscriptTurn, type Ticket, type UpdateSessionEntryBody,
} from '@sebeto/shared';
import type { AppContext, SessionEntryInput, SessionEntryRepo, StoredSessionEntry } from '../contracts.js';
import { createRedactor, type Redactor } from '../diagnostics/redact.js';
import { publicEntry } from '../storage/sessions.js';
import { badRequest, conflict, notFound, unavailable } from './errors.js';
import { createTicket } from './tickets.js';
import {
  MAX_SUMMARY, MAX_TITLE, MAX_TURN_TEXT, claudeConfigDir, clip, encodeProjectDir, isSessionFileName, readClaudeSession, readClaudeTranscript,
} from './claude-sessions.js';

export const DEFAULT_TRANSCRIPT_TURNS = 30;
export const MAX_TRANSCRIPT_TURNS = 200;
const GOAL_IN_SUMMARY = 200;
const OUTCOME_IN_SUMMARY = MAX_SUMMARY - GOAL_IN_SUMMARY - 10;

function library(ctx: AppContext): SessionEntryRepo {
  const lib = ctx.repos.sessionLibrary;
  if (!lib) throw unavailable('The session library is not available.');
  return lib;
}

const redactors = new WeakMap<AppContext, Redactor>();
/** Secrets out of every title and summary (API token, key=value secrets, bearer tokens, keys, e-mail local parts). */
function redactorFor(ctx: AppContext): Redactor {
  let r = redactors.get(ctx);
  if (!r) {
    r = createRedactor({ homeDir: null, userName: null, secrets: [ctx.config?.apiToken] });
    redactors.set(ctx, r);
  }
  return r;
}

const changedEvent = (ctx: AppContext) => ctx.bus.publish({ type: 'sessions.changed' });

function requireEntry(ctx: AppContext, id: Id): StoredSessionEntry {
  const e = library(ctx).getStored(id);
  if (!e || e.hidden) throw notFound('Session', id);
  return e;
}

// ---------------------------------------------------------------- auto-filing of Sebeto sessions
/** Category of a ticket's entry: its team slug, else its first tag, else ''. */
function autoCategory(teamSlug: string | null, tags: readonly string[]): string {
  return teamSlug ?? tags[0] ?? '';
}

/**
 * Add or refresh the library entry of a Sebeto ticket. Returns true when something changed.
 * The owner's own category stays: it is replaced only while it is empty or still an automatic one
 * (a team slug or one of the ticket's tags).
 */
export function fileTicketSession(ctx: AppContext, ticketOrId: Ticket | Id): boolean {
  const lib = ctx.repos.sessionLibrary;
  if (!lib) return false;
  const ticket = typeof ticketOrId === 'string' ? ctx.repos.tickets.get(ticketOrId) : ticketOrId;
  if (!ticket) return false;
  const facts = lib.ticketFacts(ticket.id);
  if (!facts) return false; // never started: nothing to file yet
  const redact = redactorFor(ctx);
  const tags = ticket.tags ?? [];
  const outcome = facts.lastAgentText ?? facts.lastStatusNote ?? '';
  const goal = clip(ticket.goal, GOAL_IN_SUMMARY);
  const summary = redact(clip([goal, outcome ? `Outcome: ${clip(outcome, OUTCOME_IN_SUMMARY)}` : ''].filter(Boolean).join(' — '), MAX_SUMMARY));
  const values = {
    sessionId: facts.latestSessionId,
    externalSessionId: facts.externalSessionId,
    title: redact(clip(ticket.title, MAX_TITLE)) || `T-${ticket.number}`,
    summary,
    tags,
    runtime: facts.runtime,
    model: facts.model,
    messageCount: facts.messageCount,
    costUsd: Math.round(facts.costUsd * 1e6) / 1e6,
    startedAt: facts.startedAt,
    lastActivityAt: facts.lastActivityAt,
  };
  const category = autoCategory(facts.teamSlug, tags);
  const existing = lib.findSebeto(ticket.id);
  if (!existing) {
    lib.insert({ source: 'sebeto', ticketId: ticket.id, cwd: null, category, ...values });
    return true;
  }
  // The owner's category is kept (v0.5 K: categorySource 'owner'); a suggested one ('auto'/'rules')
  // gives way to the ticket's own team or tag, but is not wiped when the ticket has neither.
  const suggested = existing.categorySource === 'auto' || existing.categorySource === 'rules';
  const automatic = existing.categorySource !== 'owner'
    && (existing.category === '' || tags.includes(existing.category) || lib.isTeamSlug(existing.category) || (suggested && category !== ''));
  const patch: Partial<SessionEntryInput> = {};
  for (const [k, v] of Object.entries(values) as Array<[keyof typeof values, unknown]>) {
    const cur = existing[k as keyof StoredSessionEntry];
    if (JSON.stringify(cur) !== JSON.stringify(v)) (patch as Record<string, unknown>)[k] = v;
  }
  if (automatic && existing.category !== category && !(suggested && category === '')) {
    patch.category = category;
    patch.categorySource = null;
  }
  if (!Object.keys(patch).length) return false;
  lib.patch(existing.id, patch);
  return !existing.hidden;
}

/** File every ticket that has a session (startup; idempotent). Returns how many entries changed. */
export function backfillSessionLibrary(ctx: AppContext): number {
  const lib = ctx.repos.sessionLibrary;
  if (!lib) return 0;
  let changed = 0;
  for (const ticketId of lib.ticketsWithSessions()) {
    try {
      if (fileTicketSession(ctx, ticketId)) changed++;
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, ticketId }, 'session library: filing failed');
    }
  }
  if (changed) changedEvent(ctx);
  return changed;
}

/** Backfill once, then keep entries in step with their tickets. Returns the unsubscribe function. */
export function startSessionLibrary(ctx: AppContext): () => void {
  if (!ctx.repos.sessionLibrary) return () => undefined;
  const n = backfillSessionLibrary(ctx);
  if (n) ctx.log.info({ entries: n }, 'session library: filed existing sessions');
  return ctx.bus.subscribe((event) => {
    if (event.type !== 'ticket.updated') return;
    try {
      if (fileTicketSession(ctx, event.ticket.id)) changedEvent(ctx);
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message, ticketId: event.ticket.id }, 'session library: filing failed');
    }
  });
}

// ---------------------------------------------------------------- list / get / update / delete
export function listSessions(ctx: AppContext, query: { q?: string; category?: string; source?: SessionSource; cursor?: string; limit?: number }): Page<SessionEntry> {
  return library(ctx).list({
    ...(query.q ? { q: query.q } : {}),
    ...(query.category ? { category: query.category === '-' ? '-' : normalizeTag(query.category) ?? '-' } : {}),
    ...(query.source ? { source: query.source } : {}),
    cursor: query.cursor ?? null,
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });
}

export function sessionCategories(ctx: AppContext): SessionCategoryCount[] {
  return library(ctx).categories();
}

export function getSession(ctx: AppContext, id: Id): SessionEntry {
  return publicEntry(requireEntry(ctx, id));
}

export function updateSession(ctx: AppContext, id: Id, body: UpdateSessionEntryBody): SessionEntry {
  requireEntry(ctx, id);
  const redact = redactorFor(ctx);
  const patch: Partial<SessionEntryInput> = {};
  if (body.title !== undefined) {
    const t = redact(clip(body.title, MAX_TITLE));
    if (!t) throw badRequest('Give the session a title.', 'session_title');
    patch.title = t;
  }
  if (body.summary !== undefined) patch.summary = redact(clip(body.summary, MAX_SUMMARY));
  if (body.category !== undefined) {
    // Normalised like a tag; '' (or nothing usable) clears it.
    patch.category = body.category.trim() ? normalizeTag(body.category) ?? '' : '';
    // v0.5 K: the owner's choice is never replaced by suggestions; clearing it makes it free again.
    patch.categorySource = patch.category ? 'owner' : null;
  }
  if (body.tags !== undefined) patch.tags = normalizeTags(body.tags);
  if (body.pinned !== undefined) patch.pinned = body.pinned;
  const entry = library(ctx).patch(id, patch);
  changedEvent(ctx);
  return publicEntry(entry);
}

/** Remove from the library (a hidden tombstone): never touches files or tickets. */
export function deleteSession(ctx: AppContext, id: Id): void {
  const e = requireEntry(ctx, id);
  library(ctx).patch(id, { hidden: true, pinned: false });
  ctx.securityLog?.record({
    category: 'session', action: 'session.removed', actor: { type: 'user', id: null, name: 'You' },
    ticketId: e.ticketId, summary: `Removed "${e.title}" from the session library`, data: { entryId: id, source: e.source },
  });
  changedEvent(ctx);
}

// ---------------------------------------------------------------- scan Claude Code sessions
/** Folders of agent runs of other Sebeto workspaces (…-sebeto-…-tickets-T-12, …-sebeto-…-intake): not the owner's chats. */
const SEBETO_RUN_DIR_RE = /sebeto.*-(tickets-T-\d+|intake)$/i;

export interface ScanOptions {
  /** Claude Code config folder (default: claudeConfigDir()). */
  claudeDir?: string;
}

/**
 * Find Claude Code sessions on this computer. READ-ONLY on ~/.claude. Skips unchanged files, Sebeto's
 * own ticket and intake sessions (folders under the workspace) and entries the owner removed.
 */
export async function scanSessions(ctx: AppContext, opts: ScanOptions = {}): Promise<SessionScanResult> {
  const lib = library(ctx);
  const redact = redactorFor(ctx);
  const projects = path.join(opts.claudeDir ?? claudeConfigDir(), 'projects');
  const result: SessionScanResult = { found: 0, added: 0, updated: 0, skipped: 0 };
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(projects, { withFileTypes: true });
  } catch {
    return result; // Claude Code not used on this computer
  }
  // Sessions that Sebeto itself runs (tickets/T-n, intake) live in folders named after the workspace.
  const own = encodeProjectDir(ctx.config.workspaceDir).toLowerCase();
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    if (dir.name.toLowerCase().startsWith(own) || SEBETO_RUN_DIR_RE.test(dir.name)) continue;
    const folder = path.join(projects, dir.name);
    let files: fs.Dirent[];
    try {
      files = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !isSessionFileName(f.name)) continue; // symlinks and sub-folders are skipped
      result.found++;
      const file = path.join(folder, f.name);
      try {
        const stat = await fs.promises.stat(file);
        const mtime = stat.mtime.toISOString();
        const id = path.basename(f.name, '.jsonl');
        const existing = lib.findExternal('claude-code', id);
        if (existing && (existing.hidden || existing.fileMtime === mtime)) {
          result.skipped++;
          continue;
        }
        // A session Sebeto already runs as a ticket: link, don't duplicate.
        if (!existing) {
          const own = lib.sebetoSessionByExternal(id);
          if (own) {
            const seb = lib.findSebeto(own.ticketId);
            if (seb && !seb.externalSessionId) lib.patch(seb.id, { externalSessionId: id });
            result.skipped++;
            continue;
          }
        }
        const info = await readClaudeSession(file);
        if (existing) {
          // Title, category, tags and pin are the owner's; refresh what the session itself changed.
          lib.patch(existing.id, {
            summary: redact(info.summary),
            messageCount: info.messageCount, lastActivityAt: info.lastActivityAt, model: info.model ?? existing.model,
            fileMtime: mtime, filePath: existing.filePath ?? file,
          });
          result.updated++;
        } else {
          lib.insert({
            source: 'claude-code', externalSessionId: id, sessionId: null, ticketId: null,
            title: redact(info.title) || 'Claude Code session', summary: redact(info.summary), category: '', tags: [],
            cwd: info.cwd, filePath: file, fileMtime: mtime, runtime: 'claude-cli', model: info.model,
            messageCount: info.messageCount, costUsd: 0, startedAt: info.startedAt, lastActivityAt: info.lastActivityAt,
          });
          result.added++;
        }
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message }, 'session library: could not read a Claude Code session file');
        result.skipped++;
      }
    }
  }
  ctx.securityLog?.record({
    category: 'session', action: 'session.scanned', actor: { type: 'user', id: null, name: 'You' },
    summary: `Scanned this computer for Claude Code sessions: ${result.found} found, ${result.added} new`, data: { ...result },
  });
  if (result.added || result.updated) changedEvent(ctx);
  return result;
}

// ---------------------------------------------------------------- transcript preview
export async function sessionTranscript(ctx: AppContext, id: Id, limit = DEFAULT_TRANSCRIPT_TURNS): Promise<SessionTranscript> {
  const e = requireEntry(ctx, id);
  const max = Math.min(MAX_TRANSCRIPT_TURNS, Math.max(1, Math.floor(limit)));
  if (e.source === 'sebeto') {
    if (!e.ticketId) return { entryId: id, turns: [], truncated: false };
    const rows = library(ctx).recentMessages(e.ticketId, max + 1);
    const turns: SessionTranscriptTurn[] = rows.slice(-max).map((m) => ({
      role: m.role === 'user' ? 'user' : m.role === 'agent' || m.role === 'handoff' ? 'agent' : 'system',
      text: m.text.length > MAX_TURN_TEXT ? `${m.text.slice(0, MAX_TURN_TEXT - 1)}…` : m.text,
      at: m.at,
    }));
    return { entryId: id, turns, truncated: rows.length > max };
  }
  if (!e.filePath || !fs.existsSync(e.filePath)) return { entryId: id, turns: [], truncated: false };
  const { turns, truncated } = await readClaudeTranscript(e.filePath, max);
  const redact = redactorFor(ctx);
  return { entryId: id, turns: turns.map((t) => ({ ...t, text: redact(t.text) })), truncated };
}

// ---------------------------------------------------------------- open
/** Copy a session file so Claude Code finds it from the ticket folder (`claude --resume` looks in the cwd's project folder). */
async function copyForResume(file: string, sessionId: string, ticketFolder: string, claudeDir: string): Promise<string> {
  const destDir = path.join(claudeDir, 'projects', encodeProjectDir(ticketFolder));
  await fs.promises.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${sessionId}.jsonl`);
  try {
    await fs.promises.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return dest;
}

export async function openSession(ctx: AppContext, id: Id, body: OpenSessionBody = {}, opts: ScanOptions = {}): Promise<OpenSessionResponse> {
  const e = requireEntry(ctx, id);
  const lib = library(ctx);
  const linked = e.ticketId ? ctx.repos.tickets.get(e.ticketId) : undefined;

  if (e.source === 'sebeto' || linked) {
    if (!linked) throw conflict('The ticket of this session no longer exists.', 'ticket_missing');
    if (linked.status !== 'done') return { ticket: linked, action: 'existing' };
    // A Completed ticket goes back to "Needs you": the owner gives the next instruction and the agent
    // continues the same session. (Backlog would mean "never started".) Only the user may reopen.
    const ticket = ctx.state.transition(linked.id, 'needs_you', 'user', { note: 'Reopened from the session library' });
    ctx.securityLog?.record({
      category: 'session', action: 'session.reopened', actor: { type: 'user', id: null, name: 'You' },
      ticketId: ticket.id, sessionId: e.sessionId, summary: `Reopened T-${ticket.number} from the session library`, data: { entryId: id },
    });
    changedEvent(ctx);
    return { ticket, action: 'reopened' };
  }

  // claude-code → a new ticket that resumes the same conversation.
  if (!e.externalSessionId || !/^[0-9a-f-]{36}$/i.test(e.externalSessionId)) throw conflict('This session has no Claude Code id.', 'session_invalid');
  if (!ctx.runtimes.get('claude-cli')) throw conflict('Claude Code is not enabled in Sebeto, so this session cannot be continued.', 'runtime_unavailable');
  if (!e.filePath || !fs.existsSync(e.filePath)) throw conflict('The session file is no longer on this computer. Scan again.', 'session_file_missing');

  let teamId: Id | null = null;
  if (body.teamId) {
    if (!lib.teamSlug(body.teamId)) throw badRequest(`Team ${body.teamId} does not exist`, 'unknown_team');
    teamId = body.teamId;
  }
  const agentId = body.agentId ?? (teamId ? lib.teamLead(teamId) : null);
  const title = clip(body.title?.trim() || e.title, 200) || 'Continue Claude Code session';
  const created = await createTicket(ctx, {
    title,
    goal: `Continue the earlier Claude Code session: ${e.summary || e.title}`,
    agentId,
    runtime: 'claude-cli',
    projectId: body.projectId ?? null,
    tags: e.tags,
  });
  const session = ctx.repos.sessions.create({
    ticketId: created.id, agentId: created.agentId, runtime: 'claude-cli', model: e.model, reason: 'import', externalSessionId: e.externalSessionId,
  });
  const ticket = ctx.repos.tickets.update(created.id, {
    currentSessionId: session.id,
    origin: { kind: 'session', sessionEntryId: id, source: 'Claude Code session', untrusted: true },
    ...(teamId ? { teamId } : {}),
  });
  const copied = await copyForResume(e.filePath, e.externalSessionId, ticket.folder, opts.claudeDir ?? claudeConfigDir());
  lib.patch(id, { ticketId: ticket.id });
  const event = ctx.repos.audit.append({
    ticketId: ticket.id, kind: 'info',
    summary: 'Opened from the session library: the agent continues an earlier Claude Code session. Its content counts as untrusted.',
    data: { entryId: id, externalSessionId: e.externalSessionId },
  });
  ctx.bus.publish({ type: 'event.created', event });
  ctx.securityLog?.record({
    category: 'session', action: 'session.imported', actor: { type: 'user', id: null, name: 'You' },
    ticketId: ticket.id, sessionId: session.id, agentId: ticket.agentId,
    summary: `Opened a Claude Code session as T-${ticket.number}`, data: { entryId: id, externalSessionId: e.externalSessionId, copiedTo: path.basename(path.dirname(copied)) },
  });
  ctx.bus.publish({ type: 'ticket.updated', ticket });
  changedEvent(ctx);
  return { ticket, action: 'created' };
}

// ---------------------------------------------------------------- agent memory
export function searchMemory(ctx: AppContext, input: { query?: string; category?: string; limit?: number; agentId: Id | null }): SessionEntry[] {
  const lib = library(ctx);
  const prefer = input.agentId ? lib.agentTeamSlug(input.agentId) : null;
  const category = input.category?.trim() ? normalizeTag(input.category) ?? undefined : undefined;
  const limit = Math.min(MAX_MEMORY_RESULTS, Math.max(1, Math.floor(input.limit ?? MAX_MEMORY_RESULTS)));
  return lib.search({ q: input.query ?? '', ...(category ? { category } : {}), preferCategory: prefer, limit });
}

export async function readMemory(ctx: AppContext, id: Id, maxTurns = 12): Promise<{ entry: SessionEntry; transcript: SessionTranscript }> {
  const entry = getSession(ctx, id);
  const transcript = await sessionTranscript(ctx, id, Math.min(40, Math.max(1, maxTurns)));
  return { entry, transcript };
}
