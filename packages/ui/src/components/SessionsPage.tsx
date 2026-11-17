import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  SUGGEST_DEFAULT_COST_USD, SUGGEST_MAX_COST_USD,
  type CategorySuggestion, type Id, type SessionCategoryCount, type SessionEntry, type SessionSource, type SessionTranscript,
  type SuggestCategoriesMode, type SuggestCategoriesResult,
} from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage, formatCost, formatRelative } from '../lib/format';
import { Dialog } from './Dialog';
import { TagEditor } from './Projects';
import { HeaderActions } from './HeaderActions';

const PAGE = 30;
const ROLE_KEY: Record<SessionTranscript['turns'][number]['role'], MessageKey> = {
  user: 'ss.role.user', agent: 'ss.role.agent', tool: 'ss.role.tool', system: 'ss.role.system',
};

/** The Sessions page (v0.4 §A): the session library with search, categories, scan, preview and open. */
export function SessionsPage({ onMenu }: { onMenu: () => void }) {
  const { state, api, dispatch, actions } = useStore();
  const { t, locale } = useI18n();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [source, setSource] = useState<SessionSource | ''>('');
  const [items, setItems] = useState<SessionEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cats, setCats] = useState<SessionCategoryCount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<Id | null>(null);
  const [preview, setPreview] = useState<SessionEntry | null>(null);
  const [editing, setEditing] = useState<SessionEntry | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Id | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const version = state.versions['sessions.changed'] ?? 0;

  // Search as you type, with a short pause.
  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const filters = { ...(query ? { q: query } : {}), ...(category !== null ? { category: category === '' ? '-' : category } : {}), ...(source ? { source } : {}) };
  const filterKey = JSON.stringify(filters);
  const load = useCallback(async (more: string | null) => {
    try {
      const page = await api.listSessions({ ...JSON.parse(filterKey), limit: PAGE, ...(more ? { cursor: more } : {}) });
      setItems((cur) => (more && cur ? [...cur, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api, filterKey]);

  useEffect(() => { void load(null); }, [load, version]);
  useEffect(() => { api.sessionCategories().then(setCats, () => setCats([])); }, [api, version]);

  const total = cats.reduce((n, c) => n + c.count, 0);

  const scan = async () => {
    setScanning(true); setError(null); setNotice(null);
    try {
      const r = await api.scanSessions();
      setNotice(r.found ? t('ss.scan.result', { found: r.found, added: r.added, updated: r.updated }) : t('ss.scan.none'));
      void load(null);
      api.sessionCategories().then(setCats, () => undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };

  const replace = (e: SessionEntry) => setItems((cur) => cur?.map((x) => (x.id === e.id ? e : x)) ?? cur);

  const togglePin = async (e: SessionEntry) => {
    setError(null);
    try { replace(await api.updateSession(e.id, { pinned: !e.pinned })); } catch (err) { setError(errorMessage(err)); }
  };

  const open = async (e: SessionEntry) => {
    setBusyId(e.id); setError(null); setNotice(null);
    try {
      const res = await api.openSession(e.id);
      dispatch({ type: 'ticketUpserted', ticket: res.ticket });
      if (res.action === 'existing') {
        goToTicket(res.ticket.id);
        return;
      }
      setNotice(t(res.action === 'created' ? 'ss.open.created' : 'ss.open.reopened', { number: res.ticket.number }));
      void load(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const goToTicket = (ticketId: Id) => {
    dispatch({ type: 'setPage', page: 'board' });
    actions.select(ticketId);
  };

  const remove = async (id: Id) => {
    setError(null);
    try {
      await api.deleteSession(id);
      setConfirmRemove(null);
      setItems((cur) => cur?.filter((x) => x.id !== id) ?? cur);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const catLabel = (c: string) => (c ? c : t('ss.cat.none'));

  return (
    <div className="ss">
      <header className="header">
        <button type="button" className="icon-btn header__menu" onClick={onMenu} aria-label={t('header.menu')}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="header__text">
          <h1 className="header__title">{t('ss.title')}</h1>
          <p className="header__summary">{t('ss.summary', { count: total })}</p>
        </div>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => setSuggesting(true)} title={t('ss.suggest.intro')}>
          {t('ss.suggest')}
        </button>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void scan()} disabled={scanning} title={t('ss.scan.hint')}>
          {scanning ? t('ss.scanning') : t('ss.scan')}
        </button>
        <HeaderActions />
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setError(null)}>{t('error.dismiss')}</button>
        </div>
      )}
      <div className="ss-body">
        <p className="small muted">{t('ss.intro')} {t('ss.scan.hint')}</p>
        {notice && <p className="ss-toast" role="status">{notice}<button type="button" className="tg__x" aria-label={t('dialog.close')} onClick={() => setNotice(null)}>×</button></p>}
        <div className="ss-filters">
          <label className="ss-search">
            <span className="sr-only">{t('ss.search.label')}</span>
            <input className="input" type="search" value={q} placeholder={t('ss.search.placeholder')} aria-label={t('ss.search.label')} onChange={(e) => setQ(e.target.value)} />
          </label>
          <label className="ss-source">
            <span className="sr-only">{t('ss.source.label')}</span>
            <select className="input" value={source} aria-label={t('ss.source.label')} onChange={(e) => setSource(e.target.value as SessionSource | '')}>
              <option value="">{t('ss.source.all')}</option>
              <option value="sebeto">{t('ss.source.sebeto')}</option>
              <option value="claude-code">{t('ss.source.claude')}</option>
            </select>
          </label>
        </div>
        <ul className="tg-cloud ss-cats" aria-label={t('ss.cat.label')}>
          <li>
            <button type="button" className={`tg${category === null ? ' tg--active' : ''}`} aria-pressed={category === null} onClick={() => setCategory(null)}>
              {t('ss.cat.all')} <span className="tg__n">{total}</span>
            </button>
          </li>
          {cats.map((c) => (
            <li key={c.category || '-'}>
              <button type="button" className={`tg${category === c.category ? ' tg--active' : ''}`} aria-pressed={category === c.category}
                onClick={() => setCategory(category === c.category ? null : c.category)}>
                {catLabel(c.category)} <span className="tg__n">{c.count}</span>
              </button>
            </li>
          ))}
        </ul>

        {items === null ? <p className="small muted">{t('board.loading')}</p> : items.length === 0 ? (
          <p className="trusted__empty">{query || category !== null || source ? t('ss.emptySearch') : t('ss.empty')}</p>
        ) : (
          <ul className="ss-list">
            {items.map((e) => (
              <li key={e.id} className={`ss-row${e.pinned ? ' ss-row--pinned' : ''}`}>
                <div className="ss-row__main">
                  <div className="ss-row__head">
                    <span className={`chip ss-src ss-src--${e.source}`} title={e.source === 'claude-code' ? t('ss.outside') : undefined}>
                      {e.source === 'claude-code' ? t('ss.badge.claude') : t('ss.badge.sebeto')}
                    </span>
                    <strong className="ss-row__title">{e.title}</strong>
                  </div>
                  {e.summary && <p className="ss-row__summary small">{e.summary}</p>}
                  <div className="ss-row__meta small muted">
                    {e.category && (
                      <button type="button" className="tg tg--small ss-cat" onClick={() => setCategory(e.category)}>{e.category}</button>
                    )}
                    {e.category && (e.categorySource === 'auto' || e.categorySource === 'rules') && (
                      <span className="ss-cat-auto" title={e.categorySource === 'auto' ? t('ss.suggest.ai') : t('ss.suggest.rules')}>{t('ss.cat.auto')}</span>
                    )}
                    {e.tags.map((tag) => <span key={tag} className="tg tg--small">#{tag}</span>)}
                    {e.ticketNumber !== null && e.ticketId && (
                      <button type="button" className="ss-ref" onClick={() => goToTicket(e.ticketId!)}>T-{e.ticketNumber}</button>
                    )}
                    <span title={new Date(e.lastActivityAt).toLocaleString()}>{formatRelative(e.lastActivityAt, locale)}</span>
                    {e.costUsd > 0 && <span>{formatCost(e.costUsd, locale)}</span>}
                    {e.messageCount > 0 && <span>{t('ss.messages', { count: e.messageCount })}</span>}
                    {e.cwd && <span className="ss-cwd" title={e.cwd}>{t('ss.folder', { cwd: e.cwd })}</span>}
                  </div>
                </div>
                <div className="ss-row__actions">
                  <button type="button" className={`btn btn--ghost btn--sm ss-pin${e.pinned ? ' ss-pin--on' : ''}`} aria-pressed={e.pinned}
                    title={t('ss.pinHint')} onClick={() => void togglePin(e)}>
                    {e.pinned ? `★ ${t('ss.unpin')}` : `☆ ${t('ss.pin')}`}
                  </button>
                  <SessionOpenButton entry={e} busy={busyId === e.id} onOpen={() => void open(e)} onGoTo={goToTicket} ticketStatus={(e.ticketId && state.tickets[e.ticketId]?.status) || null} />
                  <button type="button" className="btn btn--outline btn--sm" onClick={() => setPreview(e)}>{t('ss.preview')}</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(e)}>{t('ss.edit')}</button>
                  {confirmRemove === e.id ? (
                    <span className="row ss-confirm">
                      <span className="small">{t('ss.remove.confirm')}</span>
                      <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove(e.id)}>{t('ss.remove')}</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmRemove(null)}>{t('ss.edit.cancel')}</button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn--ghost btn--sm pj-del" onClick={() => setConfirmRemove(e.id)}>{t('ss.remove')}</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {cursor && <button type="button" className="btn btn--outline btn--sm ss-more" onClick={() => void load(cursor)}>{t('ss.more')}</button>}
      </div>
      {preview && <TranscriptDialog entry={preview} onClose={() => setPreview(null)} />}
      {suggesting && (
        <SuggestCategoriesDialog
          onClose={() => setSuggesting(false)}
          onApplied={(n) => {
            setSuggesting(false);
            setNotice(t('ss.suggest.applied', { applied: n }));
            void load(null);
            api.sessionCategories().then(setCats, () => undefined);
          }}
        />
      )}
      {editing && <EditSessionDialog entry={editing} onClose={() => setEditing(null)} onSaved={(e) => { replace(e); setEditing(null); api.sessionCategories().then(setCats, () => undefined); }} />}
    </div>
  );
}

/**
 * "Open as ticket" for an outside session not opened yet; "Go to ticket" when its ticket is open on the
 * board; otherwise "Reopen" (the core reopens a Completed ticket, or answers that it is already open).
 */
function SessionOpenButton({ entry, busy, ticketStatus, onOpen, onGoTo }: { entry: SessionEntry; busy: boolean; ticketStatus: string | null; onOpen: () => void; onGoTo: (id: Id) => void }) {
  const { t } = useI18n();
  if (entry.ticketId && ticketStatus && ticketStatus !== 'done') {
    return <button type="button" className="btn btn--outline btn--sm" onClick={() => onGoTo(entry.ticketId!)}>{t('ss.open.goto')}</button>;
  }
  const label = entry.ticketId ? t('ss.open.reopen') : t('ss.open.new');
  return <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={onOpen}>{label}</button>;
}

function TranscriptDialog({ entry, onClose }: { entry: SessionEntry; onClose: () => void }) {
  const { api } = useStore();
  const { t, locale } = useI18n();
  const [tr, setTr] = useState<SessionTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { api.sessionTranscript(entry.id, 40).then(setTr, (e) => setError(errorMessage(e))); }, [api, entry.id]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [tr]);
  return (
    <Dialog title={`${t('ss.preview.title')}: ${entry.title}`} onClose={onClose} wide>
      {entry.source === 'claude-code' && <p className="small muted">{t('ss.outside')}</p>}
      {error && <p className="mail-error" role="alert">{error}</p>}
      {!tr && !error && <p className="small muted">{t('board.loading')}</p>}
      {tr && tr.turns.length === 0 && <p className="trusted__empty">{t('ss.preview.empty')}</p>}
      {tr && tr.turns.length > 0 && (
        <div className="ss-transcript">
          {tr.truncated && <p className="small muted">{t('ss.preview.truncated')}</p>}
          {tr.turns.map((turn, i) => (
            <div key={i} className={`ss-turn ss-turn--${turn.role}`}>
              <span className="ss-turn__who small">{t(ROLE_KEY[turn.role])}{turn.at ? ` · ${formatRelative(turn.at, locale)}` : ''}</span>
              <p className="ss-turn__text">{turn.text}</p>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * v0.5 K: "Suggest categories". Choose rules (free) or the Chief of Staff (AI, with a cost limit),
 * preview the suggestions, untick or change any of them, then apply the ones kept.
 */
function SuggestCategoriesDialog({ onClose, onApplied }: { onClose: () => void; onApplied: (applied: number) => void }) {
  const { api } = useStore();
  const { t, locale } = useI18n();
  const [mode, setMode] = useState<SuggestCategoriesMode>('rules');
  const [cap, setCap] = useState(String(SUGGEST_DEFAULT_COST_USD));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuggestCategoriesResult | null>(null);
  const [rows, setRows] = useState<Array<CategorySuggestion & { keep: boolean }>>([]);

  const capValue = Math.min(SUGGEST_MAX_COST_USD, Math.max(0, Number(cap) || 0));
  const run = async () => {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await api.suggestSessionCategories({ mode, dryRun: true, ...(mode === 'ai' ? { maxCostUsd: capValue } : {}) });
      setResult(r);
      setRows(r.suggestions.map((s) => ({ ...s, keep: true })));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const kept = rows.filter((r) => r.keep);
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.applySessionCategories({ items: kept.map((k) => ({ id: k.entryId, category: k.category, source: k.source })) });
      onApplied(r.applied);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  const setRow = (i: number, patch: Partial<CategorySuggestion & { keep: boolean }>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Dialog title={t('ss.suggest.title')} onClose={onClose} wide>
      <p className="small muted">{t('ss.suggest.intro')}</p>
      <fieldset className="ss-suggest__mode">
        <legend className="field__label">{t('ss.suggest.mode')}</legend>
        <label className="ss-suggest__opt">
          <input type="radio" name="ss-suggest-mode" checked={mode === 'rules'} onChange={() => { setMode('rules'); setResult(null); }} />
          <span><strong>{t('ss.suggest.rules')}</strong><br /><span className="small muted">{t('ss.suggest.rulesHint')}</span></span>
        </label>
        <label className="ss-suggest__opt">
          <input type="radio" name="ss-suggest-mode" checked={mode === 'ai'} onChange={() => { setMode('ai'); setResult(null); }} />
          <span><strong>{t('ss.suggest.ai')}</strong><br /><span className="small muted">{t('ss.suggest.aiHint')}</span></span>
        </label>
        {mode === 'ai' && (
          <label className="field ss-suggest__cap">
            <span className="field__label">{t('ss.suggest.cap')}</span>
            <input className="input" type="number" min={0} max={SUGGEST_MAX_COST_USD} step={0.01} value={cap} onChange={(e) => setCap(e.target.value)} />
          </label>
        )}
      </fieldset>
      <div className="row">
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void run()}>{busy && !result ? t('ss.suggest.working') : t('ss.suggest.preview')}</button>
      </div>
      {error && <p className="mail-error" role="alert">{error}</p>}
      {result && (
        <div className="ss-suggest__result" role="status">
          <p className="small">
            {result.suggestions.length ? t('ss.suggest.count', { count: result.suggestions.length, considered: result.considered }) : t('ss.suggest.none', { considered: result.considered })}
            {result.mode === 'ai' && <> {t('ss.suggest.cost', { calls: result.modelCalls, cost: formatCost(result.costUsd, locale), cap: formatCost(result.maxCostUsd, locale) })}</>}
          </p>
          {(result.skipped.locked > 0 || result.skipped.budget > 0 || result.skipped.invalid > 0) && (
            <p className="small muted">{t('ss.suggest.skipped', { locked: result.skipped.locked, budget: result.skipped.budget, invalid: result.skipped.invalid })}</p>
          )}
          {result.error && <p className="mail-error">{t('ss.suggest.error', { error: result.error })}</p>}
          <p className="small muted">{t('ss.suggest.choices', { choices: result.choices.join(', ') })}</p>
          {rows.length > 0 && (
            <ul className="ss-suggest__list">
              {rows.map((r, i) => (
                <li key={r.entryId} className="ss-suggest__row">
                  <label className="ss-suggest__keep">
                    <input type="checkbox" checked={r.keep} aria-label={t('ss.suggest.keep')} onChange={(e) => setRow(i, { keep: e.target.checked })} />
                    <span className="ss-suggest__name">{r.title}</span>
                  </label>
                  <select className="input ss-suggest__cat" value={r.category} aria-label={t('ss.edit.category')} onChange={(e) => setRow(i, { category: e.target.value, keep: true })}>
                    {result.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {r.source === 'rules' && r.reason && <span className="small muted">{t('ss.suggest.reason', { reason: r.reason })}</span>}
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <div className="row">
              <button type="button" className="btn btn--primary" disabled={busy || !kept.length} onClick={() => void apply()}>{t('ss.suggest.apply', { count: kept.length })}</button>
              <button type="button" className="btn btn--outline" disabled={busy} onClick={onClose}>{t('ss.edit.cancel')}</button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function EditSessionDialog({ entry, onClose, onSaved }: { entry: SessionEntry; onClose: () => void; onSaved: (e: SessionEntry) => void }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [title, setTitle] = useState(entry.title);
  const [category, setCategory] = useState(entry.category);
  const [tags, setTags] = useState(entry.tags);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      onSaved(await api.updateSession(entry.id, { title: title.trim(), category, tags }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('ss.edit.title')} onClose={onClose}>
      <form className="mail-form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span className="field__label">{t('ss.edit.name')}</span>
          <input className="input" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">{t('ss.edit.category')}</span>
          <input className="input" maxLength={32} value={category} list="ss-categories" placeholder="service-desk" onChange={(e) => setCategory(e.target.value)} />
          <datalist id="ss-categories">
            {['service-desk', 'devops', 'infrastructure', 'security', 'red-team'].map((c) => <option key={c} value={c} />)}
          </datalist>
          <span className="small muted">{t('ss.edit.categoryHint')}</span>
        </label>
        <div className="field">
          <span className="field__label">{t('ss.edit.tags')}</span>
          <TagEditor tags={tags} onChange={setTags} />
        </div>
        {error && <p className="mail-error" role="alert">{error}</p>}
        <div className="row">
          <button type="submit" className="btn btn--primary" disabled={busy || !title.trim()}>{t('ss.edit.save')}</button>
          <button type="button" className="btn btn--outline" disabled={busy} onClick={onClose}>{t('ss.edit.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}
