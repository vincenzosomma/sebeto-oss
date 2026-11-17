/**
 * Read-only counts for the diagnostics report. Returns numbers and ids only: no ticket titles,
 * goals or messages. (Audit summaries and run exit reasons are returned for the redactor.)
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { StatsRepo } from '../contracts.js';

function grouped(db: Database.Database, sql: string, ...params: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of db.prepare(sql).all(...params) as Array<{ k: string; n: number }>) out[row.k] = row.n;
  return out;
}

export function createStatsRepo(db: Database.Database): StatsRepo {
  return {
    schemaVersion: () => db.pragma('user_version', { simple: true }) as number,
    dbBytes() {
      const file = db.name;
      if (!file || file === ':memory:') return null;
      let total = 0;
      for (const f of [file, `${file}-wal`]) {
        try { total += fs.statSync(f).size; } catch { /* missing WAL is fine */ }
      }
      return total;
    },
    ticketsByStatus: () => grouped(db, 'SELECT status AS k, COUNT(*) AS n FROM tickets WHERE deleted_at IS NULL GROUP BY status'),
    agentCount: () => (db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n,
    runsByStatusSince: (sinceIso) => grouped(db, 'SELECT status AS k, COUNT(*) AS n FROM runs WHERE started_at >= ? GROUP BY status', sinceIso),
    jobsByState: () => grouped(db, 'SELECT state AS k, COUNT(*) AS n FROM jobs GROUP BY state'),
    recentErrors: (limit) => (db.prepare(
      `SELECT t.number AS ticketNumber, e.summary AS summary, e.created_at AS at
       FROM audit_events e JOIN tickets t ON t.id = e.ticket_id
       WHERE e.kind = 'error' ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    ).all(limit) as Array<{ ticketNumber: number; summary: string; at: string }>),
    recentFailedRuns: (limit) => (db.prepare(
      `SELECT t.number AS ticketNumber, r.trigger AS trigger, r.exit_reason AS exitReason, COALESCE(r.ended_at, r.started_at) AS at
       FROM runs r JOIN tickets t ON t.id = r.ticket_id
       WHERE r.status = 'failed' ORDER BY r.started_at DESC, r.id DESC LIMIT ?`,
    ).all(limit) as Array<{ ticketNumber: number; trigger: string; exitReason: string | null; at: string }>),
  };
}
