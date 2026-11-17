/**
 * Path safety for agent-supplied paths. Threat: an agent (possibly prompt-injected) tries to read
 * or write outside its ticket folder - other tickets, the user's home, the Sebeto database, or the
 * hidden snapshot repo (to rewrite history / break Undo). Every tool path goes through
 * {@link resolveInside} before any fs call.
 */
import fs from 'node:fs';
import path from 'node:path';

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathError';
  }
}

/** Top-level folders agents may never touch (snapshot repo, runtime temp). Compared case-insensitively. */
const RESERVED = new Set(['.sebeto-git', '.sebeto', '.git']);

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

/** True when `child` is `parent` itself or below it (both absolute, already real paths). */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Realpath of the deepest existing ancestor of `abs` (for files that don't exist yet). */
async function realpathOfExisting(abs: string): Promise<string> {
  let current = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.promises.realpath(current);
      return path.join(real, ...tail.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export interface ResolvedPath {
  /** Absolute path to use for fs calls. */
  abs: string;
  /** Normalised forward-slash path relative to the ticket folder ('.' for the root). */
  rel: string;
}

/**
 * Resolve an agent-supplied relative path inside `folder`.
 * Rejects: absolute paths (POSIX, Windows drive, UNC), `..` escapes, NTFS alternate data streams
 * and drive-relative forms (`:`), NUL bytes, reserved dirs, and symlinks/junctions resolving outside.
 */
export async function resolveInside(folder: string, input: string): Promise<ResolvedPath> {
  const raw = (input ?? '').trim() || '.';
  if (raw.includes('\0')) throw new PathError('Path contains invalid characters.');
  // `C:foo`, `file.txt:secret` (NTFS alternate data stream), `\\?\` device paths all contain ':'.
  if (raw.includes(':')) throw new PathError('Use a path relative to the ticket folder (no drive letters or ":").');
  const unified = raw.replace(/\\/g, '/');
  if (unified.startsWith('/') || path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new PathError('Absolute paths are not allowed; use a path relative to the ticket folder.');
  }
  const rel = path.posix.normalize(unified).replace(/\/+$/, '') || '.';
  if (rel === '..' || rel.startsWith('../')) throw new PathError('That path is outside the ticket folder.');
  const reserved = rel.split('/').find((s) => RESERVED.has(s.toLowerCase()));
  if (reserved) throw new PathError(`"${reserved}" is reserved by Sebeto and cannot be accessed.`);

  const root = await fs.promises.realpath(folder);
  const abs = path.resolve(root, ...rel.split('/'));
  if (!isWithin(root, abs)) throw new PathError('That path is outside the ticket folder.');
  // Follow symlinks / junctions: the real target must stay inside the folder too.
  const real = await realpathOfExisting(abs);
  if (!isWithin(root, real)) throw new PathError('That path links outside the ticket folder.');
  return { abs: real, rel };
}
