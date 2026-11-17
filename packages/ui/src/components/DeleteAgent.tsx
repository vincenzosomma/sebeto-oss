/**
 * "Delete agent" in the agent editor: a confirmation that says what will happen (open tickets move to
 * the default agent, reports move up), then DELETE /agents/:id. Busy / last-agent refusals in plain words.
 */
import { useMemo, useState } from 'react';
import type { Agent } from '@sebeto/shared';
import { ApiHttpError } from '../api/types';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage } from '../lib/format';
import { deletePlan, plural } from '../lib/agents';
import { Dialog } from './Dialog';

export function DeleteAgentButton({ agent, agents, onDeleted }: {
  agent: Agent;
  agents: Agent[];
  /** Called after the core deleted the agent, with a short summary for the page. */
  onDeleted: (summary: string) => void;
}) {
  const { state, api, dispatch } = useStore();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = useMemo(() => deletePlan(agents, Object.values(state.tickets), agent.id), [agents, state.tickets, agent.id]);

  const close = () => { if (!busy) { setOpen(false); setError(null); } };

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.deleteAgent(agent.id);
      dispatch({ type: 'agentRemoved', id: agent.id });
      setOpen(false);
      onDeleted(t('oc.del.done', { name: agent.name, tickets: r.reassignedTickets, reports: r.movedReports }));
    } catch (err) {
      const code = err instanceof ApiHttpError ? err.code : '';
      setError(code === 'agent_busy' ? t('oc.del.busy', { name: agent.name })
        : code === 'last_agent' ? t('oc.del.last', { name: agent.name })
          : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const name = agent.name;
  const target = plan.target?.name ?? '';
  const tickets = plan.openTickets === 0
    ? t('oc.del.tickets0', { name })
    : plural(t, plan.openTickets, 'oc.del.tickets1', 'oc.del.tickets', { target });
  const reports = plan.reports === 0
    ? t('oc.del.reports0', { name })
    : plan.manager
      ? plural(t, plan.reports, 'oc.del.reports1', 'oc.del.reports', { manager: plan.manager.name })
      : plural(t, plan.reports, 'oc.del.reportsTop1', 'oc.del.reportsTop');

  return (
    <>
      <button type="button" className="btn btn--danger" onClick={() => setOpen(true)}>{t('oc.del.button')}</button>
      {open && (
        <Dialog title={t('oc.del.title', { name })} onClose={close}>
          {plan.last ? (
            <p className="oc-del__error" role="alert">{t('oc.del.last', { name })}</p>
          ) : (
            <ul className="oc-del__list">
              <li>{tickets}</li>
              <li>{reports}</li>
            </ul>
          )}
          <p className="small muted">{t('oc.del.keep')}</p>
          {error && <p className="oc-del__error" role="alert">{error}</p>}
          <div className="oc-del__actions">
            <button type="button" className="btn btn--outline" onClick={close} disabled={busy} autoFocus>{t('oc.del.cancel')}</button>
            <button type="button" className="btn oc-del__confirm" onClick={() => void confirm()} disabled={busy || plan.last}>
              {busy ? t('oc.del.deleting') : t('oc.del.confirm')}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
