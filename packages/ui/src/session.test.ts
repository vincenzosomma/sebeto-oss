import { describe, expect, it } from 'vitest';
import { isDesktopShell } from './session';
import { getToken, setToken, type KeyValueStorage } from './api/token';

describe('session', () => {
  it('detects the desktop shell', () => {
    expect(isDesktopShell('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Electron/38.2.0 Safari/537.36')).toBe(true);
    expect(isDesktopShell('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Safari/537.36')).toBe(false);
  });

  it('signing out forgets the token in storage and memory', () => {
    const map = new Map<string, string>();
    const storage: KeyValueStorage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
    setToken('secret-token-123456', storage);
    expect(getToken(storage)).toBe('secret-token-123456');
    setToken(null, storage);
    expect(getToken(storage)).toBeNull();
    expect(map.size).toBe(0);
  });
});
