import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshots, GIT_DIR_NAME } from './index.js';

let root: string;
const snaps = createSnapshots();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-snap-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (folder: string, rel: string, text: string) => {
  const abs = path.join(folder, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const read = (folder: string, rel: string) => fs.readFileSync(path.join(folder, ...rel.split('/')), 'utf8');
const exists = (folder: string, rel: string) => fs.existsSync(path.join(folder, ...rel.split('/')));

describe('snapshots', () => {
  it('init creates the folder and hidden repo', async () => {
    const folder = path.join(root, 'tickets', 'T-1'); // missing parents, Windows path
    await snaps.init(folder);
    expect(fs.existsSync(path.join(folder, GIT_DIR_NAME, 'HEAD'))).toBe(true);
    await snaps.init(folder); // idempotent
  });

  it('first commit on an empty folder creates an initial commit; unchanged returns same oid', async () => {
    const folder = path.join(root, 'T-2');
    await snaps.init(folder);
    const a = await snaps.commit(folder, 'initial');
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    const b = await snaps.commit(folder, 'nothing');
    expect(b).toBe(a);
  });

  it('commits adds, modifications, deletions and nested dirs; diff reports them', async () => {
    const folder = path.join(root, 'T-3');
    await snaps.init(folder);
    write(folder, 'a.txt', 'one');
    write(folder, 'deep/nested/b.txt', 'two');
    write(folder, 'gone.txt', 'bye');
    const c1 = await snaps.commit(folder, 'c1');
    expect(await snaps.diff(folder, c1, c1)).toEqual([]);

    write(folder, 'a.txt', 'one changed');
    write(folder, 'deep/nested/c.txt', 'three');
    fs.rmSync(path.join(folder, 'gone.txt'));
    const c2 = await snaps.commit(folder, 'c2');
    expect(c2).not.toBe(c1);
    expect(await snaps.diff(folder, c1, c2)).toEqual([
      { path: 'a.txt', change: 'modified' },
      { path: 'deep/nested/c.txt', change: 'added' },
      { path: 'gone.txt', change: 'deleted' },
    ]);
    // Nothing changed since c2.
    expect(await snaps.commit(folder, 'again')).toBe(c2);
  });

  it('never versions .sebeto-git or .sebeto/', async () => {
    const folder = path.join(root, 'T-4');
    await snaps.init(folder);
    const c1 = await snaps.commit(folder, 'c1');
    write(folder, '.sebeto/tmp.json', '{}');
    expect(await snaps.commit(folder, 'temp only')).toBe(c1);
    write(folder, 'x.txt', 'x');
    const c2 = await snaps.commit(folder, 'c2');
    expect(await snaps.diff(folder, c1, c2)).toEqual([{ path: 'x.txt', change: 'added' }]);
  });

  it('restore brings back old content, deletes later files and commits the restore', async () => {
    const folder = path.join(root, 'T-5');
    await snaps.init(folder);
    write(folder, 'keep.txt', 'v1');
    write(folder, 'dir/old.txt', 'old');
    const c1 = await snaps.commit(folder, 'c1');

    write(folder, 'keep.txt', 'v2');
    fs.rmSync(path.join(folder, 'dir'), { recursive: true });
    write(folder, 'later/new.txt', 'new');
    write(folder, '.sebeto/runtime.txt', 'temp');
    const c2 = await snaps.commit(folder, 'c2');

    write(folder, 'uncommitted.txt', 'u'); // not yet snapshotted: must also go away
    const r = await snaps.restore(folder, c1.slice(0, 10));
    expect(r).not.toBe(c2);
    expect(read(folder, 'keep.txt')).toBe('v1');
    expect(read(folder, 'dir/old.txt')).toBe('old');
    expect(exists(folder, 'later/new.txt')).toBe(false);
    expect(exists(folder, 'later')).toBe(false);
    expect(exists(folder, 'uncommitted.txt')).toBe(false);
    expect(exists(folder, '.sebeto/runtime.txt')).toBe(true); // runtime files untouched
    expect(await snaps.diff(folder, c1, r)).toEqual([]);
    // The pre-restore state is still recoverable.
    const back = await snaps.restore(folder, c2);
    expect(read(folder, 'keep.txt')).toBe('v2');
    expect(exists(folder, 'later/new.txt')).toBe(true);
    expect(exists(folder, 'uncommitted.txt')).toBe(false);
    expect(back).toMatch(/^[0-9a-f]{40}$/);
  });

  it('skips files above the size limit', async () => {
    const small = createSnapshots({ maxFileBytes: 10 });
    const folder = path.join(root, 'T-7');
    await small.init(folder);
    const c1 = await small.commit(folder, 'c1');
    write(folder, 'big.bin', 'x'.repeat(11));
    write(folder, 'ok.txt', 'fine');
    const c2 = await small.commit(folder, 'c2');
    expect(await small.diff(folder, c1, c2)).toEqual([{ path: 'ok.txt', change: 'added' }]);
    await small.restore(folder, c1);
    expect(exists(folder, 'big.bin')).toBe(true); // never versioned, so never deleted
    expect(exists(folder, 'ok.txt')).toBe(false);
  });

  it('serialises concurrent commits on the same folder', async () => {
    const folder = path.join(root, 'T-6');
    await snaps.init(folder);
    write(folder, 'a.txt', 'a');
    const [x, y] = await Promise.all([snaps.commit(folder, 'x'), snaps.commit(folder, 'y')]);
    expect(y).toBe(x);
  });
});
