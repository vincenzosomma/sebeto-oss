import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store/StoreProvider';
import { columnCount } from '../store/reducer';
import { useI18n } from '../i18n/I18nProvider';
import { useSession } from '../session';
import { useTheme } from './ThemeProvider';
import { THEME_CHOICES, type ThemeChoice } from '../lib/theme';

/** Top-right of every page header: notifications bell, theme menu, sign out. */
export function HeaderActions() {
  const { state, actions, dispatch } = useStore();
  const { t } = useI18n();
  const { signOut } = useSession();
  const waiting = columnCount(state, 'needs_you');
  return (
    <div className="header__actions">
      <button
        type="button"
        className="icon-btn bell"
        onClick={() => { dispatch({ type: 'setPage', page: 'board' }); actions.setView('needs_you'); }}
        aria-label={t('header.bell', { count: waiting })}
        title={t('header.bell', { count: waiting })}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 16v-5a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
        {waiting > 0 && <span className="bell__count" aria-hidden="true">{waiting}</span>}
      </button>
      <ThemeMenu />
      {signOut && (
        <button type="button" className="icon-btn" onClick={signOut} aria-label={t('signout.app.button')} title={t('signout.app.hint')}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 17l-5-5 5-5M5 12h11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

const SUN = <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />;
const MOON = <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />;
const SCREEN = <path d="M4 5h16v11H4zM9 20h6M12 16v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />;
const ICON: Record<ThemeChoice, ReactNode> = { light: SUN, dark: MOON, system: SCREEN };

function ThemeMenu() {
  const { t } = useI18n();
  const { choice, setChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); button.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    // Focus the checked item so the keyboard lands inside the menu.
    box.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const label = `${t('footer.theme')}: ${t(`theme.${choice}`)}`;
  return (
    <div className="theme-menu" ref={box}>
      <button
        ref={button}
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">{ICON[choice]}</svg>
      </button>
      {open && (
        <div className="theme-menu__list" role="menu" aria-label={t('footer.theme')} onKeyDown={onMenuKey}>
          {THEME_CHOICES.map((c) => (
            <button
              key={c}
              type="button"
              role="menuitemradio"
              aria-checked={choice === c}
              className="theme-menu__item"
              onClick={() => { setChoice(c); setOpen(false); button.current?.focus(); }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">{ICON[c]}</svg>
              <span>{t(`theme.${c}`)}</span>
              {choice === c && <span className="theme-menu__check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
