import { useEffect, useState } from 'react';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage } from '../lib/format';

/**
 * Red banner across the app while the emergency stop (lockdown) is on (v0.4 B). It also loads the
 * lockdown state once at startup; afterwards the 'security.lockdown' WebSocket event keeps it fresh.
 */
export function LockdownBanner() {
  const { state, api, dispatch } = useStore();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.securityStatus().then((s) => dispatch({ type: 'setLockdown', active: s.active }), () => undefined);
  }, [api, dispatch]);

  if (!state.lockdown) return null;

  const release = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.releaseLockdown();
      dispatch({ type: 'setLockdown', active: false });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sec-lockdown" role="alert">
      <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
      <div className="sec-lockdown__text">
        <strong>{t('sec.lockdown.banner')}</strong>
        <span className="small">{error ?? t('sec.lockdown.releaseHint')}</span>
      </div>
      <button type="button" className="btn btn--sm sec-lockdown__btn" onClick={() => void release()} disabled={busy}>
        {busy ? t('sec.lockdown.releasing') : t('sec.lockdown.release')}
      </button>
    </div>
  );
}
