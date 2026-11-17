/**
 * The Memory page (v0.4 §E): the team's linked notes as a map (graph), a list, and the agents'
 * proposals waiting for approval. Notes open in a viewer with links/backlinks, Edit, Delete (to
 * the trash) and "Open in Obsidian". Refreshes on the `memory.changed` event.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  MEMORY_KINDS, memoryKey,
  type Id, type MemoryGraph as Graph, type MemoryGraphNode, type MemoryInfo, type MemoryKind, type MemoryNote, type MemoryNoteDetail,
} from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage, formatRelative } from '../lib/format';
import { wikiToLinks } from '../lib/memory-graph';
import { Dialog } from './Dialog';
import { MemoryGraph } from './MemoryGraph';
import { RichText } from './RichText';
import { HeaderActions } from './HeaderActions';

type Tab = 'graph' | 'list' | 'proposals';
const kindKey = (k: MemoryKind | 'missing') => `mem.kind.${k}` as MessageKey;

export function MemoryPage({ onMenu }: { onMenu: () => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const version = state.versions['memory.changed'] ?? 0;
  const [tab, setTab] = useState<Tab>(() => (typeof window !== 'undefined' && window.innerWidth < 600 ? 'list' : 'graph'));
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [team, setTeam] = useState('');
  const [kind, setKind] = useState<MemoryKind | ''>('');
  const [showProposed, setShowProposed] = useState(false);
  const [center, setCenter] = useState<{ id: Id; title: string } | null>(null);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const [proposals, setProposals] = useState<MemoryNote[]>([]);
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [openId, setOpenId] = useState<Id | null>(null);
  const [editing, setEditing] = useState<MemoryNoteDetail | 'new' | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  const filterKey = JSON.stringify({ query, team, kind, showProposed, center: center?.id ?? null, depth });
  const load = useCallback(async () => {
    const f = JSON.parse(filterKey) as { query: string; team: string; kind: MemoryKind | ''; showProposed: boolean; center: Id | null; depth: 1 | 2 };
    try {
      const [g, list, props, i] = await Promise.all([
        api.memoryGraph({ ...(f.team ? { team: f.team } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.query ? { q: f.query } : {}), ...(f.center ? { center: f.center, depth: f.depth } : {}), proposed: f.showProposed }),
        api.listMemoryNotes({ ...(f.team ? { team: f.team } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.query ? { q: f.query } : {}), status: 'approved', limit: 300 }),
        api.listMemoryNotes({ status: 'proposed', limit: 200 }),
        api.memoryInfo(),
      ]);
      setGraph(g); setNotes(list); setProposals(props); setInfo(i);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api, filterKey]);
  useEffect(() => { void load(); }, [load, version]);

  const teams = useMemo(() => Object.values(state.teams ?? {}).sort((a, b) => a.name.localeCompare(b.name)), [state.teams]);

  const run = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key); setError(null); setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const reindex = () => run('reindex', async () => {
    const r = await api.reindexMemory();
    return t('mem.reindexed', { notes: r.notes, links: r.links });
  });
  const backfill = () => run('backfill', async () => {
    setConfirmBackfill(false);
    const r = await api.backfillMemory({});
    return t('mem.backfill.done', { written: r.written, skipped: r.skipped });
  });

  /** Open a note by link name: an existing note, else offer to write it. */
  const openByName = useCallback(async (name: string) => {
    const key = memoryKey(name);
    const all = [...(notes ?? []), ...proposals];
    const hit = all.find((n) => memoryKey(n.title) === key);
    if (hit) { setOpenId(hit.id); return; }
    try {
      const rel = await api.memoryRelated(name);
      if (rel.note && memoryKey(rel.note.title) === key) { setOpenId(rel.note.id); return; }
    } catch { /* fall through */ }
    setNewTitle(name);
    setEditing('new');
  }, [api, notes, proposals]);

  const openNode = (n: MemoryGraphNode) => {
    if (n.kind === 'missing') { setNewTitle(n.title); setEditing('new'); }
    else setOpenId(n.id);
  };

  const summary = info
    ? info.proposed ? t('mem.summaryProposed', { notes: info.notes, links: info.links, proposed: info.proposed }) : t('mem.summary', { notes: info.notes, links: info.links })
    : '';

  return (
    <div className="mem">
      <header className="header">
        <button type="button" className="icon-btn header__menu" onClick={onMenu} aria-label={t('header.menu')}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="header__text">
          <h1 className="header__title">{t('mem.title')}</h1>
          <p className="header__summary">{summary}</p>
        </div>
        <div className="mem-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => { setNewTitle(''); setEditing('new'); }}>{t('mem.new')}</button>
          <button type="button" className="btn btn--outline btn--sm" disabled={busy !== null} onClick={() => void reindex()}>{busy === 'reindex' ? t('mem.reindexing') : t('mem.reindex')}</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => setConfirmBackfill(true)}>{t('mem.backfill')}</button>
        </div>
        <HeaderActions />
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setError(null)}>{t('error.dismiss')}</button>
        </div>
      )}
      <div className="mem-body">
        <p className="small muted">{t('mem.intro')}</p>
        {notice && <p className="ss-toast" role="status">{notice}<button type="button" className="tg__x" aria-label={t('dialog.close')} onClick={() => setNotice(null)}>×</button></p>}
        <div className="mem-tabs" role="tablist">
          {(['graph', 'list', 'proposals'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`trg-tab${tab === k ? ' trg-tab--on' : ''}`} onClick={() => setTab(k)}>
              {t(`mem.tab.${k}` as MessageKey)}{k === 'proposals' && proposals.length > 0 && <span className="count mem-count">{proposals.length}</span>}
            </button>
          ))}
        </div>

        {tab !== 'proposals' && (
          <div className="mem-filters">
            <input className="input mem-search" type="search" value={q} placeholder={t('mem.search.placeholder')} aria-label={t('mem.search')} onChange={(e) => setQ(e.target.value)} />
            <select className="input" value={team} aria-label={t('mem.filter.team')} onChange={(e) => setTeam(e.target.value)}>
              <option value="">{t('mem.filter.teamAll')}</option>
              {teams.map((tm) => <option key={tm.id} value={tm.slug}>{tm.name}</option>)}
            </select>
            <select className="input" value={kind} aria-label={t('mem.filter.kind')} onChange={(e) => setKind(e.target.value as MemoryKind | '')}>
              <option value="">{t('mem.filter.kindAll')}</option>
              {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(kindKey(k))}</option>)}
            </select>
            {tab === 'graph' && (
              <label className="row small mem-check">
                <input type="checkbox" checked={showProposed} onChange={(e) => setShowProposed(e.target.checked)} /> {t('mem.showProposed')}
              </label>
            )}
          </div>
        )}
        {tab === 'graph' && center && (
          <div className="mem-center row small">
            <span>{t('mem.center.label', { title: center.title })}</span>
            <label className="row">{t('mem.depth')}
              <select className="input input--sm" value={depth} onChange={(e) => setDepth(Number(e.target.value) as 1 | 2)}>
                <option value={1}>1</option><option value={2}>2</option>
              </select>
            </label>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCenter(null)}>{t('mem.center.clear')}</button>
          </div>
        )}

        {tab === 'graph' && (graph === null ? <p className="small muted">{t('mem.loading')}</p> : graph.nodes.length === 0 ? (
          <p className="trusted__empty">{t('mem.graph.empty')}</p>
        ) : (
          <>
            <MemoryGraph graph={graph} selectedId={openId} onOpen={openNode} />
            <div className="mem-legend small muted">
              {(['system', 'app', 'cve', 'runbook', 'decision', 'person', 'ticket', 'note'] as const).filter((k) => graph.nodes.some((n) => n.kind === k)).map((k) => (
                <span key={k} className="mem-legend__item"><span className={`mem-dot mem-dot--${k}`} aria-hidden="true" />{t(kindKey(k))}</span>
              ))}
              {graph.nodes.some((n) => n.kind === 'missing') && <span className="mem-legend__item"><span className="mem-dot mem-dot--missing" aria-hidden="true" />{t('mem.legend.missing')}</span>}
              {graph.nodes.some((n) => n.untrusted) && <span className="mem-legend__item"><span className="mem-dot mem-dot--untrusted" aria-hidden="true" />{t('mem.legend.untrusted')}</span>}
              <span className="mem-legend__hint">{t('mem.graph.hint')}</span>
            </div>
            {graph.truncated && <p className="small muted">{t('mem.truncated')}</p>}
          </>
        ))}

        {tab === 'list' && (notes === null ? <p className="small muted">{t('mem.loading')}</p> : notes.length === 0 ? (
          <p className="trusted__empty">{query || team || kind ? t('mem.list.empty') : t('mem.graph.empty')}</p>
        ) : (
          <ul className="ss-list">
            {notes.map((n) => <NoteRow key={n.id} note={n} onOpen={() => setOpenId(n.id)} />)}
          </ul>
        ))}

        {tab === 'proposals' && (
          <>
            <p className="small muted">{t('mem.proposals.intro')}</p>
            {proposals.length === 0 ? <p className="trusted__empty">{t('mem.proposals.empty')}</p> : (
              <ul className="ss-list">
                {proposals.map((n) => (
                  <NoteRow key={n.id} note={n} onOpen={() => setOpenId(n.id)}>
                    <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null} onClick={() => void run(`ap-${n.id}`, async () => { await api.approveMemoryNote(n.id); return null; })}>{t('mem.approve')}</button>
                    <ConfirmDelete title={n.title} disabled={busy !== null} onConfirm={() => void run(`del-${n.id}`, async () => { await api.deleteMemoryNote(n.id); return null; })} />
                  </NoteRow>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {openId && (
        <NoteViewer
          id={openId}
          version={version}
          onClose={() => setOpenId(null)}
          onOpenName={(name) => void openByName(name)}
          onOpenId={setOpenId}
          onEdit={(d) => { setOpenId(null); setEditing(d); }}
          onCenter={(d) => { setCenter({ id: d.id, title: d.title }); setTab('graph'); setOpenId(null); }}
          onDeleted={() => { setOpenId(null); void load(); }}
          onApproved={() => void load()}
        />
      )}
      {editing && (
        <NoteEditor
          note={editing === 'new' ? null : editing}
          initialTitle={newTitle}
          onClose={() => setEditing(null)}
          onSaved={(d) => { setEditing(null); setOpenId(d.id); void load(); }}
        />
      )}
      {confirmBackfill && (
        <Dialog title={t('mem.backfill.title')} onClose={() => setConfirmBackfill(false)}>
          <p>{t('mem.backfill.body')}</p>
          <div className="row dialog__actions">
            <button type="button" className="btn btn--primary" onClick={() => void backfill()}>{t('mem.backfill.confirm')}</button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmBackfill(false)}>{t('mem.cancel')}</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Badges({ note }: { note: Pick<MemoryNote, 'kind' | 'provenance' | 'untrusted' | 'status'> }) {
  const { t } = useI18n();
  return (
    <>
      <span className={`chip mem-kind mem-kind--${note.kind}`}>{t(kindKey(note.kind))}</span>
      <span className={`chip mem-prov mem-prov--${note.provenance}`}>{t(`mem.prov.${note.provenance}` as MessageKey)}</span>
      {note.untrusted && <span className="chip mem-untrusted" title={t('mem.badge.untrustedHint')}>⚠ {t('mem.badge.untrusted')}</span>}
      {note.status === 'proposed' && <span className="chip mem-proposed">{t('mem.badge.proposed')}</span>}
    </>
  );
}

function NoteRow({ note, onOpen, children }: { note: MemoryNote; onOpen: () => void; children?: ReactNode }) {
  const { t, locale } = useI18n();
  return (
    <li className="ss-row">
      <div className="ss-row__main">
        <div className="ss-row__head">
          <button type="button" className="mem-title-btn" onClick={onOpen}><strong className="ss-row__title">{note.title}</strong></button>
          <Badges note={note} />
        </div>
        {note.excerpt && <p className="ss-row__summary small">{note.excerpt}</p>}
        <div className="ss-row__meta small muted">
          {note.teamSlug && <span className="tg tg--small">{note.teamSlug}</span>}
          {note.tags.map((tag) => <span key={tag} className="tg tg--small">#{tag}</span>)}
          <span>↗ {note.linkCount} · ↙ {note.backlinkCount}</span>
          <span>{t('mem.updated', { when: formatRelative(note.updatedAt, locale) })}</span>
        </div>
      </div>
      {children && <div className="ss-row__actions">{children}</div>}
    </li>
  );
}

function ConfirmDelete({ title, disabled, onConfirm }: { title: string; disabled?: boolean; onConfirm: () => void }) {
  const { t } = useI18n();
  const [ask, setAsk] = useState(false);
  if (!ask) return <button type="button" className="btn btn--ghost btn--sm pj-del" disabled={disabled} onClick={() => setAsk(true)}>{t('mem.delete')}</button>;
  return (
    <span className="row ss-confirm">
      <span className="small">{t('mem.delete.confirm', { title })}</span>
      <button type="button" className="btn btn--danger btn--sm" onClick={() => { setAsk(false); onConfirm(); }}>{t('mem.delete')}</button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsk(false)}>{t('mem.cancel')}</button>
    </span>
  );
}

function NoteViewer({ id, version, onClose, onOpenName, onOpenId, onEdit, onCenter, onDeleted, onApproved }: {
  id: Id; version: number; onClose: () => void; onOpenName: (name: string) => void; onOpenId: (id: Id) => void;
  onEdit: (d: MemoryNoteDetail) => void; onCenter: (d: MemoryNoteDetail) => void; onDeleted: () => void; onApproved: () => void;
}) {
  const { api } = useStore();
  const { t, locale } = useI18n();
  const [d, setD] = useState<MemoryNoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    api.getMemoryNote(id).then(setD, (e) => setError(errorMessage(e)));
  }, [api, id, version]);
  const body = useMemo(() => (d ? wikiToLinks(d.body.replace(/<!--\s*sebeto:auto-end\s*-->/g, '\n---\n')) : ''), [d]);
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Dialog title={d?.title ?? t('mem.loading')} onClose={onClose} wide>
      {error && <p className="mail-error" role="alert">{error}</p>}
      {!d && !error && <p className="small muted">{t('mem.loading')}</p>}
      {d && (
        <div className="mem-viewer">
          <div className="row mem-viewer__badges">
            <Badges note={d} />
            {d.teamSlug && <span className="tg tg--small">{d.teamSlug}</span>}
            {d.tags.map((tag) => <span key={tag} className="tg tg--small">#{tag}</span>)}
            <span className="small muted">{t('mem.updated', { when: formatRelative(d.updatedAt, locale) })}</span>
          </div>
          {d.untrusted && <p className="small mem-warn">{t('mem.badge.untrustedHint')}</p>}
          <div className="mem-viewer__body"><RichText text={body} onInternalLink={onOpenName} /></div>
          <div className="mem-viewer__links">
            <section>
              <h3 className="section-label">{t('mem.links')}</h3>
              {d.links.length ? (
                <ul className="tg-cloud">{d.links.map((l) => <li key={l}><button type="button" className="tg" onClick={() => onOpenName(l)}>{l}</button></li>)}</ul>
              ) : <p className="small muted">{t('mem.noLinks')}</p>}
            </section>
            <section>
              <h3 className="section-label">{t('mem.backlinks')}</h3>
              {d.backlinks.length ? (
                <ul className="tg-cloud">{d.backlinks.map((b) => <li key={b.id}><button type="button" className="tg" onClick={() => onOpenId(b.id)}>{b.title}</button></li>)}</ul>
              ) : <p className="small muted">{t('mem.noLinks')}</p>}
            </section>
          </div>
          <p className="small muted mem-path">{d.path}</p>
          <div className="row dialog__actions mem-viewer__actions">
            {d.status === 'proposed' && (
              <button type="button" className="btn btn--primary btn--sm" onClick={() => void act(async () => { setD(await api.approveMemoryNote(d.id)); onApproved(); })}>{t('mem.approve')}</button>
            )}
            <button type="button" className="btn btn--outline btn--sm" onClick={() => onEdit(d)}>{t('mem.edit')}</button>
            {d.status === 'approved' && <button type="button" className="btn btn--ghost btn--sm" onClick={() => onCenter(d)}>{t('mem.center')}</button>}
            <a className="btn btn--ghost btn--sm" href={d.obsidianUrl}>{t('mem.obsidian')}</a>
            <ConfirmDelete title={d.title} onConfirm={() => void act(async () => { await api.deleteMemoryNote(d.id); onDeleted(); })} />
          </div>
        </div>
      )}
    </Dialog>
  );
}

function NoteEditor({ note, initialTitle, onClose, onSaved }: { note: MemoryNoteDetail | null; initialTitle: string; onClose: () => void; onSaved: (d: MemoryNoteDetail) => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const [title, setTitle] = useState(note?.title ?? initialTitle);
  const [kind, setKind] = useState<MemoryKind>(note?.kind ?? (/^CVE-\d{4}-\d+$/i.test(initialTitle) ? 'cve' : 'system'));
  const [body, setBody] = useState(note?.body ?? '');
  const [tags, setTags] = useState((note?.tags ?? []).join(', '));
  const [team, setTeam] = useState(note?.teamSlug ?? '');
  const [untrusted, setUntrusted] = useState(note?.untrusted ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teams = Object.values(state.teams ?? {}).sort((a, b) => a.name.localeCompare(b.name));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true); setError(null);
    const payload = {
      title: title.trim(), kind, body, tags: tags.split(',').map((s) => s.trim()).filter(Boolean), teamSlug: team || null, untrusted,
    };
    try {
      onSaved(note ? await api.updateMemoryNote(note.id, payload) : await api.createMemoryNote(payload));
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Dialog title={note ? t('mem.editTitle') : t('mem.newTitle')} onClose={onClose} wide>
      <form className="mem-form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{t('mem.form.title')}</span>
          <input className="input" value={title} maxLength={120} required onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="row mem-form__row">
          <label className="field">
            <span>{t('mem.form.kind')}</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
              {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(kindKey(k))}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t('mem.form.team')}</span>
            <select className="input" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">{t('mem.form.noTeam')}</option>
              {teams.map((tm) => <option key={tm.id} value={tm.slug}>{tm.name}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span>{t('mem.form.body')}</span>
          <textarea className="input mem-form__body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
          <span className="small muted">{t('mem.form.bodyHint')}</span>
        </label>
        <label className="field">
          <span>{t('mem.form.tags')}</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="row small">
          <input type="checkbox" checked={untrusted} onChange={(e) => setUntrusted(e.target.checked)} /> {t('mem.form.untrusted')}
        </label>
        {error && <p className="mail-error" role="alert">{error}</p>}
        <div className="row dialog__actions">
          <button type="submit" className="btn btn--primary" disabled={saving || !title.trim()}>{saving ? t('mem.saving') : t('mem.save')}</button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>{t('mem.cancel')}</button>
        </div>
      </form>
    </Dialog>
  );
}
