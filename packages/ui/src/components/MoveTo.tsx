import { TICKET_STATUSES, type Ticket } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';

/** Keyboard-accessible alternative to drag-and-drop. */
export function MoveTo({ ticket }: { ticket: Ticket }) {
  const { actions } = useStore();
  const { t, status } = useI18n();
  return (
    <div className="move-to" role="group" aria-labelledby="move-to-label">
      <span className="small muted" id="move-to-label">{t('panel.moveTo')}</span>
      <div className="pills">
        {TICKET_STATUSES.map((s) => {
          const active = s === ticket.status;
          return (
            <button
              key={s}
              type="button"
              className={`pill${active ? ' pill--active' : ''}`}
              aria-pressed={active}
              onClick={() => !active && void actions.move(ticket.id, s)}
            >
              {status(s)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
