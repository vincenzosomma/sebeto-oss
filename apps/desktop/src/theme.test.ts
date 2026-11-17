import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  THEME_ARG_PREFIX, THEME_CHANNEL, WINDOW_BACKGROUND, loadThemeSource, parseThemeSource, saveThemeSource, themeArg, themeFromArgv, windowBackground,
} from './theme';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'sebeto-theme-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('desktop theme', () => {
  it('accepts only light / dark / system from the renderer', () => {
    expect(parseThemeSource('light')).toBe('light');
    expect(parseThemeSource('dark')).toBe('dark');
    expect(parseThemeSource('system')).toBe('system');
    for (const bad of ['', 'DARK', 'auto', null, undefined, 1, { toString: () => 'dark' }, ['dark']]) expect(parseThemeSource(bad)).toBeNull();
  });

  it('picks the window background of the theme in use', () => {
    expect(windowBackground(true)).toBe(WINDOW_BACKGROUND.dark);
    expect(windowBackground(false)).toBe(WINDOW_BACKGROUND.light);
  });

  it('matches the UI tokens for the page background', () => {
    const tokens = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'ui', 'src', 'styles', 'tokens.css'), 'utf8');
    const at = tokens.lastIndexOf(':root[data-theme="dark"] {');
    const [light, dark] = [tokens.slice(0, at), tokens.slice(at)];
    expect(light).toContain(`--bg: ${WINDOW_BACKGROUND.light};`);
    expect(dark).toContain(`--bg: ${WINDOW_BACKGROUND.dark};`);
  });

  it('saves and loads the choice; bad or missing files mean system', () => {
    const d = tmp();
    expect(loadThemeSource(d)).toBe('system');
    saveThemeSource(d, 'dark');
    expect(loadThemeSource(d)).toBe('dark');
    writeFileSync(join(d, 'theme.json'), '{"themeSource":"neon"}');
    expect(loadThemeSource(d)).toBe('system');
    writeFileSync(join(d, 'theme.json'), 'not json');
    expect(loadThemeSource(d)).toBe('system');
    expect(() => saveThemeSource(join(d, 'missing', 'dir'), 'light')).not.toThrow();
  });

  it('passes the saved choice to the preload on argv', () => {
    expect(themeArg('dark')).toBe(`${THEME_ARG_PREFIX}dark`);
    expect(themeFromArgv(['electron', '--foo', themeArg('light')])).toBe('light');
    expect(themeFromArgv([`${THEME_ARG_PREFIX}evil`])).toBeNull();
    expect(themeFromArgv([])).toBeNull();
  });

  it('keeps the preload in sync (channel, flag, validation) and exposes nothing else', () => {
    const preload = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'preload.cts'), 'utf8');
    expect(preload).toContain(`'${THEME_CHANNEL}'`);
    expect(preload).toContain(`'${THEME_ARG_PREFIX}'`);
    expect(preload.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(preload).not.toMatch(/ipcRenderer\.(invoke|sendSync|on)\b/);
    expect(preload).toContain("if (valid(choice)) electron.ipcRenderer.send(THEME_CHANNEL, choice)");
  });
});
