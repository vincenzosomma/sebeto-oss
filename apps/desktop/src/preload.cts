/**
 * Preload for the Sebeto window (sandboxed, contextIsolation on). It exposes one tiny bridge,
 * `window.sebetoDesktop`, used by the UI's theme switch (v0.6 §N):
 *   - `theme`: the choice saved by the desktop app ('light' | 'dark' | 'system'), read before first paint;
 *   - `setTheme(choice)`: sends a validated choice to the main process (nothing else crosses).
 * A sandboxed preload can only require 'electron', so the few constants are repeated from theme.ts.
 */
import electron = require('electron');

type ThemeSource = 'light' | 'dark' | 'system';
const THEME_CHANNEL = 'sebeto:set-theme';
const THEME_ARG_PREFIX = '--sebeto-theme=';

const valid = (v: unknown): v is ThemeSource => v === 'light' || v === 'dark' || v === 'system';
const arg = process.argv.find((a) => a.startsWith(THEME_ARG_PREFIX))?.slice(THEME_ARG_PREFIX.length);

electron.contextBridge.exposeInMainWorld('sebetoDesktop', {
  theme: valid(arg) ? arg : 'system',
  setTheme(choice: unknown): void {
    if (valid(choice)) electron.ipcRenderer.send(THEME_CHANNEL, choice);
  },
});
