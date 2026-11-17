import { useState, type FormEvent } from 'react';
import type { Ticket, TicketDetail } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, ticketRef } from '../lib/format';

/**
 * Parent / sub-tickets of a ticket (2026-11-16): the ticket it belongs to, its sub-tickets with their
 * status, and "Add sub-ticket" so the owner can split work by hand (agents already can with
 * delegate_ticket). A sub-ticket keeps the parent's team and project; the agent defaults to the parent's.
 */
export function SubTickets({ ticket, detail }: { ticket: Ticket; detail: TicketDetail | null }) {
  const { state, actions } = useStore();
  const { t, status } = useI18n();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [agentId, setAgentId] = useState(ticket.agentId ?? '');
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = Object.values(state.agents).filter((a) => !a.paused).sort((a, b) => a.name.localeCompare(b.name));
  const children = detail?.children ?? [];
  const done = children.filter((c) => c.status === 'done').length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await actions.create({
        title: title.trim(), goal: goal.trim() || `${title.trim()}\n\nPart of ${ticketRef(ticket.number)}: ${ticket.title}`,
        parentId: ticket.id, agentId: agentId || null, teamId: ticket.teamId ?? null, projectId: ticket.projectId ?? null, start,
      });
      if (created) {
        setTitle(''); setGoal(''); setOpen(false);
        await actions.refreshDetail();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tp-deleg" aria-label={t('panel.delegation')}>
      {detail?.parent && (
        <p className="small tp-deleg__parent">
          {t('panel.partOf')}{' '}
          <button type="button" className="linklike" onClick={() => actions.select(detail.parent!.id)}>
            {ticketRef(detail.parent.number)} — {detail.parent.title}
          </button>
        </p>
      )}
      {children.length > 0 && (
        <>
          <h3 className="section-label">{t('sub.heading', { done, total: children.length })}</h3>
          <ul className="tp-deleg__list">
            {children.map((c) => (
              <li key={c.id} className="tp-deleg__item">
                <button type="button" className="linklike" onClick={() => actions.select(c.id)}>
                  {ticketRef(c.number)} {c.title}
                </button>
                <span className={`badge badge--${c.status}`}>{status(c.status)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!open ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>{t('sub.add')}</button>
      ) : (
        <form className="sub-form" onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span className="field__label">{t('sub.title')}</span>
            <input className="input" required maxLength={200} value={title} autoFocus onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{t('sub.goal')}</span>
            <textarea className="input" rows={3} maxLength={20000} value={goal} placeholder={t('sub.goalPlaceholder')} onChange={(e) => setGoal(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{t('sub.agent')}</span>
            <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">{t('sub.noAgent')}</option>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /><span>{t('sub.start')}</span></label>
          {error && <p className="small mail-error" role="alert">{error}</p>}
          <div className="row">
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !title.trim()}>{t('sub.create')}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>{t('sub.cancel')}</button>
          </div>
        </form>
      )}
    </section>
  );
}
