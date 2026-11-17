/** Left menu → "Deleted tickets": restore a ticket, or delete it forever (with its conversation and folder). */
import { useCallback, useEffect, useState } from 'react';
import type { Ticket } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, formatCost, formatRelative, ticketRef } from '../lib/format';
import { HeaderActions } from './HeaderActions';

export function DeletedTicketsPage({ onMenu }: { onMenu: () => void }) {
  const { api, state } = useStore();
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Ticket[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all: Ticket[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await api.listTickets({ deleted: true, limit: 200, ...(cursor ? { cursor } : {}) });
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && all.length < 1000);
      // Most recently deleted first.
      setItems(all.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? '')));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api]);
  // Reload when the board changes size (a ticket deleted or restored elsewhere).
  const boardSize = Object.keys(state.tickets).length;
  useEffect(() => { void load(); }, [load, boardSize]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(null); }
  };
  const purge = (tk: Ticket) => {
    if (!window.confirm(t('del.purgeConfirm', { ref: ticketRef(tk.number), title: tk.title }))) return;
    void act(tk.id, () => api.purgeTicket(tk.id));
  };
  const purgeAll = () => {
    if (!items?.length || !window.confirm(t('del.purgeAllConfirm', { n: items.length }))) return;
    void act('all', async () => { for (const tk of items) await api.purgeTicket(tk.id); });
  };

  return (
    <div className="sec deleted-page">
      <header className="header">
        <button type="button" className="icon-btn header__menu" onClick={onMenu} aria-label={t('header.menu')}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="header__text">
          <h1 className="header__title">{t('del.title')}</h1>
          <p className="header__summary">{t('del.summary')}</p>
        </div>
        {!!items?.length && (
          <button type="button" className="btn btn--outline btn--sm del-purge" disabled={!!busy} onClick={purgeAll}>{t('del.purgeAll')}</button>
        )}
        <HeaderActions />
      </header>
      {error && <p className="mail-error" role="alert">{error}</p>}
      {!items ? <p className="small muted" role="status">{t('panel.loading')}</p>
        : items.length === 0 ? <p className="trusted__empty">{t('del.empty')}</p>
        : (
          <ul className="del-list">
            {items.map((tk) => (
              <li key={tk.id} className="del-item">
                <div className="del-item__main">
                  <span className="small muted">{ticketRef(tk.number)}</span>
                  <strong className="del-item__title">{tk.title}</strong>
                  <span className="small muted">
                    {t('del.meta', { when: tk.deletedAt ? formatRelative(tk.deletedAt, locale) : '', cost: formatCost(tk.costUsd, locale) })}
                  </span>
                </div>
                <span className="row del-item__actions">
                  <button type="button" className="btn btn--primary btn--sm" disabled={!!busy} onClick={() => void act(tk.id, () => api.restoreTicket(tk.id))}>
                    {busy === tk.id ? t('del.working') : t('del.restore')}
                  </button>
                  <button type="button" className="btn btn--ghost btn--sm del-item__purge" disabled={!!busy} onClick={() => purge(tk)}>{t('del.purge')}</button>
                </span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
