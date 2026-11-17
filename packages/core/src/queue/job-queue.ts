/**
 * SQLite-backed job queue (docs/16 Scalability.md rule 3). Same contract as the future Postgres
 * `SELECT ... FOR UPDATE SKIP LOCKED` implementation: claim is atomic, jobs survive restarts.
 */
import type Database from 'better-sqlite3';
import { nowIso, uuidv7, type Id } from '@sebeto/shared';
import type { Job, JobKind, JobPayload, JobQueue } from '../contracts.js';

interface JobRow {
  id: string;
  kind: JobKind;
  payload: string;
  priority: number;
  state: Job['state'];
  attempts: number;
  run_after: string;
  locked_by: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Finished (done/failed) jobs older than this are deleted by `prune()` (called by the scheduler). */
export const JOB_RETENTION_DAYS = 14;

/** Default priority per kind (lower = sooner). */
export const DEFAULT_PRIORITY: Record<JobKind, number> = {
  'run.permission': 0,
  'run.reply': 0,
  'run.start': 10,
  'run.message': 20,
  'run.heartbeat': 30,
};

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    payload: JSON.parse(r.payload) as JobPayload,
    priority: r.priority,
    state: r.state,
    attempts: r.attempts,
    runAfter: r.run_after,
    lockedBy: r.locked_by,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}

export function createJobQueue(db: Database.Database): JobQueue {
  const stmts = {
    get: db.prepare<[string], JobRow>('SELECT * FROM jobs WHERE id = ?'),
    queuedByKey: db.prepare<[string], JobRow>("SELECT * FROM jobs WHERE dedupe_key = ? AND state = 'queued'"),
    insert: db.prepare(`
      INSERT INTO jobs (id, kind, payload, priority, state, attempts, run_after, locked_by, last_error, dedupe_key, created_at, updated_at)
      VALUES (@id, @kind, @payload, @priority, 'queued', 0, @runAfter, NULL, NULL, @dedupeKey, @now, @now)`),
    nextDue: db.prepare<[string], { id: string }>(`
      SELECT id FROM jobs WHERE state = 'queued' AND run_after <= ?
      ORDER BY priority ASC, id ASC LIMIT 1`),
    lock: db.prepare(
      "UPDATE jobs SET state = 'running', locked_by = ?, updated_at = ? WHERE id = ? AND state = 'queued'"),
    complete: db.prepare(
      "UPDATE jobs SET state = 'done', locked_by = NULL, updated_at = ? WHERE id = ?"),
    requeue: db.prepare(`
      UPDATE jobs SET state = 'queued', attempts = attempts + 1, last_error = ?, run_after = ?, locked_by = NULL, updated_at = ?
      WHERE id = ?`),
    markFailed: db.prepare(`
      UPDATE jobs SET state = 'failed', attempts = attempts + 1, last_error = ?, locked_by = NULL, updated_at = ?
      WHERE id = ?`),
    // A stale running job whose dedupe key already has a queued twin is superseded, not requeued
    // (the partial unique index allows only one queued job per key).
    supersedeStale: db.prepare(`
      UPDATE jobs SET state = 'failed', locked_by = NULL, last_error = 'superseded by a queued duplicate', updated_at = ?
      WHERE state = 'running' AND dedupe_key IS NOT NULL
        AND EXISTS (SELECT 1 FROM jobs q WHERE q.state = 'queued' AND q.dedupe_key = jobs.dedupe_key)`),
    recoverStale: db.prepare(
      "UPDATE jobs SET state = 'queued', locked_by = NULL, updated_at = ? WHERE state = 'running'"),
    depth: db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'"),
    prune: db.prepare<[string]>("DELETE FROM jobs WHERE state IN ('done','failed') AND updated_at < ?"),
  };

  const enqueue = db.transaction(
    (kind: JobKind, payload: JobPayload, opts: { priority?: number; runAfter?: Date; dedupeKey?: string }): Job => {
      if (opts.dedupeKey !== undefined) {
        const existing = stmts.queuedByKey.get(opts.dedupeKey);
        if (existing) return toJob(existing);
      }
      const id = uuidv7();
      const now = nowIso();
      stmts.insert.run({
        id,
        kind,
        payload: JSON.stringify(payload),
        priority: opts.priority ?? DEFAULT_PRIORITY[kind],
        runAfter: opts.runAfter ? opts.runAfter.toISOString() : now,
        dedupeKey: opts.dedupeKey ?? null,
        now,
      });
      return toJob(stmts.get.get(id)!);
    },
  );

  const claim = db.transaction((workerId: string): Job | undefined => {
    const now = nowIso();
    const next = stmts.nextDue.get(now);
    if (!next) return undefined;
    if (stmts.lock.run(workerId, now, next.id).changes === 0) return undefined;
    return toJob(stmts.get.get(next.id)!);
  });

  const fail = db.transaction((id: Id, error: string, retryAt?: Date): void => {
    const job = stmts.get.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    const now = nowIso();
    const twin = job.dedupe_key !== null ? stmts.queuedByKey.get(job.dedupe_key) : undefined;
    if (retryAt && !twin) stmts.requeue.run(error, retryAt.toISOString(), now, id);
    else stmts.markFailed.run(error, now, id); // no retry, or a queued duplicate will do the work
  });

  const recoverStale = db.transaction((): number => {
    const now = nowIso();
    return stmts.supersedeStale.run(now).changes + stmts.recoverStale.run(now).changes;
  });

  return {
    enqueue: (kind, payload, opts = {}) => enqueue.immediate(kind, payload, opts),
    // IMMEDIATE takes the write lock before the SELECT, so two processes cannot claim the same job.
    claim: (workerId) => claim.immediate(workerId),
    complete(id) {
      if (stmts.complete.run(nowIso(), id).changes === 0) throw new Error(`Job not found: ${id}`);
    },
    fail: (id, error, retryAt) => fail.immediate(id, error, retryAt),
    recoverStale: () => recoverStale.immediate(),
    depth: () => stmts.depth.get()!.n,
    prune(olderThanDays = JOB_RETENTION_DAYS) {
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
      return stmts.prune.run(cutoff).changes;
    },
  };
}
