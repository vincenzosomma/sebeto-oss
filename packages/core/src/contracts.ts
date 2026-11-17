/**
 * Internal contracts of sebeto-core. Each module is built against these interfaces so that
 * storage (SQLite now, Postgres later), queue, bus and tools can be swapped without touching
 * business logic. See docs/16 Scalability.md (seams) and docs/15 Architecture Review.md.
 *
 * All repository methods are synchronous (better-sqlite3 is synchronous). A future Postgres
 * implementation will provide an async variant behind the same module boundaries.
 */
import type { ConnectorActivation,
  Agent, AuditEvent, CommandSpec, Id, Project, ProjectSummary, TagCount, Message, Page, PermissionKey, PermissionLevel, PermissionRequest,
  PermissionRequestState, Run, RunStatus, RunTrigger, RuntimeAdapter, RuntimeId, Session,
  SecurityActor, SecurityCategory, SecurityEvent, SecuritySeverity,
  SessionCategoryCount, SessionEntry, SessionReason, SessionSource, StatusCause, StatusTransition, Team, Ticket, TicketStatus, TrustedCommand, WsEvent,
  PermissionDecision, TicketOrigin, Trigger, TriggerFire, TriggerFireOutcome, TriggerConfig, TicketBlueprint,
  MemoryKind, MemoryNote, MemoryProvenance, MemoryStatus, CostGroupBy, CostsReport, PlanningPurpose,
} from '@sebeto/shared';
import type { MemoryVault } from './memory/vault.js';
import type { SecretStore } from './connectors/secrets.js';
import type { AiConnectionStore } from './connectors/ai-connections.js';

import type { MailConnector } from './connectors/mail.js';
import type { SettingsStore } from './settings.js';
import type { McpHub } from './connectors/mcp-hub.js';
import type { SkillStore } from './skills/store.js';
import type { OAuthManager } from './connectors/oauth.js';
import type { BackupService } from './backup/service.js';

// ---------------------------------------------------------------- config
export interface CoreConfig {
  /** Workspace root: holds sebeto.db, tickets/<number>/ folders, skills/. */
  workspaceDir: string;
  /** HTTP bind host. Desktop: 127.0.0.1 only. */
  host: string;
  port: number; // 0 = random free port
  /** API bearer token (random per launch on desktop; from env in container mode). */
  apiToken: string;
  /** Absolute path of built UI files to serve (optional; dev uses Vite). */
  uiDir?: string;
  /** Max agent runs executing at the same time (global). */
  maxParallelRuns: number;
  /** Enabled runtime ids. */
  runtimes: RuntimeId[];
  version: string;
}

// ---------------------------------------------------------------- storage
export interface NewTicket {
  title: string;
  goal: string;
  agentId?: Id | null;
  runtime?: RuntimeId | null;
  model?: string | null;
  costCapUsd?: number;
  parentId?: Id | null;
  dependsOn?: Id[];
  projectId?: Id | null;
  tags?: string[];
  /** v0.4 §D: where the ticket came from (stored as JSON; set only by the core, never by API clients). */
  origin?: TicketOrigin | null;
  /** v0.4 team (teams.ts). */
  teamId?: Id | null;
}

export interface TicketQuery {
  status?: TicketStatus; q?: string; cursor?: string | null; limit?: number;
  /** Project id, or 'none' for tickets without a project. */
  projectId?: Id | 'none';
  /** Tickets having ALL these tags. */
  tags?: string[];
  /** v0.4: team id, or 'none' for tickets without a team. */
  teamId?: Id | 'none';
  /** true = only deleted tickets ("Deleted tickets"); otherwise deleted ones are left out. */
  deleted?: boolean;
}

export interface TicketRepo {
  /** Assigns id, number, folder (<workspace>/tickets/T-<number>), status 'backlog', timestamps. */
  create(input: NewTicket): Ticket;
  get(id: Id): Ticket | undefined;
  /** "Delete forever" (the row and everything that cascades from it). */
  delete(id: Id): boolean;
  list(query: TicketQuery): Page<Ticket>; // ordered by updatedAt desc; cursor-based; q searches title, goal AND messages (FTS5)
  /** Direct children of a ticket (delegated sub-tickets), newest first. Indexed on parent_id. */
  childrenOf(parentId: Id): Ticket[];
  /** Low-level patch. Status changes MUST go through StateMachine, not here. */
  update(id: Id, patch: Partial<Omit<Ticket, 'id' | 'number' | 'createdAt'>>): Ticket;
  addCost(id: Id, usd: number): Ticket;
}

