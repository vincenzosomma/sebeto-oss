import { useCallback, useMemo, useState } from 'react';
import { HttpClient } from './api/client';
import { MockApi } from './api/mock';
import { getToken, initTokenFromLocation, isMockEnabled, setToken } from './api/token';
import type { SebetoApi } from './api/types';
import { Shell } from './components/Shell';
import { TokenScreen } from './components/TokenScreen';
import { StoreProvider } from './store/StoreProvider';
import { SessionContext, isDesktopShell } from './session';

const MOCK = isMockEnabled(typeof window !== 'undefined' ? window.location.href : '', import.meta.env.VITE_MOCK);

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => MOCK || !!initTokenFromLocation());
  const [rejected, setRejected] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  // Bumped after a new token is entered, to remount the store with fresh data.
  const [sessionKey, setSessionKey] = useState(0);

  const onUnauthorized = useCallback(() => {
    setToken(null);
    setRejected(true);
    setAuthed(false);
  }, []);

  const api = useMemo<SebetoApi>(
    () => (MOCK ? new MockApi() : new HttpClient({ origin: import.meta.env.VITE_API_BASE || undefined, token: getToken })),
    [],
  );

  // Forget the token in this browser; the store (and its live connection) unmounts with the shell.
  const signOut = useCallback(() => {
    setToken(null);
    setRejected(false);
    setSignedOut(true);
    setAuthed(false);
  }, []);
  const session = useMemo(() => ({ signOut: MOCK || isDesktopShell() ? undefined : signOut }), [signOut]);

  const submitToken = useCallback(
    async (token: string) => {
      setToken(token);
      try {
        await api.listTickets({ limit: 1 });
        setRejected(false);
        setSignedOut(false);
        setSessionKey((n) => n + 1);
        setAuthed(true);
        return true;
      } catch {
        setToken(null);
        setRejected(true);
        return false;
      }
    },
    [api],
  );

  if (!authed) return <TokenScreen rejected={rejected} signedOut={signedOut} onSubmit={submitToken} />;
  return (
    <SessionContext.Provider value={session}>
      <StoreProvider key={sessionKey} api={api} onUnauthorized={onUnauthorized}>
        <Shell />
      </StoreProvider>
    </SessionContext.Provider>
  );
}
