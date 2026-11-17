import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import type { TicketStatus } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { ticketsIn } from '../store/reducer';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { TicketCard } from './TicketCard';

/** Cards rendered per step; long columns grow with "Show more" (local first, then the next server page). */
export const RENDER_STEP = 30;

export function Column({ status }: { status: TicketStatus }) {
  const { state, actions } = useStore();
  const { t, status: label } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [limit, setLimit] = useState(RENDER_STEP);
  const col = state.columns[status];
  const tickets = ticketsIn(state, status);
  const shown = tickets.slice(0, limit);
  const hasMore = tickets.length > limit || !!col.cursor;
  const headingId = `col-${status}`;

  const showMore = async () => {
    if (tickets.length <= limit && col.cursor) await actions.loadMore(status);
    setLimit((n) => n + RENDER_STEP);
  };

  return (
    <section ref={setNodeRef} className={`column${isOver ? ' column--over' : ''}`} aria-labelledby={headingId}>
      <header className="column__head">
        <span className={`dot dot--${status}`} aria-hidden="true" />
        <h2 className="column__title" id={headingId}>{label(status)}</h2>
        <span className="count">{tickets.length}{col.cursor ? '+' : ''}</span>
      </header>
      <p className="column__hint">{t(`board.hint.${status}` as MessageKey)}</p>
      <ul className="column__list">
        {shown.map((tk) => (
          <li key={tk.id}>
            <TicketCard ticket={tk} />
          </li>
        ))}
      </ul>
      {tickets.length === 0 && !col.loading && <p className="column__empty">{t('board.empty')}</p>}
      {col.loading && <p className="column__empty" role="status">{t('board.loading')}</p>}
      {hasMore && !col.loading && (
        <button type="button" className="btn btn--ghost btn--block" onClick={showMore}>
          {t('board.showMore')}
        </button>
      )}
    </section>
  );
}
