import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  SECURITY_CATEGORIES, SECURITY_SEVERITIES,
  type SecurityCategory, type SecurityEvent, type SecuritySettings, type SecuritySeverity, type SecuritySummary, type SecurityVerifyResult,
} from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage } from '../lib/format';
import {
  EMPTY_FILTERS, RETENTION_CHOICES, TIME_RANGES, filtersActive, saveBlob, toQuery, type SecurityFilters, type TimeRange,
} from '../lib/security';
import { Dialog } from './Dialog';
import { HeaderActions } from './HeaderActions';

const SEV_KEY: Record<SecuritySeverity, MessageKey> = { info: 'sec.sev.info', notice: 'sec.sev.notice', warning: 'sec.sev.warning', critical: 'sec.sev.critical' };
const CAT_KEY: Record<SecurityCategory, MessageKey> = {
  auth: 'sec.cat.auth', agent: 'sec.cat.agent', permission: 'sec.cat.permission', tool: 'sec.cat.tool', session: 'sec.cat.session',
  ticket: 'sec.cat.ticket', config: 'sec.cat.config', connector: 'sec.cat.connector', trigger: 'sec.cat.trigger', system: 'sec.cat.system',
};
const RANGE_KEY: Record<TimeRange, MessageKey> = {
  '1h': 'sec.filters.range.1h', '24h': 'sec.filters.range.24h', '7d': 'sec.filters.range.7d', '30d': 'sec.filters.range.30d', all: 'sec.filters.range.all',
};

function useDateTime() {
  const { locale } = useI18n();
  return useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return (iso: string) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? iso : fmt.format(d);
    };
  }, [locale]);
}

export function SeverityBadge({ severity }: { severity: SecuritySeverity }) {
  const { t } = useI18n();
  return <span className={`sec-sev sec-sev--${severity}`}>{t(SEV_KEY[severity])}</span>;
}

