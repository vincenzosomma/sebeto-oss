import { useEffect, useState, type FormEvent } from 'react';
import type { DisconnectMailResponse } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, formatRelative } from '../lib/format';
import { Dialog } from './Dialog';

/** Settings → Email: connect Gmail with an app password, or disconnect. */
export function MailSettings({ onClose }: { onClose: () => void }) {
  const { state, dispatch, api } = useStore();
  const { t, locale } = useI18n();
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState<DisconnectMailResponse | null>(null);

  useEffect(() => {
    api.mailStatus().then((status) => dispatch({ type: 'mailLoaded', status }), (err) => setError(errorMessage(err)));
  }, [api, dispatch]);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const status = await api.connectMail({ provider: 'gmail', address, password });
      dispatch({ type: 'mailLoaded', status });
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      setSignedOut(await api.disconnectMail());
      dispatch({ type: 'mailLoaded', status: { connected: false } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const mail = state.mail;
  return (
    <Dialog title={t('mail.heading')} onClose={onClose}>
      <p className="small muted">{t('mail.intro')}</p>
      {mail?.connected ? (
        <>
          <div className="mail-status" role="status">
            <div>
              <strong>{t('mail.connected', { address: mail.address })}</strong>
              <div className="small muted">Gmail · {t('mail.connectedSince', { when: formatRelative(mail.connectedAt, locale) })}</div>
            </div>
            <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => void disconnect()}>
              {t('mail.disconnect')}
            </button>
          </div>
          <p className="small muted">{t('mail.privacy')}</p>
        </>
      ) : (
        <form className="mail-form" onSubmit={(e) => void connect(e)}>
          <label className="field">
            <span className="field__label">{t('mail.address')}</span>
            <input className="input" type="email" autoComplete="email" required value={address}
              placeholder="name@gmail.com" onChange={(e) => setAddress(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{t('mail.password')}</span>
            <input className="input" type="password" autoComplete="off" required value={password}
              placeholder="abcd efgh ijkl mnop" onChange={(e) => setPassword(e.target.value)} aria-describedby="mail-pass-hint" />
            <span className="small muted" id="mail-pass-hint">{t('mail.passwordHint')}</span>
          </label>
          <details>
            <summary className="small">{t('mail.steps')}</summary>
            <ol className="mail-steps">
              <li>{t('mail.step1')}</li>
              <li>{t('mail.step2')}</li>
              <li>{t('mail.step3')}</li>
            </ol>
          </details>
          {error && <p className="mail-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn--primary" disabled={busy || !address || !password}>
            {busy ? t('mail.connecting') : t('mail.connect')}
          </button>
          <p className="small muted">{t('mail.privacy')}</p>
        </form>
      )}
      {signedOut && (
        <div className="signout-note" role="status">
          <p><strong>{t('signout.done')}</strong> {t(signedOut.revokedAtProvider ? 'signout.revoked' : 'signout.local')}</p>
          {signedOut.accountUrl && !signedOut.revokedAtProvider && (
            <p className="small">
              {t('signout.accountHint')}{' '}
              <a href={signedOut.accountUrl} target="_blank" rel="noopener noreferrer">{signedOut.accountUrl.replace(/^https:\/\//, '')}</a>
            </p>
          )}
        </div>
      )}
      {mail?.connected && error && <p className="mail-error" role="alert">{error}</p>}
    </Dialog>
  );
}
