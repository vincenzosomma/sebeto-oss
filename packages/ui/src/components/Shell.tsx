import { useEffect, useState } from 'react';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { AgentsPage } from './AgentsPage';
import { Board } from './Board';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { TicketPanel } from './TicketPanel';
import { SetupHost } from './SetupWizard';
import { useDesktopNotifications } from './DesktopNotifications';
import { FilterBar } from './Projects';
import { SessionsPage } from './SessionsPage';
import { MemoryPage } from './MemoryPage';
import { SecurityPage } from './SecurityPage';
import { CostsPage } from './CostsPage';
import { DeletedTicketsPage } from './DeletedTicketsPage';
import { LockdownBanner } from './LockdownBanner';
import { isLockdownError } from '../lib/security';

export function Shell() {
  const { state, actions } = useStore();
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  // Bumped by Settings → Run setup again.
  const [setupRun, setSetupRun] = useState(0);
  useDesktopNotifications();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) setMenuOpen(false);
      else if (state.selectedId) actions.select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, state.selectedId, actions]);

  return (
    <div className={`app${state.selectedId ? ' app--panel' : ''}`}>
      <a className="skip-link" href="#board">{t('board.skip')}</a>
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} onRunSetup={() => setSetupRun((n) => n + 1)} />
      {menuOpen && <div className="scrim scrim--menu" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <main className="main" id="board" tabIndex={-1}>
        <LockdownBanner />
        {state.page === 'security' ? <SecurityPage onMenu={() => setMenuOpen(true)} />
          : state.page === 'agents' ? <AgentsPage onMenu={() => setMenuOpen(true)} />
          : state.page === 'sessions' ? <SessionsPage onMenu={() => setMenuOpen(true)} />
          : state.page === 'memory' ? <MemoryPage onMenu={() => setMenuOpen(true)} />
          : state.page === 'costs' ? <CostsPage onMenu={() => setMenuOpen(true)} />
          : state.page === 'deleted' ? <DeletedTicketsPage onMenu={() => setMenuOpen(true)} />
          : <Header onMenu={() => setMenuOpen(true)} />}
        {state.error && (
          <div className="error-banner" role="alert">
            <span>{isLockdownError(state.error) ? t('sec.lockdown.refused') : t('error.generic', { message: state.error })}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={actions.dismissError}>
              {t('error.dismiss')}
            </button>
          </div>
        )}
        {state.page === 'board' && <FilterBar />}
        {state.page === 'board' && <Board />}
      </main>
      {state.selectedId && (
        <>
          <div className="scrim scrim--panel" onClick={() => actions.select(null)} aria-hidden="true" />
          <TicketPanel key={state.selectedId} ticketId={state.selectedId} />
        </>
      )}
      <SetupHost runAgain={setupRun} />
    </div>
  );
}
