/** Pure helpers for the Backups dialog (v0.7 Q). */
import { MIN_BACKUP_PASSPHRASE, type Locale } from '@sebeto/shared';

const intlLocale = (l: Locale) => (l === 'it' ? 'it-IT' : 'en-US');

/** 2_450_000 → "2.3 MB" (binary units, one decimal from MB up). */
export function formatBytes(bytes: number, locale: Locale): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = Math.max(0, bytes);
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const fmt = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: u >= 2 ? 1 : 0 });
  return `${fmt.format(n)} ${units[u]}`;
}

export type PassphraseProblem = 'short' | 'mismatch' | null;

/** Checks the passphrase and its confirmation before a backup with secrets. */
export function passphraseProblem(pass: string, confirm: string): PassphraseProblem {
  if ([...pass].length < MIN_BACKUP_PASSPHRASE) return 'short';
  if (pass !== confirm) return 'mismatch';
  return null;
}

/** Joins the backup folder and a file name with the folder's own separator. */
export function backupPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** A suggested new workspace folder next to the backups: <parent of the workspace>/workspace-restored-YYYYMMDD. */
export function suggestedTarget(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const parts = dir.split(sep).filter((p, i) => p !== '' || i === 0);
  // <workspace>/backups → <workspace>-restored-…; any other folder → <folder>/sebeto-restored-…
  const stamp = /sebeto-backup-(\d{8})/.exec(name)?.[1] ?? 'backup';
  if (parts.length > 1 && parts[parts.length - 1] === 'backups') {
    const ws = parts.slice(0, -1).join(sep);
    return `${ws}-restored-${stamp}`;
  }
  return `${parts.join(sep)}${sep}sebeto-restored-${stamp}`;
}

/** The two commands that restore a backup into a new folder and start Sebeto on it (PowerShell). */
export function restoreCommands(dir: string, name: string, target: string, withPassphrase: boolean): string[] {
  const restore = `node packages/core/dist/restore.js "${backupPath(dir, name)}" "${target}"${withPassphrase ? ' --passphrase-file "<file with the passphrase>"' : ''}`;
  return [restore, `$env:SEBETO_WORKSPACE = "${target}"; npm start`];
}
