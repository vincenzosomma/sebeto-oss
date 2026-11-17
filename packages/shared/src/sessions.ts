/**
 * Session library and agent memory (v0.4, docs/28 v0.4 Plan.md §A).
 *
 * Every agent session Sebeto knows about gets an entry in the library: the sessions of Sebeto
 * tickets, and Claude Code sessions found on this computer (~/.claude/projects/<dir>/<id>.jsonl)
 * that were never on the board. Each entry has a category (a team slug such as "service-desk", or
 * any label the owner types) so the owner and the agents can find it quickly.
 *
 * - The owner can open any entry: an external session becomes a NEW ticket that resumes it; a
 *   Sebeto session whose ticket is Completed reopens that ticket.
 * - Agents read the library through two Sebeto tools, behind the `memory.read` permission:
 *     search_memory { query, category?, limit? }  → short list (title, summary, category, T-number, date)
 *     read_memory   { id, maxTurns? }             → summary + the last turns of the transcript (trimmed)
 *   Content from external (non-Sebeto) sessions is UNTRUSTED (prompt-injection rule: outbound actions
 *   ask again after reading it). Sebeto never reads secrets into the library.
 *
 * API (under /api/v1):
 *   GET    /sessions?q=&category=&source=&cursor=&limit=  → Page<SessionEntry> (latest activity first)
 *   GET    /sessions/categories                           → SessionCategoryCount[]
 *   POST   /sessions/scan                                 → SessionScanResult (find Claude Code sessions on disk)
 *   GET    /sessions/:id                                  → SessionEntry
 *   GET    /sessions/:id/transcript?limit=                → SessionTranscript (read-only preview)
 *   PATCH  /sessions/:id    UpdateSessionEntryBody        → SessionEntry
 *   POST   /sessions/:id/open  OpenSessionBody            → OpenSessionResponse (201)
 *   DELETE /sessions/:id                                  → 204 (removes the library entry only, never files)
 *   POST   /sessions/suggest-categories  SuggestCategoriesBody → SuggestCategoriesResult (v0.5 K)
 *   POST   /sessions/apply-categories    ApplyCategoriesBody   → ApplyCategoriesResult   (v0.5 K)
 * WebSocket: { type: 'sessions.changed' }
 *
 * Auto-categorise (v0.5 K): "Suggest categories" picks a category for entries that have none (or a
 * generic one nobody chose), in two modes:
 *  - 'rules' (free, no AI): the team routing rules (hints, names, Italian words) on the title,
 *    summary and folder name; only confident matches.
 *  - 'ai': the Chief of Staff on the planning model, in batches, under a total cost cap
 *    (default $0.05). Only the title, summary and folder name (basename) are sent, truncated, as
 *    UNTRUSTED data; the model may only answer an existing team slug / category or "general", and
 *    anything else is dropped. Entries of a team whose AI is locked to another runtime are never sent.
 * dryRun (the default) only previews; the owner then applies the chosen rows with apply-categories.
 * Suggestions never overwrite a category the owner set (categorySource 'owner').
 */
import type { Id, IsoDate, RuntimeId, Ticket } from './types.js';

export type SessionSource = 'sebeto' | 'claude-code';

export interface SessionEntry {
  id: Id;
  source: SessionSource;
  /** Runtime session id (e.g. the Claude Code session uuid); null when the runtime has none. */
  externalSessionId: string | null;
  /** Sebeto `sessions` row, for source 'sebeto'. */
  sessionId: Id | null;
  /** Linked ticket: the Sebeto ticket, or the ticket created when an external session was opened. */
  ticketId: Id | null;
  ticketNumber: number | null;
  title: string;
  /** Short plain-language summary (what was asked, what was done, the outcome). */
  summary: string;
  /** Normalised like a tag (see normalizeTag); '' = not categorised yet. */
  category: string;
  /** Who chose the category (v0.5 K): the owner, the Chief of Staff ('auto'), the free rules; null = Sebeto's filing or none. */
  categorySource?: SessionCategorySource | null;
  tags: string[];
  /** Original working folder of an external session. */
  cwd: string | null;
  runtime: RuntimeId | null;
  model: string | null;
  messageCount: number;
  costUsd: number;
  startedAt: IsoDate;
  lastActivityAt: IsoDate;
  /** Pinned entries are offered first to agents of the same category ("remember this"). */
  pinned: boolean;
}

