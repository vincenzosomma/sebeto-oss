import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@sebeto/shared';
import type { Repos } from '../contracts.js';
import { MIGRATIONS, openDatabase } from './index.js';

let dir: string;
let file: string;
let repos: Repos;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `sebeto-trusted-${uuidv7()}`);
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'sebeto.db');
  ({ repos } = openDatabase({ file, workspaceDir: dir }));
});

afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('trusted commands repo', () => {
  it('adds idempotently (trimmed), finds exactly, lists and removes', () => {
    const a = repos.trusted.add({ shell: 'powershell', command: '  Get-Service Spooler \n' });
    expect(a.command).toBe('Get-Service Spooler');
    expect(repos.trusted.add({ shell: 'powershell', command: 'Get-Service Spooler' }).id).toBe(a.id);
    expect(repos.trusted.find({ shell: 'powershell', command: 'Get-Service Spooler ' })?.id).toBe(a.id);
    expect(repos.trusted.find({ shell: 'cmd', command: 'Get-Service Spooler' })).toBeUndefined();
    expect(repos.trusted.find({ shell: 'powershell', command: 'get-service spooler' })).toBeUndefined();
    expect(repos.trusted.list()).toHaveLength(1);
    expect(repos.trusted.remove(a.id)).toBe(true);
    expect(repos.trusted.remove(a.id)).toBe(false);
    expect(() => repos.trusted.add({ shell: 'powershell', command: '   ' })).toThrow();
  });

  it('permission requests store the command and the "always" flag', () => {
    const t = repos.tickets.create({ title: 'disk', goal: '' });
    const cmd = { shell: 'powershell', command: 'Get-PSDrive' };
    const p = repos.permissions.create({ ticketId: t.id, runId: null, agentId: null, key: 'script.run', title: 'Run', detail: 'd', provenance: null, command: cmd });
    expect(p.command).toEqual(cmd);
    expect(p.alwaysAllowed).toBe(false);
    const decided = repos.permissions.decide(p.id, 'allowed', { always: true });
    expect(decided.alwaysAllowed).toBe(true);
    const other = repos.permissions.create({ ticketId: t.id, runId: null, agentId: null, key: 'email.send', title: 'Mail', detail: 'm', provenance: null });
    expect(other.command).toBeNull();
    // A denial is never "always allowed", even if asked to.
    expect(repos.permissions.decide(other.id, 'denied', { always: true }).alwaysAllowed).toBe(false);
  });

  it('migrates a v1 database with existing permission requests', () => {
    repos.close();
    const v1 = path.join(dir, 'v1.db');
    const raw = new Database(v1);
    raw.exec(MIGRATIONS[0]!);
    raw.pragma('user_version = 1');
    raw.prepare(`INSERT INTO tickets (id, number, title, goal, status, folder, cost_cap_usd, cost_usd, created_at, updated_at)
      VALUES ('t1', 1, 'a', '', 'backlog', '/x', 5, 0, '2026-01-01', '2026-01-01')`).run();
    raw.prepare(`INSERT INTO permission_requests (id, ticket_id, key, title, detail, state, created_at)
      VALUES ('p1', 't1', 'email.send', 'Mail', 'd', 'allowed', '2026-01-01')`).run();
    raw.close();
    const reopened = openDatabase({ file: v1, workspaceDir: dir });
    repos = reopened.repos;
    expect(reopened.migration.from).toBe(1);
    expect(reopened.migration.backup).toBeTruthy();
    const p = repos.permissions.get('p1')!;
    expect(p.command).toBeNull();
    expect(p.alwaysAllowed).toBe(false);
    expect(repos.trusted.list()).toEqual([]);
  }, 60_000);
});
