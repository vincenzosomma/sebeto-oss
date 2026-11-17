import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';

const DEBOUNCE_MS = 300;

export function SearchBox() {
  const { state, actions } = useStore();
  const { t } = useI18n();
  const [value, setValue] = useState(state.query);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const q = value.trim();
    const timer = setTimeout(() => {
      actions.setQuery(q);
      void actions.loadBoard(q);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, actions]);

  const total = Object.values(state.columns).reduce((n, c) => n + c.ids.length, 0);

  return (
    <div className="search" role="search">
      <label className="sr-only" htmlFor="search-input">{t('search.label')}</label>
      <div className="search__box">
        <svg className="search__icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="m20 20-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          id="search-input"
          className="input search__input"
          type="search"
          placeholder={t('search.placeholder')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <p className="small muted search__summary" aria-live="polite">
        {state.query ? t('search.summary', { count: total }) : ''}
      </p>
    </div>
  );
}
