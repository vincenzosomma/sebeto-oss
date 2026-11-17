import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@sebeto/shared';
import type { JobQueue, Repos } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createJobQueue } from './index.js';

let dir: string;
let repos: Repos;
let db: Database.Database;
let queue: JobQueue;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `sebeto-queue-${uuidv7()}`);
  ({ repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  queue = createJobQueue(db);
});

afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const T = { ticketId: 'ticket-1' };

describe('job queue', () => {
  it('claims by priority, then oldest', () => {
    const hb = queue.enqueue('run.heartbeat', T);
    const start1 = queue.enqueue('run.start', T);
    const start2 = queue.enqueue('run.start', T);
    const reply = queue.enqueue('run.reply', { ...T, text: 'hi' });
    expect(queue.depth()).toBe(4);
    expect(hb.priority).toBe(30);

    expect(queue.claim('w1')?.id).toBe(reply.id);
    expect(queue.claim('w1')?.id).toBe(start1.id);
    const c = queue.claim('w2')!;
    expect(c).toMatchObject({ id: start2.id, state: 'running', lockedBy: 'w2' });
    expect(queue.claim('w1')?.id).toBe(hb.id);
    expect(queue.claim('w1')).toBeUndefined();
    expect(queue.depth()).toBe(0);
  });

  it('honours explicit priority and runAfter', () => {
    const later = queue.enqueue('run.start', T, { runAfter: new Date(Date.now() + 60_000) });
    const low = queue.enqueue('run.heartbeat', T, { priority: 1 });
    expect(queue.claim('w')?.id).toBe(low.id);
    expect(queue.claim('w')).toBeUndefined(); // `later` not due yet
    expect(queue.depth()).toBe(1);
    db.prepare('UPDATE jobs SET run_after = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), later.id);
    expect(queue.claim('w')?.id).toBe(later.id);
  });

  it('dedupes queued jobs by key, but not running ones', () => {
    const a = queue.enqueue('run.heartbeat', T, { dedupeKey: 'hb:agent1' });
    const b = queue.enqueue('run.heartbeat', T, { dedupeKey: 'hb:agent1' });
    expect(b.id).toBe(a.id);
    expect(queue.depth()).toBe(1);
    queue.claim('w');
    const c = queue.enqueue('run.heartbeat', T, { dedupeKey: 'hb:agent1' });
    expect(c.id).not.toBe(a.id);
    expect(queue.depth()).toBe(1);
  });

  it('completes, fails and retries', () => {
    const j = queue.enqueue('run.start', T);
    queue.claim('w');
    queue.fail(j.id, 'rate limited', new Date(Date.now() - 1));
    const retried = queue.claim('w')!;
    expect(retried).toMatchObject({ id: j.id, attempts: 1, lastError: 'rate limited', state: 'running' });
    queue.fail(j.id, 'fatal');
    expect(queue.claim('w')).toBeUndefined();
    const row = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(j.id);
    expect(row).toEqual({ state: 'failed', attempts: 2 });

    const k = queue.enqueue('run.message', T);
    queue.claim('w');
    queue.complete(k.id);
    expect(db.prepare('SELECT state, locked_by FROM jobs WHERE id = ?').get(k.id)).toEqual({ state: 'done', locked_by: null });
  });

  it('retry with a queued duplicate fails the old job instead of colliding', () => {
    const a = queue.enqueue('run.heartbeat', T, { dedupeKey: 'k' });
    queue.claim('w');
    const b = queue.enqueue('run.heartbeat', T, { dedupeKey: 'k' });
    queue.fail(a.id, 'oops', new Date());
    expect(queue.depth()).toBe(1);
    expect(queue.claim('w')?.id).toBe(b.id);
  });

  it('recovers stale running jobs', () => {
    queue.enqueue('run.start', T);
    queue.enqueue('run.start', T);
    const dup = queue.enqueue('run.heartbeat', T, { dedupeKey: 'k' });
    queue.claim('w');
    queue.claim('w');
    queue.claim('w');
    queue.enqueue('run.heartbeat', T, { dedupeKey: 'k' });
    expect(queue.depth()).toBe(1);
    expect(queue.recoverStale()).toBe(3);
    expect(queue.depth()).toBe(3); // two starts requeued + the queued heartbeat; dup superseded
    expect(db.prepare('SELECT state FROM jobs WHERE id = ?').get(dup.id)).toEqual({ state: 'failed' });
  });

  it('claim is atomic across connections', async () => {
    const { default: Sqlite } = await import('better-sqlite3');
    const other = new Sqlite(path.join(dir, 'sebeto.db'));
    other.pragma('busy_timeout = 5000');
    const queue2 = createJobQueue(other);
    for (let i = 0; i < 20; i++) queue.enqueue('run.start', T);
    const claimed = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const a = (i % 2 === 0 ? queue : queue2).claim(`w${i}`);
      if (a) {
        expect(claimed.has(a.id)).toBe(false);
        claimed.add(a.id);
      }
    }
    expect(claimed.size).toBe(20);
    other.close();
  });

  it('prune deletes only done/failed jobs older than N days (default 14)', () => {
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const age = (id: string, days: number) => db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(ago(days), id);
    const oldDone = queue.enqueue('run.start', T);
    const oldFailed = queue.enqueue('run.start', T);
    const recentDone = queue.enqueue('run.start', T);
    const oldQueued = queue.enqueue('run.start', T);
    const oldRunning = queue.enqueue('run.message', T, { priority: 99 });
    for (let i = 0; i < 3; i++) queue.claim('w'); // claims oldDone, oldFailed, recentDone (same priority, oldest first)
    queue.complete(oldDone.id);
    queue.fail(oldFailed.id, 'boom');
    queue.complete(recentDone.id);
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(oldRunning.id);
    age(oldDone.id, 15);
    age(oldFailed.id, 30);
    age(recentDone.id, 13);
    age(oldQueued.id, 60);
    age(oldRunning.id, 60);

    expect(queue.prune()).toBe(2);
    const left = (db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(left).toEqual([recentDone.id, oldQueued.id, oldRunning.id]);
    expect(queue.prune(14)).toBe(0);
    expect(queue.prune(10)).toBe(1); // recentDone (13 days) is older than 10
    expect(queue.depth()).toBe(1);
  });
});
