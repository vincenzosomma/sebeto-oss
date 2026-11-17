/**
 * A small, dependency-free zip writer and reader for workspace backups (v0.7 Q).
 *
 * Writer: streams each file through raw DEFLATE (node:zlib) with a data descriptor, so nothing is
 * held in memory; CRC-32 from zlib.crc32 and the sha256 of the original bytes are computed on the way.
 * Reader: parses the central directory, refuses anything unusual (encryption, unknown methods,
 * duplicate or unsafe names, sizes that do not add up) and streams each entry back with a hard limit
 * on the inflated size (no zip bombs) and a CRC check.
 *
 * Limits (on purpose, to stay small): no zip64, so every file and the whole archive stay under 4 GiB
 * and an archive holds at most 65 535 files.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX32 = 0xffffffff;
export const MAX_ZIP_ENTRIES = 0xffff;
const MAX_NAME_BYTES = 1024;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * True when `name` is a safe relative path inside an archive: forward slashes only, no absolute
 * path, no drive letter, no `.` / `..` / empty segment, no control characters, no characters Windows
 * cannot store. This is the zip-slip guard; restore also re-checks the resolved path.
 */
export function isSafeEntryName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return false;
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>:"|?*]/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/[. ]$/.test(seg));
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface AddedEntry {
  name: string;
  size: number;
  sha256: string;
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  time: number;
  date: number;
}

export interface ZipWriter {
  /** Stream a file from disk into the archive. */
  addFile(name: string, source: string): Promise<AddedEntry>;
  addBuffer(name: string, data: Buffer): Promise<AddedEntry>;
  /** Write the central directory and close the file. */
  finish(): Promise<{ entries: number; bytes: number }>;
  /** Close without finishing (the caller deletes the file). */
  abort(): Promise<void>;
}

/** Create a new archive at `file` (refuses to overwrite an existing file). */
export async function createZipWriter(file: string, opts: { level?: number } = {}): Promise<ZipWriter> {
  const fh = await fs.promises.open(file, 'wx', 0o600);
  const level = opts.level ?? 6;
  const central: CentralRecord[] = [];
  const names = new Set<string>();
  let offset = 0;
  let closed = false;

  async function write(buf: Buffer): Promise<void> {
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await fh.write(buf, done, buf.length - done, null);
      done += bytesWritten;
    }
    offset += buf.length;
    if (offset > MAX32) throw new ZipError('The backup is larger than 4 GiB (not supported yet). Leave the ticket folders out.');
  }

  async function add(name: string, source: Readable): Promise<AddedEntry> {
    if (closed) throw new ZipError('archive already closed');
    if (!isSafeEntryName(name)) throw new ZipError(`Unsafe file name in backup: ${name}`);
    const key = name.toLowerCase();
    if (names.has(key)) throw new ZipError(`Duplicate file name in backup: ${name}`);
    if (central.length >= MAX_ZIP_ENTRIES) throw new ZipError('Too many files for one backup (65 535 at most).');
    names.add(key);
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(new Date());
    const start = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIG_LOCAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    // crc, sizes: 0 here, real values in the data descriptor and the central directory
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    await write(Buffer.concat([header, nameBuf]));

    let crc = 0;
    let usize = 0;
    let csize = 0;
    const hash = createHash('sha256');
    const measure = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        crc = zlib.crc32(chunk, crc);
        hash.update(chunk);
        usize += chunk.length;
        if (usize > MAX32) return cb(new ZipError(`${name} is larger than 4 GiB (not supported).`));
        cb(null, chunk);
      },
    });
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        csize += chunk.length;
        write(chunk).then(() => cb(), cb);
      },
    });
    await pipeline(source, measure, zlib.createDeflateRaw({ level }), sink);

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(SIG_DESCRIPTOR, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(csize, 8);
    desc.writeUInt32LE(usize, 12);
    await write(desc);
    central.push({ name: nameBuf, crc: crc >>> 0, csize, usize, offset: start, time, date });
    return { name, size: usize, sha256: hash.digest('hex') };
  }

  return {
    addFile: (name, source) => add(name, fs.createReadStream(source)),
    addBuffer: (name, data) => add(name, Readable.from([data])),
    async finish() {
      const cdStart = offset;
      for (const c of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(SIG_CENTRAL, 0);
        h.writeUInt16LE(20, 4); // made by: MS-DOS / FAT attributes, spec 2.0
        h.writeUInt16LE(20, 6);
        h.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
        h.writeUInt16LE(METHOD_DEFLATE, 10);
        h.writeUInt16LE(c.time, 12);
        h.writeUInt16LE(c.date, 14);
        h.writeUInt32LE(c.crc, 16);
        h.writeUInt32LE(c.csize, 20);
        h.writeUInt32LE(c.usize, 24);
        h.writeUInt16LE(c.name.length, 28);
        h.writeUInt32LE(c.offset, 42);
        await write(Buffer.concat([h, c.name]));
      }
      const cdSize = offset - cdStart;
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(SIG_EOCD, 0);
      eocd.writeUInt16LE(central.length, 8);
      eocd.writeUInt16LE(central.length, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(cdStart, 16);
      await write(eocd);
      closed = true;
      await fh.sync().catch(() => undefined);
      await fh.close();
      return { entries: central.length, bytes: offset };
    },
    async abort() {
      if (closed) return;
      closed = true;
      await fh.close().catch(() => undefined);
    },
  };
}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipReader {
  readonly entries: ZipEntry[];
  get(name: string): ZipEntry | undefined;
  /** Stream an entry's original bytes (inflated, size-limited, CRC-checked) through `streams` (the last one is the sink). */
  pipeTo(entry: ZipEntry, ...streams: [...Transform[], Writable]): Promise<void>;
  /** Read a small entry into memory (refuses entries larger than `max`). */
  readBuffer(entry: ZipEntry, max: number): Promise<Buffer>;
  /** sha256 + size of an entry's original bytes. */
  hash(entry: ZipEntry): Promise<{ sha256: string; size: number }>;
  close(): Promise<void>;
}

