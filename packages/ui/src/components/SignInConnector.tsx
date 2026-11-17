import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DisconnectMailResponse, OAuthAppStatus, OAuthProviderId } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, formatRelative } from '../lib/format';
import { Dialog } from './Dialog';

const NAMES: Record<OAuthProviderId, string> = { microsoft: 'Microsoft', google: 'Google' };

/**
 * "Sign in with Microsoft / Google": opens the provider's page in the browser; the browser comes
 * back to Sebeto on this computer and the connectors.changed event updates this dialog.
 */
export function SignInConnector({ provider, onClose }: { provider: OAuthProviderId; onClose: () => void }) {
  const { state, dispatch, api } = useStore();
  const { t, locale } = useI18n();
  const [app, setApp] = useState<OAuthAppStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [tenant, setTenant] = useState('');
  const [secret, setSecret] = useState('');
  const [signedOut, setSignedOut] = useState<DisconnectMailResponse | null>(null);
  const started = useRef(false);
  const name = NAMES[provider];

  const reload = useCallback(async () => {
    try {
      const apps = await api.oauthApps();
      const a = apps.find((x) => x.provider === provider) ?? null;
      setApp(a);
      if (a?.source === 'custom') { setClientId(a.clientId ?? ''); setTenant(a.tenant ?? ''); }
      dispatch({ type: 'mailLoaded', status: await api.mailStatus() });
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api, dispatch, provider]);

  useEffect(() => { void reload(); }, [reload, state.connectorsVersion]);

  const mail = state.mail;
  const connectedHere = !!mail?.connected && mail.provider === provider;
  const otherMailbox = mail?.connected && mail.provider !== provider ? mail.address : null;
  useEffect(() => { if (connectedHere) setWaiting(false); }, [connectedHere]);

  const signIn = async () => {
    setBusy(true); setError(null);
    try {
      setSignedOut(null);
      const { authUrl } = await api.startOAuth(provider);
      started.current = true;
      setWaiting(true);
      // Desktop app: opens the default browser; web: a new tab.
      window.open(authUrl, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveApp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      setApp(await api.setOAuthApp(provider, { clientId: clientId.trim(), ...(provider === 'microsoft' ? { tenant: tenant.trim() } : {}), ...(secret ? { clientSecret: secret } : {}) }));
      setSecret('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true); setError(null);
    try {
      setSignedOut(await api.disconnectMail());
      dispatch({ type: 'mailLoaded', status: { connected: false } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const noApp = app?.source === 'none';
  return (
    <Dialog title={t(provider === 'microsoft' ? 'oauth.titleMicrosoft' : 'oauth.titleGoogle')} onClose={onClose}>
      <p className="small muted">{t(provider === 'microsoft' ? 'oauth.introMicrosoft' : 'oauth.introGoogle')}</p>
      {connectedHere && mail?.connected ? (
        <div className="mail-status" role="status">
          <div>
            <strong>{t('mail.connected', { address: mail.address })}</strong>
            <div className="small muted">{t('oauth.mailAndCalendar')} · {t('mail.connectedSince', { when: formatRelative(mail.connectedAt, locale) })}</div>
          </div>
          <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => void disconnect()}>{t('signout.button')}</button>
        </div>
      ) : (
        <>
          {otherMailbox && <p className="trusted__empty">{t('oauth.replaces', { address: otherMailbox })}</p>}
          {noApp ? (
            <p className="mail-error">{t('oauth.noApp', { name })}</p>
          ) : (
            <button type="button" className="btn btn--primary oauth-btn" disabled={busy || !app} onClick={() => void signIn()}>
              {t('oauth.signIn', { name })}
            </button>
          )}
          {waiting && <p className="small" role="status"><span className="pulse" aria-hidden="true" /> {t('oauth.waiting', { name })}</p>}
        </>
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
      <p className="small muted">{t('oauth.privacy')}</p>
      {error && <p className="mail-error" role="alert">{error}</p>}
      <details className="oauth-advanced" open={noApp}>
        <summary className="small">{t('oauth.orgApp')}</summary>
        <form className="mail-form" onSubmit={(e) => void saveApp(e)}>
          <p className="small muted">{t(provider === 'microsoft' ? 'oauth.orgAppHelpMicrosoft' : 'oauth.orgAppHelpGoogle')}</p>
          <label className="field">
            <span className="field__label">{t('oauth.clientId')}</span>
            <input className="input cx__mono" value={clientId} onChange={(e) => setClientId(e.target.value)}
              placeholder={provider === 'microsoft' ? '00000000-0000-0000-0000-000000000000' : '1234-abc.apps.googleusercontent.com'} />
          </label>
          {provider === 'microsoft' ? (
            <label className="field">
              <span className="field__label">{t('oauth.tenant')}</span>
              <input className="input cx__mono" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="common / contoso.onmicrosoft.com" />
            </label>
          ) : (
            <label className="field">
              <span className="field__label">{t('oauth.clientSecret')}</span>
              <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={app?.hasSecret ? '••••••••' : 'GOCSPX-…'} />
            </label>
          )}
          <p className="small muted">
            {app?.source === 'custom' ? t('oauth.usingOrg', { id: app.clientId ?? '' }) : app?.source === 'builtin' ? t('oauth.usingBuiltin') : ''}
          </p>
          <div className="row">
            <button type="submit" className="btn btn--outline btn--sm" disabled={busy || !clientId.trim()}>{t('oauth.saveApp')}</button>
            {app?.source === 'custom' && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setClientId(''); void api.setOAuthApp(provider, { clientId: '' }).then(setApp, (e) => setError(errorMessage(e))); }}>
                {t('oauth.removeApp')}
              </button>
            )}
          </div>
        </form>
      </details>
    </Dialog>
  );
}
