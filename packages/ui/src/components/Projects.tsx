import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { PROJECT_COLORS, normalizeTag, type Project, type TagCount } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage, formatCost } from '../lib/format';
import { Dialog } from './Dialog';
import { entityColor } from '../lib/theme';

export function ProjectDot({ color, title }: { color: string; title?: string }) {
  return <span className="pj-dot" style={{ background: entityColor(color) }} title={title} aria-hidden={title ? undefined : true} />;
}

/** Sidebar: projects (filter the board) and the most used tags. */
export function ProjectsNav({ onPicked }: { onPicked: () => void }) {
  const { state, actions, api } = useStore();
  const { t } = useI18n();
  const [manage, setManage] = useState(false);
  const [tags, setTags] = useState<TagCount[]>([]);
  const projects = Object.values(state.projects ?? {}).filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name));

  // Refresh the tag list when tickets change (cheap: one small query).
  const ticketCount = Object.keys(state.tickets).length;
  useEffect(() => { api.listTags().then(setTags, () => setTags([])); }, [api, ticketCount, state.detail?.ticket.updatedAt]);

  const pick = (f: Project['id'] | 'none' | null) => { actions.setProjectFilter(f); onPicked(); };
  return (
    <nav aria-label={t('pj.heading')}>
      <div className="pj-head">
        <h2 className="section-label">{t('pj.heading')}</h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setManage(true)}>{t('pj.manage')}</button>
      </div>
      <ul className="views">
        {projects.map((p) => (
          <li key={p.id}>
            <button type="button" className={`view-btn${state.projectFilter === p.id ? ' view-btn--active' : ''}`} aria-pressed={state.projectFilter === p.id}
              onClick={() => pick(state.projectFilter === p.id ? null : p.id)}>
              <span className="pj-name"><ProjectDot color={p.color} />{p.name}</span>
            </button>
          </li>
        ))}
        {projects.length > 0 && (
          <li>
            <button type="button" className={`view-btn${state.projectFilter === 'none' ? ' view-btn--active' : ''}`} aria-pressed={state.projectFilter === 'none'}
              onClick={() => pick(state.projectFilter === 'none' ? null : 'none')}>
              <span className="muted">{t('pj.noProject')}</span>
            </button>
          </li>
        )}
        {projects.length === 0 && (
          <li><button type="button" className="view-btn" onClick={() => setManage(true)}><span className="muted">{t('pj.create')}</span></button></li>
        )}
      </ul>
      {tags.length > 0 && (
        <>
          <h2 className="section-label pj-tags-label">{t('tg.heading')}</h2>
          <ul className="tg-cloud">
            {tags.slice(0, 15).map((x) => (
              <li key={x.tag}>
                <button type="button" className={`tg${state.tagFilter === x.tag ? ' tg--active' : ''}`} aria-pressed={state.tagFilter === x.tag}
                  onClick={() => { actions.setTagFilter(state.tagFilter === x.tag ? null : x.tag); onPicked(); }}>
                  #{x.tag} <span className="tg__n">{x.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {manage && <ProjectsDialog onClose={() => setManage(false)} />}
    </nav>
  );
}

/** Create, edit (name, brief, colour), archive and delete projects. */
export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch, api } = useStore();
  const { t, locale } = useI18n();
  const [summaries, setSummaries] = useState<Awaited<ReturnType<typeof api.listProjects>>>([]);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => api.listProjects().then((list) => { setSummaries(list); dispatch({ type: 'projectsLoaded', projects: list }); }, (e) => setError(errorMessage(e)));
  useEffect(() => { void reload(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (id: string) => {
    try { await api.deleteProject(id); setConfirmDelete(null); await reload(); } catch (e) { setError(errorMessage(e)); }
  };
  const archive = async (p: Project) => {
    try { await api.updateProject(p.id, { archived: !p.archived }); await reload(); } catch (e) { setError(errorMessage(e)); }
  };

  return (
    <Dialog title={editing ? t(editing === 'new' ? 'pj.newTitle' : 'pj.editTitle') : t('pj.manageTitle')} onClose={onClose} wide>
      {error && <p className="mail-error" role="alert">{error}</p>}
      {editing ? (
        <ProjectForm project={editing === 'new' ? null : editing} onDone={() => { setEditing(null); void reload(); }} />
      ) : (
        <div className="pj-manage">
          <p className="small muted">{t('pj.intro')}</p>
          <button type="button" className="btn btn--primary btn--sm pj-new" onClick={() => setEditing('new')}>{t('pj.create')}</button>
          {summaries.length === 0 ? <p className="trusted__empty">{t('pj.empty')}</p> : (
            <ul className="pj-list">
              {summaries.map((p) => {
                const total = Object.values(p.counts).reduce((n, c) => n + (c ?? 0), 0);
                const open = total - (p.counts.done ?? 0);
                return (
                  <li key={p.id} className={`pj-row${p.archived ? ' pj-row--archived' : ''}`}>
                    <div className="pj-row__main">
                      <span className="pj-name"><ProjectDot color={p.color} /><strong>{p.name}</strong>{p.archived && <span className="chip">{t('pj.archived')}</span>}</span>
                      <span className="small muted">{t('pj.stats', { open, total, cost: formatCost(p.costUsd, locale) })}</span>
                      {p.description && <span className="small pj-brief">{p.description}</span>}
                    </div>
                    {confirmDelete === p.id ? (
                      <span className="row pj-confirm">
                        <span className="small">{t('pj.deleteConfirm', { n: total })}</span>
                        <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove(p.id)}>{t('pj.delete')}</button>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(null)}>{t('pj.cancel')}</button>
                      </span>
                    ) : (
                      <span className="row">
                        <button type="button" className="btn btn--outline btn--sm" onClick={() => setEditing(state.projects?.[p.id] ?? p)}>{t('pj.edit')}</button>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void archive(p)}>{t(p.archived ? 'pj.unarchive' : 'pj.archive')}</button>
                        <button type="button" className="btn btn--ghost btn--sm pj-del" onClick={() => setConfirmDelete(p.id)}>{t('pj.delete')}</button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ProjectForm({ project, onDone }: { project: Project | null; onDone: () => void }) {
  const { api, dispatch } = useStore();
  const { t } = useI18n();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [color, setColor] = useState(project?.color ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body = { name: name.trim(), description, ...(color ? { color } : {}) };
      const saved = project ? await api.updateProject(project.id, body) : await api.createProject(body);
      dispatch({ type: 'projectUpserted', project: saved });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="mail-form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span className="field__label">{t('pj.name')}</span>
        <input className="input" required maxLength={80} value={name} placeholder={t('pj.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">{t('pj.brief')}</span>
        <textarea className="input textarea" rows={5} maxLength={5000} value={description} placeholder={t('pj.briefPlaceholder')} onChange={(e) => setDescription(e.target.value)} />
        <span className="small muted">{t('pj.briefHint')}</span>
      </label>
      <fieldset className="pj-colors">
        <legend className="field__label">{t('pj.color')}</legend>
        {PROJECT_COLORS.map((c) => (
          <label key={c} className={`pj-swatch${(color || project?.color) === c ? ' pj-swatch--on' : ''}`} style={{ background: entityColor(c) }}>
            <input type="radio" name="pj-color" value={c} checked={(color || project?.color) === c} onChange={() => setColor(c)} aria-label={c} />
          </label>
        ))}
      </fieldset>
      {error && <p className="mail-error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>{t(project ? 'pj.save' : 'pj.createShort')}</button>
        <button type="button" className="btn btn--outline" disabled={busy} onClick={onDone}>{t('pj.cancel')}</button>
      </div>
    </form>
  );
}

/** Tags input: chips with ×, Enter or comma adds, Backspace on empty removes the last. */
export function TagEditor({ tags, onChange, disabled, onTagClick }: { tags: string[]; onChange: (tags: string[]) => void; disabled?: boolean; onTagClick?: (tag: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const n = normalizeTag(raw);
    setText('');
    if (n && !tags.includes(n) && tags.length < 10) onChange([...tags, n]);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(text); }
    else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1));
  };
  return (
    <div className="tg-editor">
      {tags.map((tag) => (
        <span key={tag} className="tg tg--chip">
          {onTagClick ? <button type="button" className="tg__link" onClick={() => onTagClick(tag)} title={t('tg.filterBy', { tag })}>#{tag}</button> : <>#{tag}</>}
          {!disabled && <button type="button" className="tg__x" aria-label={t('tg.remove', { tag })} onClick={() => onChange(tags.filter((x) => x !== tag))}>×</button>}
        </span>
      ))}
      {!disabled && tags.length < 10 && (
        <input className="tg-editor__input" value={text} placeholder={tags.length ? '' : t('tg.placeholder')} aria-label={t('tg.add')}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => text && add(text)} />
      )}
    </div>
  );
}

/** Active board filters (project, tag) with a way to clear each. */
export function FilterBar() {
  const { state, actions } = useStore();
  const { t } = useI18n();
  const p = state.projectFilter && state.projectFilter !== 'none' ? state.projects?.[state.projectFilter] : null;
  const team = state.teamFilter && state.teamFilter !== 'none' ? state.teams?.[state.teamFilter] : null;
  if (!state.projectFilter && !state.tagFilter && !state.teamFilter) return null;
  return (
    <div className="pj-filterbar" role="status">
      <span className="small muted">{t('pj.filtered')}</span>
      {state.projectFilter && (
        <span className="pj-filter">
          {p ? <><ProjectDot color={p.color} />{p.name}</> : t('pj.noProject')}
          <button type="button" className="tg__x" aria-label={t('pj.clear')} onClick={() => actions.setProjectFilter(null)}>×</button>
        </span>
      )}
      {state.teamFilter && (
        <span className="pj-filter">
          {team ? <><ProjectDot color={team.color} />{team.name}</> : t('tm.none')}
          <button type="button" className="tg__x" aria-label={t('pj.clear')} onClick={() => actions.setTeamFilter(null)}>×</button>
        </span>
      )}
      {state.tagFilter && (
        <span className="pj-filter">#{state.tagFilter}
          <button type="button" className="tg__x" aria-label={t('pj.clear')} onClick={() => actions.setTagFilter(null)}>×</button>
        </span>
      )}
      {p?.description && <span className="small muted pj-filter-brief" title={p.description}>{p.description}</span>}
    </div>
  );
}
