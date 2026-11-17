// Shared helpers for the contract-fixture recorders (record-claude-fixtures.mjs,
// record-ollama-fixtures.mjs). Removes anything personal from recorded output before it is
// committed: the home folder, the user name, e-mail addresses, and anything that looks like a key.
import os from 'node:os';
import path from 'node:path';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every spelling of `dir` that can appear in raw or JSON-encoded output. */
function spellings(dir) {
  const back = dir.replace(/\//g, '\\');
  const fwd = dir.replace(/\\/g, '/');
  const out = new Set([back, fwd, back.replace(/\\/g, '\\\\')]);
  // Git Bash style (/c/Users/name) and lowercase drive letters.
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(dir);
  if (m) {
    const rest = m[2].replace(/\\/g, '/');
    out.add(`/${m[1].toLowerCase()}/${rest}`);
    for (const s of [...out]) out.add(s[0].toLowerCase() + s.slice(1));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const userName = path.basename(os.homedir());
const homeRes = spellings(os.homedir()).map((s) => new RegExp(escapeRe(s), 'gi'));
const userRe = userName.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(userName)}(?![A-Za-z0-9])`, 'gi') : null;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEY_RES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic keys and OAuth tokens
  /sk-[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b[0-9a-f]{64}\b/gi, // Sebeto MCP tokens are 64 hex chars
];

/** Redact one text blob. `extra` replaces run-specific strings first ([needle, replacement]). */
export function redact(text, extra = []) {
  let t = text;
  for (const [needle, repl] of extra) if (needle) t = t.split(needle).join(repl);
  // Account details Claude Code adds to the result record.
  t = t.replace(/("credential_expires_at":)"[^"]*"/g, '$1"<redacted>"');
  for (const re of homeRes) t = t.replace(re, '<home>');
  t = t.replace(EMAIL_RE, '<email>');
  for (const re of KEY_RES) t = t.replace(re, '<redacted-key>');
  if (userRe) t = t.replace(userRe, '<user>');
  return t;
}

/** Throws if anything personal survived redaction (belt and braces). */
export function assertClean(text, label) {
  const problems = [];
  if (userRe && userRe.test(text)) problems.push(`user name "${userName}"`);
  if (userRe) userRe.lastIndex = 0;
  if (EMAIL_RE.test(text)) problems.push('an e-mail address');
  EMAIL_RE.lastIndex = 0;
  if (/sk-ant-|sk-[A-Za-z0-9]{20,}/.test(text)) problems.push('an API key');
  if (problems.length) throw new Error(`${label}: redaction left ${problems.join(', ')}`);
}

/** LF-only text with a trailing newline. */
export function lf(text) {
  return `${text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`;
}
