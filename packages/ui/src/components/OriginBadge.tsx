import type { TicketOrigin } from '@sebeto/shared';
import { useI18n } from '../i18n/I18nProvider';
import { originBadge } from '../lib/triggers';

/** v0.4 §D: "⚡ Alertmanager", "✉ mail", "⏰ schedule" on tickets opened by a trigger. */
export function OriginBadge({ origin }: { origin: TicketOrigin | null | undefined }) {
  const { t } = useI18n();
  const b = originBadge(origin);
  if (!b) return null;
  return (
    <span className={`origin-badge${b.untrusted ? ' origin-badge--untrusted' : ''}`} title={t('trg.origin.title', { source: origin?.source ?? b.label })}>
      <span aria-hidden="true">{b.icon}</span> {b.label}
    </span>
  );
}

/** Panel note for tickets whose content came from outside. */
export function UntrustedOriginNote({ origin }: { origin: TicketOrigin | null | undefined }) {
  const { t } = useI18n();
  if (!origin?.untrusted) return null;
  return (
    <p className="origin-note" role="note">
      <OriginBadge origin={origin} /> {t('trg.origin.untrusted')}
    </p>
  );
}
