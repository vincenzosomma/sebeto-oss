import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PERMISSION_LABELS, STATUS_LABELS, type Locale, type PermissionKey, type TicketStatus } from '@sebeto/shared';
import { detectLocale, translate, type MessageKey } from './catalog';

const STORAGE_KEY = 'sebeto.locale';

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  status: (s: TicketStatus) => string;
  permission: (k: PermissionKey) => string;
}

const Ctx = createContext<I18n | null>(null);

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'it') return saved;
  } catch {
    /* ignore */
  }
  return detectLocale(typeof navigator !== 'undefined' ? navigator.language : 'en');
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo<I18n>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
      status: (s) => STATUS_LABELS[locale][s],
      permission: (k) => PERMISSION_LABELS[locale][k],
    }),
    [locale, setLocale],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
