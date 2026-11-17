import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BACKUP_FORMAT, type BackupManifest, type SecurityEvent } from '@sebeto/shared';
import type { AppContext, CoreConfig, Snapshots } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createJobQueue } from '../queue/index.js';
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createPermissionGate } from '../gate/index.js';
import { createRuntimeRegistry } from '../runtimes/index.js';
import { createServer } from '../api/server.js';
import { createSecretStore, plainFileProtector } from '../connectors/secrets.js';
import { createSettingsStore } from '../settings.js';
import { createSecurityLog, type SecurityLog } from '../security/log.js';
import { createScheduler } from '../scheduler/scheduler.js';
import { MIGRATIONS } from '../storage/migrations.js';
import { restoreBackupFile, verifyBackupFile } from './archive.js';
import { createBackupService, isAutoDue, validateBackupDir, type BackupService } from './service.js';
import { openSecrets, sealSecrets } from './secrets-box.js';
import { createZipWriter, isSafeEntryName, openZip } from './zip.js';
import { runRestoreCli } from './cli.js';

const TOKEN = 'backup-test-token-0123456789';
const FAST_SCRYPT = { N: 2 ** 14, r: 8, p: 1 };
const PASS = 'correct horse battery staple';
const SECRET_VALUE = 'gmail-app-password-xyzzy-42';
const SLOW = 60_000;

interface H {
  dir: string;
  tmp: string;
  db: Database.Database;
  ctx: AppContext;
  sec: SecurityLog;
  backups: BackupService;
}

function harness(): H {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-backup-'));
  const dir = path.join(tmp, 'workspace');
  fs.mkdirSync(dir);
  const { repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir });
  const bus = createEventBus();
  const queue = createJobQueue(db);
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const snapshots: Snapshots = { init: async () => undefined, commit: async () => 'oid', restore: async () => 'oid', diff: async () => [] };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const config: CoreConfig = { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 1, runtimes: ['mock'], version: '0.7.0-test' };
  const secrets = createSecretStore(dir, plainFileProtector());
  const ctx: AppContext = { config, log, repos, queue, bus, state, gate, snapshots, runtimes: createRuntimeRegistry([]), secrets, settings: createSettingsStore(dir) };
  const sec = createSecurityLog({ db, workspaceDir: dir, bus, log, repos });
  ctx.securityLog = sec;
  const backups = createBackupService({
    db, workspaceDir: dir, appVersion: config.version, secrets, securityLog: sec, log, scrypt: FAST_SCRYPT,
    ticketFolders: () => db.prepare<[], { folder: string }>('SELECT folder FROM tickets').all().map((r) => r.folder),
  });
  ctx.backups = backups;
  return { dir, tmp, db, ctx, sec, backups };
}

/** A workspace with tickets, a memory note, settings, a template, a skill, a ticket file and a secret. */
async function seed(h: H): Promise<void> {
  const a = h.ctx.repos.agents.create({ name: 'Ops agent' });
  for (const title of ['Renew the TLS certificate of fs01', 'Patch CVE-2026-1234 on the web tier']) {
    const t = h.ctx.repos.tickets.create({ title, goal: 'g', agentId: a.id });
    fs.mkdirSync(t.folder, { recursive: true });
    fs.writeFileSync(path.join(t.folder, 'notes.txt'), `work for ${title}\n`);
  }
  fs.mkdirSync(path.join(h.dir, 'memory', 'systems'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'memory', 'systems', 'FS01.md'), '# FS01\nFile server in Naples. Certificate renewed yearly.\n');
  h.ctx.settings!.update({ intakeModel: 'sonnet', setupCompleted: true });
  fs.mkdirSync(path.join(h.dir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'templates', 'service-desk.json'), '{"name":"Service Desk"}');
  fs.mkdirSync(path.join(h.dir, 'skills', 'cert-check'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'skills', 'cert-check', 'SKILL.md'), '---\nname: cert-check\n---\nCheck certificates.\n');
  await h.ctx.secrets!.set('mail-password', SECRET_VALUE);
}

