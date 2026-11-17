/**
 * Backups for the running core (v0.7 Q): settings in <workspace>/backup.json (no DB change), the
 * list / create / delete / verify actions behind /api/v1/backups, the daily automatic backup driven
 * by the scheduler tick, retention, and the security log events:
 *   backup.created, backup.deleted, backup.verified, backup.failed (+ backup.settings_changed).
 * Events carry names, sizes and counts only: never file contents, secrets or the passphrase.
 *
 * Automatic backup is ON by default (daily, keep 7, no ticket folders, no secrets): for an IT Ops
 * tool a lost or corrupted workspace (disk failure, ransomware, a bad update) is a security incident
 * too, and a backup without secrets and without ticket folders is small and holds nothing that the
 * workspace folder itself does not already hold, with the same file permissions.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  BACKUP_NAME_RE, BACKUP_TIME_RE, MAX_BACKUP_KEEP,
  type BackupEstimate, type BackupInfo, type BackupKind, type BackupListResponse, type BackupSettings, type BackupVerifyResult,
  type CreateBackupBody, type VerifyBackupBody,
} from '@sebeto/shared';
import type { Logger, SecurityLogger } from '../contracts.js';
import type { SecretStore } from '../connectors/secrets.js';
import { fullLog } from '../security/log.js';
import { AppError, badRequest, conflict, notFound } from '../services/errors.js';
import {
  BASE_FOLDERS, BackupError, DB_NAME, SETTINGS_FILES, TICKETS_FOLDER, createBackupFile, folderBytes, listFolder, listSecretNames,
  sha256File, verifyBackupFile,
} from './archive.js';
import { SecretsBoxError, checkPassphrase } from './secrets-box.js';

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { autoEnabled: true, autoTime: '12:30', keep: 7, dir: null };
export const BACKUPS_FOLDER = 'backups';
/** Workspace folders a backup folder may never be inside (they are backed up, or hold secrets/logs). */
const PROTECTED_FOLDERS = [TICKETS_FOLDER, ...BASE_FOLDERS, 'secrets', 'logs', 'intake'];

export interface BackupService {
  list(): BackupListResponse;
  estimate(): Promise<BackupEstimate>;
  create(body: CreateBackupBody, kind?: BackupKind): Promise<BackupInfo>;
  remove(name: string): void;
  verify(name: string, body?: VerifyBackupBody): Promise<BackupVerifyResult>;
  /** Absolute path of an existing backup (404 otherwise). */
  filePath(name: string): string;
  settings(): BackupSettings;
  updateSettings(patch: Partial<BackupSettings>): BackupSettings;
  /** Start the automatic backup when it is due (never overlapping, skipped during an emergency stop). Never throws. */
  tick(now?: Date): Promise<BackupInfo | null> | null;
  /** True while a backup is being written. */
  running(): boolean;
}

export interface BackupServiceOptions {
  db: Database.Database;
  workspaceDir: string;
  appVersion: string;
  secrets?: SecretStore;
  securityLog?: SecurityLogger;
  log?: Logger;
  /** Ticket folders known to the database (a backup folder may not be inside any of them). */
  ticketFolders?: () => string[];
  /** Test hook: cheaper scrypt parameters. */
  scrypt?: { N: number; r: number; p: number };
}

interface StoredState extends BackupSettings {
  lastAuto?: { at: string; ok: boolean; message: string | null } | null;
}

function isInsideOrSame(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Validates an owner-picked backup folder; returns it resolved. Throws AppError 400. */
export function validateBackupDir(input: unknown, workspaceDir: string, ticketFolders: string[] = []): string {
  if (typeof input !== 'string' || input.trim() === '' || input.length > 1024) throw badRequest('The backup folder must be a path (at most 1024 characters).', 'invalid_backup_dir');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input)) throw badRequest('The backup folder contains invalid characters.', 'invalid_backup_dir');
  const raw = input.trim();
  if (!path.isAbsolute(raw)) throw badRequest('The backup folder must be a full path (for example D:\\Backups\\Sebeto).', 'invalid_backup_dir');
  if (raw.split(/[\\/]+/).some((seg) => seg === '..' || seg === '.')) throw badRequest('The backup folder may not contain "." or ".." parts.', 'invalid_backup_dir');
  const dir = path.resolve(raw);
  const ws = path.resolve(workspaceDir);
  if (isInsideOrSame(dir, ws) && !isInsideOrSame(dir, path.join(ws, BACKUPS_FOLDER))) {
    throw badRequest('Inside the workspace, backups can only go to its "backups" folder.', 'invalid_backup_dir');
  }
  for (const f of PROTECTED_FOLDERS) {
    if (isInsideOrSame(dir, path.join(ws, f))) throw badRequest(`The backup folder cannot be inside the workspace's ${f} folder.`, 'invalid_backup_dir');
  }
  for (const t of ticketFolders) {
    if (t && isInsideOrSame(dir, path.resolve(t))) throw badRequest('The backup folder cannot be inside a ticket folder.', 'invalid_backup_dir');
  }
  return dir;
}