export interface NewAgent {
  name: string;
  role?: string;
  job?: string;
  runtime?: RuntimeId;
  model?: string | null;
  reportsTo?: Id | null;
  heartbeatMinutes?: number;
  monthlyBudgetUsd?: number;
  permissions?: Partial<Record<PermissionKey, PermissionLevel>>;
  /** v0.4 team (teams.ts). */
  teamId?: Id | null;
  claudeConnectors?: string[];
}

export interface AgentRepo {
  create(input: NewAgent): Agent; // missing permissions filled from DEFAULT_PERMISSIONS; ALWAYS_ASK keys clamped to 'ask'
  get(id: Id): Agent | undefined;
  list(): Agent[];
  update(id: Id, patch: Partial<Omit<Agent, 'id' | 'createdAt'>>): Agent; // rejects reportsTo cycles; clamps ALWAYS_ASK
  /** Sum of run costs for this agent in the current calendar month (UTC). */
  monthSpendUsd(id: Id): number;
  /** Replace the agent's skills (slugs, in order). */
  setSkills(id: Id, slugs: string[]): Agent;
  /** Unassign a deleted skill from every agent; returns how many assignments were removed. */
  removeSkillEverywhere(slug: string): number;
  /**
   * Delete the agent row; returns false when it did not exist. Foreign keys do the rest:
   * skill assignments cascade; tickets, sessions, permission requests and reports keep NULL.
   * Callers move open tickets and reports first (services/agents.ts deleteAgent).
   * Optional: absent in in-memory test fakes.
   */
  delete?(id: Id): boolean;
  /** Open (not done) tickets assigned to the agent, and whether it is working right now. Optional like delete. */
  workload?(id: Id): AgentWorkload;
}

export interface AgentWorkload {
  /** Tickets assigned to the agent whose status is not 'done', oldest first. */
  openTicketIds: Id[];
  /** A run of the agent is 'running', or a job for one of its tickets is being executed. */
  busy: boolean;
}

export interface SessionRepo {
  create(input: { ticketId: Id; agentId: Id | null; runtime: RuntimeId; model: string | null; reason: SessionReason; externalSessionId?: string | null }): Session;
  get(id: Id): Session | undefined;
  setExternalId(id: Id, externalSessionId: string): Session;
  end(id: Id): Session;
  listForTicket(ticketId: Id): Session[];
}

export interface RunRepo {
  create(input: { sessionId: Id; ticketId: Id; jobId: Id | null; trigger: RunTrigger }): Run; // status 'running'
  get(id: Id): Run | undefined;
  update(id: Id, patch: Partial<Pick<Run, 'status' | 'endedAt' | 'tokensIn' | 'tokensOut' | 'costUsd' | 'exitReason' | 'snapshotBefore' | 'snapshotAfter'>>): Run;
  listForTicket(ticketId: Id, limit?: number): Run[]; // newest first
  /** Runs left in 'running' state by a crash; marked failed at startup. */
  failOrphans(reason: string): number;
}

export interface MessageRepo {
  create(input: { ticketId: Id; runId?: Id | null; role: Message['role']; author: string; text: string }): Message;
  listForTicket(ticketId: Id, opts?: { cursor?: string | null; limit?: number }): Page<Message>; // oldest-first within page
}

export interface AuditRepo {
  append(input: { ticketId: Id; runId?: Id | null; kind: AuditEvent['kind']; summary: string; data?: Record<string, unknown> | null }): AuditEvent;
  listForTicket(ticketId: Id, opts?: { cursor?: string | null; limit?: number }): Page<AuditEvent>;
}

