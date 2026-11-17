/**
 * Security application services: the API layer for the security log, incident response
 * ("Emergency stop") and logging of refused API requests (rate limited).
 */
import { Readable } from 'node:stream';
import type {
  EmergencyStopResult, Id, Page, SecurityEvent, SecuritySettings, SecuritySummary, SecurityVerifyResult,
} from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { badRequest, unavailable } from '../services/errors.js';
import { SYSTEM_ACTOR } from './actor.js';
import { fullLog, type LockdownState, type SecurityEventQuery, type SecurityLog } from './log.js';

export function requireSecurityLog(ctx: AppContext): SecurityLog {
  const log = fullLog(ctx.securityLog);
  if (!log) throw unavailable('The security log is not available in this build');
  return log;
}

export function listSecurityEvents(ctx: AppContext, query: SecurityEventQuery): Page<SecurityEvent> {
  return requireSecurityLog(ctx).list(query);
}

export function securitySummary(ctx: AppContext, hours = 24): SecuritySummary {
  return requireSecurityLog(ctx).summary(hours);
}

export function lockdownStatus(ctx: AppContext): LockdownState {
  return fullLog(ctx.securityLog)?.lockdownState() ?? { active: false, since: null, reason: null };
}

export function verifySecurityLog(ctx: AppContext): SecurityVerifyResult {
  const log = requireSecurityLog(ctx);
  const result = log.verify();
  log.record({
    category: 'system', action: 'system.integrity_checked', severity: result.ok ? 'info' : 'critical',
    summary: result.ok
      ? `Integrity check passed: ${result.checked} event(s) are unchanged.`
      : `Integrity check FAILED at event #${result.brokenAtSeq}: ${result.problem}`,
    data: { ...result },
  });
  return result;
}

export function getSecuritySettings(ctx: AppContext): SecuritySettings {
  return requireSecurityLog(ctx).settings();
}

export function updateSecuritySettings(ctx: AppContext, patch: Partial<SecuritySettings>): SecuritySettings {
  const log = requireSecurityLog(ctx);
  const before = log.settings();
  let after: SecuritySettings;
  try {
    after = log.updateSettings(patch);
  } catch (err) {
    throw badRequest((err as Error).message, 'invalid_settings');
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after) as Array<keyof SecuritySettings>) if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
  if (Object.keys(changes).length) {
    // Shorter retention deletes history: worth a warning.
    const shorter = after.retentionDays > 0 && (before.retentionDays === 0 || after.retentionDays < before.retentionDays);
    log.record({
      category: 'config', action: 'config.security_settings_changed', severity: shorter ? 'warning' : 'notice',
      summary: `Security log settings changed: ${Object.entries(changes).map(([k, v]) => `${k} ${String(v.from)} → ${String(v.to)}`).join(', ')}.`,
      data: { changes },
    });
  }
  return after;
}

// ---------------------------------------------------------------- incident response
const STOP_NOTE = 'Emergency stop';

/**
 * Emergency stop: lockdown first (so nothing new starts), then cancel running runs and queued
 * work, pause every agent, turn off every trigger. Every step is logged as critical.
 */
export function emergencyStop(ctx: AppContext, reason: string): EmergencyStopResult {
  const log = requireSecurityLog(ctx);
  const why = reason.trim().slice(0, 500);
  log.setLockdown(true, why);
  log.record({ category: 'system', action: 'system.emergency_stop', severity: 'critical', summary: `Emergency stop pressed: ${why}`, data: { reason: why } });

  // 1. Running agents.
  let cancelledActive = 0;
  const running = log.runningTicketIds();
  for (const ticketId of running) {
    try {
      if (ctx.executor?.cancel(ticketId)) cancelledActive++;
    } catch (err) {
      ctx.log.error({ err: (err as Error).message, ticketId }, 'emergency stop: cancel failed');
    }
  }
  // 2. Queued work (starts, replies, heartbeats, permission resumes).
  const dropped = log.dropQueuedJobs(`${STOP_NOTE}: ${why}`.slice(0, 500));
  const touched = new Set<Id>([...running, ...dropped.ticketIds]);
  for (const ticketId of touched) {
    try {
      const event = ctx.repos.audit.append({
        ticketId, kind: 'info',
        summary: `Emergency stop: Sebeto stopped the agent work on this ticket. Reason: ${why}`,
        data: { emergencyStop: true },
      });
      ctx.bus.publish({ type: 'event.created', event });
    } catch { /* the ticket may be gone */ }
  }
  log.record({
    category: 'system', action: 'system.emergency_stop.runs_cancelled', severity: 'critical',
    summary: `Emergency stop: ${cancelledActive} running agent(s) stopped, ${dropped.count} queued job(s) cancelled.`,
    data: { runningCancelled: cancelledActive, queuedCancelled: dropped.count, tickets: [...touched] },
  });

  // 3. Pause every agent (each pause is also logged as agent.paused).
  let pausedAgents = 0;
  for (const agent of ctx.repos.agents.list()) {
    if (agent.paused) continue;
    try {
      const updated = ctx.repos.agents.update(agent.id, { paused: true });
      ctx.bus.publish({ type: 'agent.updated', agent: updated });
      pausedAgents++;
    } catch (err) {
      ctx.log.error({ err: (err as Error).message, agentId: agent.id }, 'emergency stop: pause failed');
    }
  }
  log.record({ category: 'system', action: 'system.emergency_stop.agents_paused', severity: 'critical', summary: `Emergency stop: ${pausedAgents} agent(s) paused.`, data: { pausedAgents } });

  // 4. Triggers off.
  const disabledTriggers = log.disableTriggers();
  if (disabledTriggers > 0) ctx.bus.publish({ type: 'triggers.changed' });
  log.record({ category: 'system', action: 'system.emergency_stop.triggers_disabled', severity: 'critical', summary: `Emergency stop: ${disabledTriggers} trigger(s) turned off.`, data: { disabledTriggers } });

  ctx.log.warn({ cancelledActive, queued: dropped.count, pausedAgents, disabledTriggers }, 'EMERGENCY STOP');
  return { ok: true, cancelledRuns: cancelledActive + dropped.count, pausedAgents, disabledTriggers };
}

