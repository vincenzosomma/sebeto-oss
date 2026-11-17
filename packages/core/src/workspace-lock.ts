/**
 * One Sebeto per workspace. The desktop app and `npm start` share ~/.sebeto/workspace; two cores on
 * the same SQLite database, ticket folders and job queue would run agents twice. The first core
 * writes <workspace>/sebeto.lock with its process id; a second one refuses to start with a clear
 * message. A lock left by a crashed process (pid no longer alive) is taken over.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = 'sebeto.lock';

export class WorkspaceLockedError extends Error {
  constructor(readonly pid: number, readonly workspaceDir: string) {
    super(`Sebeto is already running with this workspace (process ${pid}). Close the other Sebeto window or terminal first, or use another workspace with SEBETO_WORKSPACE.`);
    this.name = 'WorkspaceLockedError';
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Take the workspace lock; returns a release function. Throws WorkspaceLockedError. */
export function acquireWorkspaceLock(workspaceDir: string, opts: { pid?: number; isAlive?: (pid: number) => boolean } = {}): () => void {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  const file = path.join(workspaceDir, LOCK_FILE);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const body = JSON.stringify({ pid, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' = create only if missing: atomic against a second core starting at the same moment.
      fs.writeFileSync(file, body, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let other = 0;
      try { other = (JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }).pid ?? 0; } catch { /* unreadable: treat as stale */ }
      if (other && other !== pid && isAlive(other)) throw new WorkspaceLockedError(other, workspaceDir);
      fs.rmSync(file, { force: true }); // stale lock from a crashed run
      if (attempt === 1) throw err;
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
      if (cur.pid === pid) fs.rmSync(file, { force: true });
    } catch { /* already gone */ }
  };
}
