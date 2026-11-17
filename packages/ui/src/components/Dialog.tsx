import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n/I18nProvider';

/** Modal dialog on the native <dialog> element (focus trap, Esc and backdrop handled by the browser). */
export function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog--wide' : ''}`}
      aria-labelledby="dialog-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="dialog__body">
        <header className="dialog__head">
          <h2 id="dialog-title" className="dialog__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('dialog.close')}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
