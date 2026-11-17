import { describe, expect, it } from 'vitest';
import { MockApi } from '../api/mock';
import { ApiHttpError } from '../api/types';
import { translate } from '../i18n/catalog';
import { backupPath, formatBytes, passphraseProblem, restoreCommands, suggestedTarget } from './backups';

describe('backup helpers', () => {
  it('formats sizes', () => {
    expect(formatBytes(512, 'en')).toBe('512 B');
    expect(formatBytes(2_450_000, 'en')).toBe('2.3 MB');
    expect(formatBytes(2_450_000, 'it')).toBe('2,3 MB');
    expect(formatBytes(5 * 1024 ** 3, 'en')).toBe('5 GB');
  });

  it('checks the passphrase and its confirmation', () => {
    expect(passphraseProblem('short', 'short')).toBe('short');
    expect(passphraseProblem('long enough phrase', 'long enough phrasE')).toBe('mismatch');
    expect(passphraseProblem('long enough phrase', 'long enough phrase')).toBeNull();
  });

  it('builds the restore commands for a NEW folder (never the running workspace)', () => {
    const dir = 'C:\\Users\\alex\\.sebeto\\workspace\\backups';
    const name = 'sebeto-backup-20261114-123004-auto.zip';
    expect(backupPath(dir, name)).toBe(`${dir}\\${name}`);
    const target = suggestedTarget(dir, name);
    expect(target).toBe('C:\\Users\\alex\\.sebeto\\workspace-restored-20261114');
    const [restore, start] = restoreCommands(dir, name, target, true);
    expect(restore).toBe(`node packages/core/dist/restore.js "${dir}\\${name}" "${target}" --passphrase-file "<file with the passphrase>"`);
    expect(start).toBe(`$env:SEBETO_WORKSPACE = "${target}"; npm start`);
    expect(suggestedTarget('/mnt/backups/sebeto', name)).toBe('/mnt/backups/sebeto/sebeto-restored-20261114');
  });

  it('has the dialog texts in English and Italian', () => {
    expect(translate('en', 'bk.button')).toBe('Backups');
    expect(translate('it', 'bk.button')).toBe('Backup');
    expect(translate('it', 'bk.now.tickets', { size: '2 MB', count: 3 })).toContain('3 cartelle');
  });
});

describe('mock API backups', () => {
  it('lists, creates, verifies, deletes and validates like the core', async () => {
    const api = new MockApi();
    const first = await api.listBackups();
    expect(first.settings).toEqual({ autoEnabled: true, autoTime: '12:30', keep: 7, dir: null });
    expect(first.items.length).toBeGreaterThan(0);

    await expect(api.createBackup({ passphrase: 'short' })).rejects.toBeInstanceOf(ApiHttpError);
    const made = await api.createBackup({ includeTickets: true, passphrase: 'a long passphrase' });
    expect((await api.listBackups()).items[0]!.name).toBe(made.name);

    expect(await api.verifyBackup(made.name, { passphrase: 'a long passphrase' })).toMatchObject({ ok: true, includesSecrets: true, secretsOpened: true });
    expect(await api.verifyBackup(made.name, { passphrase: 'nope' })).toMatchObject({ ok: false, secretsOpened: false });
    const dl = await api.downloadBackup(made.name);
    expect(dl.fileName).toBe(made.name);

    await expect(api.deleteBackup('../../sebeto.db')).rejects.toMatchObject({ status: 400 });
    await api.deleteBackup(made.name);
    expect((await api.listBackups()).items.some((b) => b.name === made.name)).toBe(false);

    await expect(api.updateBackupSettings({ autoTime: '25:00' })).rejects.toMatchObject({ status: 400 });
    await expect(api.updateBackupSettings({ dir: 'C:\\ws\\tickets\\T-1' })).rejects.toMatchObject({ status: 400 });
    await expect(api.updateBackupSettings({ dir: 'relative\\dir' })).rejects.toMatchObject({ status: 400 });
    const s = await api.updateBackupSettings({ keep: 1, dir: 'D:\\Backups\\Sebeto' });
    expect(s).toMatchObject({ keep: 1, dir: 'D:\\Backups\\Sebeto' });
    const after = await api.listBackups();
    expect(after.items.filter((b) => b.kind === 'auto')).toHaveLength(1);
    expect(after.dir).toBe('D:\\Backups\\Sebeto');
  });
});
