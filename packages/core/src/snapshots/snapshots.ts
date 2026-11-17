/**
 * Git-backed snapshots of a ticket folder (docs/15 Architecture Review.md, item 7).
 *
 * Every ticket folder gets its own hidden git repository whose git dir is `<folder>/.sebeto-git`.
 * We use isomorphic-git (pure JS) so end users never need a git install. The repository is
 * Sebeto's private undo history, never the user's own git:
 *  - `.sebeto-git/` (the repo itself) and `.sebeto/` (runtime temp files) are never versioned;
 *  - a nested user `.git/` folder is never versioned either;
 *  - files larger than {@link MAX_FILE_BYTES} are skipped (not versioned, not deleted by restore;
 *    if a versioned file grows past the limit, its last small version stays in history).
 */
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import type { WalkerEntry } from 'isomorphic-git';
import type { Snapshots } from '../contracts.js';

/** Hidden git dir name inside each ticket folder. */
export const GIT_DIR_NAME = '.sebeto-git';
/** Runtime temp dir inside each ticket folder (never versioned). */
export const RUNTIME_DIR_NAME = '.sebeto';
/** Files above this size are not versioned. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

const AUTHOR = { name: 'Sebeto', email: 'sebeto@localhost' };
const BRANCH = 'main';

/** Top-level names that are never part of a snapshot (compared case-insensitively for Windows). */
const EXCLUDED_TOP = new Set([GIT_DIR_NAME, RUNTIME_DIR_NAME, '.git']);

function isExcluded(filepath: string): boolean {
  if (filepath === '.') return false;
  const segments = filepath.split('/');
  if (EXCLUDED_TOP.has(segments[0]!.toLowerCase())) return true;
  // A nested user repo anywhere in the tree is also left alone.
  return segments.some((s) => s.toLowerCase() === '.git');
}

interface Repo { dir: string; gitdir: string }

function repoOf(folder: string): Repo {
  const dir = path.resolve(folder);
  return { dir, gitdir: path.join(dir, GIT_DIR_NAME) };
}

async function headOid(repo: Repo): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs, ...repo, ref: 'HEAD' });
  } catch {
    return undefined; // unborn branch: no commit yet
  }
}

async function blobOid(entry: WalkerEntry | null): Promise<string | undefined> {
  if (!entry) return undefined;
  return (await entry.type()) === 'blob' ? entry.oid() : undefined;
}

