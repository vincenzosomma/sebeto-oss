import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DARK_QUERY, applyTheme, loadThemeChoice, notifyDesktop, resolveTheme, saveThemeChoice, systemPrefersDark,
  type ResolvedTheme, type ThemeChoice,
} from '../lib/theme';

interface ThemeCtx {
  choice: ThemeChoice;
  theme: ResolvedTheme;
  setChoice: (c: ThemeChoice) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => loadThemeChoice());
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const theme = resolveTheme(choice, systemDark);

  // Follow the OS live (matters while the choice is "Same as the system").
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(DARK_QUERY);
    const onChange = () => setSystemDark(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => notifyDesktop(choice), [choice]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    saveThemeChoice(c);
  }, []);

  const value = useMemo(() => ({ choice, theme, setChoice }), [choice, theme, setChoice]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}
