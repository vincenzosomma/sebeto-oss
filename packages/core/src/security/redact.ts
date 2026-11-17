/**
 * Redaction for the security log. Unlike the diagnostics redactor (diagnostics/redact.ts) it keeps
 * what an investigator needs (file names, hosts and paths, e-mail addresses, ids) and removes only
 * what could be a secret:
 *   - values under secret-like keys (password, secret, token, authorization, cookie, apiKey…)
 *   - `Bearer …` / `Basic …`, `password=…`, `token: …` inside text
 *   - well-known key formats (sk-…, ghp_…, AKIA…, JWTs…)
 *   - URL user:password@ and secret-like query values (?token=, &sig=, &code=…)
 *   - long hex / base64 blobs that look random (except under hash/oid/snapshot-like keys)
 * Data is also kept small: long strings are cut, long arrays shortened, deep objects flattened.
 */

export const REDACTED = '<redacted>';

const SECRET_KEY_SUFFIX = /(password|passwd|passphrase|pwd|secret|token|authorization|cookie|apikey|privatekey|credential|credentials|bearer|signature|accesskey|sessionkey|otp|pin)$/;
const EXACT_SECRET_KEYS = new Set(['auth', 'code', 'key_secret', 'sig']);
/** Keys whose values are hashes or git ids on purpose (not secrets). */
const HASHY_KEY = /(hash|oid|snapshot|before|after|restoredto|fingerprint|commit|sha)$/;

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z]/g, '');

export function isSecretKey(key: string): boolean {
  const n = normKey(key);
  if (!n) return false;
  if (EXACT_SECRET_KEYS.has(key.toLowerCase())) return true;
  // Counts like tokensIn / tokensOut / tokenCount are not secrets.
  if (/^tokens?(in|out|count|used|total)$/.test(n) || n.endsWith('tokensin') || n.endsWith('tokensout')) return false;
  return SECRET_KEY_SUFFIX.test(n);
}

const KEYVAL_RE = /\b(password|passwd|pwd|passphrase|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|app[_ -]?password|cookie)(["']?\s*[:=]\s*["']?)(?!<redacted>)([^\s"',;&]+)/gi;
const AUTH_RE = /\b(authorization["']?\s*[:=]\s*["']?)(?:(?:Basic|Bearer|Token|Digest)\s+)?(?!<redacted>)[^\s"',;]+/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+(?!<redacted>)([A-Za-z0-9._~+/=-]{8,})/g;
const PREFIXED_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|sk_live_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,}|ya29\.[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?|AIza[A-Za-z0-9_-]{30,})/g;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]{1,15}:\/\/)([^\s/@:]+)(:[^\s/@]*)?@/gi;
const QUERY_RE = /([?&#])([A-Za-z0-9_.-]{1,64})=([^&#\s"'<>]*)/g;
const SECRET_QUERY = /^(token|access_token|refresh_token|id_token|code|key|apikey|api_key|sig|signature|password|pass|pwd|secret|client_secret|auth|session|sessionid|x-amz-signature|x-amz-credential|sv|se|sp)$/i;
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const B64_RE = /[A-Za-z0-9+/_=-]{32,}/g;

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A long run that looks like a random key, not a file name or a sentence. */
function looksRandom(s: string): boolean {
  const core = s.replace(/=+$/, '');
  if (core.length < 32) return false;
  if (core.includes('/') && core.split('/').some((seg) => /^[A-Za-z][a-z]+$/.test(seg))) return false; // a path
  const hasDigit = /\d/.test(core);
  const mixed = /[a-z]/.test(core) && /[A-Z]/.test(core);
  return hasDigit && mixed && entropy(core) >= 4.0;
}

export interface RedactTextOptions {
  /** Keep long hex/base64 runs (the value is a hash or a git id on purpose). */
  keepBlobs?: boolean;
}

/** Remove secret-looking parts of a free-text value. */
export function redactText(input: string, opts: RedactTextOptions = {}): string {
  if (!input) return input;
  let s = input;
  s = s.replace(URL_USERINFO_RE, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  s = s.replace(QUERY_RE, (m, sep: string, name: string) => (SECRET_QUERY.test(name) ? `${sep}${name}=${REDACTED}` : m));
  s = s.replace(AUTH_RE, (_m, head: string) => `${head}${REDACTED}`);
  s = s.replace(KEYVAL_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
  s = s.replace(BEARER_RE, (_m, kind: string) => `${kind} ${REDACTED}`);
  s = s.replace(PREFIXED_RE, REDACTED);
  if (!opts.keepBlobs) {
    s = s.replace(HEX_RE, REDACTED);
    s = s.replace(B64_RE, (m) => (looksRandom(m) ? REDACTED : m));
  }
  return s;
}

export const MAX_STRING = 500;
const MAX_ARRAY = 50;
const MAX_DEPTH = 5;
export const MAX_DATA_BYTES = 8 * 1024;

function clip(s: string, max = MAX_STRING): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function redactValue(value: unknown, key: string | null, depth: number): unknown {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    if (key !== null && isSecretKey(key)) return value ? REDACTED : value;
    return clip(redactText(value, { keepBlobs: key !== null && HASHY_KEY.test(normKey(key)) }));
  }
  if (typeof value !== 'object') return null; // functions, symbols
  if (key !== null && isSecretKey(key)) return REDACTED;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, key, depth + 1) ?? null);
    if (value.length > MAX_ARRAY) out.push(`… ${value.length - MAX_ARRAY} more`);
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const r = redactValue(v, k, depth + 1);
    if (r !== undefined) out[k] = r;
  }
  return out;
}

/** Deep copy of `data` with secrets removed; plain JSON only (safe to hash and store). */
export function redactData(data: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  let out = redactValue(data, null, 0) as Record<string, unknown>;
  let json = JSON.stringify(out);
  if (json.length > MAX_DATA_BYTES) {
    // Too big: keep the top-level scalars, summarise the rest.
    const small: Record<string, unknown> = { truncated: true };
    for (const [k, v] of Object.entries(out)) {
      if (v === null || typeof v !== 'object') small[k] = typeof v === 'string' ? clip(v, 200) : v;
      else small[k] = Array.isArray(v) ? `[${v.length} items]` : '{…}';
    }
    out = small;
    json = JSON.stringify(out);
    if (json.length > MAX_DATA_BYTES) out = { truncated: true };
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

export function redactSummary(summary: string): string {
  return clip(redactText(String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()), MAX_STRING);
}
