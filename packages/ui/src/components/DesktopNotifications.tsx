import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { attentionEvents, notificationsSupported, notifyEnabled, setNotifyEnabled, snapshotForNotify } from '../lib/notify';
import { ticketRef } from '../lib/format';

/**
 * Shows a system notification when a ticket moves to Needs you / Blocked or an agent asks for a
 * permission, but only while Sebeto is not in front of the owner (hidden or not focused).
 * Clicking it brings Sebeto forward and opens the ticket.
 */
export function useDesktopNotifications(): void {
  const { state, dispatch, actions } = useStore();
  const { t } = useI18n();
  const prev = useRef<ReturnType<typeof snapshotForNotify> | null>(null);
  const loaded = Object.keys(state.tickets).length > 0;

  useEffect(() => {
    if (!loaded) return;
    const events = attentionEvents(prev.current, state.tickets, state.pendingPerms);
    prev.current = snapshotForNotify(state.tickets, state.pendingPerms);
    if (!events.length || !notifyEnabled() || !notificationsSupported() || Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return; // the owner is looking at Sebeto already
    for (const e of events.slice(0, 3)) {
      const title = t(e.kind === 'permission' ? 'notify.permission' : e.kind === 'blocked' ? 'notify.blocked' : 'notify.needsYou');
      try {
        const n = new Notification(title, { body: `${ticketRef(e.ticket.number)} · ${e.ticket.title}`, tag: e.key });
        n.onclick = () => {
          window.focus();
          dispatch({ type: 'setPage', page: 'board' });
          actions.select(e.ticketId);
          n.close();
        };
      } catch { /* some browsers only allow notifications from a service worker */ }
    }
  }, [loaded, state.tickets, state.pendingPerms, t, dispatch, actions]);
}

/** Settings entry: Desktop notifications On / Off (asks the browser for permission when needed). */
export function NotificationsToggle() {
  const { t } = useI18n();
  const supported = notificationsSupported();
  const [on, setOn] = useState(() => notifyEnabled());
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() => (supported ? Notification.permission : 'unsupported'));

  const toggle = async () => {
    if (!supported) return;
    let p = Notification.permission;
    if (!on && p === 'default') {
      try { p = await Notification.requestPermission(); } catch { /* ignore */ }
      setPerm(p);
    }
    setNotifyEnabled(!on);
    setOn(!on);
  };

  const state = !supported || perm === 'denied' ? 'blocked' : on && perm === 'granted' ? 'on' : 'off';
  return (
    <button type="button" className="view-btn" onClick={() => void toggle()} disabled={!supported}
      title={state === 'blocked' ? t('notify.blockedHint') : t('notify.hint')} aria-pressed={state === 'on'}>
      <span>{t('notify.setting')}</span>
      <span className={`count${state === 'on' ? ' count--on' : ''}`}>{t(state === 'on' ? 'notify.on' : state === 'blocked' ? 'notify.blockedShort' : 'notify.off')}</span>
    </button>
  );
}
