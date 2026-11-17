import { useEffect } from 'react';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { formatRelative } from '../lib/format';
import { Dialog } from './Dialog';

/** The commands the owner chose to "Always allow", with a way to stop trusting each one. */
export function TrustedCommands({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore();
  const { t, locale } = useI18n();

  useEffect(() => {
    void actions.loadTrusted();
  }, [actions]);

  const list = state.trusted;
  return (
    <Dialog title={t('trusted.heading')} onClose={onClose}>
      <p className="small muted">{t('trusted.intro')}</p>
      {list === null ? (
        <p className="small muted" role="status">{t('panel.loading')}</p>
      ) : list.length === 0 ? (
        <p className="trusted__empty">{t('trusted.empty')}</p>
      ) : (
        <ul className="trusted">
          {list.map((c) => (
            <li key={c.id} className="trusted__item">
              <div className="trusted__text">
                <code className="trusted__cmd">{c.command}</code>
                <span className="small muted">{c.shell} · {t('trusted.added', { when: formatRelative(c.createdAt, locale) })}</span>
              </div>
              <button type="button" className="btn btn--outline btn--sm" onClick={() => void actions.removeTrusted(c.id)}>
                {t('trusted.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