export interface PermissionRepo {
  create(input: Omit<PermissionRequest, 'id' | 'state' | 'createdAt' | 'decidedAt' | 'command' | 'alwaysAllowed' | 'taskScoped'> & { command?: CommandSpec | null }): PermissionRequest;
  get(id: Id): PermissionRequest | undefined;
  /** opts.always marks an 'allowed' decision as "Always allow this command"; opts.taskScoped as "Allow for this task". */
  decide(id: Id, state: Exclude<PermissionRequestState, 'pending'>, opts?: { always?: boolean; taskScoped?: boolean }): PermissionRequest;
  listForTicket(ticketId: Id): PermissionRequest[];
  pendingForTicket(ticketId: Id): PermissionRequest[];
  /**
   * Use an allowed-once grant: sets consumed_at only when the request is 'allowed' and not yet
   * consumed (one atomic UPDATE). Returns true when this call consumed it.
   */
  consume(id: Id): boolean;
  /** When the grant was used (internal; not part of the public PermissionRequest). Undefined when missing. */
  consumedAt(id: Id): string | null | undefined;
}

/** v0.4 teams (packages/shared/src/teams.ts). memberIds come from agents.team_id. */
export interface TeamRepo {
  get(id: Id): Team | undefined;
  bySlug(slug: string): Team | undefined;
  findByName(name: string): Team | undefined;
  /** Ordered by name. */
  list(): Team[];
  create(input: {
    slug: string; name: string; description: string; color: string; leadAgentId: Id | null; routingHints: string;
    /** v0.4 F/G (optional: default no team AI, unlocked, no scope needed). */
    runtime?: RuntimeId | null; model?: string | null; lockRuntime?: boolean; requireScope?: boolean; claudeConnectors?: string[];
  }): Team;
  update(id: Id, patch: Partial<Pick<Team, 'name' | 'description' | 'color' | 'leadAgentId' | 'routingHints' | 'runtime' | 'model' | 'lockRuntime' | 'requireScope' | 'claudeConnectors'>>): Team;
  /** Agents and tickets keep existing without a team (ON DELETE SET NULL). */
  remove(id: Id): boolean;
  /** Team of each ticket in a project (for the routing project hint): teamId → ticket count. */
  projectTeamCounts(projectId: Id): Array<{ teamId: Id; count: number }>;
}

/** Commands the owner trusts ("Always allow this command"). */
export interface ProjectRepo {
  get(id: Id): Project | undefined;
  findByName(name: string): Project | undefined;
  /** All projects with ticket counts per status and total cost; archived last. */
  list(): ProjectSummary[];
  create(input: { name: string; description: string; color: string }): Project;
  update(id: Id, patch: Partial<Pick<Project, 'name' | 'description' | 'color' | 'archived'>>): Project;
  /** Tickets keep existing without a project (ON DELETE SET NULL). */
  remove(id: Id): boolean;
  /** Tags in use with their ticket counts, most used first. */
  tags(): TagCount[];
}

export interface TrustedCommandRepo {
  /** Idempotent: adding the same shell + command twice returns the existing entry. */
  add(input: { shell: string; command: string; requestId?: Id | null }): TrustedCommand;
  find(spec: CommandSpec): TrustedCommand | undefined;
  list(): TrustedCommand[];
  remove(id: Id): boolean;
}

export interface TransitionRepo {
  append(t: Omit<StatusTransition, 'id' | 'createdAt'>): StatusTransition;
  listForTicket(ticketId: Id): StatusTransition[];
}

/** Read-only counts for "Export diagnostics" (numbers and ids, never ticket text). */
export interface StatsRepo {
  /** PRAGMA user_version. */
  schemaVersion(): number;
  /** Size of the database file + WAL in bytes; null for an in-memory database. */
  dbBytes(): number | null;
  ticketsByStatus(): Record<string, number>;
  agentCount(): number;
  runsByStatusSince(sinceIso: string): Record<string, number>;
  jobsByState(): Record<string, number>;
  /** Latest audit events of kind 'error', newest first. */
  recentErrors(limit: number): Array<{ ticketNumber: number; summary: string; at: string }>;
  /** Latest failed runs, newest first. */
  recentFailedRuns(limit: number): Array<{ ticketNumber: number; trigger: string; exitReason: string | null; at: string }>;
}

// ---------------------------------------------------------------- v0.5 cost dashboard (§L)
export interface CostsRepoQuery {
  /** ISO-8601 UTC, inclusive. */
  from: string;
  /** ISO-8601 UTC, exclusive. */
  to: string;
  groupBy: CostGroupBy[];
  projectId?: Id | 'none' | null;
  teamId?: Id | 'none' | null;
  top: number;
  /** Runtimes counted as free besides FREE_RUNTIMES (v0.7: local OpenAI-compatible connections). */
  extraFreeRuntimes?: string[];
}

