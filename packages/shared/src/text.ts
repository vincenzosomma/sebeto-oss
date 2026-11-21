/**
 * Small text helpers that run in linear time. They replace regular expressions such as
 * /^-+|-+$/ or /^[^\s@]+@[^\s@]+\.[^\s@]+$/, which can take quadratic time on crafted input
 * (CodeQL js/polynomial-redos).
 */

/** Removes any of `chars` from the start and the end. trimChars('--a-b--', '-') → 'a-b'. */
export function trimChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) start++;
  while (end > start && chars.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/** Removes any of `chars` from the end only. */
export function trimEndChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}

/**
 * Looks like an email address: one @ with text before it, no spaces or angle brackets, and a dot
 * inside the domain (not first or last). Same answers as /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.
 */
export function looksLikeEmail(s: string): boolean {
  if (!s || s.length > 320 || /[\s<>]/.test(s)) return false;
  const at = s.indexOf('@');
  if (at < 1 || at !== s.lastIndexOf('@')) return false;
  return s.slice(at + 2, -1).includes('.');
}
