import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { splitAttachmentNote, type Id, type Message } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { formatTime } from '../lib/format';
import { RichText } from './RichText';

/** Consecutive messages from the same author within this gap are grouped under one header. */
const GROUP_GAP_MS = 5 * 60_000;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0]![0]! + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** A chat bubble that clamps long prose behind "Show more". Code-bearing messages are left whole
 * (their code panes scroll on their own), so a snippet is never hidden behind a fade. */
function Bubble({ text }: { text: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [open, setOpen] = useState(false);
  const clampable = !text.includes('```');

  useLayoutEffect(() => {
    if (!clampable) { setOverflow(false); return; }
    const el = ref.current;
    if (el) setOverflow(el.scrollHeight - el.clientHeight > 4);
  }, [text, open, clampable]);

  const clamp = clampable && !open;
  return (
    <>
      <div
        ref={ref}
        className={`msg__bubble msg__bubble--rich${clamp ? ' msg__bubble--clamp' : ''}${overflow && clamp ? ' msg__bubble--faded' : ''}`}
      >
        <RichText text={text} />
      </div>
      {clampable && (overflow || open) && (
        <button type="button" className="msg__more" onClick={() => setOpen((o) => !o)}>
          {open ? t('chat.showLess') : t('chat.showMore')}
        </button>
      )}
    </>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

/** Files the owner attached to a message: image previews, other files as download buttons. */
function Attachments({ ticketId, files }: { ticketId: Id; files: string[] }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    for (const f of files.filter((n) => IMAGE.test(n))) {
      api.getAttachment(ticketId, f).then((b) => {
        const u = URL.createObjectURL(b);
        made.push(u);
        if (live) setUrls((cur) => ({ ...cur, [f]: u }));
      }, () => { if (live) setUrls((cur) => ({ ...cur, [f]: null })); });
    }
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [api, ticketId, files.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (name: string) => {
    try {
      const u = URL.createObjectURL(await api.getAttachment(ticketId, name));
      const a = document.createElement('a');
      a.href = u;
      if (!IMAGE.test(name) && !/\.(pdf|txt|log|md|csv|json)$/i.test(name)) a.download = name;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 60_000);
    } catch { /* missing file: nothing to open */ }
  };

  return (
    <ul className="msg__files" aria-label={t('chat.attachments')}>
      {files.map((f) => (
        <li key={f}>
          {IMAGE.test(f) && urls[f]
            ? <button type="button" className="msg__img" onClick={() => void open(f)} title={f}><img src={urls[f]!} alt={f} /></button>
            : <button type="button" className="att-chip att-chip--ready" onClick={() => void open(f)} title={t('chat.openFile')}>
                <span className="att-chip__icon" aria-hidden="true">{IMAGE.test(f) ? '🖼' : '📄'}</span>
                <span className="att-chip__name">{f}</span>
              </button>}
        </li>
      ))}
    </ul>
  );
}

export function Chat({ messages }: { messages: Message[] }) {
  const { t, locale } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1]?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [last]);

  return (
    <section className="chat" aria-labelledby="chat-h">
      <h3 className="section-label" id="chat-h">{t('chat.heading')}</h3>
      {messages.length === 0 && <p className="small muted">{t('chat.empty')}</p>}
      <ol className="chat__list" aria-live="polite" aria-relevant="additions">
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          // Group consecutive messages from the same author (unless it's a system note, or there was
          // a long pause): only the first in a run shows the author + time header.
          const cont = !!prev && prev.role === m.role && prev.author === m.author && m.role !== 'system'
            && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_GAP_MS;
          const who = m.role === 'user' ? t('chat.you') : m.author;
          return (
            <li key={m.id} className={`msg msg--${m.role}${cont ? ' msg--cont' : ''}`}>
              {m.role !== 'system' && !cont && (
                <span className="msg__who">
                  {m.role !== 'user' && <span className="msg__avatar" aria-hidden="true">{initials(who)}</span>}
                  <span className="msg__name">{who}</span>
                  <time className="msg__time" dateTime={m.createdAt}>{formatTime(m.createdAt, locale)}</time>
                </span>
              )}
              {m.role === 'system'
                ? <div className="msg__bubble">{m.text}</div>
                : (() => {
                    const split = m.role === 'user' ? splitAttachmentNote(m.text) : { text: m.text, files: [] };
                    return (
                      <>
                        {split.text.trim() && !(split.files.length && split.text.trim() === 'See the attached file(s).') && <Bubble text={split.text} />}
                        {split.files.length > 0 && <Attachments ticketId={m.ticketId} files={split.files} />}
                      </>
                    );
                  })()}
            </li>
          );
        })}
      </ol>
      <div ref={endRef} />
    </section>
  );
}
