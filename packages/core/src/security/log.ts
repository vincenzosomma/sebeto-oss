/**
 * The security log (docs/28 v0.4 Plan.md §B; contract packages/shared/src/security.ts): one
 * append-only, hash-chained table `security_events` (DB v6) plus a small settings file
 * `<workspace>/security.json` (retention, daily JSONL mirror, lockdown state).
 *
 * `record()` is synchronous and runs in one DB transaction that reads the last row and appends the
 * next, so two records can never share a seq or a prevHash (better-sqlite3 is synchronous and the
 * write lock is taken up front). It never throws: a failure is logged and returns null.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  GENESIS_HASH, SECURITY_CATEGORIES, SECURITY_SEVERITIES, nowIso, uuidv7,
  type Id, type Page, type SecurityActor, type SecurityCategory, type SecurityEvent, type SecuritySettings,
  type SecuritySeverity, type SecuritySummary, type SecurityVerifyResult,
} from '@sebeto/shared';
import type { EventBus, Logger, NewSecurityEvent, Repos, SecurityLogger } from '../contracts.js';
import { clampLimit, decodeCursor, encodeCursor } from '../storage/pagination.js';
import { SYSTEM_ACTOR, currentActor } from './actor.js';
import { eventHash } from './hash.js';
import { redactData, redactSummary } from './redact.js';

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = { retentionDays: 0, jsonlMirror: false };
export const MAX_RETENTION_DAYS = 36_500;

export interface SecurityEventQuery {
  since?: string;
  until?: string;
  category?: SecurityCategory[];
  severity?: SecuritySeverity[];
  agentId?: Id;
  ticketId?: Id;
  ticketNumber?: number;
  sessionId?: Id;
  runId?: Id;
  action?: string;
  q?: string;
  cursor?: string | null;
  limit?: number;
}

export interface LockdownState {
  active: boolean;
  since: string | null;
  reason: string | null;
}

/** The full log used by the API and the scheduler; other modules only need SecurityLogger. */
export interface SecurityLog extends SecurityLogger {
  list(query: SecurityEventQuery): Page<SecurityEvent>;
  get(id: Id): SecurityEvent | undefined;
  summary(hours?: number): SecuritySummary;
  verify(): SecurityVerifyResult;
  /** Events oldest first, in batches (for export). Never holds a DB iterator across yields. */
  batches(query: Pick<SecurityEventQuery, 'since' | 'until'>, size?: number): Generator<SecurityEvent[]>;
  settings(): SecuritySettings;
  updateSettings(patch: Partial<SecuritySettings>): SecuritySettings;
  /** Delete events older than the retention period (never the newest one). Returns the count. */
  prune(nowMs?: number): number;
  lockdownState(): LockdownState;
  setLockdown(active: boolean, reason?: string | null): LockdownState;
  /** Incident response: mark every queued job failed; returns the ticket ids they were for. */
  dropQueuedJobs(reason: string): { count: number; ticketIds: Id[] };
  /** Tickets with a run in progress right now (DB view; the executor owns the processes). */
  runningTicketIds(): Id[];
  /** Incident response: turn off every enabled trigger (table from DB v6); returns how many. */
  disableTriggers(): number;
}

/** Duck-typed access to the full log (ctx.securityLog is typed as the small contract). */
export function fullLog(logger: SecurityLogger | undefined): SecurityLog | undefined {
  return logger && typeof (logger as Partial<SecurityLog>).verify === 'function' ? (logger as SecurityLog) : undefined;
}

export interface SecurityLogOptions {
  db: Database.Database;
  /** Where security.json and logs/security/*.jsonl live; null = in memory only (tests). */
  workspaceDir?: string | null;
  bus?: EventBus;
  log?: Logger;
  /** For ticket numbers and agent names. */
  repos?: Pick<Repos, 'tickets' | 'agents'>;
}

interface Row {
  seq: number; id: string; at: string; category: string; action: string; severity: SecuritySeverity;
  actor_type: SecurityActor['type']; actor_id: string | null; actor_name: string;
  ticket_id: string | null; ticket_number: number | null; agent_id: string | null; session_id: string | null; run_id: string | null;
  summary: string; data: string | null; prev_hash: string; hash: string;
}