/** Read-only cost aggregates (labels are filled by services/costs.ts). */
export interface CostsRepo {
  /** `now` picks the budget month (UTC). */
  report(q: CostsRepoQuery, now?: Date): CostsReport;
  /** v0.6 O: store one Chief of Staff planning call (no text). An unknown ticket id is stored as null. */
  recordPlanningCall(call: PlanningCallRecord): void;
}

/** One row of `planning_calls` (v0.6 O). Never any prompt or answer text. */
export interface PlanningCallRecord {
  at: string;
  purpose: PlanningPurpose;
  ticketId: Id | null;
  /** '' when unknown (e.g. the planning model could not be picked). */
  runtime: string;
  model: string | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  ok: boolean;
}

// ---------------------------------------------------------------- v0.4 session library (§A)
/** A library entry as stored: the public entry plus internal fields never shown to agents. */
export interface StoredSessionEntry extends SessionEntry {
  /** Transcript file of an external session (internal: never exposed to agents or the API). */
  filePath: string | null;
  fileMtime: string | null;
  /** "Removed from library": kept as a tombstone so rescans and auto-filing don't bring it back. */
  hidden: boolean;
}

export type SessionEntryInput = Omit<SessionEntry, 'id' | 'ticketNumber' | 'pinned'> & {
  filePath?: string | null; fileMtime?: string | null; pinned?: boolean;
};

export interface SessionEntryQuery {
  /** Free text (FTS5, every word a prefix term, AND-ed). */
  q?: string;
  /** Exact category; '-' = entries without a category. */
  category?: string;
  source?: SessionSource;
  cursor?: string | null;
  limit?: number;
}

/** What auto-filing needs to know about a Sebeto ticket's sessions (read in one place, SQL side). */
export interface SebetoTicketFacts {
  latestSessionId: Id;
  externalSessionId: string | null;
  runtime: RuntimeId;
  model: string | null;
  startedAt: string;
  lastActivityAt: string;
  messageCount: number;
  costUsd: number;
  /** Latest agent message text, or null. */
  lastAgentText: string | null;
  /** Note of the latest status change, or null. */
  lastStatusNote: string | null;
  /** Slug of the ticket's team (teams table, v0.4 §C), or null. */
  teamSlug: string | null;
}

export interface SessionEntryRepo {
  /** Visible entry (not removed). */
  get(id: Id): SessionEntry | undefined;
  /** Any entry including removed ones, with internal fields. */
  getStored(id: Id): StoredSessionEntry | undefined;
  findExternal(source: SessionSource, externalSessionId: string): StoredSessionEntry | undefined;
  /** The 'sebeto' entry of a ticket (one per ticket, following its latest session). */
  findSebeto(ticketId: Id): StoredSessionEntry | undefined;
  /** Latest activity first, cursor paginated; removed entries are left out. */
  list(query: SessionEntryQuery): Page<SessionEntry>;
  /**
   * Agent memory search: words are OR-ed when the AND search finds nothing. Pinned entries of
   * `preferCategory` first, then that category, then the best text match / latest.
   */
  search(query: { q?: string; category?: string; preferCategory?: string | null; limit: number }): SessionEntry[];
  categories(): SessionCategoryCount[];
  /** v0.5 K: visible entries without a category (or a generic one nobody chose), newest first; never the owner's. */
  uncategorised(query: { limit: number; ids?: Id[] }): StoredSessionEntry[];
  insert(input: SessionEntryInput): StoredSessionEntry;
  patch(id: Id, patch: Partial<SessionEntryInput> & { hidden?: boolean }): StoredSessionEntry;
  /** Sebeto ticket facts for auto-filing; undefined when the ticket has no session yet. */
  ticketFacts(ticketId: Id): SebetoTicketFacts | undefined;
  /** The Sebeto session that already uses this runtime session id, if any. */
  sebetoSessionByExternal(externalSessionId: string): { sessionId: Id; ticketId: Id } | undefined;
  /** Ticket ids that have at least one session (startup backfill). */
  ticketsWithSessions(): Id[];
  teamSlug(teamId: Id): string | null;
  teamLead(teamId: Id): Id | null;
  /** Whether a team has this slug (a category set automatically from a team). */
  isTeamSlug(slug: string): boolean;
  agentTeamSlug(agentId: Id): string | null;
  /** Latest ticket chat messages, oldest first (transcript preview of Sebeto sessions). */
  recentMessages(ticketId: Id, limit: number): Array<{ role: Message['role']; author: string; text: string; at: string }>;
}

