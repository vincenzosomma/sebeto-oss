import { useCallback, useEffect, useState } from 'react';
import type { BackupEstimate, BackupInfo, BackupListResponse, BackupVerifyResult } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, formatRelative } from '../lib/format';
import { formatBytes, passphraseProblem, restoreCommands, suggestedTarget } from '../lib/backups';
import { Dialog } from './Dialog';

function saveBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyLine({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable: the text can still be selected */ }
  };
  return (
    <div className="bk-cmd">
      <code className="bk-cmd__text">{text}</code>
      <button type="button" className="btn btn--outline btn--sm" onClick={() => void copy()}>{copied ? t('bk.restore.copied') : t('bk.restore.copy')}</button>
    </div>
  );
}

/**
 * Settings → Backups (v0.7 Q): back up now (ticket folders and encrypted secrets optional), the daily
 * automatic backup, the list with download / verify / delete, and how to restore (always into a NEW
 * workspace folder, with the command line tool).
 */
export function Backups({ onClose }: { onClose: () => void }) {
  const { api } = useStore();
  const { t, locale } = useI18n();
  const [data, setData] = useState<BackupListResponse | null>(null);
  const [estimate, setEstimate] = useState<BackupEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // back up now
  const [withTickets, setWithTickets] = useState(false);
  const [withSecrets, setWithSecrets] = useState(false);
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [running, setRunning] = useState(false);
  // automatic
  const [autoOn, setAutoOn] = useState(true);
  const [autoTime, setAutoTime] = useState('12:30');
  const [keep, setKeep] = useState(7);
  const [dir, setDir] = useState('');
  const [saved, setSaved] = useState(false);
  // list
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, BackupVerifyResult>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [restoreOf, setRestoreOf] = useState<BackupInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.listBackups();
      setData(d);
      return d;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    void load().then((d) => {
      if (!alive || !d) return;
      setAutoOn(d.settings.autoEnabled);
      setAutoTime(d.settings.autoTime);
      setKeep(d.settings.keep);
      setDir(d.settings.dir ?? '');
    });
    api.backupEstimate().then((e) => { if (alive) setEstimate(e); }, () => undefined);
    return () => { alive = false; };
  }, [api, load]);

  const problem = withSecrets ? passphraseProblem(pass, confirm) : null;

  const backUpNow = async () => {
    if (problem) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const info = await api.createBackup({ includeTickets: withTickets, ...(withSecrets ? { passphrase: pass } : {}) });
      setPass('');
      setConfirm('');
      const done = t('bk.now.done', { name: info.name, size: formatBytes(info.sizeBytes, locale) });
      setNotice(info.secretsSkipped ? `${done} ${t('bk.now.skipped', { count: info.secretsSkipped })}` : done);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const saveSettings = async () => {
    setError(null);
    setSaved(false);
    try {
      const s = await api.updateBackupSettings({ autoEnabled: autoOn, autoTime, keep, dir: dir.trim() === '' ? null : dir.trim() });
      setDir(s.dir ?? '');
      setSaved(true);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const download = async (name: string) => {
    setError(null);
    try {
      const { fileName, blob } = await api.downloadBackup(name);
      saveBlob(fileName, blob);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const verify = async (name: string) => {
    setVerifying(name);
    setError(null);
    try {
      const r = await api.verifyBackup(name);
      setVerified((v) => ({ ...v, [name]: r }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setVerifying(null);
    }
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      await api.deleteBackup(name);
      setConfirmDelete(null);
      if (restoreOf?.name === name) setRestoreOf(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const last = data?.lastAuto ?? null;
  const restoreTarget = restoreOf && data ? suggestedTarget(data.dir, restoreOf.name) : '';
  const restoreHasSecrets = restoreOf ? verified[restoreOf.name]?.includesSecrets === true : false;

  return (
    <Dialog title={t('bk.title')} onClose={onClose} wide>
      <p className="small">{t('bk.intro')}</p>
      {data && <p className="small muted bk-dir">{t('bk.where', { dir: data.dir })}</p>}
      {error && <p className="dg-error small" role="alert">{t('bk.error', { message: error })}</p>}

      <section className="bk-section" aria-labelledby="bk-now">
        <h3 id="bk-now" className="section-label">{t('bk.now.heading')}</h3>
        <label className="check">
          <input type="checkbox" checked={withTickets} onChange={(e) => setWithTickets(e.target.checked)} />
          <span>{estimate ? t('bk.now.tickets', { size: formatBytes(estimate.ticketsBytes, locale), count: estimate.ticketFolders }) : t('bk.now.ticketsLoading')}</span>
        </label>
        <p className="small muted bk-hint">{t('bk.now.ticketsHint')}</p>
        <label className="check">
          <input type="checkbox" checked={withSecrets} onChange={(e) => setWithSecrets(e.target.checked)} />
          <span>{t('bk.now.secrets', { count: estimate?.secrets ?? 0 })}</span>
        </label>
        <p className="small muted bk-hint">{t('bk.now.secretsHint')}</p>
        {withSecrets && (
          <div className="bk-pass">
            <label className="field">
              <span className="field__label">{t('bk.now.pass')}</span>
              <input className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">{t('bk.now.confirm')}</span>
              <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            {pass !== '' && problem && <p className="small bk-warn" role="status">{t(problem === 'short' ? 'bk.now.short' : 'bk.now.mismatch')}</p>}
          </div>
        )}
        <div className="dg-actions">
          {notice && <span className="small bk-ok" role="status">{notice}</span>}
          <button type="button" className="btn btn--primary" onClick={() => void backUpNow()} disabled={running || problem !== null || data?.running === true}>
            {running ? t('bk.now.running') : t('bk.now.button')}
          </button>
        </div>
      </section>

      <section className="bk-section" aria-labelledby="bk-auto">
        <h3 id="bk-auto" className="section-label">{t('bk.auto.heading')}</h3>
        <label className="check">
          <input type="checkbox" checked={autoOn} onChange={(e) => { setAutoOn(e.target.checked); setSaved(false); }} />
          <span>{t('bk.auto.on')}</span>
        </label>
        <div className="bk-row">
          <label className="field">
            <span className="field__label">{t('bk.auto.time')}</span>
            <input className="input input--sm" type="time" value={autoTime} disabled={!autoOn} onChange={(e) => { setAutoTime(e.target.value); setSaved(false); }} />
          </label>
          <label className="field">
            <span className="field__label">{t('bk.auto.keep')}</span>
            <span className="bk-keep">
              <input className="input input--sm" type="number" min={1} max={365} value={keep} onChange={(e) => { setKeep(Math.max(1, Math.min(365, Number(e.target.value) || 1))); setSaved(false); }} />
              <span className="small muted">{t('bk.auto.keepUnit')}</span>
            </span>
          </label>
        </div>
        <label className="field">
          <span className="field__label">{t('bk.dir.label')}</span>
          <input className="input" type="text" spellCheck={false} placeholder={t('bk.dir.default')} value={dir} onChange={(e) => { setDir(e.target.value); setSaved(false); }} />
          <span className="small muted">{t('bk.dir.hint')}</span>
        </label>
        <p className="small muted bk-note">{t('bk.auto.hint')}</p>
        <p className="small muted" role="status">
          {last === null ? t('bk.auto.never')
            : last.ok ? t('bk.auto.last', { when: formatRelative(last.at, locale) })
              : t('bk.auto.lastFailed', { when: formatRelative(last.at, locale), message: last.message ?? '' })}
        </p>
        <div className="dg-actions">
          {saved && <span className="small bk-ok" role="status">{t('bk.auto.saved')}</span>}
          <button type="button" className="btn btn--outline" onClick={() => void saveSettings()}>{t('bk.auto.save')}</button>
        </div>
      </section>

      <section className="bk-section" aria-labelledby="bk-list">
        <h3 id="bk-list" className="section-label">{t('bk.list.heading')}</h3>
        {data === null ? (
          <p className="small muted" role="status">{t('panel.loading')}</p>
        ) : data.items.length === 0 ? (
          <p className="small muted">{t('bk.list.empty')}</p>
        ) : (
          <ul className="bk-list">
            {data.items.map((b) => {
              const v = verified[b.name];
              return (
                <li key={b.name} className="bk-item">
                  <div className="bk-item__head">
                    <div className="bk-item__text">
                      <code className="bk-item__name">{b.name}</code>
                      <span className="small muted">
                        <span className={`chip ${b.kind === 'auto' ? 'bk-chip--auto' : 'chip--tuff'}`}>{t(b.kind === 'auto' ? 'bk.list.auto' : 'bk.list.manual')}</span>{' '}
                        {t('bk.list.meta', { size: formatBytes(b.sizeBytes, locale), when: formatRelative(b.createdAt, locale) })}
                      </span>
                    </div>
                    <div className="bk-item__actions">
                      <button type="button" className="btn btn--outline btn--sm" onClick={() => void download(b.name)}>{t('bk.list.download')}</button>
                      <button type="button" className="btn btn--outline btn--sm" onClick={() => void verify(b.name)} disabled={verifying !== null}>
                        {verifying === b.name ? t('bk.list.verifying') : t('bk.list.verify')}
                      </button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRestoreOf(restoreOf?.name === b.name ? null : b)} aria-expanded={restoreOf?.name === b.name}>
                        {t('bk.list.restore')}
                      </button>
                      <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmDelete(b.name)}>{t('bk.list.delete')}</button>
                    </div>
                  </div>
                  {confirmDelete === b.name && (
                    <div className="bk-confirm" role="alertdialog" aria-label={t('bk.list.confirmDelete', { name: b.name })}>
                      <span className="small">{t('bk.list.confirmDelete', { name: b.name })}</span>
                      <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove(b.name)}>{t('bk.list.confirmYes')}</button>
                      <button type="button" className="btn btn--outline btn--sm" onClick={() => setConfirmDelete(null)}>{t('bk.list.cancel')}</button>
                    </div>
                  )}
                  {v && (v.ok ? (
                    <p className="small bk-ok" role="status">
                      {t('bk.verify.ok', { files: v.files, schema: v.schemaVersion ?? '?' })}{v.includesSecrets ? ` ${t('bk.verify.secrets')}` : ''}
                    </p>
                  ) : (
                    <div className="dg-error small" role="alert">
                      <p className="bk-tight">{t('bk.verify.bad')}</p>
                      <ul className="bk-problems">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul>
                    </div>
                  ))}
                  {restoreOf?.name === b.name && data && (
                    <div className="bk-restore">
                      <h4 className="bk-restore__title">{t('bk.restore.heading', { name: b.name })}</h4>
                      <p className="small">{t('bk.restore.intro')}</p>
                      <p className="small">{t('bk.restore.step1')}</p>
                      <CopyLine text={restoreCommands(data.dir, b.name, restoreTarget, restoreHasSecrets)[0]!} />
                      <p className="small">{t('bk.restore.step2')}</p>
                      <CopyLine text={restoreCommands(data.dir, b.name, restoreTarget, restoreHasSecrets)[1]!} />
                      <p className="small muted">{t('bk.restore.desktop')}</p>
                      <p className="small muted">{t('bk.restore.secrets')}</p>
                      <p className="small muted">{t('bk.restore.check')}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Dialog>
  );
}
