/**
 * Security log, auditing and incident response (v0.4, docs/28 v0.4 Plan.md §B).
 *
 * One append-only, tamper-evident log of everything that matters for security, across all tickets,
 * agents and sessions. It is separate from the per-ticket "What the agent did" list (audit_events):
 * deleting a ticket or an agent never deletes its security events.
 *
 * Tamper evidence: events form a hash chain.
 *   hash = sha256_hex(prevHash + "\n" + canonicalJson(event without `hash`))
 *   canonicalJson = JSON with keys sorted at every level; the first event's prevHash is GENESIS_HASH.
 *   The DB refuses UPDATE on the table; only retention may delete the OLDEST events, and verify then
 *   starts from the oldest remaining event's prevHash.
 * Never logged: secrets, tokens, passwords, OAuth codes. Email bodies and file contents are not
 * copied, only their identifiers and sizes.
 *
 * API (under /api/v1):
 *   GET  /security/events?since=&until=&category=&severity=&agentId=&ticketId=&sessionId=&q=&cursor=&limit=
 *                                         → Page<SecurityEvent> (newest first)
 *   GET  /security/summary?hours=24       → SecuritySummary
 *   GET  /security/verify                 → SecurityVerifyResult
 *   GET  /security/export?format=jsonl|csv&since=&until=   → file download (SIEM friendly)
 *   POST /security/emergency-stop   EmergencyStopBody      → EmergencyStopResult
 *   POST /security/emergency-stop/release                  → { ok: true }
 *   GET  /security/settings, PUT /security/settings  SecuritySettings
 *   GET  /security/status                 → SecurityLockdownStatus (added by part B)
 * WebSocket: { type: 'security.event'; event } and { type: 'security.lockdown'; active: boolean }
 */
import type { Id, IsoDate } from './types.js';

export type SecuritySeverity = 'info' | 'notice' | 'warning' | 'critical';
export const SECURITY_SEVERITIES: readonly SecuritySeverity[] = ['info', 'notice', 'warning', 'critical'] as const;

export type SecurityCategory =
  | 'auth'        // API token refused, sign in / sign out, OAuth
  | 'agent'       // agent created / changed (permissions!) / paused / deleted
  | 'permission'  // permission asked / allowed / denied / always-allowed, trusted commands
  | 'tool'        // every Sebeto tool call (file, web, mail, command, connector, memory)
  | 'session'     // session started / resumed / ended / imported, run started / ended, cost
  | 'ticket'      // created / moved / assigned / routed / deleted
  | 'config'      // settings, skills, templates, teams changed
  | 'connector'   // connector added / tools reviewed / removed
  | 'trigger'     // webhook / mail / schedule fired, rejected (bad signature, rate limit)
  | 'system';     // core start / stop, emergency stop, retention, integrity check
export const SECURITY_CATEGORIES: readonly SecurityCategory[] = ['auth', 'agent', 'permission', 'tool', 'session', 'ticket', 'config', 'connector', 'trigger', 'system'] as const;

export interface SecurityActor {
  type: 'user' | 'agent' | 'system' | 'trigger';
  id: string | null;
  /** Display name at the time of the event (agents can be renamed or deleted later). */
  name: string;
}

export interface SecurityEvent {
  id: Id;
  /** Monotonic sequence number (a gap at the start = retention; anywhere else = tampering). */
  seq: number;
  at: IsoDate;
  category: SecurityCategory;
  /** Dotted machine name, e.g. 'permission.denied', 'tool.run_command', 'agent.permissions_changed'. */
  action: string;
  severity: SecuritySeverity;
  actor: SecurityActor;
  ticketId: Id | null;
  ticketNumber: number | null;
  agentId: Id | null;
  sessionId: Id | null;
  runId: Id | null;
  /** Plain-language one-liner. */
  summary: string;
  data: Record<string, unknown> | null;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

export interface SecuritySummary {
  hours: number;
  total: number;
  bySeverity: Record<SecuritySeverity, number>;
  byCategory: Partial<Record<SecurityCategory, number>>;
  deniedPermissions: number;
  untrustedReads: number;
  rejectedTriggers: number;
  activeAgents: Array<{ agentId: Id; name: string; events: number }>;
  lockdown: boolean;
}

export interface SecurityVerifyResult {
  ok: boolean;
  checked: number;
  firstSeq: number | null;
  lastSeq: number | null;
  /** First event whose hash or link does not match (null when ok). */
  brokenAtSeq: number | null;
  problem: string | null;
}

export interface EmergencyStopBody { reason: string }
export interface EmergencyStopResult { ok: true; cancelledRuns: number; pausedAgents: number; disabledTriggers: number }

/** Query of GET /security/events (category and severity: comma-separated lists). Added by part B. */
export interface SecurityEventsQuery {
  since?: IsoDate;
  until?: IsoDate;
  category?: string;
  severity?: string;
  agentId?: Id;
  ticketId?: Id;
  ticketNumber?: number;
  sessionId?: Id;
  runId?: Id;
  action?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

/** GET /security/status: the emergency stop state (loaded by the UI at startup). Added by part B. */
export interface SecurityLockdownStatus { active: boolean; since: IsoDate | null; reason: string | null }

export interface SecuritySettings {
  /** Delete events older than this many days (0 = keep forever). Default 0. */
  retentionDays: number;
  /** Also append every event to <workspace>/logs/security/YYYY-MM-DD.jsonl for a SIEM collector. Default false. */
  jsonlMirror: boolean;
}
