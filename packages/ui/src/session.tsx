/**
 * App-level session: "Sign out of Sebeto" in this browser (forget the access token and go back to
 * the access-key screen). Not offered inside the desktop app, which opens with its own key every time.
 */
import { createContext, useContext } from 'react';

export interface Session {
  /** Undefined when signing out makes no sense (desktop app, demo mode). */
  signOut?: () => void;
}

export const SessionContext = createContext<Session>({});
export const useSession = () => useContext(SessionContext);

/** Electron's renderer identifies itself in the user agent. Exported for tests. */
export function isDesktopShell(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /\bElectron\//.test(userAgent);
}