export function releaseLockdown(ctx: AppContext): { ok: true } {
  const log = requireSecurityLog(ctx);
  const was = log.lockdownState();
  log.setLockdown(false);
  log.record({
    category: 'system', action: 'system.lockdown_released', severity: 'critical',
    summary: was.active ? 'Emergency stop released. Agents stay paused until you resume them.' : 'Release pressed, but no emergency stop was active.',
    data: { wasActive: was.active, since: was.since, reason: was.reason },
  });
  return { ok: true };
}

// ---------------------------------------------------------------- refused API requests
export type AuthRefusalReason = 'forbidden_host' | 'forbidden_origin' | 'missing_token' | 'bad_token';
export interface AuthRefusal { reason: AuthRefusalReason; ip: string; method: string; path: string; host?: string; origin?: string }

const REFUSAL_TEXT: Record<AuthRefusalReason, string> = {
  forbidden_host: 'a request for an unknown host name (possible DNS rebinding)',
  forbidden_origin: 'a request from another web site',
  missing_token: 'a request without the access token',
  bad_token: 'a request with a wrong access token',
};

/**
 * Log refused API requests without letting them flood the log: at most one event per
 * remote address + reason per window (default 1 minute); the next event carries how many were
 * suppressed in between.
 */
export function createAuthRefusalRecorder(ctx: AppContext, opts: { windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const maxKeys = opts.maxKeys ?? 1000;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { start: number; suppressed: number }>();
  return (r: AuthRefusal): void => {
    try {
      if (!ctx.securityLog) return;
      const key = `${r.ip}|${r.reason}`;
      const t = now();
      const entry = seen.get(key);
      if (entry && t - entry.start < windowMs) {
        entry.suppressed++;
        return;
      }
      const suppressed = entry?.suppressed ?? 0;
      seen.delete(key);
      if (seen.size >= maxKeys) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.set(key, { start: t, suppressed: 0 });
      ctx.securityLog.record({
        category: 'auth', action: `auth.refused.${r.reason}`, severity: 'warning', actor: { ...SYSTEM_ACTOR, name: `Remote ${r.ip}`.slice(0, 100) },
        summary: `Refused ${REFUSAL_TEXT[r.reason]} from ${r.ip}: ${r.method} ${r.path}${suppressed ? ` (+${suppressed} more in the last minute)` : ''}`,
        data: {
          reason: r.reason, ip: r.ip, method: r.method, path: r.path.slice(0, 200),
          ...(r.host ? { host: r.host.slice(0, 200) } : {}), ...(r.origin ? { origin: r.origin.slice(0, 200) } : {}),
          suppressedBefore: suppressed, windowSeconds: Math.round(windowMs / 1000),
        },
      });
    } catch { /* never break the request path */ }
  };
}

// ---------------------------------------------------------------- export
const CSV_COLUMNS = [
  'seq', 'at', 'severity', 'category', 'action', 'actor_type', 'actor_id', 'actor_name', 'ticket_number', 'ticket_id',
  'agent_id', 'session_id', 'run_id', 'summary', 'data', 'prev_hash', 'hash', 'id',
] as const;

/** One CSV cell: quoted, quotes doubled, and formula injection defused (= + - @ tab CR → leading '). */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(e: SecurityEvent): string {
  const v: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    seq: e.seq, at: e.at, severity: e.severity, category: e.category, action: e.action,
    actor_type: e.actor.type, actor_id: e.actor.id, actor_name: e.actor.name, ticket_number: e.ticketNumber, ticket_id: e.ticketId,
    agent_id: e.agentId, session_id: e.sessionId, run_id: e.runId, summary: e.summary, data: e.data, prev_hash: e.prevHash, hash: e.hash, id: e.id,
  };
  return CSV_COLUMNS.map((c) => csvCell(v[c])).join(',');
}

export function exportFileName(format: 'jsonl' | 'csv', at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `sebeto-security-${stamp}.${format}`;
}

export interface SecurityExport { fileName: string; contentType: string; stream: Readable }

export function exportSecurityLog(ctx: AppContext, q: { format: 'jsonl' | 'csv'; since?: string; until?: string }): SecurityExport {
  const log = requireSecurityLog(ctx);
  log.record({
    category: 'system', action: 'system.exported', severity: 'notice',
    summary: `The security log was exported as ${q.format.toUpperCase()}${q.since || q.until ? ` (${q.since ?? 'start'} → ${q.until ?? 'now'})` : ''}.`,
    data: { format: q.format, since: q.since ?? null, until: q.until ?? null },
  });
  const range = { ...(q.since ? { since: q.since } : {}), ...(q.until ? { until: q.until } : {}) };
  function* lines(): Generator<string> {
    if (q.format === 'csv') yield `﻿${CSV_COLUMNS.join(',')}\r\n`;
    for (const batch of log.batches(range)) {
      yield batch.map((e) => (q.format === 'csv' ? `${csvRow(e)}\r\n` : `${JSON.stringify(e)}\n`)).join('');
    }
  }
  return {
    fileName: exportFileName(q.format),
    contentType: q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    stream: Readable.from(lines()),
  };
}
