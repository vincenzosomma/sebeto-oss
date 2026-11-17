/**
 * Workspace backup and restore (v0.7 Q, docs/31 v0.7 Plan.md).
 *
 * A backup is ONE `.zip` file (plain zip, written and read by Sebeto itself, no dependency):
 *   manifest.json            BackupManifest (format, versions, created-at, file list + sha256 per file)
 *   sebeto.db                a consistent copy of the database (SQLite online backup API)
 *   settings.json, security.json, backup.json, connectors/…   settings (no secrets in them)
 *   memory/…, templates/…, skills/…                            the memory vault, templates, skills
 *   tickets/…                ticket folders (optional: they can be big)
 *   secrets.enc              only with a passphrase: the secrets, AES-256-GCM, key from scrypt
 *
 * Restore never touches a running workspace: it writes a NEW workspace folder (CLI:
 * `node packages/core/dist/restore.js <backup.zip> <targetDir> [--passphrase-file <file>]`) after
 * checking the manifest, every sha256, the schema version and every path.
 *
 * API (under /api/v1):
 *   GET    /backups                     → BackupListResponse
 *   GET    /backups/estimate            → BackupEstimate (sizes before a backup, e.g. ticket folders)
 *   POST   /backups          CreateBackupBody → BackupInfo (201)
 *   GET    /backups/:name/download      → the .zip file
 *   POST   /backups/:name/verify  VerifyBackupBody → BackupVerifyResult
 *   DELETE /backups/:name               → 204
 *   GET    /backups/settings, PUT /backups/settings  BackupSettings
 */
import type { IsoDate } from './types.js';

export const BACKUP_FORMAT = 'sebeto-backup/1';
/** sebeto-backup-20261114-093000.zip, sebeto-backup-20261114-093000-auto.zip (optional -2, -3… suffix). */
export const BACKUP_NAME_RE = /^sebeto-backup-\d{8}-\d{6}(?:-auto)?(?:-\d{1,3})?\.zip$/;
export const MIN_BACKUP_PASSPHRASE = 12;
export const MAX_BACKUP_PASSPHRASE = 1024;
export const MAX_BACKUP_KEEP = 365;
/** HH:MM, 24 hours, local time of the computer running the core. */
export const BACKUP_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type BackupKind = 'manual' | 'auto';

export interface BackupInfo {
  name: string;
  kind: BackupKind;
  sizeBytes: number;
  createdAt: IsoDate;
  /** Only in the reply to POST /backups: secrets this computer could not read, left out of the backup. */
  secretsSkipped?: number;
}

export interface BackupSettings {
  /** Daily automatic backup (database, memory, settings, templates, skills; never ticket folders or secrets). */
  autoEnabled: boolean;
  /** Local time HH:MM. A backup missed while the computer was off runs at the next start / check. */
  autoTime: string;
  /** How many automatic backups to keep (older ones are deleted). Manual backups are never deleted automatically. */
  keep: number;
  /** Where backups are written; null = <workspace>/backups. Absolute path, never inside a ticket folder. */
  dir: string | null;
}

export interface BackupListResponse {
  items: BackupInfo[];
  /** The folder in use (resolved). */
  dir: string;
  settings: BackupSettings;
  lastAuto: { at: IsoDate; ok: boolean; message: string | null } | null;
  /** True while a backup is being written. */
  running: boolean;
}

export interface BackupEstimate {
  /** Database + memory + settings + templates + skills. */
  baseBytes: number;
  ticketsBytes: number;
  ticketFolders: number;
  secrets: number;
}

export interface CreateBackupBody {
  includeTickets?: boolean;
  /** Include the secrets, encrypted with this passphrase (never stored, never logged). */
  passphrase?: string;
}

export interface VerifyBackupBody {
  /** Optional: also check that the secrets open with this passphrase. */
  passphrase?: string;
}

export interface BackupManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  appVersion: string;
  schemaVersion: number;
  createdAt: IsoDate;
  kind: BackupKind;
  includesTickets: boolean;
  /** Secrets are inside secrets.enc (encrypted with the owner's passphrase). */
  includesSecrets: boolean;
  secretCount: number;
  /** Workspace the backup was made from (ticket folder paths in the database are rewritten on restore). */
  sourceWorkspace: string;
  files: BackupManifestFile[];
}

export interface BackupVerifyResult {
  ok: boolean;
  name: string;
  files: number;
  bytes: number;
  schemaVersion: number | null;
  /** This app's newest schema version. */
  supportedSchemaVersion: number;
  createdAt: IsoDate | null;
  appVersion: string | null;
  includesTickets: boolean;
  includesSecrets: boolean;
  /** null: no passphrase given (or no secrets); true/false: the secrets opened or not. */
  secretsOpened: boolean | null;
  /** The whole file's sha256 matches the one recorded in the security log when it was made (null: no record). */
  matchesRecordedHash: boolean | null;
  problems: string[];
}
