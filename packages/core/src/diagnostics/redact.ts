/**
 * Redactor for the diagnostics report (docs/15 Architecture Review.md, item 16). Every free-text
 * value that leaves the app in a bug report goes through here first:
 *   - known secrets (the API token…)            -> <secret>
 *   - `password=…`, `token: …`, `Bearer …`       -> <secret>
 *   - long hex / base64-like runs (>= 24 chars)  -> <secret>
 *   - URLs                                       -> scheme://host (no user, path, query)
 *   - e-mail addresses                           -> m***@domain.it
 *   - the home folder, C:\Users\<name>, /home/<name>, /Users/<name> -> <home>
 *   - the OS user name                           -> <user>
 *   - public IPv4 addresses                      -> <ip> (private / loopback ones stay)
 * It errs on the side of removing too much: a bug report never needs the secret itself.
 */
import os from 'node:os';

export interface RedactorOptions {
  /** Home folder to hide (default: os.homedir()). */
  homeDir?: string | null;
  /** OS user name to hide (default: os.userInfo().username). Names shorter than 3 characters are ignored. */
  userName?: string | null;
  /** Exact strings that must never appear (API token, …). Values shorter than 6 characters are ignored. */
  secrets?: Array<string | null | undefined>;
}

export type Redactor = (text: string) => string;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function currentUser(): string | null {
  try { return os.userInfo().username; } catch { return null; }
}

/** True for private, loopback, link-local and unspecified IPv4 addresses. */
export function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const URL_RE = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>()[\]{}]*)/gi;
const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const KEYVAL_RE = /\b(password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|app[_ -]?password)(["']?\s*[:=]\s*["']?)(?!<secret>)([^\s"',;&]+)/gi;
const AUTH_RE = /\b(authorization["']?\s*[:=]\s*["']?)(?:(?:Basic|Bearer|Token)\s+)?[^\s"',;]+/gi;
const BEARER_RE = /\b(Bearer)\s+(?!<secret>)([A-Za-z0-9._~+/=-]{8,})/gi;
const PREFIXED_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,}|ya29\.[A-Za-z0-9._-]{12,}|eyJ[A-Za-z0-9_-]{10,})/g;
const HEX_RE = /\b[0-9a-fA-F]{24,}\b/g;
const B64_RE = /[A-Za-z0-9+_=-]{24,}/g;
const WIN_HOME_RE = /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"'<>:|*?]+/gi;
const UNIX_HOME_RE = /(^|[^\w.~-])\/(?:home|Users)\/[^/\s"'<>:]+/g;
const IPV4_RE = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.]*\d)/g;

/** A run that looks like a key: hex, or mixed upper/lower case with digits (model names stay). */
function looksSecret(s: string): boolean {
  if (/^[0-9a-fA-F]+$/.test(s)) return true;
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);
}

export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const home = opts.homeDir === undefined ? os.homedir() : opts.homeDir;
  const user = opts.userName === undefined ? currentUser() : opts.userName;
  const secrets = (opts.secrets ?? []).filter((s): s is string => typeof s === 'string' && s.length >= 6)
    .sort((a, b) => b.length - a.length);

  // The home folder, with either slash style (C:\Users\x and C:/Users/x), any case on Windows-like paths.
  const homeRe = home && home.length > 3
    ? new RegExp(escapeRe(home.replace(/[\\/]+$/, '')).replace(/\\\\|\//g, '[\\\\/]'), 'gi')
    : null;
  const userRe = user && user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(user)}(?![A-Za-z0-9])`, 'gi') : null;

  return (input: string): string => {
    if (!input) return input;
    let s = input;
    s = s.replace(URL_RE, (_m, scheme: string, rest: string) => {
      const authority = rest.split(/[/?#\\]/, 1)[0] ?? '';
      const host = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
      return `${scheme.toLowerCase()}://${host}`;
    });
    for (const secret of secrets) s = s.split(secret).join('<secret>');
    s = s.replace(AUTH_RE, (_m, head: string) => `${head}<secret>`);
    s = s.replace(KEYVAL_RE, (_m, key: string, sep: string) => `${key}${sep}<secret>`);
    s = s.replace(BEARER_RE, (_m, kind: string) => `${kind} <secret>`);
    s = s.replace(PREFIXED_RE, '<secret>');
    s = s.replace(EMAIL_RE, (_m, local: string, domain: string) => `${local.charAt(0)}***@${domain}`);
    if (homeRe) s = s.replace(homeRe, '<home>');
    s = s.replace(WIN_HOME_RE, '<home>');
    s = s.replace(UNIX_HOME_RE, (_m, pre: string) => `${pre}<home>`);
    s = s.replace(HEX_RE, '<secret>');
    s = s.replace(B64_RE, (m) => (looksSecret(m) ? '<secret>' : m));
    s = s.replace(IPV4_RE, (m, ip: string) => (isPrivateIpv4(ip) || !ip.split('.').every((n) => Number(n) <= 255) ? m : '<ip>'));
    if (userRe) s = s.replace(userRe, '<user>');
    return s;
  };
}

/** Deep copy of a JSON-like value with every string redacted (object keys are left as they are). */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}
