import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_COLORS } from '@sebeto/shared';
import {
  THEME_STORAGE_KEY, applyTheme, entityColor, loadThemeChoice, notifyDesktop, parseThemeChoice, resolveTheme, saveThemeChoice,
} from './theme';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const blocked = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('SecurityError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

describe('theme choice', () => {
  it('accepts only light / dark / system; anything else means system', () => {
    expect(parseThemeChoice('light')).toBe('light');
    expect(parseThemeChoice('dark')).toBe('dark');
    expect(parseThemeChoice('system')).toBe('system');
    for (const bad of [null, undefined, '', 'Dark', 'auto', 1, {}]) expect(parseThemeChoice(bad)).toBe('system');
  });

  it('resolves system from the OS and keeps explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('loads and saves per computer, system included', () => {
    const s = memoryStorage();
    expect(loadThemeChoice(s, undefined)).toBe('system');
    saveThemeChoice('dark', s);
    expect(s.data.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(loadThemeChoice(s, undefined)).toBe('dark');
    saveThemeChoice('system', s);
    expect(loadThemeChoice(s, undefined)).toBe('system');
    expect(loadThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: 'purple' }), undefined)).toBe('system');
  });

  it("falls back to the desktop app's saved choice when localStorage is empty", () => {
    const desktop = { sebetoDesktop: { theme: 'dark' } };
    expect(loadThemeChoice(memoryStorage(), desktop)).toBe('dark');
    expect(loadThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: 'light' }), desktop)).toBe('light');
    expect(loadThemeChoice(memoryStorage(), { sebetoDesktop: { theme: '<script>' } })).toBe('system');
    expect(loadThemeChoice(blocked, desktop)).toBe('dark');
  });

  it('works when storage is blocked or missing', () => {
    expect(loadThemeChoice(blocked, undefined)).toBe('system');
    expect(() => saveThemeChoice('dark', blocked)).not.toThrow();
    expect(loadThemeChoice(undefined, undefined)).toBe('system');
    expect(() => saveThemeChoice('light', undefined)).not.toThrow();
  });

  it('puts the resolved theme on <html> and the meta theme colour', () => {
    const meta = { setAttribute: vi.fn() };
    const doc = { documentElement: { dataset: {} as Record<string, string> }, querySelector: () => meta } as unknown as Document;
    applyTheme('dark', doc);
    expect(doc.documentElement.dataset['theme']).toBe('dark');
    expect(meta.setAttribute).toHaveBeenCalledWith('content', '#141D2B');
  });

  it('tells the desktop bridge when there is one, and ignores its absence', () => {
    const setTheme = vi.fn();
    notifyDesktop('dark', { sebetoDesktop: { setTheme } });
    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(() => notifyDesktop('light', {})).not.toThrow();
    expect(() => notifyDesktop('light', undefined)).not.toThrow();
    expect(() => notifyDesktop('light', { sebetoDesktop: { setTheme: () => { throw new Error('x'); } } })).not.toThrow();
  });

  it('index.html applies the same rules before first paint', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
    expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
    expect(html).toContain("(prefers-color-scheme: dark)");
    expect(html).toContain("setAttribute('data-theme'");
    // the inline script runs before the app bundle
    expect(html.indexOf("setAttribute('data-theme'")).toBeLessThan(html.indexOf('src/main.tsx'));
  });
});

describe('entityColor', () => {
  it('maps palette colours to theme tokens and leaves others alone', () => {
    expect(entityColor('#0E5A8A')).toBe('var(--pc-0e5a8a, #0E5A8A)');
    expect(entityColor('#2e7d5b')).toBe('var(--pc-2e7d5b, #2E7D5B)');
    expect(entityColor('#123456')).toBe('#123456');
    expect(entityColor('var(--series-1)')).toBe('var(--series-1)');
    expect(entityColor(undefined)).toBeUndefined();
  });

  it('has a token in tokens.css for every palette colour', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'tokens.css'), 'utf8');
    for (const c of PROJECT_COLORS) expect(css).toContain(`--pc-${c.slice(1).toLowerCase()}:`);
  });
});
