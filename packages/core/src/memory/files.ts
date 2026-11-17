/**
 * File helpers of the memory vault. Everything stays inside <workspace>/memory:
 *  - relative paths only, '/' separators, no '..' / '.' segments, no drive letters, no hidden
 *    segments (".obsidian", ".trash" and dot files are Obsidian's or ours, never notes);
 *  - symbolic links are never followed (scan skips them; writes refuse them and check the real
 *    parent folder is still inside the vault);
 *  - writes go to a hidden temp file first and are renamed into place (no half-written notes).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Largest note Sebeto reads or writes (bigger files are left out of the index). */
export const MAX_NOTE_BYTES = 64 * 1024;
/** Folders deeper than this are not scanned. */
export const MAX_SCAN_DEPTH = 6;
/** At most this many note files are indexed. */
export const MAX_SCAN_FILES = 5000;
export const TRASH_FOLDER = '.trash';

export class MemoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryPathError';
  }
}

/** Validate and normalise a vault-relative path ("systems/FS01.md"). Throws MemoryPathError. */
export function cleanRel(rel: string, opts: { allowHidden?: boolean } = {}): string {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || rel.includes('\0')) throw new MemoryPathError('Invalid note path.');
  const p = rel.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('//')) throw new MemoryPathError('Note paths must be relative to the memory folder.');
  const parts = p.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') throw new MemoryPathError('Note paths cannot leave the memory folder.');
    if (seg.startsWith('.') && !(opts.allowHidden && seg === TRASH_FOLDER)) throw new MemoryPathError('Hidden folders are not notes.');
  }
  return parts.join('/');
}

/** Absolute path of a clean relative path, checked to be inside the folder. */
export function absOf(folder: string, rel: string, opts: { allowHidden?: boolean } = {}): string {
  const clean = cleanRel(rel, opts);
  const root = path.resolve(folder);
  const abs = path.resolve(root, ...clean.split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new MemoryPathError('Note paths cannot leave the memory folder.');
  return abs;
}

async function realInside(folder: string, dir: string): Promise<void> {
  const [root, real] = await Promise.all([fs.promises.realpath(folder), fs.promises.realpath(dir)]);
  const r = path.resolve(root);
  if (real !== r && !real.startsWith(r + path.sep)) throw new MemoryPathError('That folder leads outside the memory folder.');
}

/** Refuse when the target exists and is a link (or not a regular file). */
async function refuseLink(abs: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(abs);
    if (st.isSymbolicLink()) throw new MemoryPathError('Sebeto does not write through links.');
    if (!st.isFile()) throw new MemoryPathError('That path is not a note file.');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Write a note atomically. `exclusive` fails (EEXIST) when the file already exists. */
export async function writeNote(folder: string, rel: string, text: string, opts: { exclusive?: boolean; allowHidden?: boolean } = {}): Promise<void> {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_NOTE_BYTES) throw new MemoryPathError(`The note is too long (${Math.round(bytes / 1024)} KB; limit ${MAX_NOTE_BYTES / 1024} KB).`);
  const abs = absOf(folder, rel, opts);
  const dir = path.dirname(abs);
  await fs.promises.mkdir(dir, { recursive: true });
  await realInside(folder, dir);
  const exists = await refuseLink(abs);
  if (opts.exclusive && exists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  const tmp = path.join(dir, `.${path.basename(abs)}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.promises.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.promises.rename(tmp, abs);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

/** Read a note file (regular file, no link, size-capped). */
export async function readNote(folder: string, rel: string): Promise<{ text: string; mtimeMs: number; size: number }> {
  const abs = absOf(folder, rel);
  const st = await fs.promises.lstat(abs);
  if (st.isSymbolicLink() || !st.isFile()) throw new MemoryPathError('That note is not a regular file.');
  if (st.size > MAX_NOTE_BYTES) throw new MemoryPathError('That note is too large.');
  await realInside(folder, path.dirname(abs));
  return { text: await fs.promises.readFile(abs, 'utf8'), mtimeMs: st.mtimeMs, size: st.size };
}

/** Move a note inside the vault (fails when the target exists). */
export async function moveNote(folder: string, fromRel: string, toRel: string, opts: { toHidden?: boolean } = {}): Promise<void> {
  const from = absOf(folder, fromRel);
  const to = absOf(folder, toRel, { allowHidden: opts.toHidden });
  if (!(await refuseLink(from))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  await realInside(folder, path.dirname(to));
  if (await refuseLink(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  await fs.promises.rename(from, to);
}

/** First free "<dir>/<base>.md", "<dir>/<base> 2.md", … (case-insensitive on every OS). */
export async function freeName(folder: string, dirRel: string, fileName: string, opts: { allowHidden?: boolean; ignore?: string } = {}): Promise<string> {
  const base = fileName.replace(/\.md$/i, '');
  for (let n = 1; n < 1000; n++) {
    const rel = `${dirRel ? `${dirRel}/` : ''}${n === 1 ? base : `${base} ${n}`}.md`;
    if (opts.ignore && rel.toLowerCase() === opts.ignore.toLowerCase()) return rel;
    const abs = absOf(folder, rel, opts);
    let taken = false;
    try {
      const names = await fs.promises.readdir(path.dirname(abs));
      taken = names.some((x) => x.toLowerCase() === path.basename(abs).toLowerCase());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (!taken) return rel;
  }
  throw new MemoryPathError('Too many notes with that name.');
}

export interface ScannedFile { rel: string; mtimeMs: number; size: number }

/** All note files (*.md) under the folder: no hidden entries, no links, depth and count capped. */
export async function listNoteFiles(folder: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const walk = async (dirAbs: string, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_SCAN_FILES) return;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) await walk(abs, `${prefix}${e.name}/`, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        try {
          const st = await fs.promises.lstat(abs);
          out.push({ rel: `${prefix}${e.name}`, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* vanished meanwhile */ }
      }
    }
  };
  await walk(path.resolve(folder), '', 0);
  return out;
}
