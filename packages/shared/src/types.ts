/**
 * Core domain types shared by core, UI and desktop.
 * See docs/05 Architecture.md and docs/15 Architecture Review.md.
 */

import type { TicketOrigin } from './triggers.js';

export type Id = string; // UUIDv7, generated in the app (see ids.ts)
export type IsoDate = string; // ISO-8601 UTC timestamp

/** Board columns. UI labels: Backlog, In progress, Needs you, Blocked, Completed. */
export type TicketStatus = 'backlog' | 'in_progress' | 'needs_you' | 'blocked' | 'done';
export const TICKET_STATUSES: readonly TicketStatus[] = ['backlog', 'in_progress', 'needs_you', 'blocked', 'done'] as const;

export type RuntimeId = 'mock' | 'claude-cli' | 'claude-sdk' | 'codex-cli' | 'codex' | 'gemini' | 'ollama' | (string & {});

export type PermissionLevel = 'allow' | 'ask' | 'never';

/** Side-effect classes enforced by Sebeto tools (not by runtimes). */
export type PermissionKey = 'fs.read' | 'fs.write' | 'web.read' | 'email.read' | 'email.send' | 'tool.read' | 'tool.change' | 'script.run' | 'prod.change' | 'memory.read' | 'memory.write' | 'ticket.create';
export const PERMISSION_KEYS: readonly PermissionKey[] = ['fs.read', 'fs.write', 'web.read', 'email.read', 'email.send', 'tool.read', 'tool.change', 'script.run', 'prod.change', 'memory.read', 'memory.write', 'ticket.create'] as const;

/** Defaults: read freely, write with snapshots, everything outbound asks; production is always Ask. */
export const DEFAULT_PERMISSIONS: Record<PermissionKey, PermissionLevel> = {
  'fs.read': 'allow',
  'fs.write': 'allow',
  'web.read': 'ask',
  'email.read': 'ask',
  'email.send': 'ask',
  'tool.read': 'ask',
  'tool.change': 'ask',
  'script.run': 'ask',
  'prod.change': 'ask',
  /** Search and read past sessions in the session library (v0.4). External sessions count as untrusted input. */
  'memory.read': 'allow',
  /** Propose memory notes (v0.4 E). Proposals wait for the owner's approval before agents can use them. */
  'memory.write': 'allow',
  /** Delegate work: create a child ticket for a teammate (v0.8 agent communication). Asks by default. */
  'ticket.create': 'ask',
};

/**
 * Keys whose approval lasts for the whole ticket instead of one action: reading the mailbox means
 * several searches and reads, and asking for each one would be noise. Denials still apply per run.
 */
export const TICKET_SCOPED_KEYS: readonly PermissionKey[] = ['email.read', 'tool.read'] as const;

/** Keys that can never be set to 'allow'. */
export const ALWAYS_ASK: readonly PermissionKey[] = ['prod.change'] as const;

export interface Agent {
  id: Id;
  name: string;
  role: string;
  job: string; // plain-language job description (becomes part of the system prompt)
  runtime: RuntimeId;
  model: string | null;
  reportsTo: Id | null;
  heartbeatMinutes: number;
  monthlyBudgetUsd: number;
  permissions: Record<PermissionKey, PermissionLevel>;
  paused: boolean;
  createdAt: IsoDate;
  /** Team this agent belongs to (v0.4, teams.ts); null = none. Optional for older clients. */
  teamId?: Id | null;
  /** Assigned skill slugs (docs/17 Agents & Skills.md), in the order they were assigned. */
  skills: string[];
  /**
   * Claude Code runtime only: the owner's own Claude connectors (claude.ai and local MCP servers, by
   * the name `claude mcp list` shows, e.g. "claude.ai Atlassian – Acme") this agent may use. Every
   * call still goes through Sebeto's gate (docs/37). Empty / absent = none (Sebeto tools only).
   */
  claudeConnectors?: string[];
}