// ---------------------------------------------------------------- v0.4 §D triggers
/** Internal runtime state of a trigger (triggers.state JSON). */
export interface TriggerState {
  /** schedule: ISO time of the next due run. */
  nextRunAt?: string;
  /** mail: only emails dated at or after this ISO time count (set when the rule is created / turned on). */
  since?: string;
  /** mail: ids of emails already handled (newest last, capped). */
  seen?: string[];
  /** mail / slack: ISO time of the last poll. */
  lastPollAt?: string;
  /** slack: ts of the newest message already handled (the next poll reads after it). */
  cursor?: string;
}

export interface StoredTrigger extends Trigger {
  /** sha256 hex of the webhook secret (never leaves the core). */
  secretHash: string | null;
  state: TriggerState;
}

export interface NewTriggerFire {
  triggerId: Id;
  outcome: TriggerFireOutcome;
  ticketId?: Id | null;
  dedupeKey?: string | null;
  detail: string;
  at?: string;
}

export interface TriggerRepo {
  get(id: Id): StoredTrigger | undefined;
  list(): StoredTrigger[];
  create(input: { id?: Id; name: string; enabled: boolean; config: TriggerConfig; blueprint: TicketBlueprint; dedupeWindowMinutes: number; secretHash?: string | null; state?: TriggerState }): StoredTrigger;
  update(id: Id, patch: Partial<Pick<StoredTrigger, 'name' | 'enabled' | 'config' | 'blueprint' | 'dedupeWindowMinutes' | 'secretHash' | 'state'>>): StoredTrigger;
  setState(id: Id, state: TriggerState): void;
  remove(id: Id): boolean;
  /** Emergency stop: turn every trigger off; returns how many were on. */
  disableAll(): number;
  /** Appends a fire row; created/commented/ignored also bump fire_count and last_fired_at. */
  recordFire(input: NewTriggerFire): TriggerFire;
  listFires(triggerId: Id, limit?: number): TriggerFire[];
  /** Tickets created by this trigger for this dedupe key since the given time (newest first). */
  createdTicketsFor(triggerId: Id, dedupeKey: string, sinceIso: string): Id[];
  /** True when an accepted fire with this dedupe key exists (mail: message already handled). */
  seenKey(triggerId: Id, dedupeKey: string): boolean;
}

// ---------------------------------------------------------------- v0.4 §E memory graph index
/** One indexed Markdown note (memory/vault.ts builds it from the file). */
export interface IndexedMemoryFile {
  id: Id; path: string; title: string; key: string; kind: MemoryKind; provenance: MemoryProvenance; untrusted: boolean;
  status: MemoryStatus; teamSlug: string | null; ticketId: Id | null; tags: string[]; excerpt: string;
  sha256: string; fileMtime: string; updatedAt: string;
  /** Body for full-text search (title is added by the repo). */
  body: string;
  /** Link target keys (memoryKey). */
  links: string[];
}

export interface MemoryNoteRow extends MemoryNote { key: string; sha256: string }

export interface MemoryNoteQuery {
  /** Free text (FTS5 over title + body). */
  q?: string;
  /** OR the words instead of AND (agent search). */
  any?: boolean;
  kind?: MemoryKind;
  /** Team slug, or '-' for notes without a team. */
  team?: string;
  status?: MemoryStatus;
  ticketId?: Id;
  limit?: number;
}

