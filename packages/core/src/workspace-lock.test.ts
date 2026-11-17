import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_FILE, WorkspaceLockedError, acquireWorkspaceLock, pidAlive } from './workspace-lock.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-lock-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('workspace lock', () => {
  it('one core per workspace; released on shutdown', () => {
    const release = acquireWorkspaceLock(dir, { pid: 1001, isAlive: () => true });
    expect(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).pid).toBe(1001);
    let err: unknown;
    try { acquireWorkspaceLock(dir, { pid: 2002, isAlive: () => true }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WorkspaceLockedError);
    expect((err as Error).message).toMatch(/already running with this workspace \(process 1001\)/);
    release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
    acquireWorkspaceLock(dir, { pid: 2002, isAlive: () => true })();
  });

  it('takes over a lock left by a crashed process, or an unreadable one', () => {
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 999_999 }));
    const release = acquireWorkspaceLock(dir, { pid: 3003, isAlive: () => false });
    expect(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).pid).toBe(3003);
    release();
    fs.writeFileSync(path.join(dir, LOCK_FILE), 'garbage');
    expect(() => acquireWorkspaceLock(dir, { pid: 4004, isAlive: () => true })()).not.toThrow();
  });

  it('release never removes a lock that belongs to another process', () => {
    const release = acquireWorkspaceLock(dir, { pid: 5005, isAlive: () => true });
    fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 6006 }));
    release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(true);
  });

  it('knows its own process is alive', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(-1)).toBe(false);
  });
});