function allEvents(sec: SecurityLog): SecurityEvent[] {
  const out: SecurityEvent[] = [];
  for (const b of sec.batches({})) out.push(...b);
  return out;
}

function zipPath(h: H, name: string): string {
  return path.join(h.dir, 'backups', name);
}

/** Write an archive by hand (tests for hostile files). */
async function handMadeZip(file: string, entries: Array<[string, Buffer]>, level?: number): Promise<void> {
  const w = await createZipWriter(file, { level });
  for (const [name, data] of entries) await w.addBuffer(name, data);
  await w.finish();
}

let h: H;
beforeEach(() => { h = harness(); });
afterEach(() => {
  h.ctx.repos.close();
  fs.rmSync(h.tmp, { recursive: true, force: true });
});

describe('zip', () => {
  it('accepts only safe relative names', () => {
    for (const ok of ['sebeto.db', 'memory/systems/FS01.md', 'tickets/T-1/.git/HEAD']) expect(isSafeEntryName(ok), ok).toBe(true);
    for (const bad of ['', '../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/x', 'a\\b', 'a//b', './a', 'a/./b', 'nul\u0000', 'a:b', 'dir/trailing.', 'x/']) {
      expect(isSafeEntryName(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('round-trips files through the writer and reader with sha256 and CRC', async () => {
    const file = path.join(h.tmp, 'x.zip');
    const big = Buffer.alloc(300_000, 'Napoli ');
    await handMadeZip(file, [['a.txt', Buffer.from('hello')], ['dir/big.bin', big], ['empty', Buffer.alloc(0)]]);
    const z = await openZip(file);
    expect(z.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/big.bin', 'empty']);
    expect((await z.readBuffer(z.get('a.txt')!, 100)).toString()).toBe('hello');
    expect((await z.hash(z.get('dir/big.bin')!)).size).toBe(big.length);
    expect((await z.readBuffer(z.get('empty')!, 10)).length).toBe(0);
    await z.close();
  });
});

describe('backup round trip', () => {
  it('backup → verify → restore into a new folder → same rows, notes and settings; no secrets without a passphrase', async () => {
    await seed(h);
    const info = await h.backups.create({ includeTickets: true });
    expect(info.kind).toBe('manual');
    const file = zipPath(h, info.name);
    expect(fs.existsSync(file)).toBe(true);
    expect(h.backups.list().items.map((b) => b.name)).toEqual([info.name]);

    // Secrets are left out without a passphrase: no secrets.enc, and the value is nowhere in the file.
    const v = await h.backups.verify(info.name);
    expect(v).toMatchObject({ ok: true, includesSecrets: false, includesTickets: true, matchesRecordedHash: true, schemaVersion: MIGRATIONS.length });
    const z = await openZip(file);
    expect(z.get('secrets.enc')).toBeUndefined();
    const manifest = JSON.parse((await z.readBuffer(z.get('manifest.json')!, 1e7)).toString()) as BackupManifest;
    await z.close();
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining([
      'sebeto.db', 'settings.json', 'memory/systems/FS01.md', 'templates/service-desk.json', 'skills/cert-check/SKILL.md', 'tickets/T-1/notes.txt',
    ]));
    expect(manifest.files.some((f) => f.path.startsWith('secrets'))).toBe(false);
    expect(fs.readFileSync(file).includes(Buffer.from(SECRET_VALUE))).toBe(false);

    const target = path.join(h.tmp, 'restored');
    const r = await restoreBackupFile(file, target, { protector: plainFileProtector() });
    expect(r.secretsRestored).toBe(0);
    expect(r.ticketFoldersMoved).toBe(2);
    expect(fs.existsSync(path.join(target, 'secrets'))).toBe(false);

    const { repos: restored } = openDatabase({ file: path.join(target, 'sebeto.db'), workspaceDir: target });
    try {
      const before = h.ctx.repos.tickets.list({ limit: 50 }).items.map((t) => [t.number, t.title]).sort();
      const after = restored.tickets.list({ limit: 50 }).items;
      expect(after.map((t) => [t.number, t.title]).sort()).toEqual(before);
      for (const t of after) expect(path.dirname(path.dirname(t.folder))).toBe(target);
      expect(fs.readFileSync(path.join(after.find((t) => t.number === 1)!.folder, 'notes.txt'), 'utf8')).toContain('work for');
      expect(restored.agents.list().map((a) => a.name)).toContain('Ops agent');
    } finally {
      restored.close();
    }
    expect(fs.readFileSync(path.join(target, 'memory', 'systems', 'FS01.md'), 'utf8')).toBe(fs.readFileSync(path.join(h.dir, 'memory', 'systems', 'FS01.md'), 'utf8'));
    expect(createSettingsStore(target).get()).toMatchObject({ intakeModel: 'sonnet', setupCompleted: true });
    expect(fs.existsSync(path.join(target, 'skills', 'cert-check', 'SKILL.md'))).toBe(true);

    // The restore is written into the NEW workspace's security log; the old one is untouched.
    const db2 = new Database(path.join(target, 'sebeto.db'));
    const restoredEvent = db2.prepare("SELECT data FROM security_events WHERE action = 'backup.restored'").get() as { data: string } | undefined;
    db2.close();
    expect(JSON.parse(restoredEvent!.data)).toMatchObject({ name: info.name, secretsRestored: 0, ticketFoldersMoved: 2 });
    expect(allEvents(h.sec).some((e) => e.action === 'backup.restored')).toBe(false);
    expect(allEvents(h.sec).filter((e) => e.action === 'backup.created')[0]!.data).toMatchObject({ name: info.name, includesTickets: true, encrypted: false, secretCount: 0 });
  }, SLOW);

  it('ticket folders are optional and left out by default', async () => {
    await seed(h);
    const est = await h.backups.estimate();
    expect(est.ticketFolders).toBe(2);
    expect(est.ticketsBytes).toBeGreaterThan(0);
    expect(est.secrets).toBe(1);
    const info = await h.backups.create({});
    const z = await openZip(zipPath(h, info.name));
    expect(z.entries.some((e) => e.name.startsWith('tickets/'))).toBe(false);
    await z.close();
  }, SLOW);

  it('a passphrase encrypts the secrets; the right one restores them, a wrong one fails', async () => {
    await seed(h);
    const info = await h.backups.create({ passphrase: PASS });
    const file = zipPath(h, info.name);
    expect(fs.readFileSync(file).includes(Buffer.from(SECRET_VALUE))).toBe(false);

    expect(await h.backups.verify(info.name, { passphrase: PASS })).toMatchObject({ ok: true, includesSecrets: true, secretsOpened: true });
    const wrong = await h.backups.verify(info.name, { passphrase: 'not the right passphrase' });
    expect(wrong).toMatchObject({ ok: false, secretsOpened: false });
    expect(wrong.problems.join(' ')).toMatch(/Wrong passphrase/);

    await expect(restoreBackupFile(file, path.join(h.tmp, 'r-wrong'), { passphrase: 'not the right passphrase', protector: plainFileProtector() })).rejects.toThrow(/Wrong passphrase/);
    expect(fs.existsSync(path.join(h.tmp, 'r-wrong'))).toBe(false);

    const r = await restoreBackupFile(file, path.join(h.tmp, 'r-ok'), { passphrase: PASS, protector: plainFileProtector() });
    expect(r.secretsRestored).toBe(1);
    expect(await createSecretStore(path.join(h.tmp, 'r-ok'), plainFileProtector()).get('mail-password')).toBe(SECRET_VALUE);

    // Without the passphrase the rest is restored and the owner is told the secrets were not.
    const r2 = await restoreBackupFile(file, path.join(h.tmp, 'r-none'), { protector: plainFileProtector() });
    expect(r2.secretsRestored).toBe(0);
    expect(r2.warnings.join(' ')).toMatch(/NOT restored/);

    // The passphrase never reaches the security log.
    expect(JSON.stringify(allEvents(h.sec))).not.toContain(PASS);
    expect(JSON.stringify(allEvents(h.sec))).not.toContain(SECRET_VALUE);
  }, SLOW);

  it('leaves out (and counts) a secret this computer cannot read instead of failing the backup', async () => {
    await seed(h);
    fs.writeFileSync(path.join(h.dir, 'secrets', 'broken.secret'), 'x');
    const real = h.ctx.secrets!;
    const flaky = { ...real, get: async (n: string) => { if (n === 'broken') throw new Error('Windows could not decrypt the secret'); return real.get(n); } };
    const svc = createBackupService({ db: h.db, workspaceDir: h.dir, appVersion: 't', secrets: flaky, securityLog: h.sec, scrypt: FAST_SCRYPT });
    const info = await svc.create({ passphrase: PASS });
    expect(info.secretsSkipped).toBe(1);
    const ev = allEvents(h.sec).find((e) => e.action === 'backup.created')!;
    expect(ev).toMatchObject({ severity: 'warning', data: { secretCount: 1, secretsSkipped: 1 } });
    const r = await restoreBackupFile(zipPath(h, info.name), path.join(h.tmp, 'r'), { passphrase: PASS, protector: plainFileProtector() });
    expect(r.secretsRestored).toBe(1);
  }, SLOW);

  it('secrets box: AES-256-GCM with the default scrypt key; wrong passphrase and changed bytes fail', async () => {
    const sealed = await sealSecrets({ a: 'one', b: 'two' }, PASS);
    const env = JSON.parse(sealed.toString()) as { kdf: { N: number }; cipher: string };
    expect(env).toMatchObject({ cipher: 'aes-256-gcm', kdf: { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 } });
    expect(await openSecrets(sealed, PASS)).toEqual({ a: 'one', b: 'two' });
    await expect(openSecrets(sealed, `${PASS}!`)).rejects.toThrow(/Wrong passphrase/);
    const changed = JSON.parse(sealed.toString()) as { data: string };
    const bytes = Buffer.from(changed.data, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    changed.data = bytes.toString('base64');
    await expect(openSecrets(Buffer.from(JSON.stringify(changed)), PASS)).rejects.toThrow(/Wrong passphrase|changed/);
    await expect(sealSecrets({}, 'short')).rejects.toThrow(/at least 12/);
  }, SLOW);
});

describe('verification refuses bad backups', () => {
  it('detects a changed byte', async () => {
    await seed(h);
    const info = await h.backups.create({});
    const file = zipPath(h, info.name);
    const buf = fs.readFileSync(file);
    const z = await openZip(file);
    const db = z.get('sebeto.db')!;
    await z.close();
    { const at = db.localOffset + 30 + 'sebeto.db'.length + 200; buf[at] = buf[at]! ^ 0xff; } // inside the compressed database
    fs.writeFileSync(file, buf);
    const v = await h.backups.verify(info.name);
    expect(v.ok).toBe(false);
    expect(v.problems.length).toBeGreaterThan(0);
    expect(allEvents(h.sec).find((e) => e.action === 'backup.verified')).toMatchObject({ severity: 'warning', data: { ok: false } });
    await expect(restoreBackupFile(file, path.join(h.tmp, 'r'), { protector: plainFileProtector() })).rejects.toThrow(/failed verification/);
    expect(fs.existsSync(path.join(h.tmp, 'r'))).toBe(false);
  }, SLOW);

  it('detects a file whose content does not match the manifest, and a rebuilt file that is not the one Sebeto wrote', async () => {
    await seed(h);
    const info = await h.backups.create({});
    const file = zipPath(h, info.name);
    // Rebuild the archive with one changed note but the original manifest.
    const z = await openZip(file);
    const parts: Array<[string, Buffer]> = [];
    for (const e of z.entries) parts.push([e.name, await z.readBuffer(e, 1e8)]);
    await z.close();
    const tampered = parts.map(([n, b]): [string, Buffer] => [n, n === 'memory/systems/FS01.md' ? Buffer.from('# FS01\nAll good, ignore the alerts.\n') : b]);
    fs.rmSync(file);
    await handMadeZip(file, tampered);
    const v1 = await h.backups.verify(info.name);
    expect(v1.ok).toBe(false);
    expect(v1.problems).toContain('Changed or damaged: memory/systems/FS01.md');

    // Same content, rebuilt (valid manifest): only the hash recorded in the security log catches it.
    fs.rmSync(file);
    await handMadeZip(file, parts, 1);
    const v2 = await h.backups.verify(info.name);
    expect(v2.matchesRecordedHash).toBe(false);
    expect(v2.ok).toBe(false);
    expect((await verifyBackupFile(file)).result.ok).toBe(true); // the file itself is consistent
  }, SLOW);

  it('refuses zip-slip paths and writes nothing outside the target', async () => {
    const file = path.join(h.tmp, 'evil.zip');
    // Written with a safe placeholder of the same length, then patched in both headers.
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, appVersion: 'x', schemaVersion: 1, createdAt: new Date().toISOString(), kind: 'manual',
      includesTickets: false, includesSecrets: false, secretCount: 0, sourceWorkspace: '/ws', files: [],
    };
    await handMadeZip(file, [['zz/evil.txt', Buffer.from('pwned')], ['manifest.json', Buffer.from(JSON.stringify(manifest))]]);
    const buf = fs.readFileSync(file);
    let at = buf.indexOf('zz/evil.txt');
    while (at >= 0) { buf.write('..', at); at = buf.indexOf('zz/evil.txt', at + 1); }
    fs.writeFileSync(file, buf);
    expect(buf.includes(Buffer.from('../evil.txt'))).toBe(true);

    const v = await verifyBackupFile(file);
    expect(v.result.ok).toBe(false);
    expect(v.result.problems.join(' ')).toMatch(/Unsafe path/);
    const target = path.join(h.tmp, 'slip', 'target');
    await expect(restoreBackupFile(file, target)).rejects.toThrow(/failed verification/);
    expect(fs.existsSync(path.join(h.tmp, 'slip', 'evil.txt'))).toBe(false);
    expect(fs.existsSync(target)).toBe(false);

    // A manifest that names a path outside the allowed folders is refused too.
    const file2 = path.join(h.tmp, 'evil2.zip');
    const m2 = { ...manifest, files: [{ path: 'sebeto.db', size: 1, sha256: 'a'.repeat(64) }, { path: 'startup/run.cmd', size: 1, sha256: 'b'.repeat(64) }] };
    await handMadeZip(file2, [['sebeto.db', Buffer.from('x')], ['startup/run.cmd', Buffer.from('y')], ['manifest.json', Buffer.from(JSON.stringify(m2))]]);
    expect((await verifyBackupFile(file2)).result.problems.join(' ')).toMatch(/Unexpected file/);
  });

  it('refuses a database schema newer than this app supports', async () => {
    const db = Buffer.from('not really a db');
    const { createHash } = await import('node:crypto');
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, appVersion: '9.9.9', schemaVersion: MIGRATIONS.length + 1, createdAt: new Date().toISOString(), kind: 'manual',
      includesTickets: false, includesSecrets: false, secretCount: 0, sourceWorkspace: '/ws',
      files: [{ path: 'sebeto.db', size: db.length, sha256: createHash('sha256').update(db).digest('hex') }],
    };
    const file = path.join(h.tmp, 'future.zip');
    await handMadeZip(file, [['sebeto.db', db], ['manifest.json', Buffer.from(JSON.stringify(manifest))]]);
    const v = await verifyBackupFile(file);
    expect(v.result.ok).toBe(false);
    expect(v.result.problems.join(' ')).toMatch(/newer than this Sebeto supports/);
  });

  it('refuses to restore into a folder that is not empty (never over a workspace)', async () => {
    await seed(h);
    const info = await h.backups.create({});
    await expect(restoreBackupFile(zipPath(h, info.name), h.dir)).rejects.toThrow(/not empty/);
    expect(fs.existsSync(path.join(h.dir, 'sebeto.db'))).toBe(true);
  }, SLOW);
});

describe('automatic backup, retention and settings', () => {
  it('is on by default (daily, keep 7) and due once a day after its time', () => {
    expect(h.backups.settings()).toEqual({ autoEnabled: true, autoTime: '12:30', keep: 7, dir: null });
    const s = h.backups.settings();
    const day = (hh: number, mm = 0) => new Date(2026, 10, 14, hh, mm);
    expect(isAutoDue(day(12, 29), s, null)).toBe(false);
    expect(isAutoDue(day(12, 30), s, null)).toBe(true);
    expect(isAutoDue(day(18), s, day(12, 31).toISOString())).toBe(false);
    expect(isAutoDue(day(18), s, new Date(2026, 10, 13, 12, 31).toISOString())).toBe(true); // missed yesterday's: catch up
    expect(isAutoDue(day(18), { ...s, autoEnabled: false }, null)).toBe(false);
  });

  it('keeps the last N automatic backups, never deletes manual ones, never includes tickets or secrets', async () => {
    await seed(h);
    h.backups.updateSettings({ keep: 2 });
    const manual = await h.backups.create({});
    for (let d = 1; d <= 4; d++) {
      const info = await h.backups.tick(new Date(2026, 10, d, 13, 0));
      expect(info?.kind).toBe('auto');
    }
    expect(h.backups.tick(new Date(2026, 10, 4, 18, 0))).toBeNull(); // already done today
    const names = h.backups.list().items.map((b) => b.name);
    expect(names).toContain(manual.name);
    expect(names.filter((n) => n.includes('-auto'))).toEqual(['sebeto-backup-20261104-130000-auto.zip', 'sebeto-backup-20261103-130000-auto.zip']);
    const deleted = allEvents(h.sec).filter((e) => e.action === 'backup.deleted');
    expect(deleted).toHaveLength(2);
    expect(deleted.every((e) => e.data?.['reason'] === 'retention')).toBe(true);
    const z = await openZip(zipPath(h, names.find((n) => n.includes('-auto'))!));
    expect(z.entries.some((e) => e.name.startsWith('tickets/') || e.name === 'secrets.enc')).toBe(false);
    await z.close();
    expect(h.backups.list().lastAuto).toMatchObject({ ok: true });
  }, SLOW);

  it('skips the automatic backup during an emergency stop; the scheduler drives it', async () => {
    h.sec.setLockdown(true, 'test');
    expect(h.backups.tick(new Date(2026, 10, 14, 13, 0))).toBeNull();
    expect(h.backups.list().items).toHaveLength(0);
    h.sec.setLockdown(false);
    const sched = createScheduler(h.ctx, { now: () => new Date(2026, 10, 14, 13, 0).getTime() });
    sched.tick();
    expect(h.backups.running()).toBe(true);
    for (let i = 0; i < 200 && h.backups.running(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(h.backups.list().items.map((b) => b.kind)).toEqual(['auto']);
  }, SLOW);

  it('validates the backup folder: absolute, no "..", not inside ticket folders or the workspace', () => {
    const ws = h.dir;
    const outside = path.join(h.tmp, 'elsewhere');
    expect(validateBackupDir(outside, ws)).toBe(outside);
    expect(validateBackupDir(path.join(ws, 'backups', 'nightly'), ws)).toBe(path.join(ws, 'backups', 'nightly'));
    expect(() => validateBackupDir('relative/dir', ws)).toThrow(/full path/);
    expect(() => validateBackupDir(`${ws}${path.sep}backups${path.sep}..${path.sep}tickets`, ws)).toThrow(/"\.\."/);
    expect(() => validateBackupDir(path.join(ws, 'tickets', 'T-1'), ws)).toThrow();
    expect(() => validateBackupDir(path.join(ws, 'memory'), ws)).toThrow();
    expect(() => validateBackupDir(ws, ws)).toThrow();
    const external = path.join(h.tmp, 'projects', 'rollout');
    expect(() => validateBackupDir(path.join(external, 'bk'), ws, [external])).toThrow(/ticket folder/);
    expect(h.backups.updateSettings({ dir: outside }).dir).toBe(outside);
    expect(h.backups.list().dir).toBe(outside);
  });
});

describe('API /backups', () => {
  let app: FastifyInstance;
  const auth = { authorization: `Bearer ${TOKEN}` };
  beforeEach(async () => { app = await createServer(h.ctx); });
  afterEach(async () => { await app.close(); });

  it('create, list, estimate, download, verify, delete; names and passphrases are validated', async () => {
    await seed(h);
    expect((await app.inject({ url: '/api/v1/backups' })).statusCode).toBe(401);
    const short = await app.inject({ method: 'POST', url: '/api/v1/backups', headers: auth, payload: { passphrase: 'short' } });
    expect(short.statusCode).toBe(400);
    expect(short.body).not.toContain('short"');

    const created = await app.inject({ method: 'POST', url: '/api/v1/backups', headers: auth, payload: { includeTickets: false, passphrase: PASS } });
    expect(created.statusCode).toBe(201);
    const { name } = created.json() as { name: string };

    const list = (await app.inject({ url: '/api/v1/backups', headers: auth })).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name, kind: 'manual' });
    expect(list.settings.autoEnabled).toBe(true);
    expect((await app.inject({ url: '/api/v1/backups/estimate', headers: auth })).json()).toMatchObject({ ticketFolders: 2, secrets: 1 });

    const dl = await app.inject({ url: `/api/v1/backups/${name}/download`, headers: auth });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/zip');
    expect(dl.headers['content-disposition']).toContain(name);
    expect(dl.rawPayload.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);

    const ver = await app.inject({ method: 'POST', url: `/api/v1/backups/${name}/verify`, headers: auth, payload: { passphrase: PASS } });
    expect(ver.json()).toMatchObject({ ok: true, secretsOpened: true, matchesRecordedHash: true });

    for (const bad of ['..%2F..%2Fsebeto.db', 'sebeto.db', 'sebeto-backup-1.zip', '..%5Cx.zip']) {
      const r = await app.inject({ method: 'DELETE', url: `/api/v1/backups/${bad}`, headers: auth });
      expect([400, 404], bad).toContain(r.statusCode);
    }
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/backups/sebeto-backup-20200101-000000.zip', headers: auth })).statusCode).toBe(404);
    expect(fs.existsSync(path.join(h.dir, 'sebeto.db'))).toBe(true);

    const bad = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', headers: auth, payload: { dir: path.join(h.dir, 'tickets', 'T-1') } });
    expect(bad.statusCode).toBe(400);
    const set = await app.inject({ method: 'PUT', url: '/api/v1/backups/settings', headers: auth, payload: { autoEnabled: false, autoTime: '07:15', keep: 3 } });
    expect(set.json()).toEqual({ autoEnabled: false, autoTime: '07:15', keep: 3, dir: null });

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/backups/${name}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/v1/backups', headers: auth })).json().items).toHaveLength(0);

    const actions = allEvents(h.sec).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['backup.created', 'backup.verified', 'backup.deleted', 'backup.settings_changed']));
    expect(JSON.stringify(allEvents(h.sec))).not.toContain(PASS);

    const spec = (await app.inject({ url: '/api/v1/openapi.json', headers: auth })).json();
    for (const p of ['/backups', '/backups/estimate', '/backups/settings', '/backups/{name}/download', '/backups/{name}/verify', '/backups/{name}']) expect(spec.paths[p], p).toBeDefined();
  }, SLOW);
});

describe('restore CLI', () => {
  it('verifies, restores with a passphrase file and prints how to start Sebeto on the new folder', async () => {
    await seed(h);
    const info = await h.backups.create({});
    const file = zipPath(h, info.name);
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await runRestoreCli(['--verify', file], io)).toBe(0);
    expect(out.join('\n')).toMatch(/^OK: \d+ files intact/);
    expect(await runRestoreCli([file], io)).toBe(2);
    expect(await runRestoreCli([file, h.dir], io)).toBe(1);
    expect(err.join('\n')).toMatch(/not empty/);

    const passFile = path.join(h.tmp, 'pass.txt');
    fs.writeFileSync(passFile, `${PASS}\r\n`);
    const target = path.join(h.tmp, 'cli-restored');
    out.length = 0;
    expect(await runRestoreCli([file, target, '--passphrase-file', passFile], io)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`SEBETO_WORKSPACE = "${target}"`);
    expect(text).not.toContain(PASS);
    expect(fs.existsSync(path.join(target, 'sebeto.db'))).toBe(true);
  }, SLOW);
});