export interface MemoryIndexRepo {
  /** Every indexed file (scan bookkeeping). */
  files(): Array<{ id: Id; path: string; sha256: string; fileMtime: string }>;
  /** Insert or replace the row of f.path (+ FTS + links) in one transaction. */
  upsert(f: IndexedMemoryFile): void;
  /** Only the stored mtime changed (same content). */
  touch(path: string, fileMtime: string): void;
  removePath(path: string): boolean;
  get(id: Id): MemoryNoteRow | undefined;
  byPath(path: string): MemoryNoteRow | undefined;
  /** The automatic note of a ticket (kind ticket, provenance chief-of-staff). */
  ticketNote(ticketId: Id): MemoryNoteRow | undefined;
  byKeys(keys: string[], status?: MemoryStatus): MemoryNoteRow[];
  byIds(ids: Id[]): MemoryNoteRow[];
  /** Newest first, or best text match first when q is given. */
  list(query: MemoryNoteQuery): MemoryNoteRow[];
  /** Notes whose key contains the fragment (shortest first). */
  titleLike(fragment: string, status: MemoryStatus | undefined, limit: number): MemoryNoteRow[];
  linksOf(id: Id): string[];
  allLinks(): Array<{ fromId: Id; toKey: string }>;
  /** Ids of notes linking to any of these keys. */
  linkingTo(keys: string[]): Id[];
  counts(): { notes: number; proposed: number; links: number };
}

export interface Repos {
  /** v0.4 §E memory graph index; absent in in-memory test fakes. */
  memoryIndex?: MemoryIndexRepo;
  /** Diagnostics counts; absent in in-memory test fakes. */
  stats?: StatsRepo;
  /** v0.5 §L cost dashboard aggregates; absent in in-memory test fakes. */
  costs?: CostsRepo;
  /** v0.4 session library (agent memory); absent in in-memory test fakes. */
  sessionLibrary?: SessionEntryRepo;
  /** v0.4 §D triggers; absent in in-memory test fakes. */
  triggers?: TriggerRepo;
  tickets: TicketRepo;
  agents: AgentRepo;
  sessions: SessionRepo;
  runs: RunRepo;
  messages: MessageRepo;
  audit: AuditRepo;
  permissions: PermissionRepo;
  transitions: TransitionRepo;
  trusted: TrustedCommandRepo;
  projects: ProjectRepo;
  /** v0.4 teams; optional so in-memory test fakes keep working (no teams = routing falls back). */
  teams?: TeamRepo;
  /** Run fn in a single DB transaction. */
  tx<T>(fn: () => T): T;
  close(): void;
}

// ---------------------------------------------------------------- job queue
export type JobKind = 'run.start' | 'run.reply' | 'run.heartbeat' | 'run.message' | 'run.permission';

export interface JobPayload {
  ticketId: Id;
  /** For run.reply / run.message: the text to send to the agent; for run.start: a hand-over note added to the goal. */
  text?: string;
  /** For run.permission: decided permission request id. */
  permissionRequestId?: Id;
}

