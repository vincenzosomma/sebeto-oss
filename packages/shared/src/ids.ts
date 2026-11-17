import { randomBytes } from './random.js';

/**
 * UUIDv7 (RFC 9562): 48-bit unix ms timestamp + random. Time-sortable and safe to
 * generate on many instances (see docs/16 Scalability.md, rule 2).
 * Monotonic within the same millisecond in this process.
 */
let lastMs = -1;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = now;
  if (ms <= lastMs) {
    ms = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) ms = ++lastMs;
  } else {
    seq = (bytes[6]! & 0x0f) << 8 | bytes[7]!;
    seq &= 0x7ff; // leave headroom for increments
  }
  lastMs = ms;
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