/**
 * Serialise operations per folder: isomorphic-git writes the index file, and two concurrent
 * commits on the same repo would corrupt it or lose changes.
 */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(folder: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(folder).toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

async function initRepo(repo: Repo): Promise<void> {
  await fs.promises.mkdir(repo.dir, { recursive: true });
  if (!fs.existsSync(path.join(repo.gitdir, 'HEAD'))) {
    await git.init({ fs, ...repo, defaultBranch: BRANCH });
  }
  // Belt and braces for real git users who inspect the folder with `git --git-dir`.
  const exclude = path.join(repo.gitdir, 'info', 'exclude');
  if (!fs.existsSync(exclude)) {
    await fs.promises.mkdir(path.dirname(exclude), { recursive: true });
    await fs.promises.writeFile(exclude, `/${GIT_DIR_NAME}/\n/${RUNTIME_DIR_NAME}/\n`);
  }
}

/**
 * Stage the working tree against HEAD and commit when something changed.
 * `force` commits even when nothing changed (used by restore so the undo is visible in history).
 */
async function commitRepo(repo: Repo, message: string, maxBytes: number, force = false): Promise<string> {
  await initRepo(repo);
  const head = await headOid(repo);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  let changed = false;

  const trees = [git.WORKDIR(), git.STAGE()];
  if (head) trees.unshift(git.TREE({ ref: head }));

  await git.walk({
    fs, ...repo, trees,
    map: async (filepath, entries) => {
      if (isExcluded(filepath)) return null; // prune the whole subtree
      if (filepath === '.') return true;
      const [h, w, s] = head ? entries : [null, entries[0]!, entries[1]!];
      const hOid = await blobOid(h ?? null);
      const sOid = await blobOid(s ?? null);
      let wOid: string | undefined;
      if (w && (await w.type()) === 'blob') {
        const stat = await w.stat();
        if (stat.size > maxBytes) return true; // too big: leave whatever is versioned untouched
        wOid = await w.oid();
      }
      if (wOid !== undefined) {
        if (wOid !== hOid) changed = true;
        if (wOid !== sOid) toAdd.push(filepath);
      } else if (hOid !== undefined || sOid !== undefined) {
        // Deleted from disk (or became a directory): drop it from the index.
        if (hOid !== undefined) changed = true;
        if (sOid !== undefined) toRemove.push(filepath);
      }
      return true;
    },
  });

  // Apply index changes sequentially after the walk (the walk itself runs concurrently).
  for (const filepath of toRemove) await git.remove({ fs, ...repo, filepath });
  if (toAdd.length) await git.add({ fs, ...repo, filepath: toAdd });

  if (head && !changed && !force) return head;
  // First call on an empty folder creates an (empty) initial commit so there's always a HEAD.
  return git.commit({ fs, ...repo, message, author: AUTHOR, committer: AUTHOR });
}

/** Remove now-empty parent directories of a deleted file, stopping at the ticket folder. */
async function pruneEmptyDirs(dir: string, filepath: string): Promise<void> {
  let current = path.dirname(path.join(dir, filepath));
  while (path.relative(dir, current) && !path.relative(dir, current).startsWith('..')) {
    try {
      if ((await fs.promises.readdir(current)).length > 0) return;
      await fs.promises.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export function createSnapshots(opts: { maxFileBytes?: number } = {}): Snapshots {
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  return {
    init: (folder) => withLock(folder, () => initRepo(repoOf(folder))),

    commit: (folder, message) => withLock(folder, () => commitRepo(repoOf(folder), message, maxBytes)),

    restore: (folder, oid) => withLock(folder, async () => {
      const repo = repoOf(folder);
      const target = await git.expandOid({ fs, ...repo, oid });
      // 1. Snapshot the current state first so the restore itself can be undone.
      const current = await commitRepo(repo, 'Before restore', maxBytes);
      // 2. Make the files match the target commit (HEAD now equals the working tree,
      //    except for skipped large files, which we leave alone).
      const writes: Array<{ filepath: string; oid: string }> = [];
      const deletes: string[] = [];
      await git.walk({
        fs, ...repo, trees: [git.TREE({ ref: current }), git.TREE({ ref: target })],
        map: async (filepath, [cur, tgt]) => {
          if (isExcluded(filepath)) return null;
          const cOid = await blobOid(cur ?? null);
          const tOid = await blobOid(tgt ?? null);
          if (tOid !== undefined && tOid !== cOid) writes.push({ filepath, oid: tOid });
          else if (tOid === undefined && cOid !== undefined) deletes.push(filepath);
          return true;
        },
      });
      for (const filepath of deletes) {
        await fs.promises.rm(path.join(repo.dir, filepath), { force: true });
        await pruneEmptyDirs(repo.dir, filepath);
      }
      for (const { filepath, oid: blob } of writes) {
        const abs = path.join(repo.dir, filepath);
        const { blob: content } = await git.readBlob({ fs, ...repo, oid: blob });
        // If a directory now sits where a file must go (or vice versa), clear it first.
        const st = await fs.promises.lstat(abs).catch(() => undefined);
        if (st && !st.isFile()) await fs.promises.rm(abs, { recursive: true, force: true });
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        // Always written as a regular file: we never recreate symlinks (they could point outside).
        await fs.promises.writeFile(abs, content);
      }
      // 3. Record the restore as a new snapshot.
      return commitRepo(repo, `Restore to ${target.slice(0, 7)}`, maxBytes, true);
    }),

    diff: async (folder, fromOid, toOid) => {
      const repo = repoOf(folder);
      const out: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }> = [];
      await git.walk({
        fs, ...repo, trees: [git.TREE({ ref: fromOid }), git.TREE({ ref: toOid })],
        map: async (filepath, [a, b]) => {
          if (isExcluded(filepath)) return null;
          const aOid = await blobOid(a ?? null);
          const bOid = await blobOid(b ?? null);
          if (aOid === undefined && bOid !== undefined) out.push({ path: filepath, change: 'added' });
          else if (aOid !== undefined && bOid === undefined) out.push({ path: filepath, change: 'deleted' });
          else if (aOid !== undefined && aOid !== bOid) out.push({ path: filepath, change: 'modified' });
          return true;
        },
      });
      return out.sort((x, y) => x.path.localeCompare(y.path));
    },
  };
}
