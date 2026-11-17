import { useEffect, useState } from 'react';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { Dialog } from './Dialog';

const PREVIEW_LINES = 60;

/** sebeto-diagnostics-YYYY-MM-DD.json (same name the core uses for ?download=1). */
export function diagnosticsFileName(generatedAt: string): string {
  return `sebeto-diagnostics-${(generatedAt || new Date().toISOString()).slice(0, 10)}.json`;
}

/**
 * "Export diagnostics": shows what the redacted report contains and downloads it as a file.
 * The report is fetched with the bearer token in a header (never in a URL), then saved from a Blob.
 */
export function Diagnostics({ onClose }: { onClose: () => void }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [file, setFile] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getDiagnostics().then(
      (report) => {
        if (!alive) return;
        setText(JSON.stringify(report, null, 2));
        setFile(diagnosticsFileName(report.app.generatedAt));
      },
      (err: unknown) => { if (alive) setError((err as Error).message); },
    );
    return () => { alive = false; };
  }, [api]);

  const download = () => {
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaved(true);
  };

  const lines = text?.split('\n') ?? [];
  return (
    <Dialog title={t('dg.title')} onClose={onClose}>
      <p className="small">{t('dg.intro')}</p>
      <ul className="dg-facts small">
        <li>{t('dg.includes')}</li>
        <li>{t('dg.excludes')}</li>
      </ul>
      {error ? (
        <p className="dg-error small" role="alert">{t('dg.error', { message: error })}</p>
      ) : text === null ? (
        <p className="small muted" role="status">{t('dg.loading')}</p>
      ) : (
        <>
          <div className="dg-preview-head">
            <span className="section-label">{t('dg.preview')}</span>
            <span className="small muted">{t('dg.lines', { shown: Math.min(PREVIEW_LINES, lines.length), total: lines.length })}</span>
          </div>
          <pre className="dg-preview" tabIndex={0} aria-label={t('dg.preview')}>{lines.slice(0, PREVIEW_LINES).join('\n')}</pre>
        </>
      )}
      <div className="dg-actions">
        {saved && <span className="small muted" role="status">{t('dg.downloaded', { file })}</span>}
        <button type="button" className="btn btn--primary" onClick={download} disabled={text === null}>
          {t('dg.download')}
        </button>
      </div>
    </Dialog>
  );
}
