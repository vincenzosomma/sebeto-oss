import { useEffect, useRef, useState } from 'react';
import type { Id } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { hasActiveRun } from '../store/reducer';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage, formatCost, formatRelative, ticketRef } from '../lib/format';
import { AuditList } from './AuditList';
import { BudgetCard, agentBudgetReached, budgetReached } from './BudgetCard';
import { Chat } from './Chat';
import { Composer } from './Composer';
import { SubTickets } from './SubTickets';
import { MoveTo } from './MoveTo';
import { PermissionCard } from './PermissionCard';
import { TagEditor } from './Projects';
import { UntrustedOriginNote, OriginBadge } from './OriginBadge';
import { TeamSelect } from './Teams';
import { latestRouting } from '../lib/teams';
import { ticketLockTeam, ticketScopeTeam } from '../lib/team-ai';
import { LockIcon, ScopeSection } from './TeamAi';

export function TicketPanel({ ticketId }: { ticketId: Id }) {
  const { state, actions, api } = useStore();
  const { t, status, locale } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [routing, setRouting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const ticket = state.detail?.ticket ?? state.tickets[ticketId];
  const detail = state.detail && state.detail.ticket.id === ticketId ? state.detail : null;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  if (!ticket) return null;
  const hasTeams = Object.keys(state.teams ?? {}).length > 0;
  const routed = detail ? latestRouting(detail.events) : null;
  const route = async () => { setRouting(true); try { await actions.routeTicket(ticket.id); } finally { setRouting(false); } };
  const agent = ticket.agentId ? state.agents[ticket.agentId] : undefined;
  const running = hasActiveRun(detail) || (!detail && ticket.status === 'in_progress');
  const costPct = ticket.costCapUsd > 0 ? Math.min(100, (ticket.costUsd / ticket.costCapUsd) * 100) : 0;
  const pending = detail?.permissions.filter((p) => p.state === 'pending') ?? [];
  // v0.4 F/G: a locked team's AI, and a written scope required before starting.
  const lockTeam = ticketLockTeam(ticket, state.teams, state.agents);
  const scopeMissing = !ticket.scope && !!ticketScopeTeam(ticket, state.teams, state.agents);
  const decided = (detail?.permissions.filter((p) => p.state !== 'pending') ?? []).slice(-2);
  const bannerKey: MessageKey | null =
    ticket.status === 'needs_you' ? 'panel.banner.needs_you'
    : ticket.status === 'blocked' ? 'panel.banner.blocked'
    : ticket.status === 'backlog' ? 'panel.banner.backlog'
    : null;

  return (
    <aside className="panel" aria-labelledby="panel-title">
      <div className="panel__scroll">
        <header className="panel__head">
          <div className="panel__topline">
            <span className="small muted">{ticketRef(ticket.number)}</span>
            <button ref={closeRef} type="button" className="icon-btn" onClick={() => actions.select(null)} aria-label={t('panel.close')}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <h2 className="panel__title" id="panel-title">{ticket.title}</h2>
          {ticket.origin?.untrusted ? <UntrustedOriginNote origin={ticket.origin} /> : ticket.origin?.kind === 'trigger' && <OriginBadge origin={ticket.origin} />}
          <div className="panel__status">
            <span className={`badge badge--${ticket.status}`}>{status(ticket.status)}</span>
            <span className="small muted">
              {t('panel.costOf', { cost: formatCost(ticket.costUsd, locale), cap: formatCost(ticket.costCapUsd, locale) })} ·{' '}
              {t('panel.updated', { when: formatRelative(ticket.updatedAt, locale) })}
            </span>
          </div>
          <div
            className="meter"
            role="meter"
            aria-label={t('panel.costOf', { cost: formatCost(ticket.costUsd, locale), cap: formatCost(ticket.costCapUsd, locale) })}
            aria-valuemin={0}
            aria-valuemax={ticket.costCapUsd}
            aria-valuenow={ticket.costUsd}
          >
            <span className={`meter__fill${costPct >= 90 ? ' meter__fill--high' : ''}`} style={{ width: `${costPct}%` }} />
          </div>
          <label className="field panel__agent">
            <span className="field__label">{t('panel.agent')}</span>
            <select
              className="input"
              value={ticket.agentId ?? ''}
              disabled={running}
              title={running ? t('panel.agentLocked') : undefined}
              onChange={(e) => { if (e.target.value) void actions.assign(ticket.id, e.target.value); }}
            >
              {!agent && <option value="">{t('card.unassigned')}</option>}
              {Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.role ? `${a.name} (${a.role})` : a.name}{a.runtime === 'mock' ? ` · ${t('panel.agentTest')}` : ''}
                </option>
              ))}
            </select>
            {running && <span className="small muted">{t('panel.agentLocked')}</span>}
          </label>
          {hasTeams && (
            <div className="field tm-panel">
              <span className="field__label">{t('tm.team')}</span>
              <span className="row tm-panel__row">
                <TeamSelect label={false} value={ticket.teamId ?? null} onChange={(v) => void actions.updateTicket(ticket.id, { teamId: v })} />
                <button type="button" className="btn btn--outline btn--sm" disabled={routing} onClick={() => void route()}>
                  {routing ? t('tm.routing') : t('tm.routeAuto')}
                </button>
              </span>
              {routed && <span className="small muted tm-reason" title={routed.summary}>{t('tm.reason', { reason: routed.decision.reason })}</span>}
            </div>
          )}
          {lockTeam && <p className="small ai-locked-by"><LockIcon /> {t('ai.ticketLocked', { name: lockTeam.runtime ?? '', team: lockTeam.name })}</p>}
          <ScopeSection ticket={ticket} running={running} />
          <div className="pj-panel">
            <label className="field">
              <span className="field__label">{t('pj.project')}</span>
              <select className="input" value={ticket.projectId ?? ''}
                onChange={(e) => void actions.updateTicket(ticket.id, { projectId: e.target.value || null })}>
                <option value="">{t('pj.noProject')}</option>
                {Object.values(state.projects ?? {}).filter((p) => !p.archived || p.id === ticket.projectId).sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="field__label">{t('tg.heading')}</span>
              <TagEditor tags={ticket.tags ?? []} onChange={(tags) => void actions.updateTicket(ticket.id, { tags })} onTagClick={(tag) => actions.setTagFilter(tag)} />
            </div>
          </div>
          <p className="small muted panel__folder" title={ticket.folder}>{t('panel.folder')}: {ticket.folder}</p>
          <div className="panel__actions">
            {running ? (
              <>
                <span className="small running" role="status"><span className="pulse" aria-hidden="true" />{t('panel.running')}</span>
                <button type="button" className="btn btn--danger" onClick={() => void actions.cancel(ticket.id)}>
                  {t('panel.cancel')}
                </button>
              </>
            ) : (
              ticket.status !== 'done' && (
                <>
                  <button type="button" className="btn btn--primary" disabled={scopeMissing || state.lockdown}
                    title={state.lockdown ? t('sec.lockdown.startBlocked') : scopeMissing ? t('scope.startBlocked') : undefined}
                    onClick={() => void actions.start(ticket.id)}>
                    {t('panel.start')}
                  </button>
                  {state.lockdown ? <span className="small muted" role="note">{t('sec.lockdown.startBlocked')}</span>
                    : scopeMissing && <span className="small muted">{t('scope.startBlocked')}</span>}
                </>
              )
            )}
          </div>
          <MoveTo ticket={ticket} />
          <div className="row tp-delete">
            <button type="button" className="btn btn--ghost btn--sm tp-delete__btn" disabled={running || deleting}
              title={running ? t('del.stopFirst') : undefined}
              onClick={() => {
                if (!window.confirm(t('del.confirm', { ref: ticketRef(ticket.number), title: ticket.title }))) return;
                setDeleting(true); setDeleteError(null);
                api.deleteTicket(ticket.id).then(() => actions.select(null), (e: unknown) => setDeleteError(errorMessage(e))).finally(() => setDeleting(false));
              }}>
              {t('del.delete')}
            </button>
            {deleteError && <span className="small mail-error" role="alert">{deleteError}</span>}
          </div>
        </header>

        {bannerKey && <p className={`banner banner--${ticket.status}`}>{t(bannerKey)}</p>}

        {/* First thing in the panel: the agent is stopped until budget is added. */}
        {!running && (budgetReached(ticket) || agentBudgetReached(detail?.agentBudget)) && <BudgetCard ticket={ticket} agentBudget={detail?.agentBudget} />}

        <SubTickets ticket={ticket} detail={detail} />

        {pending.map((p) => (
          <PermissionCard key={p.id} request={p} />
        ))}
        {decided.map((p) => (
          <PermissionCard key={p.id} request={p} />
        ))}

        {!detail ? (
          <p className="panel__loading" role="status">{t('panel.loading')}</p>
        ) : (
          <>
            <Chat messages={detail.messages} />
            <AuditList ticketId={ticket.id} events={detail.events} runs={detail.runs} />
          </>
        )}
      </div>
      <Composer disabled={!detail} />
    </aside>
  );
}
