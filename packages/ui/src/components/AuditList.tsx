import { useState } from 'react';
import type { AuditEvent, Id, Run } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { undoableRun } from '../store/reducer';
import { useI18n } from '../i18n/I18nProvider';
import { formatRelative } from '../lib/format';

const MAX_EVENTS = 50;
/** Steps shown before "See more": the activity log is detail, the chat is the main story. */
export const COLLAPSED_EVENTS = 2;

export function AuditList({ ticketId, events, runs }: { ticketId: Id; events: AuditEvent[]; runs: Run[] }) {
  const { actions } = useStore();
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const run = undoableRun(runs);
  const all = events.slice(-MAX_EVENTS).reverse(); // newest first
  const hidden = Math.max(0, all.length - COLLAPSED_EVENTS);
  const shown = open ? all : all.slice(0, COLLAPSED_EVENTS);

  const undo = async () => {
    if (!run || !window.confirm(t('audit.undoConfirm'))) return;
    setBusy(true);
    await actions.undo(ticketId, run.id);
    setBusy(false);
  };

  return (
    <section className="audit" aria-labelledby="audit-h">
      <div className="audit__head">
        <h3 className="section-label" id="audit-h">{t('audit.heading')}</h3>
        {run && (
          <button type="button" className="btn btn--outline btn--sm" onClick={() => void undo()} disabled={busy}>
            {t('audit.undo')}
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="small muted">{t('audit.empty')}</p>
      ) : (
        <>
          <ul className="audit__list" id={`audit-list-${ticketId}`}>
            {shown.map((e) => (
              <li key={e.id} className={`audit__item audit__item--${e.kind}`}>
                <span className="audit__summary">{e.summary}</span>
                <time className="audit__time" dateTime={e.createdAt}>{formatRelative(e.createdAt, locale)}</time>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <button type="button" className="msg__more audit__more" aria-expanded={open} aria-controls={`audit-list-${ticketId}`} onClick={() => setOpen((o) => !o)}>
              {open ? t('audit.seeLess') : t('audit.seeMore', { n: hidden })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
