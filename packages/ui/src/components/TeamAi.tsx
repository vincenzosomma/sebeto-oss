/**
 * v0.4 F (team AI + lock) and G (written scope): the AI section of a team, the lock badge, and the
 * ticket's Scope box. The core enforces both rules; these only explain them and disable what it refuses.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { MAX_SCOPE_CHARS, type RuntimeInfo, type Team, type Ticket } from '@sebeto/shared';
import type { SebetoApi } from '../api/types';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, formatRelative } from '../lib/format';
import { checkScopeFile, isInstalled, runtimeName, scopeReady, shortHash, ticketScopeTeam } from '../lib/team-ai';

// ---------------------------------------------------------------- runtimes (loaded once per API)
// Reloaded when connectors change (v0.7 R: AI connections add and remove runtimes).
const runtimeCache = new WeakMap<SebetoApi, { version: number; list: Promise<RuntimeInfo[]> }>();

/** The runtimes the core offers (detection + models); [] while loading or on error. */
export function useRuntimes(): RuntimeInfo[] {
  const { api, state } = useStore();
  const version = state.connectorsVersion;
  const [list, setList] = useState<RuntimeInfo[]>([]);
  useEffect(() => {
    let live = true;
    let entry = runtimeCache.get(api);
    if (!entry || entry.version !== version) {
      entry = { version, list: api.listRuntimes().catch(() => { runtimeCache.delete(api); return [] as RuntimeInfo[]; }) };
      runtimeCache.set(api, entry);
    }
    void entry.list.then((r) => { if (live) setList(r); });
    return () => { live = false; };
  }, [api, version]);
  return list;
}

export function LockIcon() {
  return (
    <svg className="ai-lock-icon" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v6A1.5 1.5 0 0 1 12.5 16h-9A1.5 1.5 0 0 1 2 14.5v-6A1.5 1.5 0 0 1 3.5 7H4zm2 0h4V5a2 2 0 1 0-4 0v2z" />
    </svg>
  );
}

/** "🔒 Ollama" chip for a team with an AI (lock icon only when locked). Nothing when the team has no AI. */
export function TeamAiBadge({ team, runtimes }: { team: Team; runtimes?: RuntimeInfo[] }) {
  const { t } = useI18n();
  if (!team.runtime) return null;
  const name = runtimeName(runtimes, team.runtime);
  return (
    <span className={`ai-badge${team.lockRuntime ? ' ai-badge--locked' : ''}`} title={team.lockRuntime ? t('ai.lockedTo', { name }) : name}>
      {team.lockRuntime && <LockIcon />}
      <span>{name}{team.model ? ` · ${team.model}` : ''}</span>
    </span>
  );
}

export interface TeamAiValue { runtime: string; model: string; lockRuntime: boolean; requireScope: boolean }

