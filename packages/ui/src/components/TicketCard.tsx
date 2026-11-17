import { memo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Ticket } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { pendingPermissionCount } from '../store/reducer';
import { useI18n } from '../i18n/I18nProvider';
import { formatCost, formatRelative, ticketRef } from '../lib/format';
import { ProjectDot } from './Projects';
import { OriginBadge } from './OriginBadge';
import { TeamChip } from './Teams';

/** Presentational card (also used in the drag overlay). */
export const TicketCardView = memo(function TicketCardView({ ticket, overlay = false }: { ticket: Ticket; overlay?: boolean }) {
  const { state } = useStore();
  const { t, locale } = useI18n();
  const agent = ticket.agentId ? state.agents[ticket.agentId] : undefined;
  // Live/known activity first, then what the core sent with the ticket (survives reloads).
  const latest = state.activity[ticket.id] ?? ticket.lastActivity ?? null;
  const activity = latest?.summary || (ticket.status === 'backlog' ? t('card.notStarted') : '');
  const activityAt = latest ? formatRelative(latest.at, locale) : '';
  const perms = pendingPermissionCount(state, ticket.id);
  const project = ticket.projectId ? state.projects?.[ticket.projectId] : undefined;
  const team = ticket.teamId ? state.teams?.[ticket.teamId] : undefined;
  return (
    <span
      className={`card card--${ticket.status}${state.selectedId === ticket.id ? ' card--selected' : ''}${overlay ? ' card--overlay' : ''}`}
    >
      <span className="card__meta">
        <span className="card__ref">{project && <ProjectDot color={project.color} title={project.name} />}{ticketRef(ticket.number)}</span>
        <span className="card__agent">{agent ? agent.name : t('card.unassigned')}</span>
      </span>
      <span className="card__title">{ticket.title}</span>
      {ticket.origin?.kind === 'trigger' && <OriginBadge origin={ticket.origin} />}
      {team && <span className="card__team"><TeamChip team={team} small /></span>}
      {activity && (
        <span className="card__activity" title={activity}>{activity}</span>
      )}
      {(ticket.tags?.length ?? 0) > 0 && (
        <span className="card__tags">{ticket.tags!.slice(0, 4).map((tag) => <span key={tag} className="tg tg--small">#{tag}</span>)}</span>
      )}
      {perms > 0 && <span className="chip chip--warn">{t('card.permission')}</span>}
      <span className="card__foot">
        {/* One time per card: when the latest activity happened (else when the ticket changed). */}
        {latest ? <time dateTime={latest.at}>{activityAt}</time> : <span>{formatRelative(ticket.updatedAt, locale)}</span>}
        <span>{formatCost(ticket.costUsd, locale)}</span>
      </span>
    </span>
  );
});

/** Draggable + clickable card. Keyboard users open it with Enter and use "Move to" in the panel. */
export function TicketCard({ ticket }: { ticket: Ticket }) {
  const { actions } = useStore();
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: ticket.id });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={`card-btn${isDragging ? ' card-btn--dragging' : ''}`}
      onClick={() => actions.select(ticket.id)}
      {...listeners}
    >
      <TicketCardView ticket={ticket} />
    </button>
  );
}
