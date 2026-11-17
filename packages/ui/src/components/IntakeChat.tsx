import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { IntakeMessage, ProposedTicket, Ticket } from '@sebeto/shared';
import { PlanningModel } from './PlanningModel';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, formatCost } from '../lib/format';
import { isLockdownError } from '../lib/security';
import { Dialog } from './Dialog';
import { RichText } from './RichText';
import { TeamSelect } from './Teams';

interface Draft extends ProposedTicket { include: boolean }
interface Saved { messages: IntakeMessage[]; drafts: Draft[]; created: Array<Pick<Ticket, 'id' | 'number' | 'title'>> }

// Suffix = draft shape revision: change it when the saved fields change, so old drafts are ignored.
const STORAGE_KEY = 'sebeto.intake.fkdss';
const load = (): Saved => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Saved;
  } catch { /* unavailable */ }
  return { messages: [], drafts: [], created: [] };
};
const save = (s: Saved) => {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* unavailable */ }
};

/** Only included proposals, with dependencies on excluded ones removed. Exported for tests. */
export function acceptedProposals(drafts: Draft[]): ProposedTicket[] {
  const kept = drafts.filter((d) => d.include);
  const keys = new Set(kept.map((d) => d.key));
  return kept.map(({ include: _include, ...p }) => ({ ...p, dependsOn: p.dependsOn.filter((k) => keys.has(k)) }));
}

