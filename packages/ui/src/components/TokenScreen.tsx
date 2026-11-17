import { useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { Logo } from './Logo';

export function TokenScreen({ rejected, signedOut = false, onSubmit }: { rejected: boolean; signedOut?: boolean; onSubmit: (token: string) => Promise<boolean> }) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    const ok = await onSubmit(token);
    setBusy(false);
    if (!ok) setValue('');
  };

  const demoHref = (() => {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('mock', '1');
      return u.toString();
    } catch {
      return '?mock=1';
    }
  })();

  return (
    <main className="token-screen">
      <form className="token-card" onSubmit={submit}>
        <Logo />
        <h1 className="token-card__title">{t('token.title')}</h1>
        {signedOut && <p className="signout-note" role="status">{t('signout.app.done')}</p>}
        <p className="muted">{t('token.text')}</p>
        <label className="field">
          <span className="field__label">{t('token.label')}</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={rejected || undefined}
            aria-describedby={rejected ? 'token-error' : undefined}
          />
        </label>
        {rejected && (
          <p id="token-error" className="form-error" role="alert">
            {t('token.invalid')}
          </p>
        )}
        <button className="btn btn--primary" type="submit" disabled={busy || !value.trim()}>
          {t('token.submit')}
        </button>
        <a className="link small" href={demoHref}>{t('token.demo')}</a>
      </form>
    </main>
  );
}