export interface Job {
  id: Id;
  kind: JobKind;
  payload: JobPayload;
  priority: number; // lower = sooner. 0 needs-you replies, 10 user runs, 20 messages/handoffs, 30 heartbeats
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  runAfter: string; // ISO
  lockedBy: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface JobQueue {
  enqueue(kind: JobKind, payload: JobPayload, opts?: { priority?: number; runAfter?: Date; dedupeKey?: string }): Job;
  /** Atomically claim the next due job (lowest priority, oldest). Returns undefined when none. */
  claim(workerId: string): Job | undefined;
  complete(id: Id): void;
  /** Mark failed; when retryAt is given the job is re-queued (attempts+1). */
  fail(id: Id, error: string, retryAt?: Date): void;
  /** Re-queue jobs left 'running' by a crash. */
  recoverStale(): number;
  depth(): number;
  /** Delete 'done' and 'failed' jobs last updated more than `olderThanDays` (default 14) days ago. Returns the count. */
  prune(olderThanDays?: number): number;
}

// ---------------------------------------------------------------- event bus
export interface EventBus {
  publish(event: WsEvent): void;
  subscribe(listener: (event: WsEvent) => void): () => void;
}

// ---------------------------------------------------------------- state machine
export interface StateMachine {
  /**
   * The ONLY way to change ticket.status. Validates the transition, records a StatusTransition,
   * appends an audit event, publishes 'ticket.updated'. Agents propose ('agent'), rules decide ('rule'),
   * the user can override anything ('user'). Returns the updated ticket (unchanged if from === to).
   */
  transition(ticketId: Id, to: TicketStatus, cause: StatusCause, opts?: { runId?: Id | null; note?: string }): Ticket;
  /** Whether a transition is permitted for a given cause. */
  canTransition(from: TicketStatus, to: TicketStatus, cause: StatusCause): boolean;
}

// ---------------------------------------------------------------- tools, permissions, snapshots
export type GateDecision =
  | { outcome: 'allow' }
  | { outcome: 'deny'; reason: string }
  | { outcome: 'pending'; request: PermissionRequest };

export interface PermissionGate {
  /**
   * Decide whether an agent may perform a side effect. 'ask' creates a PermissionRequest
   * (publishes permission.created, moves ticket to needs_you via StateMachine) and returns 'pending'.
   * A previously allowed-once request for the same ticket/key/detail is consumed and returns 'allow'.
   * ALWAYS_ASK keys can never be 'allow' by setting. `untrustedInput` forces 'ask' for outbound keys.
   * A `script.run` check with a `command` the owner trusts is allowed without asking (never after
   * untrusted input, never for other keys).
   */
  check(input: { ticketId: Id; runId: Id | null; agentId: Id | null; key: PermissionKey; title: string; detail: string; untrustedInput?: boolean; provenance?: string | null; command?: CommandSpec | null }): GateDecision;
  /**
   * User decision. 'allow' grants once and enqueues a run.permission job; 'deny' notifies the agent on
   * next run; 'always' = 'allow' + the command becomes trusted (only `script.run` requests with a command).
   */
  decide(requestId: Id, decision: PermissionDecision): PermissionRequest;
  /**
   * v0.9: an agent asks the owner to turn on one of their Claude connectors. Always asks (whatever the
   * agent's levels); an identical pending request is reused, a denial in this run is final.
   */
  requestConnector(input: { ticketId: Id; runId: Id | null; agentId: Id | null; title: string; detail: string; provenance?: string | null; connector: ConnectorActivation }): GateDecision;
}

export interface Snapshots {
  /** Ensure the ticket folder exists and has its hidden git repo (.sebeto-git). */
  init(folder: string): Promise<void>;
  /** Commit current state; returns commit oid (or the previous oid when nothing changed). */
  commit(folder: string, message: string): Promise<string>;
  /** Restore working files to a commit (Undo). Commits the restore as a new snapshot and returns its oid. */
  restore(folder: string, oid: string): Promise<string>;
  /** Files changed between two commits: path + change type. */
  diff(folder: string, fromOid: string, toOid: string): Promise<Array<{ path: string; change: 'added' | 'modified' | 'deleted' }>>;
}

/** Sebeto-owned tools exposed to agents over MCP (Board + Work tools). */
export interface ToolServer {
  /** Base URL of the MCP endpoint, e.g. http://127.0.0.1:<port>/mcp */
  url(): string;
  /** Issue a token scoped to one ticket+session+run. Tools reject calls outside that scope. */
  issueToken(scope: { ticketId: Id; sessionId: Id; runId: Id; agentId: Id | null }): string;
  revokeToken(token: string): void;
}

// ---------------------------------------------------------------- runtimes & executor
export interface RuntimeRegistry {
  get(id: RuntimeId): RuntimeAdapter | undefined;
  list(): RuntimeAdapter[];
}

export interface Executor {
  /** Start the worker loop(s); claims jobs and executes runs up to maxParallelRuns. */
  start(): void;
  stop(): Promise<void>;
  /** Cancel the active run of a ticket, if any. */
  cancel(ticketId: Id): boolean;
  activeRuns(): number;
}

export interface Scheduler {
  /** Cheap code-side heartbeats: enqueue run.heartbeat only when an agent has due work (no LLM call otherwise). */
  start(): void;
  stop(): void;
}

// ---------------------------------------------------------------- logger
export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
}