/** Chat with the Chief of Staff: describe a need, get proposed tickets, edit, create. */
export function IntakeChat({ onClose }: { onClose: () => void }) {
  const { state, actions, api } = useStore();
  const { t, locale } = useI18n();
  const initial = useRef(load()).current;
  const [messages, setMessages] = useState<IntakeMessage[]>(initial.messages);
  const [drafts, setDrafts] = useState<Draft[]>(initial.drafts);
  const [created, setCreated] = useState<Saved['created']>(initial.created);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<'thinking' | 'creating' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const agents = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => { save({ messages, drafts, created }); }, [messages, drafts, created]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [messages.length, drafts.length, busy]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const next: IntakeMessage[] = [...messages, { role: 'user', text }];
    setMessages(next);
    setInput('');
    setError(null);
    setCreated([]);
    setBusy('thinking');
    try {
      const res = await api.intakeTurn({ messages: next });
      setMessages([...next, { role: 'assistant', text: res.reply }]);
      if (res.proposals.length) setDrafts(res.proposals.map((p) => ({ ...p, include: true })));
      setCost((c) => c + res.costUsd);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const patch = (key: string, p: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d)));

  const accept = async (start: boolean) => {
    const proposals = acceptedProposals(drafts);
    if (!proposals.length) return;
    setBusy('creating');
    setError(null);
    try {
      const projectId = state.projectFilter && state.projectFilter !== 'none' ? state.projectFilter : null;
      const { tickets } = await api.acceptIntake({ proposals, start, projectId });
      // The board updates through the live ticket.updated events.
      setCreated(tickets.map((tk) => ({ id: tk.id, number: tk.number, title: tk.title })));
      setDrafts([]);
      setMessages((m) => [...m, { role: 'assistant', text: t(start ? 'intake.createdStarted' : 'intake.created', { list: tickets.map((tk) => `T-${tk.number}`).join(', ') }) }]);
    } catch (err) {
      setError(isLockdownError(err) ? t('sec.lockdown.refused') : errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setMessages([]); setDrafts([]); setCreated([]); setError(null); setCost(0); setInput('');
  };

  const titleOf = (key: string) => drafts.find((d) => d.key === key)?.title ?? key;
  const included = drafts.filter((d) => d.include).length;

  return (
    <Dialog title={t('intake.heading')} onClose={onClose} wide>
      <div className="intake">
        {messages.length === 0 && (
          <div className="intake__intro">
            <p>{t('intake.intro')}</p>
            <ul className="intake__examples">
              {[t('intake.example1'), t('intake.example2'), t('intake.example3')].map((ex) => (
                <li key={ex}><button type="button" className="chip-btn" onClick={() => setInput(ex)}>{ex}</button></li>
              ))}
            </ul>
          </div>
        )}
        <ol className="chat__list intake__chat" aria-live="polite">
          {messages.map((m, i) => (
            <li key={i} className={`msg msg--${m.role === 'user' ? 'user' : 'agent'}`}>
              <span className="msg__who">{m.role === 'user' ? t('chat.you') : t('intake.cos')}</span>
              <div className="msg__bubble msg__bubble--rich"><RichText text={m.text} /></div>
            </li>
          ))}
          {busy === 'thinking' && (
            <li className="msg msg--agent"><span className="msg__who">{t('intake.cos')}</span>
              <div className="msg__bubble running"><span className="pulse" aria-hidden="true" />{t('intake.thinking')}</div></li>
          )}
        </ol>

        {created.length > 0 && (
          <div className="intake__created" role="status">
            {created.map((c) => (
              <button key={c.id} type="button" className="btn btn--outline btn--sm" onClick={() => { actions.select(c.id); onClose(); }}>
                {t('intake.open', { ref: `T-${c.number}` })}: {c.title}
              </button>
            ))}
          </div>
        )}

        {drafts.length > 0 && (
          <section className="proposals" aria-label={t('intake.proposals')}>
            <h3 className="section-label">{t('intake.proposals')}</h3>
            {drafts.map((d, i) => (
              <article key={d.key} className={`proposal${d.include ? '' : ' proposal--off'}`}>
                <label className="check proposal__include">
                  <input type="checkbox" checked={d.include} onChange={(e) => patch(d.key, { include: e.target.checked })} />
                  <span>{t('intake.ticketN', { n: i + 1 })}</span>
                </label>
                <label className="field">
                  <span className="field__label">{t('new.title')}</span>
                  <input className="input" value={d.title} maxLength={200} disabled={!d.include} onChange={(e) => patch(d.key, { title: e.target.value })} />
                </label>
                <label className="field">
                  <span className="field__label">{t('intake.goal')}</span>
                  <textarea className="input textarea" rows={3} value={d.goal} disabled={!d.include} onChange={(e) => patch(d.key, { goal: e.target.value })} />
                </label>
                <div className="proposal__row">
                  {Object.keys(state.teams ?? {}).length > 0 && (
                    <TeamSelect value={d.teamId ?? null} disabled={!d.include}
                      onChange={(v) => patch(d.key, { teamId: v === 'auto' ? null : v })} />
                  )}
                  <label className="field">
                    <span className="field__label">{t('new.agent')}</span>
                    <select className="input" value={d.agentId ?? ''} disabled={!d.include} onChange={(e) => patch(d.key, { agentId: e.target.value || null })}>
                      <option value="">{t('new.agentAuto')}</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.role ? `${a.name} (${a.role})` : a.name}</option>)}
                    </select>
                  </label>
                  <label className="field proposal__cap">
                    <span className="field__label">{t('intake.cap')}</span>
                    <input className="input" type="number" min={0.1} max={50} step={0.5} value={d.costCapUsd} disabled={!d.include}
                      onChange={(e) => patch(d.key, { costCapUsd: Math.max(0.1, Number(e.target.value) || 0.1) })} />
                  </label>
                </div>
                {d.dependsOn.length > 0 && (
                  <p className="small muted">{t('intake.after', { list: d.dependsOn.map(titleOf).join(', ') })}</p>
                )}
                {d.why && <p className="small muted proposal__why">{d.why}</p>}
              </article>
            ))}
            <div className="row proposals__actions">
              <button type="button" className="btn btn--primary" disabled={!!busy || included === 0 || state.lockdown}
                title={state.lockdown ? t('sec.lockdown.startBlocked') : undefined} onClick={() => void accept(true)}>
                {t('intake.createStart', { n: included })}
              </button>
              <button type="button" className="btn btn--outline" disabled={!!busy || included === 0} onClick={() => void accept(false)}>
                {t('intake.create', { n: included })}
              </button>
            </div>
          </section>
        )}

        {error && <p className="mail-error" role="alert">{error}</p>}
        <div ref={endRef} />

        <form className="intake__composer" onSubmit={(e) => void send(e)}>
          <textarea className="input textarea" rows={2} value={input} placeholder={t('intake.placeholder')}
            aria-label={t('intake.placeholder')} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={busy === 'creating'} />
          <div className="intake__bar">
            <span className="small muted">
              {cost > 0 ? t('intake.cost', { cost: formatCost(cost, locale) }) : t('intake.hint')}
            </span>
            <PlanningModel disabled={!!busy} />
            <span className="row">
              {messages.length > 0 && <button type="button" className="btn btn--ghost btn--sm" onClick={reset} disabled={!!busy}>{t('intake.reset')}</button>}
              <button type="submit" className="btn btn--tuff btn--sm" disabled={!!busy || !input.trim()}>{t('intake.send')}</button>
            </span>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