/** The AI section of the team form (and of "Add a team" with showScope=false). */
export function TeamAiFields({ value, onChange, runtimes, showScope = true, onApply, applyBusy = false, hint }: {
  value: TeamAiValue;
  onChange: (v: TeamAiValue) => void;
  runtimes: RuntimeInfo[];
  showScope?: boolean;
  /** "Apply to all members" (only for an existing team). */
  onApply?: () => void;
  applyBusy?: boolean;
  hint?: string | null;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<TeamAiValue>) => onChange({ ...value, ...patch });
  const models = runtimes.find((r) => r.id === value.runtime)?.models ?? [];
  const choices = [...runtimes.map((r) => r.id), ...(value.runtime && !runtimes.some((r) => r.id === value.runtime) ? [value.runtime] : [])];
  const missing = value.runtime && runtimes.length > 0 && !isInstalled(runtimes, value.runtime);
  return (
    <fieldset className="ai-fields">
      <legend className="field__label">{t('ai.section')}</legend>
      <div className="ai-fields__row">
        <label className="field">
          <span className="field__label">{t('ai.runtime')}</span>
          <select className="input" value={value.runtime}
            onChange={(e) => set({ runtime: e.target.value, model: '', lockRuntime: e.target.value ? value.lockRuntime : false })}>
            <option value="">{showScope ? t('ai.runtimeNone') : t('ai.addUsual')}</option>
            {choices.map((id) => (
              <option key={id} value={id}>{isInstalled(runtimes, id) ? runtimeName(runtimes, id) : t('ai.notInstalled', { name: runtimeName(runtimes, id) })}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t('ai.model')}</span>
          {models.length > 0 ? (
            <select className="input" value={value.model} disabled={!value.runtime} onChange={(e) => set({ model: e.target.value })}>
              <option value="">{t('ai.modelDefault')}</option>
              {[...models, ...(value.model && !models.includes(value.model) ? [value.model] : [])].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input className="input" value={value.model} disabled={!value.runtime} placeholder={t('ai.modelDefault')} maxLength={200} onChange={(e) => set({ model: e.target.value })} />
          )}
        </label>
      </div>
      {hint && <p className="small ai-hint">{hint}</p>}
      {missing && <p className="small ai-warn" role="note">{t('ai.notInstalledWarn', { name: runtimeName(runtimes, value.runtime) })}</p>}
      <label className="check">
        <input type="checkbox" checked={value.lockRuntime} disabled={!value.runtime} onChange={(e) => set({ lockRuntime: e.target.checked })} />
        <span><LockIcon /> {t('ai.lock')}</span>
      </label>
      <span className="small muted ai-explain">{value.runtime ? t('ai.lockHint') : t('ai.lockNeedsRuntime')}</span>
      {onApply && (
        <span className="row ai-apply">
          <button type="button" className="btn btn--outline btn--sm" disabled={!value.runtime || applyBusy} onClick={onApply}>{t('ai.apply')}</button>
          <span className="small muted">{t('ai.applyHint')}</span>
        </span>
      )}
      {showScope && (
        <>
          <label className="check">
            <input type="checkbox" checked={value.requireScope} onChange={(e) => set({ requireScope: e.target.checked })} />
            <span>{t('ai.scope')}</span>
          </label>
          <span className="small muted ai-explain">{t('ai.scopeHint')}</span>
        </>
      )}
    </fieldset>
  );
}

// ---------------------------------------------------------------- ticket: written scope (G)
/** The Scope box of the ticket panel. Shown when the team requires it, a scope exists, or after "Add scope". */
export function ScopeSection({ ticket, running }: { ticket: Ticket; running: boolean }) {
  const { state, api, dispatch } = useStore();
  const { t, locale } = useI18n();
  const team = ticketScopeTeam(ticket, state.teams, state.agents);
  const scope = ticket.scope ?? null;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Another ticket opened: reset the form.
  useEffect(() => { setOpen(false); setEditing(false); setText(''); setFileName(null); setConfirmed(false); setError(null); setNote(null); }, [ticket.id]);

  if (!team && !scope && !open) {
    return <button type="button" className="btn btn--ghost btn--sm scope-add" onClick={() => { setOpen(true); setEditing(true); }}>+ {t('scope.add')}</button>;
  }
  const showForm = editing || (!scope && !!team);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = checkScopeFile(file.name, file.size);
    if (problem) { setError(t(problem)); return; }
    const body = await file.text();
    if (body.length > MAX_SCOPE_CHARS) { setError(t('scope.tooLong', { max: MAX_SCOPE_CHARS })); return; }
    setText(body);
    setFileName(file.name);
    setConfirmed(false);
    setError(null);
    setNote(t('scope.loaded', { name: file.name }));
  };
  const save = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const next = await api.setTicketScope(ticket.id, { text, fileName, confirm: true });
      dispatch({ type: 'ticketUpserted', ticket: next });
      setEditing(false); setConfirmed(false); setNote(t('scope.saved'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const next = await api.clearTicketScope(ticket.id);
      dispatch({ type: 'ticketUpserted', ticket: next });
      setOpen(!!team);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`scope${team && !scope ? ' scope--missing' : ''}`} aria-label={t('scope.title')}>
      <h3 className="field__label">{t('scope.title')}</h3>
      {team && !scope && <p className="scope__notice small" role="note">{t('scope.required', { team: team.name })}</p>}
      {scope && !editing && (
        <>
          <pre className="scope__text">{scope.text}</pre>
          <p className="small muted">
            {t('scope.meta', { when: formatRelative(scope.confirmedAt, locale), hash: shortHash(scope.sha256) })}
            {scope.fileName ? ` · ${t('scope.from', { name: scope.fileName })}` : ''}
          </p>
          <span className="row">
            <button type="button" className="btn btn--outline btn--sm" disabled={running || busy}
              onClick={() => { setEditing(true); setText(scope.text); setFileName(scope.fileName); setConfirmed(false); }}>{t('scope.edit')}</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={running || busy} onClick={() => void remove()}>{t('scope.remove')}</button>
          </span>
        </>
      )}
      {showForm && (
        <div className="stack scope__form">
          <p className="small muted">{t('scope.intro')}</p>
          <textarea className="input textarea scope__input" rows={6} value={text} maxLength={MAX_SCOPE_CHARS} placeholder={t('scope.placeholder')}
            disabled={running} onChange={(e) => { setText(e.target.value); setConfirmed(false); }} aria-label={t('scope.title')} />
          <span className="row scope__tools">
            <input ref={fileRef} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" className="tt-file" tabIndex={-1} onChange={(e) => void onFile(e)} aria-label={t('scope.load')} />
            <button type="button" className="btn btn--outline btn--sm" disabled={running} onClick={() => fileRef.current?.click()}>{t('scope.load')}</button>
            <span className="small muted">{t('scope.chars', { count: text.length, max: MAX_SCOPE_CHARS })}</span>
          </span>
          <label className="check">
            <input type="checkbox" checked={confirmed} disabled={running || !text.trim()} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>{t('scope.confirm')}</span>
          </label>
          <span className="row">
            <button type="button" className="btn btn--primary btn--sm" disabled={running || busy || !scopeReady(text, confirmed)} onClick={() => void save()}>{t('scope.save')}</button>
            {(scope || !team) && <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditing(false); setOpen(!!scope); }}>{t('scope.cancel')}</button>}
          </span>
          {running && <span className="small muted">{t('scope.runningLocked')}</span>}
        </div>
      )}
      {error && <p className="small form-error" role="alert">{error}</p>}
      {note && <p className="small muted" role="status">{note}</p>}
    </section>
  );
}
