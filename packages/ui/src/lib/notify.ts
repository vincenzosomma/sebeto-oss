/**
 * Desktop notifications: tell the owner when something needs them while Sebeto is not in front of
 * them. Pure decision logic lives here (tested); the hook in Shell.tsx shows the notifications.
 */
import type { Id, Ticket, TicketStatus } from '@sebeto/shared';

export interface NotifyEvent {
  key: string;
  ticketId: Id;
  kind: 'needs_you' | 'blocked' | 'permission';
  ticket: Pick<Ticket, 'number' | 'title'>;
  detail?: string;
}

const ATTENTION: readonly TicketStatus[] = ['needs_you', 'blocked'];

/**
 * What changed since the last look: tickets that moved INTO Needs you / Blocked, and permission
 * requests that are new. The first look (prev === null) only records the state: no flood of old news.
 */
export function attentionEvents(
  prev: { statuses: Record<Id, TicketStatus>; perms: Set<Id> } | null,
  tickets: Record<Id, Ticket>,
  pendingPerms: Record<Id, Id>,
  permTitles: Record<Id, string> = {},
): NotifyEvent[] {
  if (!prev) return [];
  const out: NotifyEvent[] = [];
  for (const t of Object.values(tickets)) {
    const before = prev.statuses[t.id];
    if (before !== undefined && before !== t.status && ATTENTION.includes(t.status)) {
      out.push({ key: `${t.id}:${t.status}:${t.updatedAt}`, ticketId: t.id, kind: t.status as 'needs_you' | 'blocked', ticket: t });
    }
  }
  for (const [permId, ticketId] of Object.entries(pendingPerms)) {
    const t = tickets[ticketId];
    if (!prev.perms.has(permId) && t) {
      out.push({ key: `perm:${permId}`, ticketId, kind: 'permission', ticket: t, detail: permTitles[permId] });
    }
  }
  // A permission request also moves the ticket to Needs you: say it once, with the more useful text.
  const permTickets = new Set(out.filter((e) => e.kind === 'permission').map((e) => e.ticketId));
  return out.filter((e) => !(e.kind === 'needs_you' && permTickets.has(e.ticketId)));
}

export function snapshotForNotify(tickets: Record<Id, Ticket>, pendingPerms: Record<Id, Id>) {
  return {
    statuses: Object.fromEntries(Object.values(tickets).map((t) => [t.id, t.status])) as Record<Id, TicketStatus>,
    perms: new Set(Object.keys(pendingPerms)),
  };
}

const PREF_KEY = 'sebeto.notify';

/** Per-browser preference; default on. */
export function notifyEnabled(): boolean {
  try { return localStorage.getItem(PREF_KEY) !== 'off'; } catch { return true; }
}

export function setNotifyEnabled(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}
