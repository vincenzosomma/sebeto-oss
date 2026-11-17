/**
 * Theme contrast check (v0.6 §N): reads styles/tokens.css, resolves the light and dark token sets
 * and checks the main foreground/background pairs against WCAG AA.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHex } from './contrast';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const lightRaw = block(':root');
const darkRaw = { ...lightRaw, ...block(':root[data-theme="dark"]') };

function resolver(raw: Record<string, string>) {
  const get = (name: string, depth = 0): string => {
    const v = raw[name];
    if (v === undefined) throw new Error(`token ${name} is not defined`);
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    if (ref) {
      if (depth > 8) throw new Error(`var() loop at ${name}`);
      return get(ref[1]!, depth + 1);
    }
    return v;
  };
  return get;
}

const THEMES = { light: resolver(lightRaw), dark: resolver(darkRaw) };

const TEXT = 4.5;
const UI = 3;
const SURFACES = ['--bg', '--surface', '--surface-2', '--surface-3', '--column-bg', '--nav-hover'];
const STATUS = ['--status-backlog', '--status-in_progress', '--status-needs_you', '--status-blocked', '--status-done'];
const KINDS = ['--mk-system', '--mk-app', '--mk-cve', '--mk-runbook', '--mk-decision', '--mk-person', '--mk-ticket', '--mk-note'];
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-other'];
const PROJECT = ['--pc-0e5a8a', '--pc-2e7d5b', '--pc-b5532c', '--pc-7a4fa0', '--pc-c08a1e', '--pc-3b6e8f', '--pc-8a3b5e', '--pc-4f6b2e'];
const HIGHLIGHT = ['--hl-comment', '--hl-keyword', '--hl-string', '--hl-number', '--hl-variable', '--hl-title', '--hl-meta', '--hl-deletion', '--hl-addition', '--code-text'];

/** [foreground, background, minimum ratio, what it is]. */
const PAIRS: [string, string, number, string][] = [
  ...SURFACES.flatMap((bg) => [
    ['--text', bg, TEXT, 'body text'],
    ['--text-2', bg, TEXT, 'secondary text'],
    ['--text-muted', bg, TEXT, 'muted text'],
  ] as [string, string, number, string][]),
  ['--text-placeholder', '--surface', TEXT, 'placeholder'],
  ['--nav-active-text', '--nav-active-bg', TEXT, 'active sidebar item'],
  ['--gulf-blue', '--surface', TEXT, 'links'],
  ['--gulf-blue', '--bg', TEXT, 'links on the page'],
  ['--deep-sea', '--surface', TEXT, 'headings'],
  ['--deep-sea', '--bg', TEXT, 'page titles'],
  ['--on-primary', '--gulf-blue', TEXT, 'primary button'],
  ['--on-primary', '--primary-hover', TEXT, 'primary button hover'],
  ['--on-primary', '--deep-sea', TEXT, 'avatar'],
  ['--deep-sea', '--sea-mist', TEXT, 'chips / notices'],
  ['--text', '--sea-mist', TEXT, 'user chat bubble'],
  ['--gulf-blue', '--sea-mist', UI, 'selected segment border'],
  ['--on-tuff', '--tuff-yellow', TEXT, 'tuff call-to-action'],
  ['--on-tuff', '--tuff-hover', TEXT, 'tuff hover'],
  ['--text', '--tuff-light', TEXT, 'tuff-light notes'],
  ['--needs-you-text', '--tuff-light', TEXT, 'agent provenance'],
  ['--needs-you-text', '--surface', TEXT, 'needs-you text'],
  ['--needs-you-text', '--needs-you-tint', TEXT, 'needs-you chips'],
  ['--warn-text', '--needs-you-tint', TEXT, 'warnings'],
  ['--status-blocked', '--surface', TEXT, 'error text'],
  ['--status-blocked', '--blocked-tint', TEXT, 'error box'],
  ['--blocked-text', '--blocked-tint', TEXT, 'blocked banner'],
  ['--done-text', '--surface', TEXT, 'success text'],
  ['--done-text', '--done-tint', TEXT, 'success chips'],
  ['--text-2', '--surface-3', TEXT, 'backlog badge'],
  ['--inverse-text', '--inverse-bg', TEXT, 'active pill'],
  ['--on-status', '--danger-hover', TEXT, 'danger button hover'],
  ['--on-status', '--status-blocked', TEXT, 'danger fill / lockdown banner'],
  ...STATUS.filter((s) => s !== '--status-backlog').map((s) => ['--on-status', s, TEXT, `badge ${s}`] as [string, string, number, string]),
  ...STATUS.map((s) => [s, '--surface', UI, `status dot ${s}`] as [string, string, number, string]),
  ...KINDS.map((k) => ['--on-status', k, TEXT, `kind chip ${k}`] as [string, string, number, string]),
  ...KINDS.map((k) => [k, '--surface', UI, `graph node ${k}`] as [string, string, number, string]),
  ['--text-2', '--surface', TEXT, 'graph labels'],
  ['--graph-edge', '--surface', UI, 'graph edges'],
  ...SERIES.map((s) => [s, '--surface', UI, `chart series ${s}`] as [string, string, number, string]),
  ...PROJECT.map((p) => [p, '--surface', UI, `project/team colour ${p}`] as [string, string, number, string]),
  ['--border-input', '--surface', UI, 'input outline'],
  ['--border-input', '--bg', UI, 'input outline on the page'],
  ['--gulf-blue', '--surface', UI, 'selected card / focus border'],
  ...HIGHLIGHT.map((h) => [h, '--code-bg', TEXT, `code ${h}`] as [string, string, number, string]),
  ['--code-head-text', '--code-head-bg', TEXT, 'code header'],
  ['--code-btn-text', '--code-head-bg', TEXT, 'code copy button'],
];

describe('theme tokens', () => {
  it('defines the same names in the dark set as in the light set (no stray tokens)', () => {
    const extra = Object.keys(block(':root[data-theme="dark"]')).filter((k) => !(k in lightRaw));
    expect(extra).toEqual([]);
  });

  for (const [theme, get] of Object.entries(THEMES)) {
    describe(`${theme} theme`, () => {
      it.each(PAIRS)('%s on %s ≥ %s (%s)', (fg, bg, min) => {
        const f = get(fg);
        const b = get(bg);
        expect(parseHex(f), `${fg} = ${f}`).not.toBeNull();
        expect(parseHex(b), `${bg} = ${b}`).not.toBeNull();
        const ratio = contrastRatio(f, b);
        expect(ratio, `${theme}: ${fg} ${f} on ${bg} ${b} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(min);
      });
    });
  }
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
    expect(contrastRatio('#777', '#FFF')).toBeCloseTo(4.48, 2);
  });
});