/** Tool-name prefix Claude Code uses for an MCP server ("claude.ai Atlassian – Acme" → "claude_ai_Atlassian_Acme"). */
export function claudeMcpSlug(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

export interface Ticket {
  id: Id;
  number: number; // human friendly T-<number>, unique per workspace
  title: string;
  goal: string;
  status: TicketStatus;
  agentId: Id | null;
  runtime: RuntimeId | null; // override; null = agent default
  model: string | null;
  currentSessionId: Id | null;
  folder: string; // absolute path of the ticket sandbox folder
  costCapUsd: number;
  costUsd: number; // accumulated
  parentId: Id | null;
  dependsOn: Id[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
  /** Project this ticket belongs to (null = none). Always set by the core; optional for older clients. */
  projectId?: Id | null;
  /** Free labels, normalised (lowercase, no '#'). Always set by the core. */
  tags?: string[];
  /** Team the ticket is given to (v0.4, teams.ts); null = none. Always set by the core. */
  teamId?: Id | null;
  /** Where the ticket came from (v0.4, triggers.ts); null = created by hand before v0.4. */
  origin?: TicketOrigin | null;
  /** v0.4 G: written scope / rules of engagement confirmed by the owner (required by some teams). */
  scope?: TicketScope | null;
  /**
   * Summary and time of the ticket's latest audit event ("latest activity" on board cards).
   * Filled by the core on list and get; null when the ticket has no events yet. Optional because
   * tickets built elsewhere (e.g. some ticket.updated payloads) may omit it: clients keep what they know.
   */
  lastActivity?: { summary: string; at: IsoDate } | null;
  /** In "Deleted tickets" since this time (restore brings it back); null/absent = live. */
  deletedAt?: IsoDate | null;
}

export type SessionReason = 'new' | 'compaction' | 'handoff' | 'runtime_change' | 'crash' | 'import';

export interface Session {
  id: Id;
  ticketId: Id;
  agentId: Id | null;
  runtime: RuntimeId;
  model: string | null;
  externalSessionId: string | null; // e.g. Claude Code session id
  reason: SessionReason;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
}

export type RunTrigger = 'start' | 'user' | 'heartbeat' | 'message' | 'permission';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Run {
  id: Id;
  sessionId: Id;
  ticketId: Id;
  jobId: Id | null;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  exitReason: string | null;
  snapshotBefore: string | null; // git commit oid
  snapshotAfter: string | null;
}

export type MessageRole = 'user' | 'agent' | 'handoff' | 'system';

export interface Message {
  id: Id;
  ticketId: Id;
  runId: Id | null;
  role: MessageRole;
  author: string; // 'You', agent name, or 'Analyst → Comms writer'
  text: string;
  createdAt: IsoDate;
}

/**
 * v0.4 G: the authorised scope of a ticket (targets, dates, what is allowed / forbidden, contacts).
 * Written or loaded from a file by the OWNER and confirmed by them; stored in the DB (authoritative)
 * and given to the agent as trusted owner instructions. A copy is written to <ticket folder>/SCOPE.md
 * for reference only (agents could edit that file; the DB text is what counts).
 *
 * API: PUT /tickets/:id/scope  SetTicketScopeBody → Ticket   (refused while the ticket is running)
 *      DELETE /tickets/:id/scope → Ticket
 */
export interface TicketScope {
  text: string;
  /** Name of the file it was loaded from, if any. */
  fileName: string | null;
  /** sha256 hex of `text`. */
  sha256: string;
  confirmedAt: IsoDate;
}
export interface SetTicketScopeBody {
  text: string;
  fileName?: string | null;
  /** Must be true: "I confirm this scope is written and authorised." */
  confirm: true;
}
export const MAX_SCOPE_CHARS = 20_000;

/** Append-only audit log entry; powers "What the agent did". */
export interface AuditEvent {
  id: Id;
  ticketId: Id;
  runId: Id | null;
  kind: 'tool' | 'status' | 'permission' | 'snapshot' | 'error' | 'cost' | 'info';
  summary: string; // plain language
  data: Record<string, unknown> | null;
  createdAt: IsoDate;
}

export type PermissionRequestState = 'pending' | 'allowed' | 'denied';

export interface PermissionRequest {
  id: Id;
  ticketId: Id;
  runId: Id | null;
  agentId: Id | null;
  key: PermissionKey;
  title: string; // "Permission needed: send email"
  detail: string; // what exactly will happen
  provenance: string | null; // untrusted source that influenced the request, if any
  /** For `run_command` requests: the exact shell + command, so the owner can trust it ("Always allow"). */
  command: CommandSpec | null;
  state: PermissionRequestState;
  /** True when the owner chose "Always allow this command" (the command is now trusted). */
  alwaysAllowed: boolean;
  /** True when the owner chose "Allow for this task": the grant covers the whole ticket (reused, not consumed). */
  taskScoped: boolean;
  /**
   * v0.9: set when an agent asks the owner to turn on one of their Claude connectors. Allow turns it
   * on for the agent; decision 'team' turns it on for the agent's team.
   */
  connector?: ConnectorActivation | null;
  createdAt: IsoDate;
  decidedAt: IsoDate | null;
}

/** v0.9: what an agent asked to turn on (request_claude_connector). */
export interface ConnectorActivation {
  /** The connector's name as `claude mcp list` shows it ("claude.ai Atlassian – Acme"). */
  name: string;
  /** The asking agent's team, when it has one (offers "turn on for the team"). */
  teamId: Id | null;
  teamName: string | null;
}

/** A system command as the agent asked to run it. */
export interface CommandSpec {
  shell: string; // 'powershell' | 'cmd' | 'bash' | 'sh'
  command: string;
}

/**
 * A command the owner trusts ("Always allow this command"): it runs without asking again, for any
 * agent whose `script.run` permission is Ask. Exact match on shell + command (trimmed). Never applies
 * to production changes, nor after the run has read untrusted content.
 */
export interface TrustedCommand {
  id: Id;
  shell: string;
  command: string;
  createdAt: IsoDate;
  /** The permission request it was created from, if any. */
  requestId: Id | null;
}

export type StatusCause = 'agent' | 'rule' | 'user';

export interface StatusTransition {
  id: Id;
  ticketId: Id;
  from: TicketStatus;
  to: TicketStatus;
  cause: StatusCause;
  runId: Id | null;
  note: string | null;
  createdAt: IsoDate;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
