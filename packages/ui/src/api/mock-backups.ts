/**
 * Backups for the mock API (v0.7 Q): an in-memory list with the same rules as the core
 * (names, settings validation, retention of automatic backups, passphrase length).
 */
import {
  BACKUP_NAME_RE, BACKUP_TIME_RE, MAX_BACKUP_KEEP, MIN_BACKUP_PASSPHRASE,
  type BackupEstimate, type BackupInfo, type BackupListResponse, type BackupSettings, type BackupVerifyResult,
  type CreateBackupBody, type VerifyBackupBody,
} from '@sebeto/shared';
import { ApiHttpError } from './types';

const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');

function nameFor(d: Date, auto: boolean): string {
  return `sebeto-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${auto ? '-auto' : ''}.zip`;
}

export class MockBackups {
  private items: Array<BackupInfo & { secrets: boolean }> = [];
  private settings: BackupSettings = { autoEnabled: true, autoTime: '12:30', keep: 7, dir: null };
  private lastAuto: BackupListResponse['lastAuto'] = null;

  constructor(now = Date.now()) {
    for (let d = 3; d >= 1; d--) {
      const at = new Date(now - d * 24 * HOUR);
      at.setHours(12, 30, 4, 0);
      this.items.push({ name: nameFor(at, true), kind: 'auto', sizeBytes: 2_400_000 + d * 31_000, createdAt: at.toISOString(), secrets: false });
    }
    const manual = new Date(now - 5 * HOUR);
    this.items.push({ name: nameFor(manual, false), kind: 'manual', sizeBytes: 18_900_000, createdAt: manual.toISOString(), secrets: true });
    this.lastAuto = { at: this.items[2]!.createdAt, ok: true, message: null };
  }

  private find(name: string) {
    if (!BACKUP_NAME_RE.test(name)) throw new ApiHttpError(400, 'invalid_backup_name', 'Invalid backup name.');
    const b = this.items.find((i) => i.name === name);
    if (!b) throw new ApiHttpError(404, 'not_found', `Backup ${name} not found`);
    return b;
  }

  list(): BackupListResponse {
    const items = [...this.items].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(({ secrets: _s, ...b }) => b);
    return { items, dir: this.settings.dir ?? 'C:\\Users\\demo\\.sebeto\\workspace\\backups', settings: { ...this.settings }, lastAuto: this.lastAuto, running: false };
  }

  estimate(): BackupEstimate {
    return { baseBytes: 2_450_000, ticketsBytes: 16_400_000, ticketFolders: 23, secrets: 2 };
  }

  create(body: CreateBackupBody): BackupInfo {
    if (body.passphrase !== undefined && [...body.passphrase].length < MIN_BACKUP_PASSPHRASE) {
      throw new ApiHttpError(400, 'invalid_passphrase', `The passphrase must be at least ${MIN_BACKUP_PASSPHRASE} characters long.`);
    }
    const now = new Date();
    let name = nameFor(now, false);
    for (let i = 2; this.items.some((b) => b.name === name); i++) name = name.replace(/(-\d+)?\.zip$/, `-${i}.zip`);
    const info: BackupInfo = { name, kind: 'manual', sizeBytes: 2_450_000 + (body.includeTickets ? 16_400_000 : 0), createdAt: now.toISOString() };
    this.items.push({ ...info, secrets: body.passphrase !== undefined });
    return info;
  }

  verify(name: string, body: VerifyBackupBody = {}): BackupVerifyResult {
    const b = this.find(name);
    const secretsOpened = b.secrets && body.passphrase !== undefined ? body.passphrase.length >= MIN_BACKUP_PASSPHRASE : null;
    const problems = secretsOpened === false ? ['Wrong passphrase, or the encrypted secrets were changed.'] : [];
    return {
      ok: problems.length === 0, name, files: 42, bytes: b.sizeBytes * 3, schemaVersion: 10, supportedSchemaVersion: 10,
      createdAt: b.createdAt, appVersion: '0.1.0', includesTickets: b.sizeBytes > 10_000_000, includesSecrets: b.secrets,
      secretsOpened, matchesRecordedHash: true, problems,
    };
  }

  remove(name: string): void {
    this.find(name);
    this.items = this.items.filter((b) => b.name !== name);
  }

  download(name: string): { fileName: string; blob: Blob } {
    this.find(name);
    return { fileName: name, blob: new Blob(['PK demo backup (mock data)'], { type: 'application/zip' }) };
  }

  updateSettings(patch: Partial<BackupSettings>): BackupSettings {
    const next = { ...this.settings };
    if (patch.autoEnabled !== undefined) next.autoEnabled = patch.autoEnabled;
    if (patch.autoTime !== undefined) {
      if (!BACKUP_TIME_RE.test(patch.autoTime)) throw new ApiHttpError(400, 'bad_request', 'autoTime must be HH:MM (24 hours)');
      next.autoTime = patch.autoTime;
    }
    if (patch.keep !== undefined) {
      if (!Number.isInteger(patch.keep) || patch.keep < 1 || patch.keep > MAX_BACKUP_KEEP) throw new ApiHttpError(400, 'bad_request', `keep must be a whole number from 1 to ${MAX_BACKUP_KEEP}`);
      next.keep = patch.keep;
    }
    if (patch.dir !== undefined) {
      if (patch.dir !== null && (!/^([A-Za-z]:[\\/]|\/)/.test(patch.dir) || /(^|[\\/])\.\.([\\/]|$)/.test(patch.dir) || /[\\/]tickets([\\/]|$)/i.test(patch.dir))) {
        throw new ApiHttpError(400, 'invalid_backup_dir', 'The backup folder must be a full path, without "..", and not inside a ticket folder.');
      }
      next.dir = patch.dir;
    }
    this.settings = next;
    const autos = this.items.filter((b) => b.kind === 'auto').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const drop = new Set(autos.slice(next.keep).map((b) => b.name));
    this.items = this.items.filter((b) => !drop.has(b.name));
    return { ...next };
  }
}