export function validBackupName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 64 && BACKUP_NAME_RE.test(name);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** sebeto-backup-YYYYMMDD-HHMMSS[-auto].zip in the computer's local time. */
export function backupBaseName(d: Date, kind: BackupKind): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `sebeto-backup-${stamp}${kind === 'auto' ? '-auto' : ''}`;
}

/** Sorts backups by time, then by the -2, -3… counter (newest = largest key). */
export function backupSortKey(name: string): string {
  const m = /^sebeto-backup-(\d{8}-\d{6})(?:-auto)?(?:-(\d{1,3}))?\.zip$/.exec(name);
  return m ? `${m[1]}-${(m[2] ?? '1').padStart(3, '0')}` : name;
}

/** The moment today's automatic backup is due (local time). */
export function dueAt(now: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number) as [number, number];
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
}

export function isAutoDue(now: Date, settings: BackupSettings, lastAutoAt: string | null | undefined): boolean {
  if (!settings.autoEnabled) return false;
  const due = dueAt(now, settings.autoTime);
  if (now.getTime() < due.getTime()) return false;
  return !lastAutoAt || Date.parse(lastAutoAt) < due.getTime();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createBackupService(opts: BackupServiceOptions): BackupService {
  const ws = path.resolve(opts.workspaceDir);
  const file = path.join(ws, 'backup.json');
  const sec = opts.securityLog;
  let state: StoredState = { ...DEFAULT_BACKUP_SETTINGS, lastAuto: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredState>;
    if (typeof raw.autoEnabled === 'boolean') state.autoEnabled = raw.autoEnabled;
    if (typeof raw.autoTime === 'string' && BACKUP_TIME_RE.test(raw.autoTime)) state.autoTime = raw.autoTime;
    if (Number.isInteger(raw.keep) && raw.keep! >= 1 && raw.keep! <= MAX_BACKUP_KEEP) state.keep = raw.keep!;
    if (typeof raw.dir === 'string') {
      try { state.dir = validateBackupDir(raw.dir, ws); } catch { state.dir = null; }
    }
    if (raw.lastAuto && typeof raw.lastAuto.at === 'string') {
      state.lastAuto = { at: raw.lastAuto.at, ok: raw.lastAuto.ok === true, message: typeof raw.lastAuto.message === 'string' ? raw.lastAuto.message : null };
    }
  } catch { /* first run or unreadable: defaults */ }

  let busy: Promise<BackupInfo> | null = null;

  function persist(): void {
    const tmp = `${file}.tmp`;
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  const settings = (): BackupSettings => ({ autoEnabled: state.autoEnabled, autoTime: state.autoTime, keep: state.keep, dir: state.dir });
  const dir = () => state.dir ?? path.join(ws, BACKUPS_FOLDER);
  const ticketFolders = () => { try { return opts.ticketFolders?.() ?? []; } catch { return []; } };

  function items(): BackupInfo[] {
    let names: string[];
    try { names = fs.readdirSync(dir()); } catch { return []; }
    const out: BackupInfo[] = [];
    for (const name of names) {
      if (!validBackupName(name)) continue;
      try {
        const st = fs.statSync(path.join(dir(), name));
        if (!st.isFile()) continue;
        out.push({ name, kind: name.includes('-auto') ? 'auto' : 'manual', sizeBytes: st.size, createdAt: st.mtime.toISOString() });
      } catch { /* vanished */ }
    }
    return out.sort((a, b) => { const ka = backupSortKey(a.name); const kb = backupSortKey(b.name); return ka < kb ? 1 : ka > kb ? -1 : 0; });
  }

  function filePath(name: string): string {
    if (!validBackupName(name)) throw badRequest('Invalid backup name.', 'invalid_backup_name');
    const p = path.join(dir(), name);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw notFound('Backup', name);
    return p;
  }

  function freeName(kind: BackupKind, now: Date): string {
    const base = backupBaseName(now, kind);
    for (let i = 1; i < 1000; i++) {
      const name = i === 1 ? `${base}.zip` : `${base}-${i}.zip`;
      if (!fs.existsSync(path.join(dir(), name)) && !fs.existsSync(path.join(dir(), `${name}.partial`))) return name;
    }
    throw conflict('Too many backups in the same second.');
  }

  function removeFile(name: string, reason: 'owner' | 'retention'): void {
    const p = filePath(name);
    const sizeBytes = fs.statSync(p).size;
    fs.rmSync(p, { force: true });
    sec?.record({
      category: 'system', action: 'backup.deleted', severity: 'notice',
      summary: reason === 'retention' ? `Old automatic backup ${name} deleted (keep the last ${state.keep}).` : `Backup ${name} deleted.`,
      data: { name, sizeBytes, reason },
    });
  }

  function applyRetention(): void {
    const autos = items().filter((b) => b.kind === 'auto');
    for (const b of autos.slice(state.keep)) {
      try { removeFile(b.name, 'retention'); } catch (err) { opts.log?.warn({ err: errText(err) }, 'backup: retention could not delete a file'); }
    }
  }

  async function run(body: CreateBackupBody, kind: BackupKind, at: Date): Promise<BackupInfo> {
    const includeTickets = kind === 'auto' ? false : body.includeTickets === true;
    const passphrase = kind === 'auto' ? undefined : body.passphrase;
    const started = Date.now();
    const name = freeName(kind, at);
    try {
      const r = await createBackupFile({
        db: opts.db, workspaceDir: ws, outDir: dir(), name, kind, includeTickets, passphrase,
        secrets: opts.secrets, appVersion: opts.appVersion, scrypt: opts.scrypt,
      });
      sec?.record({
        category: 'system', action: 'backup.created', severity: r.secretsSkipped ? 'warning' : 'notice',
        summary: `${kind === 'auto' ? 'Automatic backup' : 'Backup'} ${name} created (${r.files} files${r.secretCount ? `, ${r.secretCount} secrets encrypted` : ''}${r.secretsSkipped ? `, ${r.secretsSkipped} unreadable secrets left out` : ''}).`,
        data: {
          name, kind, sizeBytes: r.sizeBytes, files: r.files, bytes: r.bytes, includesTickets: r.includesTickets,
          encrypted: passphrase !== undefined, secretCount: r.secretCount, secretsSkipped: r.secretsSkipped, schemaVersion: r.schemaVersion, sha256: r.sha256,
          durationMs: Date.now() - started,
        },
      });
      return { name, kind, sizeBytes: r.sizeBytes, createdAt: r.createdAt, ...(r.secretsSkipped ? { secretsSkipped: r.secretsSkipped } : {}) };
    } catch (err) {
      sec?.record({
        category: 'system', action: 'backup.failed', severity: 'warning',
        summary: `${kind === 'auto' ? 'Automatic backup' : 'Backup'} failed: ${errText(err)}`.slice(0, 300),
        data: { kind, includesTickets: includeTickets, encrypted: passphrase !== undefined, durationMs: Date.now() - started },
      });
      throw err;
    }
  }

  function start(body: CreateBackupBody, kind: BackupKind, at = new Date()): Promise<BackupInfo> {
    if (busy) throw conflict('A backup is already being written. Try again in a moment.', 'backup_running');
    const p = run(body, kind, at);
    busy = p;
    const clear = () => { if (busy === p) busy = null; };
    p.then(clear, clear);
    return p;
  }

  /** Finds the sha256 recorded when the backup was made (null: no record, e.g. retention removed it). */
  function recordedHash(name: string): string | null {
    const log = fullLog(sec);
    if (!log) return null;
    try {
      const page = log.list({ action: 'backup.created', q: name, limit: 20 });
      const ev = page.items.find((e) => e.data?.['name'] === name);
      const h = ev?.data?.['sha256'];
      return typeof h === 'string' ? h : null;
    } catch {
      return null;
    }
  }

  return {
    list: () => ({ items: items(), dir: dir(), settings: settings(), lastAuto: state.lastAuto ?? null, running: busy !== null }),

    async estimate() {
      let baseBytes = 0;
      try { baseBytes += fs.statSync(path.join(ws, DB_NAME)).size; } catch { /* in memory */ }
      for (const f of SETTINGS_FILES) { try { baseBytes += fs.statSync(path.join(ws, f)).size; } catch { /* missing */ } }
      for (const f of BASE_FOLDERS) baseBytes += await folderBytes(await listFolder(ws, f));
      const tickets = await listFolder(ws, TICKETS_FOLDER);
      const folders = new Set(tickets.map((t) => t.rel.split('/')[1]));
      return { baseBytes, ticketsBytes: await folderBytes(tickets), ticketFolders: folders.size, secrets: listSecretNames(ws).length };
    },

    async create(body, kind = 'manual') {
      if (body.passphrase !== undefined) {
        try { checkPassphrase(body.passphrase); } catch (err) { throw badRequest(errText(err), 'invalid_passphrase'); }
      }
      try {
        return await start(body, kind);
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof BackupError || err instanceof SecretsBoxError) throw new AppError(500, 'backup_failed', err.message);
        throw new AppError(500, 'backup_failed', `The backup could not be written: ${errText(err)}`);
      }
    },

    remove: (name) => removeFile(name, 'owner'),

    async verify(name, body = {}) {
      const p = filePath(name);
      const { result } = await verifyBackupFile(p, { passphrase: body.passphrase });
      const recorded = recordedHash(name);
      if (recorded) {
        result.matchesRecordedHash = (await sha256File(p)) === recorded;
        if (!result.matchesRecordedHash) {
          result.problems.push('The file is not the one Sebeto wrote: its sha256 differs from the one in the security log.');
          result.ok = false;
        }
      }
      sec?.record({
        category: 'system', action: 'backup.verified', severity: result.ok ? 'info' : 'warning',
        summary: result.ok ? `Backup ${name} verified: ${result.files} files intact.` : `Backup ${name} FAILED verification (${result.problems.length} problems).`,
        data: { name, ok: result.ok, files: result.files, bytes: result.bytes, problems: result.problems.length, matchesRecordedHash: result.matchesRecordedHash, secretsOpened: result.secretsOpened },
      });
      return result;
    },

    filePath,
    settings,

    updateSettings(patch) {
      const next = { ...state };
      if (patch.autoEnabled !== undefined) {
        if (typeof patch.autoEnabled !== 'boolean') throw badRequest('autoEnabled must be true or false');
        next.autoEnabled = patch.autoEnabled;
      }
      if (patch.autoTime !== undefined) {
        if (typeof patch.autoTime !== 'string' || !BACKUP_TIME_RE.test(patch.autoTime)) throw badRequest('autoTime must be HH:MM (24 hours)');
        next.autoTime = patch.autoTime;
      }
      if (patch.keep !== undefined) {
        if (!Number.isInteger(patch.keep) || patch.keep < 1 || patch.keep > MAX_BACKUP_KEEP) throw badRequest(`keep must be a whole number from 1 to ${MAX_BACKUP_KEEP}`);
        next.keep = patch.keep;
      }
      if (patch.dir !== undefined) next.dir = patch.dir === null ? null : validateBackupDir(patch.dir, ws, ticketFolders());
      if (next.dir !== null && path.resolve(next.dir) === path.resolve(ws, BACKUPS_FOLDER)) next.dir = null;
      const changed = (['autoEnabled', 'autoTime', 'keep', 'dir'] as const).filter((k) => next[k] !== state[k]);
      state = next;
      persist();
      if (changed.length) {
        sec?.record({
          category: 'config', action: 'backup.settings_changed', severity: 'notice',
          summary: `Backup settings changed: ${changed.join(', ')}.`,
          data: { changed, autoEnabled: state.autoEnabled, autoTime: state.autoTime, keep: state.keep, customDir: state.dir !== null },
        });
      }
      if (changed.includes('keep')) applyRetention();
      return settings();
    },

    tick(now = new Date()) {
      try {
        if (busy || !isAutoDue(now, state, state.lastAuto?.at)) return null;
        if (sec?.lockdown()) return null; // emergency stop: no automatic backup until it is released
        state.lastAuto = { at: now.toISOString(), ok: false, message: 'running' };
        persist();
        return start({}, 'auto', now).then(
          (info) => {
            state.lastAuto = { at: now.toISOString(), ok: true, message: null };
            persist();
            applyRetention();
            return info;
          },
          (err: unknown) => {
            state.lastAuto = { at: now.toISOString(), ok: false, message: errText(err).slice(0, 300) };
            try { persist(); } catch { /* ignore */ }
            opts.log?.error({ err: errText(err) }, 'automatic backup failed');
            return null;
          },
        );
      } catch (err) {
        opts.log?.error({ err: errText(err) }, 'automatic backup could not start');
        return null;
      }
    },

    running: () => busy !== null,
  };
}

