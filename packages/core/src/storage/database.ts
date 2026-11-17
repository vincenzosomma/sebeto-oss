import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Repos } from '../contracts.js';
import { MIGRATIONS } from './migrations.js';
import { createAgentRepo } from './agents.js';
import { createTicketRepo } from './tickets.js';
import { createCostsRepo } from './costs.js';
import { createProjectRepo } from './projects.js';
import { createSessionEntryRepo } from './sessions.js';
import { createTeamRepo } from './teams.js';
import {
  createAuditRepo, createMessageRepo, createPermissionRepo, createRunRepo, createSessionRepo, createTransitionRepo,
  createTrustedCommandRepo,
} from './records.js';
import { createStatsRepo } from './stats.js';
import { createTriggerRepo } from './triggers.js';
import { createMemoryIndexRepo } from './memory.js';

export interface OpenDatabaseOptions {
  /** SQLite file path (':memory:' is allowed for tests). */
  file: string;
  /** Workspace root; ticket folders are <workspaceDir>/tickets/T-<number>. */
  workspaceDir: string;
}

export interface MigrationResult {
  from: number;
  to: number;
  /** Path of the backup taken before migrating, if any. */
  backup: string | null;
}

function backupPath(file: string, version: number): string {
  const base = `${file}.bak-v${version}`;
  // Never overwrite an older backup: add a timestamp suffix if the plain name is taken.
  return fs.existsSync(base) ? `${base}-${Date.now()}` : base;
}

/**
 * Bring the schema up to date. Pending migrations run in ONE transaction (all or nothing),
 * tracked with PRAGMA user_version. An existing database with data is copied to
 * `<file>.bak-v<old>` first (VACUUM INTO gives a consistent copy even in WAL mode).
 */
export function migrate(db: Database.Database, file: string): MigrationResult {
  const from = db.pragma('user_version', { simple: true }) as number;
  const to = MIGRATIONS.length;
  if (from > to) {
    throw new Error(`Database schema v${from} is newer than this app supports (v${to}). Update Sebeto.`);
  }
  if (from === to) return { from, to, backup: null };

  let backup: string | null = null;
  const hasData = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n > 0;
  if (hasData && file !== ':memory:' && file !== '') {
    backup = backupPath(file, from);
    db.prepare('VACUUM INTO ?').run(backup);
  }

  db.transaction(() => {
    for (let v = from; v < to; v++) {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    }
  }).immediate();
  return { from, to, backup };
}

export function createRepos(db: Database.Database, workspaceDir: string): Repos {
  return {
    tickets: createTicketRepo(db, workspaceDir),
    agents: createAgentRepo(db),
    sessions: createSessionRepo(db),
    runs: createRunRepo(db),
    messages: createMessageRepo(db),
    audit: createAuditRepo(db),
    permissions: createPermissionRepo(db),
    transitions: createTransitionRepo(db),
    trusted: createTrustedCommandRepo(db),
    projects: createProjectRepo(db),
    teams: createTeamRepo(db),
    stats: createStatsRepo(db),
    costs: createCostsRepo(db),
    sessionLibrary: createSessionEntryRepo(db),
    triggers: createTriggerRepo(db),
    memoryIndex: createMemoryIndexRepo(db),
    // better-sqlite3 turns nested calls into SAVEPOINTs, so repo methods that open their own
    // transaction compose correctly inside tx().
    tx: <T>(fn: () => T): T => db.transaction(fn).immediate(),
    close: () => {
      if (db.open) db.close();
    },
  };
}

/** Open (creating if needed) the workspace database, apply pragmas and migrations, build repos. */
export function openDatabase(opts: OpenDatabaseOptions): { repos: Repos; db: Database.Database; migration: MigrationResult } {
  if (opts.file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(opts.file)), { recursive: true });
  const db = new Database(opts.file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL'); // safe with WAL; much faster commits
    const migration = migrate(db, opts.file);
    return { repos: createRepos(db, opts.workspaceDir), db, migration };
  } catch (err) {
    db.close();
    throw err;
  }
}
