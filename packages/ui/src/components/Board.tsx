import { useState } from 'react';
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors,
  type Announcements, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { TICKET_STATUSES, type Id, type TicketStatus } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { Column } from './Column';
import { TicketCardView } from './TicketCard';

const isStatus = (v: unknown): v is TicketStatus => typeof v === 'string' && (TICKET_STATUSES as readonly string[]).includes(v);

export function Board() {
  const { state, actions } = useStore();
  const { t, status } = useI18n();
  const [dragId, setDragId] = useState<Id | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );

  const columns: TicketStatus[] = state.view === 'all' ? [...TICKET_STATUSES] : [state.view];
  const ref = (id: unknown) => {
    const tk = state.tickets[String(id)];
    return tk ? `T-${tk.number}` : '';
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => ref(active.id),
    onDragOver: ({ active, over }) => (over && isStatus(over.id) ? `${ref(active.id)} → ${status(over.id)}` : undefined),
    onDragEnd: ({ active, over }) =>
      over && isStatus(over.id) ? t('card.moved', { number: ref(active.id).slice(2), column: status(over.id) }) : undefined,
    onDragCancel: ({ active }) => ref(active.id),
  };

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const id = String(e.active.id);
    const target = e.over?.id;
    if (isStatus(target)) void actions.move(id, target);
  };

  const dragged = dragId ? state.tickets[dragId] : undefined;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
      accessibility={{ announcements }}
    >
      <section className={`board board--${columns.length === 1 ? 'single' : 'full'}`} aria-label={t('board.label')}>
        {columns.map((s) => (
          <Column key={s} status={s} />
        ))}
      </section>
      <DragOverlay dropAnimation={null}>{dragged ? <TicketCardView ticket={dragged} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}
