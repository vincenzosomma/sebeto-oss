/**
 * Hash chain of the security log (packages/shared/src/security.ts):
 *   hash = sha256_hex(prevHash + "\n" + canonicalJson(event without `hash`))
 * canonicalJson = JSON with the keys of every object sorted (arrays keep their order).
 */
import { createHash } from 'node:crypto';
import type { SecurityEvent } from '@sebeto/shared';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function eventHash(event: Omit<SecurityEvent, 'hash'> & { hash?: string }): string {
  const { hash: _ignored, ...rest } = event;
  return createHash('sha256').update(`${event.prevHash}\n${canonicalJson(rest)}`, 'utf8').digest('hex');
}
