import { describe, expect, it } from 'vitest';
import { looksLikeEmail, trimChars, trimEndChars } from './text.js';

describe('linear text helpers (CodeQL polynomial-redos)', () => {
  it('trims like the regexes they replace', () => {
    for (const [s, c] of [['--a-b--', '-'], ['.-x.-', '.-'], ['', '-'], ['---', '-'], ['abc', '-'], ['__a__b__', '_']] as const) {
      const re = new RegExp(`^[${c.replace(/[-\\\]]/g, '\\$&')}]+|[${c.replace(/[-\\\]]/g, '\\$&')}]+$`, 'g');
      expect(trimChars(s, c)).toBe(s.replace(re, ''));
    }
    expect(trimEndChars('a/b///', '/')).toBe('a/b');
    expect(trimEndChars('C:\\Users\\x\\/', '\\/')).toBe('C:\\Users\\x');
    expect(trimEndChars('///', '/')).toBe('');
  });

  it('checks emails like /^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$/', () => {
    const re = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
    for (const s of ['a@b.co', 'first.last@sub.example.org', 'a@b.c.', 'a@.b', 'a@b.', '@b.co', 'a@@b.co', 'a b@c.io', 'a@b', '<a@b.co>', 'a@b..c', 'x@y.z'])
      expect(looksLikeEmail(s)).toBe(re.test(s));
  });

  it('stays fast on crafted input', () => {
    const t0 = Date.now();
    trimChars(`${'-'.repeat(200_000)}x`, '-');
    trimEndChars(`x${'/'.repeat(200_000)}`, '/');
    looksLikeEmail(`a@${'.'.repeat(300)}`);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