/** The Security page (docs/28 v0.4 Plan.md §B): summary, timeline, verify, export, settings, emergency stop. */
export function SecurityPage({ onMenu }: { onMenu: () => void }) {
  const { state, api, actions } = useStore();
  const { t } = useI18n();
  const fmt = useDateTime();
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [filters, setFilters] = useState<SecurityFilters>(EMPTY_FILTERS);
  const [items, setItems] = useState<SecurityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<SecurityEvent | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [fresh, setFresh] = useState(false);
  const pagedRef = useRef(false);
  const agents = useMemo(() => Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name)), [state.agents]);
  const agentName = (id: string | null) => (id ? state.agents[id]?.name ?? null : null);

  const load = useCallback(async (f: SecurityFilters) => {
    setLoading(true);
    try {
      const page = await api.listSecurityEvents(toQuery(f));
      setItems(page.items);
      setCursor(page.nextCursor);
      pagedRef.current = false;
      setFresh(false);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadSummary = useCallback(() => {
    api.securitySummary(24).then(setSummary, (e) => setError(errorMessage(e)));
  }, [api]);

  // Reload when filters change (text search waits for typing to pause).
  useEffect(() => {
    const h = setTimeout(() => void load(filters), filters.q || filters.ticket ? 300 : 0);
    return () => clearTimeout(h);
  }, [filters, load]);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  // Live: new events refresh the summary; the list refreshes itself unless the user paged back.
  const version = state.versions['security.event'] ?? 0;
  useEffect(() => {
    if (!version) return;
    const h = setTimeout(() => {
      loadSummary();
      if (pagedRef.current) setFresh(true);
      else void load(filters);
    }, 800);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const more = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await api.listSecurityEvents({ ...toQuery(filters), cursor });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      pagedRef.current = true;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const set = <K extends keyof SecurityFilters>(k: K, v: SecurityFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const openTicket = (ticketId: string) => {
    setSelected(null);
    actions.select(ticketId);
  };

  const warnings = summary ? summary.bySeverity.warning : 0;
  const critical = summary ? summary.bySeverity.critical : 0;

  return (
    <div className="sec">
      <header className="header">
        <button type="button" className="icon-btn header__menu" onClick={onMenu} aria-label={t('header.menu')}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="header__text">
          <h1 className="header__title">{t('sec.title')}</h1>
          <p className="header__summary">{t('sec.summary')}</p>
        </div>
        <button type="button" className="btn sec-stop-btn" onClick={() => setStopOpen(true)} title={t('sec.stop.hint')} disabled={state.lockdown}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg>
          {t('sec.stop.button')}
        </button>
        <HeaderActions />
      </header>

      <div className="sec-body">
        {error && <p className="sec-error" role="alert">{error}</p>}
        {notice && <p className="sec-notice" role="status">{notice}</p>}

        <section aria-labelledby="sec-tiles-h">
          <h2 id="sec-tiles-h" className="section-label">{t('sec.tiles.heading')}</h2>
          <div className="sec-tiles">
            <button type="button" className="sec-tile" onClick={() => setFilters({ ...EMPTY_FILTERS, range: '24h' })}>
              <span className="sec-tile__n">{summary?.total ?? '–'}</span>
              <span className="sec-tile__label">{t('sec.tiles.total')}</span>
            </button>
            <button type="button" className={`sec-tile${warnings ? ' sec-tile--warn' : ''}`} onClick={() => setFilters({ ...EMPTY_FILTERS, range: '24h', severity: 'warning,critical' })}>
              <span className="sec-tile__n">{summary ? warnings : '–'}</span>
              <span className="sec-tile__label">{t('sec.tiles.warnings')}</span>
            </button>
            <button type="button" className={`sec-tile${critical ? ' sec-tile--crit' : ''}`} onClick={() => setFilters({ ...EMPTY_FILTERS, range: '24h', severity: 'critical' })}>
              <span className="sec-tile__n">{summary ? critical : '–'}</span>
              <span className="sec-tile__label">{t('sec.tiles.critical')}</span>
            </button>
            <button type="button" className={`sec-tile${summary?.deniedPermissions ? ' sec-tile--warn' : ''}`} onClick={() => setFilters({ ...EMPTY_FILTERS, range: '24h', q: 'permission.denied' })}>
              <span className="sec-tile__n">{summary?.deniedPermissions ?? '–'}</span>
              <span className="sec-tile__label">{t('sec.tiles.denied')}</span>
            </button>
            <button type="button" className="sec-tile" title={t('sec.tiles.untrustedHint')} onClick={() => setFilters({ ...EMPTY_FILTERS, range: '24h', category: 'tool', q: '"untrusted":true' })}>
              <span className="sec-tile__n">{summary?.untrustedReads ?? '–'}</span>
              <span className="sec-tile__label">{t('sec.tiles.untrusted')}</span>
            </button>
            <button type="button" className={`sec-tile${summary?.rejectedTriggers ? ' sec-tile--warn' : ''}`} onClick={() => setFilters({ ...EMPTY_FILTERS, range: '24h', q: 'trigger.rejected' })}>
              <span className="sec-tile__n">{summary?.rejectedTriggers ?? '–'}</span>
              <span className="sec-tile__label">{t('sec.tiles.rejected')}</span>
            </button>
            <div className="sec-tile sec-tile--wide">
              <span className="sec-tile__label">{t('sec.tiles.active')}</span>
              {summary && summary.activeAgents.length > 0 ? (
                <ol className="sec-top">
                  {summary.activeAgents.map((a) => (
                    <li key={a.agentId}>
                      <button type="button" className="sec-link" onClick={() => setFilters({ ...EMPTY_FILTERS, range: '24h', agentId: a.agentId })}>{a.name}</button>
                      <span className="muted small">{a.events}</span>
                    </li>
                  ))}
                </ol>
              ) : <span className="muted small">{t('sec.tiles.noAgents')}</span>}
            </div>
          </div>
        </section>

        <section aria-labelledby="sec-filters-h" className="sec-filters">
          <h2 id="sec-filters-h" className="sr-only">{t('sec.filters.heading')}</h2>
          <label className="field">
            <span className="field__label">{t('sec.filters.range')}</span>
            <select className="input input--sm" value={filters.range} onChange={(e) => set('range', e.target.value as TimeRange)}>
              {TIME_RANGES.map((r) => <option key={r} value={r}>{t(RANGE_KEY[r])}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('sec.filters.category')}</span>
            <select className="input input--sm" value={filters.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">{t('sec.filters.any')}</option>
              {SECURITY_CATEGORIES.map((c) => <option key={c} value={c}>{t(CAT_KEY[c])}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('sec.filters.severity')}</span>
            <select className="input input--sm" value={filters.severity} onChange={(e) => set('severity', e.target.value)}>
              <option value="">{t('sec.filters.any')}</option>
              <option value="warning,critical">{t('sec.filters.atLeastWarning')}</option>
              {SECURITY_SEVERITIES.map((s) => <option key={s} value={s}>{t(SEV_KEY[s])}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t('sec.filters.agent')}</span>
            <select className="input input--sm" value={filters.agentId} onChange={(e) => set('agentId', e.target.value)}>
              <option value="">{t('sec.filters.any')}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="field sec-filters__ticket">
            <span className="field__label">{t('sec.filters.ticket')}</span>
            <input className="input input--sm" value={filters.ticket} onChange={(e) => set('ticket', e.target.value)} placeholder="T-12" inputMode="numeric" />
          </label>
          <label className="field sec-filters__q">
            <span className="field__label">{t('sec.filters.text')}</span>
            <input className="input input--sm" type="search" value={filters.q} onChange={(e) => set('q', e.target.value)} placeholder={t('sec.filters.textPlaceholder')} />
          </label>
          {filtersActive(filters) && (
            <button type="button" className="btn btn--ghost btn--sm sec-filters__reset" onClick={() => setFilters(EMPTY_FILTERS)}>{t('sec.filters.reset')}</button>
          )}
        </section>

        {fresh && (
          <button type="button" className="btn btn--outline btn--sm sec-fresh" onClick={() => void load(filters)}>{t('sec.newEvents')}</button>
        )}

        <div className="sec-table-wrap">
          <table className="sec-table">
            <thead>
              <tr>
                <th scope="col">{t('sec.col.time')}</th>
                <th scope="col">{t('sec.col.severity')}</th>
                <th scope="col">{t('sec.col.category')}</th>
                <th scope="col">{t('sec.col.actor')}</th>
                <th scope="col">{t('sec.col.summary')}</th>
                <th scope="col">{t('sec.col.ticket')}</th>
                <th scope="col">{t('sec.col.agent')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className={`sec-row sec-row--${e.severity}`} onClick={() => setSelected(e)}>
                  <td className="sec-time"><time dateTime={e.at}>{fmt(e.at)}</time></td>
                  <td><SeverityBadge severity={e.severity} /></td>
                  <td className="small">{t(CAT_KEY[e.category] ?? 'sec.cat.system')}</td>
                  <td className="small">{actorLabel(e, t)}</td>
                  <td className="sec-summary">
                    <button type="button" className="sec-link sec-summary__btn" onClick={(ev) => { ev.stopPropagation(); setSelected(e); }}>{e.summary}</button>
                    <span className="sec-action">{e.action}</span>
                  </td>
                  <td>
                    {e.ticketId && e.ticketNumber !== null ? (
                      <button type="button" className="sec-link" onClick={(ev) => { ev.stopPropagation(); openTicket(e.ticketId!); }}>T-{e.ticketNumber}</button>
                    ) : null}
                  </td>
                  <td className="small">{agentName(e.agentId) ?? (e.agentId ? '—' : '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && <p className="sec-empty muted">{t('sec.empty')}</p>}
          {loading && <p className="sec-empty muted" role="status">{t('sec.loading')}</p>}
          {cursor && !loading && (
            <button type="button" className="btn btn--outline btn--sm sec-more" onClick={() => void more()}>{t('sec.more')}</button>
          )}
        </div>

        <div className="sec-cards">
          <VerifyExport onNotice={setNotice} onError={setError} />
          <SecuritySettingsCard onNotice={setNotice} onError={setError} />
        </div>
      </div>

      {selected && <EventDrawer event={selected} onClose={() => setSelected(null)} onOpenTicket={openTicket} fmt={fmt} agentName={agentName(selected.agentId)} />}
      {stopOpen && <EmergencyStopDialog onClose={() => setStopOpen(false)} onDone={(msg) => { setNotice(msg); loadSummary(); void load(filters); }} />}
    </div>
  );
}

function actorLabel(e: SecurityEvent, t: (k: MessageKey) => string): string {
  if (e.actor.type === 'user') return t('sec.actor.user');
  if (e.actor.type === 'system' && e.actor.name === 'Sebeto') return t('sec.actor.system');
  return e.actor.name;
}

function EventDrawer({ event, onClose, onOpenTicket, fmt, agentName }: {
  event: SecurityEvent; onClose: () => void; onOpenTicket: (id: string) => void; fmt: (iso: string) => string; agentName: string | null;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const ids: Array<[string, string | null]> = [
    ['ticket', event.ticketId], ['agent', event.agentId], ['session', event.sessionId], ['run', event.runId], ['event', event.id],
  ];
  return (
    <>
      <div className="sec-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="sec-drawer" role="dialog" aria-modal="true" aria-labelledby="sec-drawer-title">
        <header className="sec-drawer__head">
          <h2 id="sec-drawer-title" className="dialog__title">{t('sec.detail.title', { seq: event.seq })}</h2>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label={t('sec.detail.close')}><span aria-hidden="true">×</span></button>
        </header>
        <div className="sec-drawer__body">
          <p className="sec-drawer__summary"><SeverityBadge severity={event.severity} /> {event.summary}</p>
          <dl className="sec-dl">
            <dt>{t('sec.detail.when')}</dt><dd><time dateTime={event.at}>{fmt(event.at)}</time> <span className="muted small">({event.at})</span></dd>
            <dt>{t('sec.detail.action')}</dt><dd><code>{event.action}</code></dd>
            <dt>{t('sec.detail.actor')}</dt><dd>{actorLabel(event, t)} <span className="muted small">({event.actor.type}{event.actor.id ? ` · ${event.actor.id}` : ''})</span></dd>
            {agentName && (<><dt>{t('sec.col.agent')}</dt><dd>{agentName}</dd></>)}
            <dt>{t('sec.detail.ids')}</dt>
            <dd>
              <ul className="sec-ids">
                {ids.filter(([, v]) => v).map(([k, v]) => <li key={k}><span className="muted small">{k}</span> <code>{v}</code></li>)}
              </ul>
            </dd>
          </dl>
          {event.ticketId && event.ticketNumber !== null && (
            <button type="button" className="btn btn--outline btn--sm" onClick={() => onOpenTicket(event.ticketId!)}>{t('sec.detail.openTicket', { number: event.ticketNumber })}</button>
          )}
          <h3 className="section-label">{t('sec.detail.data')}</h3>
          {event.data ? <pre className="sec-pre">{JSON.stringify(event.data, null, 2)}</pre> : <p className="muted small">{t('sec.detail.noData')}</p>}
          <h3 className="section-label">{t('sec.detail.hash')}</h3>
          <code className="sec-hash">{event.hash}</code>
          <h3 className="section-label">{t('sec.detail.prevHash')}</h3>
          <code className="sec-hash">{event.prevHash}</code>
          <p className="muted small">{t('sec.detail.hashHint')}</p>
        </div>
      </aside>
    </>
  );
}

function VerifyExport({ onNotice, onError }: { onNotice: (s: string) => void; onError: (s: string) => void }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [busy, setBusy] = useState<'verify' | 'jsonl' | 'csv' | null>(null);
  const [result, setResult] = useState<SecurityVerifyResult | null>(null);

  const verify = async () => {
    setBusy('verify');
    try { setResult(await api.verifySecurityLog()); } catch (e) { onError(errorMessage(e)); } finally { setBusy(null); }
  };
  const exportAs = async (format: 'jsonl' | 'csv') => {
    setBusy(format);
    try {
      const { fileName, blob } = await api.exportSecurityLog(format);
      saveBlob(blob, fileName);
      onNotice(t('sec.export.done', { file: fileName }));
    } catch (e) { onError(errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <section className="sec-card" aria-labelledby="sec-tools-h">
      <h2 id="sec-tools-h" className="sec-card__title">{t('sec.tools.heading')}</h2>
      <div className="sec-card__row">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void verify()} disabled={busy !== null}>
          {busy === 'verify' ? t('sec.verify.running') : t('sec.verify.button')}
        </button>
      </div>
      {result && (
        <p className={`sec-verify ${result.ok ? 'sec-verify--ok' : 'sec-verify--bad'}`} role="status">
          {result.ok
            ? (result.checked ? t('sec.verify.ok', { checked: result.checked }) : t('sec.verify.okEmpty'))
            : t('sec.verify.broken', { seq: result.brokenAtSeq ?? '?', problem: result.problem ?? '' })}
        </p>
      )}
      <div className="sec-card__row">
        <button type="button" className="btn btn--outline btn--sm" onClick={() => void exportAs('jsonl')} disabled={busy !== null}>{t('sec.export.jsonl')}</button>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => void exportAs('csv')} disabled={busy !== null}>{t('sec.export.csv')}</button>
      </div>
      <p className="muted small">{t('sec.export.hint')}</p>
    </section>
  );
}

function SecuritySettingsCard({ onNotice, onError }: { onNotice: (s: string) => void; onError: (s: string) => void }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.getSecuritySettings().then(setSettings, (e) => onError(errorMessage(e))); }, [api, onError]);
  if (!settings) return null;
  const choices = RETENTION_CHOICES.includes(settings.retentionDays) ? RETENTION_CHOICES : [...RETENTION_CHOICES, settings.retentionDays].sort((a, b) => a - b);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      setSettings(await api.updateSecuritySettings(settings));
      onNotice(t('sec.settings.saved'));
    } catch (err) { onError(errorMessage(err)); } finally { setSaving(false); }
  };

  return (
    <form className="sec-card" aria-labelledby="sec-settings-h" onSubmit={(e) => void save(e)}>
      <h2 id="sec-settings-h" className="sec-card__title">{t('sec.settings.heading')}</h2>
      <label className="field">
        <span className="field__label">{t('sec.settings.retention')}</span>
        <select className="input input--sm" value={settings.retentionDays} onChange={(e) => setSettings({ ...settings, retentionDays: Number(e.target.value) })}>
          {choices.map((d) => <option key={d} value={d}>{d === 0 ? t('sec.settings.retention.forever') : t('sec.settings.retention.days', { days: d })}</option>)}
        </select>
        <span className="muted small">{t('sec.settings.retentionHint')}</span>
      </label>
      <label className="sec-check">
        <input type="checkbox" checked={settings.jsonlMirror} onChange={(e) => setSettings({ ...settings, jsonlMirror: e.target.checked })} />
        <span>{t('sec.settings.mirror')}</span>
      </label>
      <div className="sec-card__row">
        <button type="submit" className="btn btn--primary btn--sm" disabled={saving}>{t('sec.settings.save')}</button>
      </div>
    </form>
  );
}

export function EmergencyStopDialog({ onClose, onDone }: { onClose: () => void; onDone?: (message: string) => void }) {
  const { api, dispatch } = useStore();
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = reason.trim().length >= 3;

  const stop = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.emergencyStop({ reason: reason.trim() });
      dispatch({ type: 'setLockdown', active: true });
      onDone?.(t('sec.stop.done', { runs: r.cancelledRuns, agents: r.pausedAgents, triggers: r.disabledTriggers }));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('sec.stop.title')} onClose={onClose}>
      <form className="sec-stop" onSubmit={(e) => void stop(e)}>
        <p>{t('sec.stop.explain')}</p>
        <ul className="sec-stop__list">
          <li>{t('sec.stop.step1')}</li>
          <li>{t('sec.stop.step2')}</li>
          <li>{t('sec.stop.step3')}</li>
        </ul>
        <p className="muted small">{t('sec.stop.after')}</p>
        <label className="field">
          <span className="field__label">{t('sec.stop.reason')}</span>
          <textarea className="input sec-stop__reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('sec.stop.reasonPlaceholder')} maxLength={500} rows={3} required autoFocus />
        </label>
        {error && <p className="sec-error" role="alert">{error}</p>}
        <div className="sec-stop__actions">
          <button type="button" className="btn btn--outline" onClick={onClose} disabled={busy}>{t('sec.stop.cancel')}</button>
          <button type="submit" className="btn sec-stop-btn" disabled={!ok || busy}>{busy ? t('sec.stop.stopping') : t('sec.stop.confirm')}</button>
        </div>
      </form>
    </Dialog>
  );
}