/** Everything wired together in main.ts. */
export interface AppContext {
  config: CoreConfig;
  log: Logger;
  repos: Repos;
  queue: JobQueue;
  bus: EventBus;
  state: StateMachine;
  gate: PermissionGate;
  snapshots: Snapshots;
  runtimes: RuntimeRegistry;
  tools?: ToolServer;
  /** Mailbox connector (Gmail / IMAP+SMTP); absent in tests that don't need it. */
  mail?: MailConnector;
  /** Workspace settings (planning model…); absent in tests that don't need it. */
  settings?: SettingsStore;
  /** Custom MCP servers / preset connectors, proxied through the tool server. */
  connectors?: McpHub;
  /** Skill library (SKILL.md folders). */
  skills?: SkillStore;
  /** Sign in with Microsoft / Google (OAuth apps + tokens). */
  oauth?: OAuthManager;
  executor?: Executor;
  scheduler?: Scheduler;
  /**
   * v0.4 security log (docs/28 v0.4 Plan.md §B). Optional so tests and older code keep working.
   * Every module records security-relevant actions with `ctx.securityLog?.record({...})`.
   */
  securityLog?: SecurityLogger;
  /**
   * v0.4: one plain planning turn on the cheap planning model (no tools, all permissions 'never').
   * Used by ticket routing (services/routing.ts); tests inject a fake. Absent = the default
   * implementation in services/planning.ts. Callers never call it directly: they use
   * `planningTurnOf(ctx)`, which records every call (fake or real) in `planning_calls` (v0.6 O).
   */
  planningTurn?: PlanningTurn;
  /** Secret store (Gmail app password, webhook HMAC keys…); absent in tests that don't need it. */
  secrets?: SecretStore;
  /** v0.4 §D: schedules + mail rules, driven by the scheduler tick. */
  triggers?: TriggerTicker;
  /** Agent hand-overs (services/handoff.ts): applied by the executor after a run ends. */
  handoffs?: { apply(ticketId: Id): Promise<void> };
  /** v0.4 §E: the memory vault (<workspace>/memory, Obsidian compatible) and its index. */
  memory?: MemoryVault;
  /** v0.7 R: OpenAI-compatible AI connections (runtimes `openai:<id>`); absent when 'openai' is not enabled. */
  aiConnections?: AiConnectionStore;
  /** v0.7 Q: workspace backups (list / create / verify / delete, daily automatic backup). */
  backups?: BackupService;
}

/** What the scheduler needs from the trigger engine (triggers/engine.ts). */
export interface TriggerTicker {
  /** Fire due schedules and start due mail polls (never overlapping). Never throws. */
  tick(now: Date): void;
}

// ---------------------------------------------------------------- v0.4 planning turn
export interface PlanningTurnInput {
  systemPrompt: string; prompt: string; budgetUsd: number; timeoutMs: number;
  /**
   * v0.4 E/F: run on exactly this runtime (and model; null = its default) instead of the planning
   * model, e.g. a team locked to one AI. The turn fails (never falls back) when it is not available.
   */
  runtime?: RuntimeId;
  /** With `runtime`: that runtime's model. Without it: an explicit model instead of the planning model setting. */
  model?: string | null;
  /** v0.6 O: why the call is made; every call is recorded in `planning_calls` for the Costs page. */
  purpose: PlanningPurpose;
  /** v0.6 O: the ticket the call is about (routing, memory note), for per-ticket costs. */
  ticketId?: Id | null;
}
export interface PlanningTurnResult {
  text: string; costUsd: number; model: string | null;
  /** The runtime that answered (absent from test fakes: then `input.runtime`, else unknown). */
  runtime?: RuntimeId;
  tokensIn?: number;
  tokensOut?: number;
}
export type PlanningTurn = (input: PlanningTurnInput) => Promise<PlanningTurnResult>;

// ---------------------------------------------------------------- v0.4 security log
export interface NewSecurityEvent {
  category: SecurityCategory;
  /** Dotted machine name: 'permission.denied', 'tool.run_command', 'trigger.rejected'… */
  action: string;
  severity?: SecuritySeverity; // default 'info'
  /** Default { type: 'system', id: null, name: 'Sebeto' }. */
  actor?: SecurityActor;
  ticketId?: Id | null;
  agentId?: Id | null;
  sessionId?: Id | null;
  runId?: Id | null;
  summary: string;
  /** Ids, sizes, names only: NEVER secrets, tokens, passwords, email bodies or file contents. */
  data?: Record<string, unknown> | null;
}

export interface SecurityLogger {
  /** Append one event to the hash chain (ticketNumber is filled in by the logger). Never throws. */
  record(input: NewSecurityEvent): SecurityEvent | null;
  /** True while the emergency stop (lockdown) is active: no new runs, no trigger fires. */
  lockdown(): boolean;
}

export type { RunStatus };