export function rowToEvent(r: Row): SecurityEvent {
  return {
    id: r.id, seq: r.seq, at: r.at, category: r.category as SecurityCategory, action: r.action, severity: r.severity,
    actor: { type: r.actor_type, id: r.actor_id, name: r.actor_name },
    ticketId: r.ticket_id, ticketNumber: r.ticket_number, agentId: r.agent_id, sessionId: r.session_id, runId: r.run_id,
    summary: r.summary, data: r.data === null ? null : (JSON.parse(r.data) as Record<string, unknown>),
    prevHash: r.prev_hash, hash: r.hash,
  };
}

const ACTOR_TYPES = new Set(['user', 'agent', 'system', 'trigger']);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const optId = (v: unknown): string | null => (typeof v === 'string' && v ? clip(v, 100) : null);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSecurityLog(opts: SecurityLogOptions): SecurityLog {
  const { db, bus, log, repos } = opts;
  const dir = opts.workspaceDir ?? null;
  const settingsFile = dir ? path.join(dir, 'security.json') : null;
  const mirrorDir = dir ? path.join(dir, 'logs', 'security') : null;

  // ---- settings + lockdown (file)
  let settings: SecuritySettings = { ...DEFAULT_SECURITY_SETTINGS };
  let lock: LockdownState = { active: false, since: null, reason: null };
  if (settingsFile) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Partial<SecuritySettings> & { lockdown?: Partial<LockdownState> };
      if (Number.isInteger(raw.retentionDays) && raw.retentionDays! >= 0 && raw.retentionDays! <= MAX_RETENTION_DAYS) settings.retentionDays = raw.retentionDays!;
      if (typeof raw.jsonlMirror === 'boolean') settings.jsonlMirror = raw.jsonlMirror;
      if (raw.lockdown && raw.lockdown.active === true) {
        lock = { active: true, since: typeof raw.lockdown.since === 'string' ? raw.lockdown.since : null, reason: typeof raw.lockdown.reason === 'string' ? raw.lockdown.reason : null };
      }
    } catch { /* first run or unreadable: defaults */ }
  }
  function persist(): void {
    if (!settingsFile) return;
    const tmp = `${settingsFile}.tmp`;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...settings, lockdown: lock }, null, 2), 'utf8');
    fs.renameSync(tmp, settingsFile);
  }

  // ---- statements
  const stmts = {
    last: db.prepare<[], { seq: number; hash: string }>('SELECT seq, hash FROM security_events ORDER BY seq DESC LIMIT 1'),
    insert: db.prepare(`INSERT INTO security_events
      (seq, id, at, category, action, severity, actor_type, actor_id, actor_name, ticket_id, ticket_number, agent_id, session_id, run_id, summary, data, prev_hash, hash)
      VALUES (@seq, @id, @at, @category, @action, @severity, @actorType, @actorId, @actorName, @ticketId, @ticketNumber, @agentId, @sessionId, @runId, @summary, @data, @prevHash, @hash)`),
    get: db.prepare<[string], Row>('SELECT * FROM security_events WHERE id = ?'),
    ascFrom: db.prepare<[number, number], Row>('SELECT * FROM security_events WHERE seq > ? ORDER BY seq ASC LIMIT ?'),
    prune: db.prepare<[string]>('DELETE FROM security_events WHERE at < ? AND seq < (SELECT MAX(seq) FROM security_events)'),
  };

  const append = db.transaction((ev: Omit<SecurityEvent, 'seq' | 'prevHash' | 'hash'>): SecurityEvent => {
    const last = stmts.last.get();
    const full: Omit<SecurityEvent, 'hash'> = { ...ev, seq: last ? last.seq + 1 : 1, prevHash: last ? last.hash : GENESIS_HASH };
    const event: SecurityEvent = { ...full, hash: eventHash(full) };
    stmts.insert.run({
      seq: event.seq, id: event.id, at: event.at, category: event.category, action: event.action, severity: event.severity,
      actorType: event.actor.type, actorId: event.actor.id, actorName: event.actor.name,
      ticketId: event.ticketId, ticketNumber: event.ticketNumber, agentId: event.agentId, sessionId: event.sessionId, runId: event.runId,
      summary: event.summary, data: event.data === null ? null : JSON.stringify(event.data), prevHash: event.prevHash, hash: event.hash,
    });
    return event;
  });

  let mirrorReady = false;
  function mirror(event: SecurityEvent): void {
    if (!settings.jsonlMirror || !mirrorDir) return;
    try {
      if (!mirrorReady) {
        fs.mkdirSync(mirrorDir, { recursive: true });
        mirrorReady = true;
      }
      fs.appendFileSync(path.join(mirrorDir, `${event.at.slice(0, 10)}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
    } catch (err) {
      mirrorReady = false;
      log?.warn({ err: errMessage(err) }, 'security log: could not write the daily JSONL file');
    }
  }

  function normalize(input: NewSecurityEvent): Omit<SecurityEvent, 'seq' | 'prevHash' | 'hash'> {
    const category: SecurityCategory = SECURITY_CATEGORIES.includes(input.category) ? input.category : 'system';
    const severity: SecuritySeverity = input.severity && SECURITY_SEVERITIES.includes(input.severity) ? input.severity : 'info';
    const rawActor = input.actor ?? currentActor() ?? SYSTEM_ACTOR;
    const actor: SecurityActor = {
      type: ACTOR_TYPES.has(rawActor.type) ? rawActor.type : 'system',
      id: optId(rawActor.id),
      name: clip(redactSummary(String(rawActor.name ?? '')) || 'Unknown', 100),
    };
    const ticketId = optId(input.ticketId);
    let ticketNumber: number | null = null;
    if (ticketId && repos) {
      try { ticketNumber = repos.tickets.get(ticketId)?.number ?? null; } catch { ticketNumber = null; }
    }
    const action = clip(String(input.action ?? '').replace(/[^A-Za-z0-9_.:-]/g, '_'), 100) || `${category}.event`;
    return {
      id: uuidv7(), at: nowIso(), category, action, severity, actor,
      ticketId, ticketNumber, agentId: optId(input.agentId), sessionId: optId(input.sessionId), runId: optId(input.runId),
      summary: redactSummary(input.summary) || action,
      data: redactData(input.data ?? null),
    };
  }

  function record(input: NewSecurityEvent): SecurityEvent | null {
    try {
      const event = append.immediate(normalize(input));
      try { bus?.publish({ type: 'security.event', event }); } catch { /* listeners never break logging */ }
      mirror(event);
      return event;
    } catch (err) {
      log?.error({ err: errMessage(err), action: input?.action }, 'security log: could not record an event');
      return null;
    }
  }

  function where(q: SecurityEventQuery): { sql: string; params: unknown[] } {
    const c: string[] = [];
    const p: unknown[] = [];
    if (q.since) { c.push('at >= ?'); p.push(q.since); }
    if (q.until) { c.push('at <= ?'); p.push(q.until); }
    if (q.category?.length) { c.push(`category IN (${q.category.map(() => '?').join(',')})`); p.push(...q.category); }
    if (q.severity?.length) { c.push(`severity IN (${q.severity.map(() => '?').join(',')})`); p.push(...q.severity); }
    if (q.agentId) { c.push('agent_id = ?'); p.push(q.agentId); }
    if (q.ticketId) { c.push('ticket_id = ?'); p.push(q.ticketId); }
    if (q.ticketNumber !== undefined) { c.push('ticket_number = ?'); p.push(q.ticketNumber); }
    if (q.sessionId) { c.push('session_id = ?'); p.push(q.sessionId); }
    if (q.runId) { c.push('run_id = ?'); p.push(q.runId); }
    if (q.action) { c.push('action = ?'); p.push(q.action); }
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      c.push("(summary LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR actor_name LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')");
      p.push(like, like, like, like);
    }
    return { sql: c.length ? c.join(' AND ') : '1=1', params: p };
  }

  const self: SecurityLog = {
    record,
    lockdown: () => lock.active,

    list(q) {
      const limit = clampLimit(q.limit);
      const w = where(q);
      const params = [...w.params];
      let cursorSql = '';
      if (q.cursor) {
        const [seq] = decodeCursor(q.cursor, 1);
        const n = Number(seq);
        if (!Number.isInteger(n)) throw Object.assign(new Error('Invalid pagination cursor'), { name: 'InvalidCursorError' });
        cursorSql = ' AND seq < ?';
        params.push(n);
      }
      const rows = db.prepare<unknown[], Row>(`SELECT * FROM security_events WHERE ${w.sql}${cursorSql} ORDER BY seq DESC LIMIT ?`).all(...params, limit + 1);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      return { items: page.map(rowToEvent), nextCursor: more ? encodeCursor([String(page[page.length - 1]!.seq)]) : null };
    },

    get(id) {
      const r = stmts.get.get(id);
      return r ? rowToEvent(r) : undefined;
    },

    summary(hours = 24) {
      const h = Math.min(24 * 366, Math.max(1, Math.floor(hours)));
      const since = new Date(Date.now() - h * 3_600_000).toISOString();
      const count = (sql: string, ...params: unknown[]) => (db.prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM security_events WHERE at >= ? ${sql}`).get(since, ...params)?.n ?? 0);
      const bySeverity = Object.fromEntries(SECURITY_SEVERITIES.map((s) => [s, 0])) as Record<SecuritySeverity, number>;
      for (const r of db.prepare<[string], { severity: SecuritySeverity; n: number }>('SELECT severity, COUNT(*) AS n FROM security_events WHERE at >= ? GROUP BY severity').all(since)) bySeverity[r.severity] = r.n;
      const byCategory: SecuritySummary['byCategory'] = {};
      for (const r of db.prepare<[string], { category: SecurityCategory; n: number }>('SELECT category, COUNT(*) AS n FROM security_events WHERE at >= ? GROUP BY category').all(since)) byCategory[r.category] = r.n;
      const top = db.prepare<[string], { agent_id: string; n: number; name: string | null }>(`
        SELECT agent_id, COUNT(*) AS n,
          (SELECT actor_name FROM security_events s2 WHERE s2.actor_id = s.agent_id AND s2.actor_type = 'agent' ORDER BY seq DESC LIMIT 1) AS name
        FROM security_events s WHERE at >= ? AND agent_id IS NOT NULL GROUP BY agent_id ORDER BY n DESC LIMIT 5`).all(since);
      return {
        hours: h,
        total: Object.values(bySeverity).reduce((a, b) => a + b, 0),
        bySeverity,
        byCategory,
        deniedPermissions: count("AND action = 'permission.denied'"),
        untrustedReads: count("AND category = 'tool' AND json_extract(data, '$.untrusted') = 1"),
        rejectedTriggers: count("AND action = 'trigger.rejected'"),
        activeAgents: top.map((r) => ({ agentId: r.agent_id, name: repos?.agents.get(r.agent_id)?.name ?? r.name ?? 'Deleted agent', events: r.n })),
        lockdown: lock.active,
      };
    },

    verify() {
      let checked = 0;
      let firstSeq: number | null = null;
      let lastSeq: number | null = null;
      let prev: SecurityEvent | null = null;
      const broken = (seq: number, problem: string): SecurityVerifyResult => ({ ok: false, checked, firstSeq, lastSeq: seq, brokenAtSeq: seq, problem });
      let after = 0;
      for (;;) {
        const rows = stmts.ascFrom.all(after, 1000);
        if (!rows.length) break;
        for (const row of rows) {
          let ev: SecurityEvent;
          try { ev = rowToEvent(row); } catch { checked++; return broken(row.seq, 'The event data cannot be read (it was changed outside Sebeto).'); }
          checked++;
          if (firstSeq === null) firstSeq = ev.seq;
          if (prev === null) {
            if (ev.seq === 1 && ev.prevHash !== GENESIS_HASH) return broken(ev.seq, 'The first event does not start the chain.');
          } else {
            if (ev.seq !== prev.seq + 1) {
              const missing = ev.seq - prev.seq - 1;
              return broken(ev.seq, missing > 0 ? `${missing} event(s) before this one are missing (deleted outside Sebeto).` : 'Events are out of order.');
            }
            if (ev.prevHash !== prev.hash) return broken(ev.seq, 'This event does not link to the one before it.');
          }
          if (eventHash(ev) !== ev.hash) return broken(ev.seq, 'This event was changed after it was written.');
          prev = ev;
          lastSeq = ev.seq;
        }
        after = rows[rows.length - 1]!.seq;
      }
      return { ok: true, checked, firstSeq, lastSeq, brokenAtSeq: null, problem: null };
    },

    *batches(q, size = 500) {
      const w = where(q);
      const stmt = db.prepare<unknown[], Row>(`SELECT * FROM security_events WHERE ${w.sql} AND seq > ? ORDER BY seq ASC LIMIT ?`);
      let after = 0;
      for (;;) {
        const rows = stmt.all(...w.params, after, size);
        if (!rows.length) return;
        after = rows[rows.length - 1]!.seq;
        yield rows.map(rowToEvent);
        if (rows.length < size) return;
      }
    },

    settings: () => ({ ...settings }),

    updateSettings(patch) {
      const next = { ...settings };
      if (patch.retentionDays !== undefined) {
        if (!Number.isInteger(patch.retentionDays) || patch.retentionDays < 0 || patch.retentionDays > MAX_RETENTION_DAYS) throw new Error('retentionDays must be a whole number of days (0 = keep forever)');
        next.retentionDays = patch.retentionDays;
      }
      if (patch.jsonlMirror !== undefined) {
        if (typeof patch.jsonlMirror !== 'boolean') throw new Error('jsonlMirror must be true or false');
        next.jsonlMirror = patch.jsonlMirror;
      }
      const before = settings;
      settings = next;
      try {
        persist();
      } catch (err) {
        settings = before;
        throw err;
      }
      return { ...settings };
    },

    prune(nowMs = Date.now()) {
      if (settings.retentionDays <= 0) return 0;
      const cutoff = new Date(nowMs - settings.retentionDays * 86_400_000).toISOString();
      let removed = 0;
      try {
        removed = stmts.prune.run(cutoff).changes;
      } catch (err) {
        log?.error({ err: errMessage(err) }, 'security log: retention prune failed');
        return 0;
      }
      if (removed > 0) {
        record({
          category: 'system', action: 'system.retention_pruned', severity: 'info',
          summary: `Deleted ${removed} security event(s) older than ${settings.retentionDays} day(s) (retention setting).`,
          data: { removed, retentionDays: settings.retentionDays, cutoff },
        });
      }
      return removed;
    },

    lockdownState: () => ({ ...lock }),

    dropQueuedJobs(reason) {
      return db.transaction(() => {
        const rows = db.prepare<[], { id: string; payload: string }>("SELECT id, payload FROM jobs WHERE state = 'queued'").all();
        if (rows.length) db.prepare("UPDATE jobs SET state = 'failed', locked_by = NULL, last_error = ?, updated_at = ? WHERE state = 'queued'").run(reason, nowIso());
        const ids = new Set<Id>();
        for (const r of rows) {
          try {
            const t = (JSON.parse(r.payload) as { ticketId?: unknown }).ticketId;
            if (typeof t === 'string') ids.add(t);
          } catch { /* ignore */ }
        }
        return { count: rows.length, ticketIds: [...ids] };
      }).immediate();
    },

    runningTicketIds() {
      return db.prepare<[], { ticket_id: string }>("SELECT DISTINCT ticket_id FROM runs WHERE status IN ('running', 'queued')").all().map((r) => r.ticket_id);
    },

    disableTriggers() {
      try {
        return db.prepare('UPDATE triggers SET enabled = 0, updated_at = ? WHERE enabled = 1').run(nowIso()).changes;
      } catch (err) {
        log?.error({ err: errMessage(err) }, 'emergency stop: could not turn off triggers');
        return 0;
      }
    },

    setLockdown(active, reason = null) {
      lock = active ? { active: true, since: nowIso(), reason: reason ?? null } : { active: false, since: null, reason: null };
      try {
        persist();
      } catch (err) {
        log?.error({ err: errMessage(err) }, 'security log: could not save the lockdown state');
      }
      try { bus?.publish({ type: 'security.lockdown', active }); } catch { /* ignore */ }
      return { ...lock };
    },
  };
  return self;
}
