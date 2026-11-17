import { useStore } from '../store/StoreProvider';
import { columnCount } from '../store/reducer';
import { useI18n } from '../i18n/I18nProvider';
import { HeaderActions } from './HeaderActions';

export function Header({ onMenu }: { onMenu: () => void }) {
  const { state } = useStore();
  const { t } = useI18n();
  const working = columnCount(state, 'in_progress');
  const waiting = columnCount(state, 'needs_you');
  const title = t(state.view === 'all' ? 'views.all' : state.view === 'needs_you' ? 'views.needs_you' : 'views.blocked');

  return (
    <header className="header">
      <button type="button" className="icon-btn header__menu" onClick={onMenu} aria-label={t('header.menu')}>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <div className="header__text">
        <h1 className="header__title">{title}</h1>
        <p className="header__summary">{t('header.summary', { working, waiting })}</p>
      </div>
      <HeaderActions />
    </header>
  );
}
