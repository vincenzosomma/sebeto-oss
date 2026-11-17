import { useState } from 'react';
import type { Locale } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { columnCount, type View } from '../store/reducer';
import { useI18n } from '../i18n/I18nProvider';
import { LOCALES } from '../i18n/catalog';
import { Logo } from './Logo';
import { NewTicketForm } from './NewTicketForm';
import { IntakeChat } from './IntakeChat';
import { SearchBox } from './SearchBox';
import { TrustedCommands } from './TrustedCommands';
import { Connectors } from './Connectors';
import { Triggers } from './Triggers';
import { Diagnostics } from './Diagnostics';
import { Backups } from './Backups';
import { NotificationsToggle } from './DesktopNotifications';
import { ProjectsNav } from './Projects';
import { TeamsNav } from './Teams';

const LOCALE_NAMES: Record<Locale, string> = { en: 'English', it: 'Italiano' };

export function Sidebar({ open, onClose, onRunSetup }: { open: boolean; onClose: () => void; onRunSetup?: () => void }) {
  const { state, actions, api, dispatch } = useStore();
  const { t, locale, setLocale } = useI18n();
  const [dialog, setDialog] = useState<'trusted' | 'connectors' | 'intake' | 'diagnostics' | 'triggers' | 'backups' | null>(null);
  const total = Object.values(state.columns).reduce((n, c) => n + c.ids.length, 0);
  const views: Array<{ id: View; label: string; count: number }> = [
    { id: 'all', label: t('views.all'), count: total },
    { id: 'needs_you', label: t('views.needs_you'), count: columnCount(state, 'needs_you') },
    { id: 'blocked', label: t('views.blocked'), count: columnCount(state, 'blocked') },
  ];
  const connKey =
    state.connection === 'open' ? 'footer.connection.open' : state.connection === 'connecting' ? 'footer.connection.connecting' : 'footer.connection.closed';

  return (
    <aside className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label="Sebeto">
      <div className="sidebar__top">
        <Logo subtitle={t('app.workspace')} />
        <button type="button" className="icon-btn sidebar__close" onClick={onClose} aria-label={t('header.closeMenu')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {api.mode === 'mock' && <span className="chip chip--tuff">{t('app.mockBadge')}</span>}
      <SearchBox />
      <button type="button" className="btn btn--tuff btn--block intake-btn" onClick={() => { setDialog('intake'); onClose(); }}>
        {t('intake.open.button')}
      </button>
      <details className="new-ticket-manual">
        <summary className="small">{t('intake.manual')}</summary>
        <NewTicketForm />
      </details>
      {dialog === 'intake' && <IntakeChat onClose={() => setDialog(null)} />}
      <nav aria-label={t('views.heading')}>
        <h2 className="section-label">{t('views.heading')}</h2>
        <ul className="views">
          {views.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                className={`view-btn${state.page === 'board' && state.view === v.id ? ' view-btn--active' : ''}`}
                aria-pressed={state.page === 'board' && state.view === v.id}
                onClick={() => {
                  dispatch({ type: 'setPage', page: 'board' });
                  actions.setView(v.id);
                  onClose();
                }}
              >
                <span>{v.label}</span>
                <span className="count">{v.count}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className={`view-btn${state.page === 'deleted' ? ' view-btn--active' : ''}`}
              aria-current={state.page === 'deleted' ? 'page' : undefined}
              onClick={() => { dispatch({ type: 'setPage', page: 'deleted' }); onClose(); }}
            >
              <span>{t('del.nav')}</span>
            </button>
          </li>
        </ul>
      </nav>
      <nav aria-label={t('ag.navHeading')}>
        <h2 className="section-label">{t('ag.navHeading')}</h2>
        <ul className="views">
          <li>
            <button
              type="button"
              className={`view-btn${state.page === 'agents' ? ' view-btn--active' : ''}`}
              aria-current={state.page === 'agents' ? 'page' : undefined}
              onClick={() => { dispatch({ type: 'setPage', page: 'agents' }); onClose(); }}
            >
              <span>{t('ag.title')}</span>
              <span className="count">{Object.keys(state.agents).length}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`view-btn${state.page === 'sessions' ? ' view-btn--active' : ''}`}
              aria-current={state.page === 'sessions' ? 'page' : undefined}
              onClick={() => { dispatch({ type: 'setPage', page: 'sessions' }); onClose(); }}
            >
              <span>{t('ss.title')}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`view-btn${state.page === 'memory' ? ' view-btn--active' : ''}`}
              aria-current={state.page === 'memory' ? 'page' : undefined}
              onClick={() => { dispatch({ type: 'setPage', page: 'memory' }); onClose(); }}
            >
              <span>{t('mem.title')}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`view-btn${state.page === 'costs' ? ' view-btn--active' : ''}`}
              aria-current={state.page === 'costs' ? 'page' : undefined}
              onClick={() => { dispatch({ type: 'setPage', page: 'costs' }); onClose(); }}
            >
              <span>{t('cost.nav')}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`view-btn${state.page === 'security' ? ' view-btn--active' : ''}`}
              aria-current={state.page === 'security' ? 'page' : undefined}
              onClick={() => { dispatch({ type: 'setPage', page: 'security' }); onClose(); }}
            >
              <span>{t('sec.nav')}</span>
              {state.lockdown && <span className="count sec-nav-stop">{t('sec.stop.button')}</span>}
            </button>
          </li>
        </ul>
      </nav>
      <ProjectsNav onPicked={onClose} />
      <TeamsNav onPicked={onClose} />
      <nav aria-label={t('settings.heading')}>
        <h2 className="section-label">{t('settings.heading')}</h2>
        <ul className="views">
          <li>
            <button type="button" className="view-btn" onClick={() => setDialog('connectors')}>
              <span>{t('conn.heading')}</span>
              {state.mail?.connected && <span className="count count--on">{t('conn.gmailOn')}</span>}
            </button>
          </li>
          <li>
            <button type="button" className="view-btn" onClick={() => setDialog('triggers')}>
              <span>{t('trg.heading')}</span>
            </button>
          </li>
          <li>
            <button type="button" className="view-btn" onClick={() => setDialog('trusted')}>
              <span>{t('trusted.heading')}</span>
              {state.trusted && <span className="count">{state.trusted.length}</span>}
            </button>
          </li>
          {onRunSetup && (
            <li>
              <button type="button" className="view-btn" onClick={() => { onRunSetup(); onClose(); }}>
                <span>{t('wz.runAgain')}</span>
              </button>
            </li>
          )}
          <li>
            <NotificationsToggle />
          </li>
          <li>
            <button type="button" className="view-btn" onClick={() => setDialog('backups')}>
              <span>{t('bk.button')}</span>
            </button>
          </li>
          <li>
            <button type="button" className="view-btn" onClick={() => setDialog('diagnostics')}>
              <span>{t('dg.button')}</span>
            </button>
          </li>
        </ul>
      </nav>
      {dialog === 'trusted' && <TrustedCommands onClose={() => setDialog(null)} />}
      {dialog === 'connectors' && <Connectors onClose={() => setDialog(null)} />}
      {dialog === 'triggers' && <Triggers onClose={() => setDialog(null)} />}
      {dialog === 'diagnostics' && <Diagnostics onClose={() => setDialog(null)} />}
      {dialog === 'backups' && <Backups onClose={() => setDialog(null)} />}
      <footer className="sidebar__footer">
        <label className="lang">
          <span className="field__label">{t('footer.language')}</span>
          <select className="input input--sm" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>{LOCALE_NAMES[l]}</option>
            ))}
          </select>
        </label>
        <span className={`conn conn--${state.connection}`} role="status">
          <span className="conn__dot" aria-hidden="true" />
          {t(connKey)}
        </span>
      </footer>
    </aside>
  );
}