export interface SessionCategoryCount { category: string; count: number }

export interface SessionScanResult { found: number; added: number; updated: number; skipped: number }

export interface UpdateSessionEntryBody { title?: string; summary?: string; category?: string; tags?: string[]; pinned?: boolean }

export interface OpenSessionBody {
  /** Agent for the new ticket (default: the team's lead, else the default agent). */
  agentId?: Id | null;
  teamId?: Id | null;
  projectId?: Id | null;
  /** Title of the new ticket (default: the entry title). */
  title?: string;
}

export interface OpenSessionResponse {
  ticket: Ticket;
  /** 'created' = new ticket that resumes the external session; 'reopened' = a Completed ticket moved back; 'existing' = already open. */
  action: 'created' | 'reopened' | 'existing';
}

export interface SessionTranscriptTurn { role: 'user' | 'agent' | 'tool' | 'system'; text: string; at: IsoDate | null }
export interface SessionTranscript { entryId: Id; turns: SessionTranscriptTurn[]; truncated: boolean }

export const MAX_MEMORY_RESULTS = 10;

// ---------------------------------------------------------------- v0.5 K auto-categorise
export type SessionCategorySource = 'owner' | 'auto' | 'rules';
export type SuggestCategoriesMode = 'ai' | 'rules';

/** The catch-all category the Chief of Staff may always choose. */
export const GENERAL_CATEGORY = 'general';
/** Categories that count as "not really categorised" when nobody chose them. */
export const GENERIC_CATEGORIES: readonly string[] = ['', 'general', 'misc', 'other', 'others', 'uncategorized', 'uncategorised', 'varie', 'altro', 'generale'];
export const SUGGEST_DEFAULT_COST_USD = 0.05;
export const SUGGEST_MAX_COST_USD = 1;
export const SUGGEST_DEFAULT_LIMIT = 100;
export const SUGGEST_MAX_LIMIT = 500;
/** Entries per planning turn. */
export const SUGGEST_BATCH_SIZE = 20;

export interface SuggestCategoriesBody {
  /** 'ai' = the Chief of Staff (costs money, capped); 'rules' = free routing rules. Default 'rules'. */
  mode?: SuggestCategoriesMode;
  /** Preview only (default true): nothing is written. */
  dryRun?: boolean;
  /** Total cost cap for 'ai' (default SUGGEST_DEFAULT_COST_USD, max SUGGEST_MAX_COST_USD). */
  maxCostUsd?: number;
  /** Most entries to look at (default 100, max 500), newest first. */
  limit?: number;
  /** Only these entries (still only uncategorised ones). */
  ids?: Id[];
}

export interface CategorySuggestion {
  entryId: Id;
  title: string;
  /** The entry's category now ('' or a generic one). */
  current: string;
  category: string;
  source: Exclude<SessionCategorySource, 'owner'>;
  /** Short plain reason (rules: the matched words; ai: 'Chief of Staff'). Never session text. */
  reason: string;
}

export interface SuggestCategoriesResult {
  mode: SuggestCategoriesMode;
  dryRun: boolean;
  /** Uncategorised entries looked at. */
  considered: number;
  suggestions: CategorySuggestion[];
  /** Written (0 on a dry run). */
  applied: number;
  skipped: {
    /** Entries of a team whose AI is locked to another runtime (never sent to the model). */
    locked: number;
    /** No confident rule / no valid answer for them. */
    noMatch: number;
    /** Answers dropped because they were not an allowed category. */
    invalid: number;
    /** Left out because the cost cap was reached. */
    budget: number;
  };
  modelCalls: number;
  costUsd: number;
  maxCostUsd: number;
  /** The categories that could be chosen. */
  choices: string[];
  /** Why the AI could not run (no planning model…), or null. */
  error: string | null;
}

export interface ApplyCategoriesBody {
  items: Array<{ id: Id; category: string; source: Exclude<SessionCategorySource, 'owner'> }>;
}
export interface ApplyCategoriesResult { applied: number; skipped: number }
