import { useEffect, useState, type FormEvent } from 'react';
import type { AgentBudget, Ticket } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { formatCost } from '../lib/format';

const QUICK = [1, 2, 5] as const;

/** True when the ticket stopped (or is about to stop) because its cost cap is used up. */
export function budgetReached(ticket: Pick<Ticket, 'costUsd' | 'costCapUsd'>): boolean {
  return ticket.costCapUsd > 0 && ticket.costUsd >= ticket.costCapUsd - 0.005;
}

/** True when the assigned agent's monthly budget is used up (it stops every ticket of that agent). */
export function agentBudgetReached(budget: AgentBudget | undefined): boolean {
  return !!budget && budget.monthlyBudgetUsd - budget.spentUsd <= 0.005;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Shown in the conversation when a ticket hit its cost cap: add budget in one click. The new cap is
 * what was spent plus the amount, and a short message resumes the agent where it stopped.
 */
export function BudgetCard({ ticket, agentBudget }: { ticket: Ticket; agentBudget?: AgentBudget }) {
  const { actions, api, dispatch } = useStore();
  const { t, locale } = useI18n();
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  // Budgets set to warn only (workspace setting budgetBlocks: false): nothing stopped, no card.
  const [blocks, setBlocks] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    api.getSettings().then((s) => { if (live) setBlocks(s.budgetBlocks !== false); }, () => { if (live) setBlocks(true); });
    return () => { live = false; };
  }, [api]);

  /** Switch every budget to warn only and let this agent carry on. */
  const warnOnly = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.updateSettings({ budgetBlocks: false });
      setBlocks(false);
      await actions.send(t('budget.resumeWarn'));
    } finally {
      setBusy(false);
    }
  };

  const add = async (amount: number) => {
    if (!(amount > 0) || busy) return;
    setBusy(true);
    // Raise whichever limit would stop the next step: the ticket cap, the agent's monthly budget, or both.
    const ticketLeft = ticket.costCapUsd - ticket.costUsd;
    const agentLeft = agentBudget ? agentBudget.monthlyBudgetUsd - agentBudget.spentUsd : Number.POSITIVE_INFINITY;
    const cap = ticketLeft < amount ? round2(Math.max(ticket.costUsd, ticket.costCapUsd) + amount) : ticket.costCapUsd;
    try {
      if (cap !== ticket.costCapUsd) await actions.updateTicket(ticket.id, { costCapUsd: cap });
      if (agentBudget && agentLeft < amount) {
        const monthly = round2(Math.max(agentBudget.spentUsd, agentBudget.monthlyBudgetUsd) + amount);
        dispatch({ type: 'agentUpserted', agent: await api.updateAgent(agentBudget.agentId, { monthlyBudgetUsd: monthly }) });
      }
      await actions.refreshDetail();
      await actions.send(t('budget.resume', { cap: formatCost(cap, locale) }));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void add(Number(custom)); };
  if (blocks === false) return null;

  return (
    <section className="budget-card" role="group" aria-label={t('budget.heading')}>
      <p className="budget-card__text">
        <strong>{t('budget.heading')}</strong>{' '}
        {budgetReached(ticket)
          ? t('budget.text', { cost: formatCost(ticket.costUsd, locale), cap: formatCost(ticket.costCapUsd, locale) })
          : t('budget.agentText', {
            name: agentBudget?.name ?? '', spent: formatCost(agentBudget?.spentUsd ?? 0, locale), budget: formatCost(agentBudget?.monthlyBudgetUsd ?? 0, locale),
          })}
      </p>
      {agentBudgetReached(agentBudget) && budgetReached(ticket) && (
        <p className="small muted">{t('budget.agentToo', { name: agentBudget!.name, budget: formatCost(agentBudget!.monthlyBudgetUsd, locale) })}</p>
      )}
      <div className="row budget-card__actions">
        {QUICK.map((n) => (
          <button key={n} type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void add(n)}>
            {t('budget.add', { amount: formatCost(n, locale) })}
          </button>
        ))}
        <form className="row budget-card__custom" onSubmit={submit}>
          <input className="input input--sm" type="number" min={0.1} max={500} step={0.5} inputMode="decimal" value={custom}
            placeholder={t('budget.other')} aria-label={t('budget.other')} onChange={(e) => setCustom(e.target.value)} />
          <button type="submit" className="btn btn--outline btn--sm" disabled={busy || !(Number(custom) > 0)}>{t('budget.addCustom')}</button>
        </form>
      </div>
      <p className="small muted">{t('budget.hint')}</p>
      <p className="small">
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void warnOnly()}>{t('budget.warnOnly')}</button>
      </p>
    </section>
  );
}
