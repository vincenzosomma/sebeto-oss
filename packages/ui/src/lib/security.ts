/** Pure helpers for the Security page (v0.4 B). */
import { LOCKDOWN_MESSAGE, TEAM_POLICY_ERRORS, type SecurityEventsQuery } from '@sebeto/shared';
import type { MessageKey } from '../i18n/catalog';

/** v0.5 I: true for the core's 409 `lockdown` (emergency stop on); works on errors and on stored messages. */
export function isLockdownError(err: unknown): boolean {
  if (typeof err === 'string') return err === LOCKDOWN_MESSAGE;
  return !!err && typeof err === 'object' && ((err as { code?: unknown }).code === TEAM_POLICY_ERRORS.lockdown || (err as { message?: unknown }).message === LOCKDOWN_MESSAGE);
}

/** The plain, translated text for a refused request during the emergency stop, else null. */
export function lockdownErrorKey(err: unknown): MessageKey | null {
  return isLockdownError(err) ? 'sec.lockdown.refused' : null;
}

export type TimeRange = '1h' | '24h' | '7d' | '30d' | 'all';
export const TIME_RANGES: readonly TimeRange[] = ['1h', '24h', '7d', '30d', 'all'];
const RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export interface SecurityFilters {
  range: TimeRange;
  category: string; // '' = all
  severity: string; // '' = all, or a comma list
  agentId: string;
  ticket: string; // "T-12", "12" or ''
  q: string;
}

export const EMPTY_FILTERS: SecurityFilters = { range: '7d', category: '', severity: '', agentId: '', ticket: '', q: '' };

/** "T-12", "t12", " 12 " → 12; anything else → undefined. */
export function parseTicketNumber(s: string): number | undefined {
  const m = /^\s*(?:t-?)?(\d{1,9})\s*$/i.exec(s);
  return m ? Number(m[1]) : undefined;
}

/** Filters → API query (newest first; the API paginates). */
export function toQuery(f: SecurityFilters, now: number = Date.now()): SecurityEventsQuery {
  const q: SecurityEventsQuery = { limit: 50 };
  if (f.range !== 'all') q.since = new Date(now - RANGE_MS[f.range]).toISOString();
  if (f.category) q.category = f.category;
  if (f.severity) q.severity = f.severity;
  if (f.agentId) q.agentId = f.agentId;
  const n = parseTicketNumber(f.ticket);
  if (n !== undefined) q.ticketNumber = n;
  if (f.q.trim()) q.q = f.q.trim();
  return q;
}

export function filtersActive(f: SecurityFilters): boolean {
  return f.category !== '' || f.severity !== '' || f.agentId !== '' || f.ticket.trim() !== '' || f.q.trim() !== '' || f.range !== EMPTY_FILTERS.range;
}

/** Retention choices shown in settings (0 = forever). */
export const RETENTION_CHOICES: readonly number[] = [0, 30, 90, 180, 365, 730];

/** Save a Blob as a file in the browser (desktop shell: the normal download prompt). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