async function readAt(fh: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipError('The backup file is truncated.');
    done += bytesRead;
  }
  return buf;
}

/** Open an archive and read its central directory. Throws ZipError for anything malformed or unsafe. */
export async function openZip(file: string): Promise<ZipReader> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    if (fileSize < 22) throw new ZipError('Not a backup file (too small).');
    const tailLen = Math.min(fileSize, 22 + 0xffff);
    const tail = await readAt(fh, fileSize - tailLen, tailLen);
    let eocdAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocdAt = i; break; }
    }
    if (eocdAt < 0) throw new ZipError('Not a backup file (no zip directory found).');
    const count = tail.readUInt16LE(eocdAt + 10);
    if (tail.readUInt16LE(eocdAt + 4) !== 0 || tail.readUInt16LE(eocdAt + 6) !== 0 || tail.readUInt16LE(eocdAt + 8) !== count) {
      throw new ZipError('Multi-part archives are not supported.');
    }
    const cdSize = tail.readUInt32LE(eocdAt + 12);
    const cdOffset = tail.readUInt32LE(eocdAt + 16);
    const eocdOffset = fileSize - tailLen + eocdAt;
    if (cdOffset + cdSize !== eocdOffset) throw new ZipError('The backup file is damaged (zip directory does not line up).');
    const cd = await readAt(fh, cdOffset, cdSize);

    const entries: ZipEntry[] = [];
    const byName = new Map<string, ZipEntry>();
    const lower = new Set<string>();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('The backup file is damaged (bad directory entry).');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError('The backup file is damaged (directory overflow).');
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + commentLen;
      if (flags & FLAG_ENCRYPTED) throw new ZipError(`Encrypted zip entries are not supported: ${name}`);
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new ZipError(`Unsupported compression in ${name}`);
      if (!isSafeEntryName(name)) throw new ZipError(`Unsafe path in backup refused: ${JSON.stringify(name.slice(0, 200))}`);
      if (lower.has(name.toLowerCase())) throw new ZipError(`Duplicate path in backup: ${name}`);
      if (size === MAX32 || compressedSize === MAX32 || localOffset === MAX32) throw new ZipError('zip64 archives are not supported.');
      if (localOffset + 30 + compressedSize > cdOffset) throw new ZipError(`The backup file is damaged (${name} points outside the data).`);
      lower.add(name.toLowerCase());
      const entry: ZipEntry = { name, method, crc, compressedSize, size, localOffset };
      entries.push(entry);
      byName.set(name, entry);
    }

    async function dataStart(entry: ZipEntry): Promise<number> {
      const h = await readAt(fh, entry.localOffset, 30);
      if (h.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`The backup file is damaged (${entry.name}).`);
      const localName = await readAt(fh, entry.localOffset + 30, h.readUInt16LE(26));
      if (localName.toString('utf8') !== entry.name) throw new ZipError(`The backup file is damaged (${entry.name}: names differ).`);
      const start = entry.localOffset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
      if (start + entry.compressedSize > cdOffset) throw new ZipError(`The backup file is damaged (${entry.name}).`);
      return start;
    }

    async function pipeTo(entry: ZipEntry, ...streams: [...Transform[], Writable]): Promise<void> {
      const start = await dataStart(entry);
      const raw = entry.compressedSize === 0
        ? Readable.from([])
        : fs.createReadStream(file, { start, end: start + entry.compressedSize - 1 });
      let crc = 0;
      let n = 0;
      const limit = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          n += chunk.length;
          if (n > entry.size) return cb(new ZipError(`${entry.name} is larger than its directory says (refused).`));
          crc = zlib.crc32(chunk, crc);
          cb(null, chunk);
        },
        flush(cb) {
          if (n !== entry.size) return cb(new ZipError(`${entry.name} is shorter than its directory says.`));
          if ((crc >>> 0) !== entry.crc) return cb(new ZipError(`${entry.name} is damaged (CRC mismatch).`));
          cb();
        },
      });
      const head: NodeJS.ReadWriteStream[] = entry.method === METHOD_DEFLATE ? [zlib.createInflateRaw(), limit] : [limit];
      await (pipeline as (...s: unknown[]) => Promise<void>)(raw, ...head, ...streams);
    }

    return {
      entries,
      get: (name) => byName.get(name),
      pipeTo,
      async readBuffer(entry, max) {
        if (entry.size > max) throw new ZipError(`${entry.name} is too large.`);
        const parts: Buffer[] = [];
        await pipeTo(entry, new Writable({ write(c: Buffer, _e, cb) { parts.push(c); cb(); } }));
        return Buffer.concat(parts);
      },
      async hash(entry) {
        const h = createHash('sha256');
        let size = 0;
        await pipeTo(entry, new Writable({ write(c: Buffer, _e, cb) { h.update(c); size += c.length; cb(); } }));
        return { sha256: h.digest('hex'), size };
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}
