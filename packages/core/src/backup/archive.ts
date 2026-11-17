/**
 * Workspace backup files (v0.7 Q, contract packages/shared/src/backups.ts): make one, check one,
 * restore one into a NEW workspace folder. The HTTP side and the schedule live in service.ts; the
 * command line restore in ../restore.ts.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type Database from 'better-sqlite3';
import {
  BACKUP_FORMAT, nowIso,
  type BackupKind, type BackupManifest, type BackupManifestFile, type BackupVerifyResult,
} from '@sebeto/shared';
import type { SecretStore } from '../connectors/secrets.js';
import { createSecretStore, defaultProtector, type Protector } from '../connectors/secrets.js';
import { MIGRATIONS } from '../storage/migrations.js';
import { openDatabase } from '../storage/database.js';
import { createSecurityLog } from '../security/log.js';
import { checkPassphrase, openSecrets, sealSecrets, SecretsBoxError } from './secrets-box.js';
import { createZipWriter, isSafeEntryName, openZip, ZipError, type ZipReader } from './zip.js';

export const MANIFEST_NAME = 'manifest.json';
export const DB_NAME = 'sebeto.db';
export const SECRETS_NAME = 'secrets.enc';
/** Workspace files copied as they are (each optional). */
export const SETTINGS_FILES = ['settings.json', 'security.json', 'backup.json'] as const;
/** Workspace folders copied with everything in them (regular files only; links are skipped). */
export const BASE_FOLDERS = ['connectors', 'memory', 'templates', 'skills'] as const;
export const TICKETS_FOLDER = 'tickets';
/** The only top-level names a backup may contain (anything else is refused on verify/restore). */
const ALLOWED_TOP = new Set<string>([MANIFEST_NAME, DB_NAME, SECRETS_NAME, ...SETTINGS_FILES, ...BASE_FOLDERS, TICKETS_FOLDER]);
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_SECRETS_BYTES = 8 * 1024 * 1024;
const SECRET_FILE_RE = /^([a-z0-9][a-z0-9-]{0,63})\.secret$/;
const SHA_RE = /^[0-9a-f]{64}$/;

export class BackupError extends Error {
  constructor(message: string, readonly code = 'backup_failed') {
    super(message);
    this.name = 'BackupError';
  }
}

/** This app's newest database schema version. */
export const SUPPORTED_SCHEMA_VERSION = MIGRATIONS.length;

interface SourceFile { rel: string; abs: string }

/** Every regular file under `<root>/<folder>` as forward-slash relative paths (links and odd names skipped). */
export async function listFolder(root: string, folder: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  async function walk(rel: string): Promise<void> {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(path.join(root, ...rel.split('/')), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const d of dirents) {
      const childRel = `${rel}/${d.name}`;
      if (!isSafeEntryName(childRel)) continue;
      if (d.isDirectory()) await walk(childRel);
      else if (d.isFile()) out.push({ rel: childRel, abs: path.join(root, ...childRel.split('/')) });
    }
  }
  await walk(folder);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export async function folderBytes(files: SourceFile[]): Promise<number> {
  let n = 0;
  for (const f of files) {
    try { n += (await fs.promises.stat(f.abs)).size; } catch { /* vanished */ }
  }
  return n;
}

/** Secret names stored in <workspace>/secrets (names only). */
export function listSecretNames(workspaceDir: string): string[] {
  try {
    return fs.readdirSync(path.join(workspaceDir, 'secrets'))
      .map((f) => SECRET_FILE_RE.exec(f)?.[1])
      .filter((n): n is string => !!n)
      .sort();
  } catch {
    return [];
  }
}

export interface CreateBackupOptions {
  db: Database.Database;
  workspaceDir: string;
  /** Folder that receives the file (created if missing). */
  outDir: string;
  name: string;
  kind: BackupKind;
  includeTickets: boolean;
  /** Include the secrets, encrypted with this passphrase. */
  passphrase?: string;
  /** Needed to read the secrets when a passphrase is given. */
  secrets?: SecretStore;
  appVersion: string;
  /** Test hook: cheaper scrypt parameters. */
  scrypt?: { N: number; r: number; p: number };
}

export interface CreateBackupResult {
  name: string;
  file: string;
  sizeBytes: number;
  files: number;
  bytes: number;
  sha256: string;
  schemaVersion: number;
  secretCount: number;
  /** Secrets that could not be read and were left out. */
  secretsSkipped: number;
  includesTickets: boolean;
  createdAt: string;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), new Writable({ write(c: Buffer, _e, cb) { h.update(c); cb(); } }));
  return h.digest('hex');
}

