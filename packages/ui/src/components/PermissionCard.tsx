import { useState } from 'react';
import { ALWAYS_ASK, TICKET_SCOPED_KEYS, type PermissionDecision, type PermissionRequest } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';

export function PermissionCard({ request }: { request: PermissionRequest }) {
  const { actions, state } = useStore();
  const { t, permission } = useI18n();
  const [busy, setBusy] = useState(false);
  const headingId = `perm-${request.id}`;

  // Only plain system commands can be trusted; production changes always ask.
  const trustable = request.key === 'script.run' && !!request.command;
  // Reading the mailbox is approved once for the whole ticket (the single "Allow" already covers it).
  const ticketScoped = TICKET_SCOPED_KEYS.includes(request.key);
  // "Allow for this task" grants for the whole ticket. Not for the already-ticket-scoped keys, and
  // not for production changes (those must be approved every time).
  const taskScopable = !ticketScoped && !ALWAYS_ASK.includes(request.key);

  // v0.9: an agent asking to turn on one of the owner's Claude connectors.
  const connector = request.connector ?? null;
  const agentName = (request.agentId && state.agents[request.agentId]?.name) || t('perm.connector.thisAgent');

  const decide = async (decision: PermissionDecision) => {
    setBusy(true);
    await actions.decide(request.id, decision);
    setBusy(false);
  };

  return (
    <section className={`perm perm--${request.state}`} aria-labelledby={headingId}>
      <h3 className="perm__title" id={headingId}>
        <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3Z" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        {request.title}
      </h3>
      <p className="perm__detail">{request.detail}</p>
      <p className="small muted">{t('perm.kind', { label: permission(request.key) })}</p>
      {request.provenance && <p className="perm__prov">{t('perm.provenance', { source: request.provenance })}</p>}
      {connector && request.state === 'pending' ? (
        <div className="row">
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void decide('allow')}>
            {t('perm.connector.agent', { agent: agentName })}
          </button>
          {connector.teamId && (
            <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void decide('team')}>
              {t('perm.connector.team', { team: connector.teamName ?? '' })}
            </button>
          )}
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void decide('deny')}>
            {t('perm.deny')}
          </button>
        </div>
      ) : request.state === 'pending' ? (
        <div className="row">
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void decide('allow')}>
            {t(ticketScoped ? 'perm.allowTicket' : 'perm.allow')}
          </button>
          {taskScopable && (
            <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void decide('task')}
              aria-describedby={`${headingId}-task`}>
              {t('perm.allowTask')}
            </button>
          )}
          {trustable && (
            <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void decide('always')}
              aria-describedby={`${headingId}-always`}>
              {t('perm.always')}
            </button>
          )}
          <button type="button" className="btn btn--outline" disabled={busy} onClick={() => void decide('deny')}>
            {t('perm.deny')}
          </button>
        </div>
      ) : null}
      {connector && request.state === 'pending' && <p className="small muted">{t('perm.connector.hint')}</p>}
      {!connector && request.state === 'pending' && taskScopable && (
        <p className="small muted" id={`${headingId}-task`}>{t('perm.allowTaskHint')}</p>
      )}
      {request.state === 'pending' && trustable && (
        <p className="small muted" id={`${headingId}-always`}>{t('perm.alwaysHint')}</p>
      )}
      {request.state !== 'pending' && (
        <p className={`perm__result perm__result--${request.state}`} role="status">
          {t(request.state === 'denied' ? 'perm.denied'
            : connector ? 'perm.connector.on'
            : request.alwaysAllowed ? 'perm.allowedAlways'
            : request.taskScoped ? 'perm.allowedTask'
            : ticketScoped ? 'perm.allowedTicket' : 'perm.allowed')}
        </p>
      )}
    </section>
  );
}
