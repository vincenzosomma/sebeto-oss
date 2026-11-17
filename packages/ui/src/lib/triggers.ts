/** Pure helpers for Settings → Triggers (v0.4 §D): friendly schedules, call examples, origin badges. */
import { WEBHOOK_PRESET_LABELS, type TicketOrigin, type WebhookPreset } from '@sebeto/shared';

export type ScheduleMode = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'advanced';
export interface FriendlySchedule { mode: ScheduleMode; time: string; weekday: number }

const pad = (n: number) => String(n).padStart(2, '0');

/** "Every day at 08:00" etc. → a 5-field cron. Advanced keeps the given cron. */
export function scheduleToCron(s: FriendlySchedule, advanced = ''): string {
  if (s.mode === 'advanced') return advanced.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.time.trim());
  const h = m ? Math.min(23, Number(m[1])) : 8;
  const mi = m ? Math.min(59, Number(m[2])) : 0;
  switch (s.mode) {
    case 'daily': return `${mi} ${h} * * *`;
    case 'weekdays': return `${mi} ${h} * * 1-5`;
    case 'weekly': return `${mi} ${h} * * ${s.weekday}`;
    case 'monthly': return `${mi} ${h} 1 * *`;
  }
}

/** Recognise a cron made by scheduleToCron (to edit it with the friendly controls); else advanced. */
export function cronToSchedule(cron: string): FriendlySchedule {
  const f = cron.trim().split(/\s+/);
  const fallback: FriendlySchedule = { mode: 'advanced', time: '08:00', weekday: 1 };
  if (f.length !== 5 || !/^\d{1,2}$/.test(f[0]!) || !/^\d{1,2}$/.test(f[1]!)) return fallback;
  const time = `${pad(Number(f[1]))}:${pad(Number(f[0]))}`;
  const [, , dom, mon, dow] = f as [string, string, string, string, string];
  if (mon !== '*') return fallback;
  if (dom === '*' && dow === '*') return { mode: 'daily', time, weekday: 1 };
  if (dom === '*' && dow === '1-5') return { mode: 'weekdays', time, weekday: 1 };
  if (dom === '*' && /^[0-6]$/.test(dow)) return { mode: 'weekly', time, weekday: Number(dow) };
  if (dom === '1' && dow === '*') return { mode: 'monthly', time, weekday: 1 };
  return fallback;
}

/** Sample JSON a script could send (the generic preset understands these fields). */
export const SAMPLE_BODY = '{"title":"Disk almost full","message":"C: on FS01 has 4% free","severity":"warning","host":"fs01"}';

export function curlExample(url: string, secret: string): string {
  return `curl -X POST "${url}" -H "Authorization: Bearer ${secret}" -H "Content-Type: application/json" -d '${SAMPLE_BODY}'`;
}

export function powershellExample(url: string, secret: string): string {
  return `Invoke-RestMethod -Method Post -Uri "${url}" -Headers @{ Authorization = "Bearer ${secret}" } -ContentType "application/json" -Body '${SAMPLE_BODY}'`;
}

/** Full webhook URL from the page origin (the core serves the UI) and the hook path. */
export function hookUrl(origin: string, hookPath: string | null): string {
  return `${origin.replace(/\/+$/, '')}${hookPath ?? ''}`;
}

/** Icon + short label for a ticket origin badge; null when there is nothing to show. */
export function originBadge(origin: TicketOrigin | null | undefined): { icon: string; label: string; untrusted: boolean } | null {
  if (!origin || origin.kind !== 'trigger') return null;
  const untrusted = origin.untrusted;
  if (origin.triggerKind === 'schedule') return { icon: '⏰', label: 'schedule', untrusted };
  if (origin.triggerKind === 'mail') return { icon: '✉', label: 'mail', untrusted };
  return { icon: '⚡', label: origin.source || 'webhook', untrusted };
}

export const PRESETS: WebhookPreset[] = ['alertmanager', 'grafana', 'uptime-kuma', 'zabbix', 'generic'];
export const presetLabel = (p: WebhookPreset) => WEBHOOK_PRESET_LABELS[p];