/** Write one backup file. Never leaves a half-written file behind under the final name. */
export async function createBackupFile(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  const createdAt = nowIso();
  if (opts.passphrase !== undefined) checkPassphrase(opts.passphrase);
  await fs.promises.mkdir(opts.outDir, { recursive: true });
  const finalFile = path.join(opts.outDir, opts.name);
  if (fs.existsSync(finalFile)) throw new BackupError(`A backup named ${opts.name} already exists.`, 'exists');
  const partial = `${finalFile}.partial`;
  const tmpDir = await fs.promises.mkdtemp(path.join(opts.outDir, '.tmp-backup-'));
  let writer: Awaited<ReturnType<typeof createZipWriter>> | null = null;
  try {
    // 1. A consistent copy of the database through SQLite's online backup API (never a raw copy).
    const dbCopy = path.join(tmpDir, DB_NAME);
    await opts.db.backup(dbCopy);
    const schemaVersion = opts.db.pragma('user_version', { simple: true }) as number;

    // 2. Files to copy.
    const sources: SourceFile[] = [];
    for (const f of SETTINGS_FILES) {
      const abs = path.join(opts.workspaceDir, f);
      try { if ((await fs.promises.lstat(abs)).isFile()) sources.push({ rel: f, abs }); } catch { /* missing */ }
    }
    for (const folder of BASE_FOLDERS) sources.push(...await listFolder(opts.workspaceDir, folder));
    if (opts.includeTickets) sources.push(...await listFolder(opts.workspaceDir, TICKETS_FOLDER));

    // 3. Secrets, sealed with the passphrase (or left out).
    let sealed: Buffer | null = null;
    let secretCount = 0;
    let secretsSkipped = 0;
    if (opts.passphrase !== undefined) {
      if (!opts.secrets) throw new BackupError('The secret store is not available, so secrets cannot be included.');
      const values: Record<string, string> = {};
      for (const name of listSecretNames(opts.workspaceDir)) {
        // A secret this computer cannot read (damaged, or protected for another Windows user) is
        // skipped and counted, so one bad file does not block every encrypted backup.
        let v: string | null;
        try { v = await opts.secrets.get(name); } catch { v = null; secretsSkipped += 1; }
        if (v !== null) values[name] = v;
      }
      secretCount = Object.keys(values).length;
      sealed = await sealSecrets(values, opts.passphrase, opts.scrypt);
    }

    // 4. The archive: data first, the manifest last (it lists every file's sha256).
    writer = await createZipWriter(partial);
    const files: BackupManifestFile[] = [];
    const db = await writer.addFile(DB_NAME, dbCopy);
    files.push({ path: DB_NAME, size: db.size, sha256: db.sha256 });
    for (const s of sources) {
      let added;
      try {
        added = await writer.addFile(s.rel, s.abs);
      } catch (err) {
        // A file deleted while the backup runs (a note moved to the trash…) is not an error.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      files.push({ path: added.name, size: added.size, sha256: added.sha256 });
    }
    if (sealed) {
      const s = await writer.addBuffer(SECRETS_NAME, sealed);
      files.push({ path: SECRETS_NAME, size: s.size, sha256: s.sha256 });
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      appVersion: opts.appVersion,
      schemaVersion,
      createdAt,
      kind: opts.kind,
      includesTickets: opts.includeTickets,
      includesSecrets: sealed !== null,
      secretCount,
      sourceWorkspace: opts.workspaceDir,
      files,
    };
    await writer.addBuffer(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    await writer.finish();
    writer = null;
    await fs.promises.rename(partial, finalFile);
    const sizeBytes = (await fs.promises.stat(finalFile)).size;
    return {
      name: opts.name, file: finalFile, sizeBytes, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0),
      sha256: await sha256File(finalFile), schemaVersion, secretCount, secretsSkipped, includesTickets: opts.includeTickets, createdAt,
    };
  } catch (err) {
    await writer?.abort();
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ------------------------------------------------------------------------------------------ verify

function parseManifest(raw: Buffer, problems: string[]): BackupManifest | null {
  let m: BackupManifest;
  try {
    m = JSON.parse(raw.toString('utf8')) as BackupManifest;
  } catch {
    problems.push('manifest.json is not valid JSON.');
    return null;
  }
  if (!m || typeof m !== 'object') { problems.push('manifest.json is empty.'); return null; }
  if (m.format !== BACKUP_FORMAT) { problems.push(`Unknown backup format ${JSON.stringify(String(m.format)).slice(0, 60)}.`); return null; }
  if (!Number.isInteger(m.schemaVersion) || m.schemaVersion < 0) { problems.push('The manifest has no valid schema version.'); return null; }
  if (!Array.isArray(m.files)) { problems.push('The manifest has no file list.'); return null; }
  const seen = new Set<string>();
  for (const f of m.files) {
    if (!f || typeof f.path !== 'string' || !isSafeEntryName(f.path)) { problems.push(`Unsafe path in the manifest refused: ${JSON.stringify(String(f?.path)).slice(0, 200)}`); return null; }
    if (!ALLOWED_TOP.has(f.path.split('/')[0]!) || f.path === MANIFEST_NAME) { problems.push(`Unexpected file in the manifest refused: ${f.path}`); return null; }
    if (!Number.isInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !SHA_RE.test(f.sha256)) { problems.push(`Bad size or sha256 for ${f.path}.`); return null; }
    if (seen.has(f.path.toLowerCase())) { problems.push(`Duplicate path in the manifest: ${f.path}`); return null; }
    seen.add(f.path.toLowerCase());
  }
  if (!seen.has(DB_NAME)) { problems.push('The backup has no database.'); return null; }
  return m;
}

export interface VerifyOptions {
  passphrase?: string;
}

export interface VerifiedBackup {
  result: BackupVerifyResult;
  manifest: BackupManifest | null;
  /** Decrypted secrets (only when a passphrase was given and it opened them). */
  secrets: Record<string, string> | null;
}

/** Check a backup without restoring it: the manifest, every file's sha256 and size, the schema version, every path. */
export async function verifyBackupFile(file: string, opts: VerifyOptions = {}): Promise<VerifiedBackup> {
  const problems: string[] = [];
  const result: BackupVerifyResult = {
    ok: false, name: path.basename(file), files: 0, bytes: 0, schemaVersion: null, supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    createdAt: null, appVersion: null, includesTickets: false, includesSecrets: false, secretsOpened: null, matchesRecordedHash: null, problems,
  };
  let zip: ZipReader | null = null;
  let manifest: BackupManifest | null = null;
  let secrets: Record<string, string> | null = null;
  try {
    zip = await openZip(file);
    const mEntry = zip.get(MANIFEST_NAME);
    if (!mEntry) {
      problems.push('manifest.json is missing: this is not a Sebeto backup.');
    } else {
      manifest = parseManifest(await zip.readBuffer(mEntry, MAX_MANIFEST_BYTES), problems);
    }
    if (manifest) {
      result.schemaVersion = manifest.schemaVersion;
      result.createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt : null;
      result.appVersion = typeof manifest.appVersion === 'string' ? manifest.appVersion : null;
      result.includesTickets = manifest.includesTickets === true;
      result.includesSecrets = manifest.includesSecrets === true;
      result.files = manifest.files.length;
      result.bytes = manifest.files.reduce((n, f) => n + f.size, 0);
      if (manifest.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
        problems.push(`The backup's database is schema v${manifest.schemaVersion}, newer than this Sebeto supports (v${SUPPORTED_SCHEMA_VERSION}). Update Sebeto first.`);
      }
      const listed = new Set(manifest.files.map((f) => f.path));
      for (const e of zip.entries) {
        if (e.name !== MANIFEST_NAME && !listed.has(e.name)) problems.push(`File not listed in the manifest: ${e.name}`);
      }
      for (const f of manifest.files) {
        const e = zip.get(f.path);
        if (!e) { problems.push(`Missing file: ${f.path}`); continue; }
        try {
          const h = await zip.hash(e);
          if (h.size !== f.size || h.sha256 !== f.sha256) problems.push(`Changed or damaged: ${f.path}`);
        } catch (err) {
          problems.push(err instanceof ZipError ? err.message : `Could not read ${f.path}.`);
        }
      }
      if (result.includesSecrets !== listed.has(SECRETS_NAME)) problems.push('The manifest and the encrypted secrets do not match.');
      if (result.includesSecrets && opts.passphrase !== undefined && problems.length === 0) {
        try {
          secrets = await openSecrets(await zip.readBuffer(zip.get(SECRETS_NAME)!, MAX_SECRETS_BYTES), opts.passphrase);
          result.secretsOpened = true;
        } catch (err) {
          result.secretsOpened = false;
          problems.push(err instanceof SecretsBoxError ? err.message : 'The secrets could not be opened.');
        }
      }
    }
  } catch (err) {
    problems.push(err instanceof ZipError ? err.message : `The backup could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  } finally {
    await zip?.close().catch(() => undefined);
  }
  result.ok = problems.length === 0;
  return { result, manifest: result.ok ? manifest : null, secrets: result.ok ? secrets : null };
}

// ------------------------------------------------------------------------------------------ restore

export interface RestoreOptions {
  passphrase?: string;
  /** How restored secrets are protected on disk (default: DPAPI on Windows, a 600 file elsewhere). */
  protector?: Protector;
  appVersion?: string;
}

export interface RestoreResult {
  targetDir: string;
  files: number;
  bytes: number;
  schemaVersion: number;
  migratedTo: number;
  secretsRestored: number;
  /** Ticket folder paths in the database moved from the old workspace to the new one. */
  ticketFoldersMoved: number;
  warnings: string[];
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Restore a backup into a NEW workspace folder (`targetDir` must not exist or be empty). Verifies
 * everything first, re-checks each sha256 while writing, rewrites ticket folder paths, migrates an
 * older database, and writes `backup.restored` into the new workspace's security log.
 */
export async function restoreBackupFile(file: string, targetDir: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const target = path.resolve(targetDir);
  if (fs.existsSync(target)) {
    const st = fs.statSync(target);
    if (!st.isDirectory()) throw new BackupError(`${target} is a file, not a folder.`, 'target_not_empty');
    if (fs.readdirSync(target).length > 0) {
      throw new BackupError(`${target} is not empty. Restore always creates a NEW workspace: choose an empty or new folder (never the workspace Sebeto is using).`, 'target_not_empty');
    }
  }
  if (isInside(path.resolve(file), target)) throw new BackupError('The backup file cannot be inside the target folder.', 'bad_target');

  const verified = await verifyBackupFile(file, { passphrase: opts.passphrase });
  if (!verified.result.ok || !verified.manifest) {
    throw new BackupError(`The backup failed verification, nothing was restored:\n- ${verified.result.problems.join('\n- ')}`, 'verify_failed');
  }
  const manifest = verified.manifest;
  const warnings: string[] = [];
  if (manifest.includesSecrets && opts.passphrase === undefined) {
    warnings.push('The backup holds encrypted secrets but no passphrase was given: they were NOT restored. Sign in to the connectors again, or restore again with --passphrase-file.');
  }

  const created = !fs.existsSync(target);
  fs.mkdirSync(target, { recursive: true });
  let zip: ZipReader | null = null;
  try {
    zip = await openZip(file);
    let files = 0;
    let bytes = 0;
    for (const f of manifest.files) {
      if (f.path === SECRETS_NAME) continue;
      const dest = path.resolve(target, ...f.path.split('/'));
      if (!isInside(dest, target)) throw new BackupError(`Unsafe path refused: ${f.path}`, 'unsafe_path');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const entry = zip.get(f.path);
      if (!entry) throw new BackupError(`Missing file: ${f.path}`, 'verify_failed');
      // Re-hash while writing: the file could have changed since it was verified.
      const h = createHash('sha256');
      const tap = new Transform({ transform(c: Buffer, _e, cb) { h.update(c); cb(null, c); } });
      await zip.pipeTo(entry, tap, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
      if (h.digest('hex') !== f.sha256) throw new BackupError(`Changed or damaged: ${f.path}`, 'verify_failed');
      files += 1;
      bytes += f.size;
    }
    await zip.close();
    zip = null;

    // Secrets: decrypted with the passphrase and stored again with this computer's protection.
    let secretsRestored = 0;
    if (verified.secrets) {
      const store = createSecretStore(target, opts.protector ?? defaultProtector());
      for (const [name, value] of Object.entries(verified.secrets)) {
        try {
          await store.set(name, value);
          secretsRestored += 1;
        } catch {
          warnings.push(`A secret could not be stored (${name}).`);
        }
      }
    }

    // Database: migrate an older schema, point ticket folders at the new workspace, log the restore.
    const { db, repos, migration } = openDatabase({ file: path.join(target, DB_NAME), workspaceDir: target });
    let ticketFoldersMoved = 0;
    try {
      const old = typeof manifest.sourceWorkspace === 'string' ? manifest.sourceWorkspace : '';
      if (old) {
        const rows = db.prepare<[], { id: string; folder: string }>('SELECT id, folder FROM tickets').all();
        const update = db.prepare<[string, string]>('UPDATE tickets SET folder = ? WHERE id = ?');
        db.transaction(() => {
          for (const r of rows) {
            if (typeof r.folder !== 'string') continue;
            const rel = path.relative(old, r.folder);
            if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
            update.run(path.join(target, rel), r.id);
            ticketFoldersMoved += 1;
          }
        })();
      }
      const sec = createSecurityLog({ db, workspaceDir: target, repos });
      sec.record({
        category: 'system', action: 'backup.restored', severity: 'notice',
        summary: `Workspace restored from backup ${path.basename(file)} (${files} files).`,
        data: {
          name: path.basename(file), files, bytes, schemaVersion: manifest.schemaVersion, migratedTo: migration.to,
          includesTickets: manifest.includesTickets, secretsRestored, ticketFoldersMoved, appVersion: opts.appVersion ?? null,
        },
      });
    } finally {
      repos.close();
    }
    return {
      targetDir: target, files, bytes, schemaVersion: manifest.schemaVersion, migratedTo: migration.to,
      secretsRestored, ticketFoldersMoved, warnings,
    };
  } catch (err) {
    await zip?.close().catch(() => undefined);
    // Leave nothing half-restored behind (only a folder this restore created or that was empty).
    if (created) fs.rmSync(target, { recursive: true, force: true });
    else for (const n of fs.readdirSync(target)) fs.rmSync(path.join(target, n), { recursive: true, force: true });
    throw err;
  }
}
