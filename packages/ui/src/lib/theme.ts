/**
 * Light / dark theme (v0.6 §N). The choice is 'light', 'dark' or 'system' (the default), saved per
 * computer in localStorage. `<html data-theme>` always holds the *resolved* theme ('light' | 'dark'):
 * index.html sets it before first paint with the same rules (keep the two in sync), and
 * ThemeProvider keeps it up to date, following the OS live while the choice is 'system'.
 */

import { PROJECT_COLORS } from '@sebeto/shared';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const THEME_STORAGE_KEY = 'sebeto.theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';
/** The browser chrome colour (<meta name="theme-color">) per theme: the page background. */
export const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#0E5A8A', dark: '#141D2B' };

/** Anything → a valid choice ('system' for unknown values). */
export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // storage blocked (privacy settings, sandboxed frame)
  }
}

/**
 * The saved choice: localStorage first; then the desktop app's saved choice (its window loads the
 * UI from a new port on every launch, so localStorage starts empty there); else 'system'.
 */
export function loadThemeChoice(
  storage: StorageLike | undefined = defaultStorage(),
  win: unknown = typeof window === 'undefined' ? undefined : window,
): ThemeChoice {
  let saved: string | null | undefined;
  try {
    saved = storage?.getItem(THEME_STORAGE_KEY);
  } catch {
    saved = undefined;
  }
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  try {
    return parseThemeChoice((win as { sebetoDesktop?: DesktopBridge } | undefined)?.sebetoDesktop?.theme);
  } catch {
    return 'system';
  }
}

/** Save the choice (never throws: blocked storage just means it lasts for this session). */
export function saveThemeChoice(choice: ThemeChoice, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* storage blocked: the choice lasts for this session only */
  }
}

export function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** Put the resolved theme on <html> and the browser chrome colour on <meta name="theme-color">. */
export function applyTheme(theme: ResolvedTheme, doc: Document = document): void {
  doc.documentElement.dataset['theme'] = theme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

/** The desktop app's preload bridge (apps/desktop/src/preload.cts), when running in Electron. */
interface DesktopBridge { theme?: unknown; setTheme?: (choice: ThemeChoice) => void }

/** Tell the desktop shell (if any) so the native window, title bar and background follow. */
export function notifyDesktop(choice: ThemeChoice, win: unknown = typeof window === 'undefined' ? undefined : window): void {
  try {
    const bridge = (win as { sebetoDesktop?: DesktopBridge } | undefined)?.sebetoDesktop;
    bridge?.setTheme?.(choice);
  } catch {
    /* the bridge is optional */
  }
}

/**
 * Project and team colours are stored as hex. The palette ones (PROJECT_COLORS) map to a theme
 * token (`--pc-<hex>`, lighter on dark); any other colour is used as is.
 */
export function entityColor(color: string | undefined | null): string | undefined {
  if (!color) return undefined;
  if (color.startsWith('var(')) return color;
  const hex = color.toUpperCase();
  return PROJECT_COLORS.includes(hex) ? `var(--pc-${hex.slice(1).toLowerCase()}, ${hex})` : color;
}
