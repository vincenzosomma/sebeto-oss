import type { Locale } from '@sebeto/shared';

const intlLocale = (l: Locale) => (l === 'it' ? 'it-IT' : 'en-US');

export function formatCost(usd: number, locale: Locale): string {
  const fmt = new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // A real but tiny spend (e.g. $0.002) must not read as "$0.00".
  if (usd > 0 && usd < 0.01) return `< ${fmt.format(0.01)}`;
  return fmt.format(usd);
}

/** Pure: "2 min ago", "yesterday", … relative to `now`. */
export function formatRelative(iso: string, locale: Locale, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto', style: 'short' });
  const sec = Math.round((then - now) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(sec / 86_400), 'day');
  return new Intl.DateTimeFormat(intlLocale(locale), { day: 'numeric', month: 'short' }).format(new Date(then));
}

export function formatTime(iso: string, locale: Locale): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit' }).format(d);
}

export const ticketRef = (n: number) => `T-${n}`;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
