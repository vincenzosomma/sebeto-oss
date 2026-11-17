import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';

/** Same limits as the server (services/attachments.ts). */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log,.md,.csv,.json,.yaml,.yml,.xml,.html,.eml,.conf,.ini,.py,.sh,.ps1,.docx,.xlsx,.pptx,.zip';

interface Pending { key: string; name: string; preview: string | null; state: 'uploading' | 'ready' | 'failed'; savedAs?: string; error?: string }

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

/** A pasted screenshot has no useful name: give it one with the time. */
function nameFor(file: File): string {
  if (file.name && file.name !== 'image.png') return file.name;
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `screenshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

export function Composer({ disabled }: { disabled: boolean }) {
  const { actions, api, state } = useStore();
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Pending[]>([]);
  const [drag, setDrag] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ticketId = state.selectedId;

  // Local image previews (object URLs) are freed when a chip goes away and on unmount.
  const previews = useRef(new Set<string>());
  const drop = (keep: (f: Pending) => boolean) => setFiles((cur) => {
    for (const f of cur) if (!keep(f) && f.preview) { URL.revokeObjectURL(f.preview); previews.current.delete(f.preview); }
    return cur.filter(keep);
  });
  useEffect(() => () => { previews.current.forEach((u) => URL.revokeObjectURL(u)); previews.current.clear(); }, []);
  // A different ticket: drop what was pending for the previous one.
  useEffect(() => { drop(() => false); setNote(null); }, [ticketId]);

  const add = (list: File[]) => {
    if (!ticketId || disabled || !list.length) return;
    setNote(null);
    const room = MAX_FILES - files.length;
    if (list.length > room) setNote(t('composer.tooMany', { n: MAX_FILES }));
    for (const file of list.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random()}`;
      const name = nameFor(file);
      if (file.size > MAX_BYTES) {
        setFiles((cur) => [...cur, { key, name, preview: null, state: 'failed', error: t('composer.tooBig') }]);
        continue;
      }
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
      setFiles((cur) => [...cur, { key, name, preview, state: 'uploading' }]);
      void (async () => {
        try {
          const saved = await api.uploadAttachment(ticketId, name, await toBase64(file));
          setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, state: 'ready', savedAs: saved.name } : f)));
        } catch (err) {
          setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, state: 'failed', error: err instanceof Error ? err.message : String(err) } : f)));
        }
      })();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const list = Array.from(e.clipboardData?.files ?? []);
    if (list.length) { e.preventDefault(); add(list); }
  };
  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDrag(false);
    add(Array.from(e.dataTransfer?.files ?? []));
  };

  const uploading = files.some((f) => f.state === 'uploading');
  const ready = files.filter((f) => f.state === 'ready').map((f) => f.savedAs!);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if ((!value && !ready.length) || uploading) return;
    setBusy(true);
    const ok = await actions.send(value, ready);
    setBusy(false);
    if (ok) { setText(''); drop(() => false); setNote(null); }
  };

  return (
    <form
      className={`composer${drag ? ' composer--drag' : ''}`}
      onSubmit={submit}
      onDragOver={(e) => { if (!disabled && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      {(files.length > 0 || note) && (
        <ul className="composer__files" aria-label={t('composer.files')}>
          {files.map((f) => (
            <li key={f.key} className={`att-chip att-chip--${f.state}`} title={f.error ?? f.name}>
              {f.preview ? <img src={f.preview} alt="" className="att-chip__thumb" /> : <span className="att-chip__icon" aria-hidden="true">📄</span>}
              <span className="att-chip__name">{f.savedAs ?? f.name}</span>
              {f.state === 'uploading' && <span className="small muted">{t('composer.uploading')}</span>}
              {f.state === 'failed' && <span className="small att-chip__err">{f.error}</span>}
              <button type="button" className="att-chip__x" aria-label={t('composer.remove', { name: f.name })}
                onClick={() => drop((x) => x.key !== f.key)}>×</button>
            </li>
          ))}
          {note && <li className="small muted">{note}</li>}
        </ul>
      )}
      <div className="composer__row">
        <button type="button" className="btn btn--ghost composer__attach" disabled={disabled || !ticketId}
          aria-label={t('composer.attach')} title={t('composer.attachHint')} onClick={() => fileRef.current?.click()}>📎</button>
        <input ref={fileRef} type="file" multiple accept={ACCEPT} className="tt-file" tabIndex={-1} aria-hidden="true"
          onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <label className="sr-only" htmlFor="composer-input">{t('composer.label')}</label>
        <textarea
          id="composer-input"
          className="input composer__input"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
          placeholder={t('composer.placeholder')}
          disabled={disabled}
          autoComplete="off"
        />
        <button type="submit" className="btn btn--primary" disabled={disabled || busy || uploading || (!text.trim() && !ready.length)}>
          {t('composer.send')}
        </button>
      </div>
    </form>
  );
}
