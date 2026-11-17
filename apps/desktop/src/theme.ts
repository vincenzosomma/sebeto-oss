/**
 * Theme for the desktop window (v0.6 §N). The UI sends the user's choice through the preload
 * bridge; only 'light' | 'dark' | 'system' is accepted. The choice is also saved in the app's
 * userData folder, because the UI's own localStorage is tied to the core's port, which changes on
 * every launch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ThemeSource = 'light' | 'dark' | 'system';

/** IPC channel used by preload.cts (keep the two in sync). */
export const THEME_CHANNEL = 'sebeto:set-theme';

/** The page background of each theme (packages/ui/src/styles/tokens.css --bg), to avoid a flash. */
export const WINDOW_BACKGROUND = { light: '#F6F6F3', dark: '#141D2B' } as const;

export function parseThemeSource(value: unknown): ThemeSource | null {
  return value === 'light' || value === 'dark' || value === 'system' ? value : null;
}

export function windowBackground(dark: boolean): string {
  return dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

const FILE = 'theme.json';

export function loadThemeSource(dir: string): ThemeSource {
  try {
    const data = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as { themeSource?: unknown };
    return parseThemeSource(data?.themeSource) ?? 'system';
  } catch {
    return 'system';
  }
}

export function saveThemeSource(dir: string, source: ThemeSource): void {
  try {
    writeFileSync(join(dir, FILE), JSON.stringify({ themeSource: source }), 'utf8');
  } catch {
    /* not fatal: the window still follows the choice for this session */
  }
}

/** The preload's command-line flag carrying the saved choice into the renderer. */
export const THEME_ARG_PREFIX = '--sebeto-theme=';

export function themeArg(source: ThemeSource): string {
  return `${THEME_ARG_PREFIX}${source}`;
}

export function themeFromArgv(argv: readonly string[]): ThemeSource | null {
  const arg = argv.find((a) => a.startsWith(THEME_ARG_PREFIX));
  return arg ? parseThemeSource(arg.slice(THEME_ARG_PREFIX.length)) : null;
}
