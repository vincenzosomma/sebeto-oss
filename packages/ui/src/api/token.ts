/** Access-token handling: read `?token=` once, keep it in sessionStorage, strip it from the address bar. */

const KEY = 'sebeto.token';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null; // access can throw (blocked storage, sandboxed frames)
  }
}

/** Pure: split a URL into the token it carries and the same URL without it. */
export function extractToken(href: string): { token: string | null; cleanUrl: string } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { token: null, cleanUrl: href };
  }
  const token = url.searchParams.get('token');
  if (token === null) return { token: null, cleanUrl: href };
  url.searchParams.delete('token');
  return { token: token.trim() || null, cleanUrl: url.toString() };
}

let memoryToken: string | null = null; // fallback when storage is unavailable

export function getToken(storage: KeyValueStorage | null = defaultStorage()): string | null {
  try {
    const v = storage?.getItem(KEY);
    if (v) return v;
  } catch {
    /* ignore */
  }
  return memoryToken;
}

export function setToken(token: string | null, storage: KeyValueStorage | null = defaultStorage()): void {
  memoryToken = token;
  try {
    if (token) storage?.setItem(KEY, token);
    else storage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Run once on startup: capture `?token=` into storage and remove it from the address bar. */
export function initTokenFromLocation(): string | null {
  if (typeof window === 'undefined') return getToken();
  const { token, cleanUrl } = extractToken(window.location.href);
  if (token) {
    setToken(token);
    try {
      window.history.replaceState(window.history.state, '', cleanUrl);
    } catch {
      /* ignore */
    }
  }
  return getToken();
}

/** Mock mode: `?mock=1` in the URL or VITE_MOCK=1 at build time. */
export function isMockEnabled(href: string, envFlag: string | undefined): boolean {
  if (envFlag === '1') return true;
  try {
    const v = new URL(href).searchParams.get('mock');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}
