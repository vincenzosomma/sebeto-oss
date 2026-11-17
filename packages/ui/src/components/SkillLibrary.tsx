import { useState, type FormEvent } from 'react';
import { PERMISSION_KEYS, type Agent, type PermissionKey, type Skill, type SkillBody } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage } from '../lib/format';
import { filterSkills, parseList, plural, slugify } from '../lib/agents';
import { Dialog } from './Dialog';

/** Colour family for a permission chip: reading is neutral, editing blue, outbound amber, production red. */
export function needTone(key: PermissionKey): 'read' | 'edit' | 'ask' | 'prod' {
  if (key === 'prod.change') return 'prod';
  if (key === 'fs.write') return 'edit';
  if (key === 'email.send' || key === 'script.run' || key === 'tool.change') return 'ask';
  return 'read';
}

/** Right column of the Agents & skills page: search, add/edit/delete skills, assign them to the selected agent. */
export function SkillLibrary({ skills, agents, target, onToggle, onChanged }: {
  skills: Skill[] | null;
  agents: Agent[];
  /** The agent skills are assigned to (null while none is selected). */
  target: Agent | null;
  onToggle: (slug: string) => void;
  onChanged: () => void;
}) {
  const { api } = useStore();
  const { t, permission } = useI18n();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = filterSkills(skills ?? [], query);
  const usedBy = (slug: string) => agents.filter((a) => a.skills.includes(slug)).length;

  const remove = async (slug: string) => {
    setBusy(slug); setError(null);
    try {
      await api.deleteSkill(slug);
      setConfirming(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ag-lib" aria-labelledby="ag-lib-title">
      <div className="ag-col-head">
        <h2 id="ag-lib-title" className="ag-col-title">{t('ag.lib.heading')}</h2>
        <button type="button" className="btn btn--outline btn--sm" onClick={() => setEditing('new')}>{t('ag.lib.new')}</button>
      </div>
      <div className="search__box">
        <svg className="search__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input
          className="input search__input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('ag.lib.search')}
          aria-label={t('ag.lib.search')}
        />
      </div>
      <p className="small muted">
        {target ? <>{t('ag.lib.target')} <strong className="ag-lib__target">{target.name}</strong></> : t('ag.lib.noTarget')}
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!skills ? <p className="small muted" role="status">{t('panel.loading')}</p>
        : skills.length === 0 ? <p className="small muted">{t('ag.lib.empty')}</p>
        : list.length === 0 ? <p className="small muted">{t('ag.lib.noMatch')}</p>
        : (
          <ul className="ag-lib__list">
            {list.map((s) => {
              const assigned = !!target?.skills.includes(s.slug);
              const n = usedBy(s.slug);
              return (
                <li key={s.slug} className={`ag-sk${assigned ? ' ag-sk--on' : ''}`}>
                  <div className="ag-sk__top">
                    <div className="ag-sk__text">
                      <strong className="ag-sk__name">{s.name}</strong>
                      <span className="ag-sk__desc">{s.description}</span>
                    </div>
                    {target && (
                      <button
                        type="button"
                        className={`btn btn--sm ${assigned ? 'ag-sk__assigned' : 'btn--primary'}`}
                        aria-pressed={assigned}
                        aria-label={assigned ? t('ag.lib.unassignLabel', { skill: s.name, agent: target.name }) : t('ag.lib.assignLabel', { skill: s.name, agent: target.name })}
                        onClick={() => onToggle(s.slug)}
                      >
                        {assigned ? t('ag.lib.assigned') : t('ag.lib.assign')}
                      </button>
                    )}
                  </div>
                  {s.needs.length > 0 && (
                    <ul className="ag-chips ag-chips--sm">
                      {s.needs.map((k) => <li key={k} className={`ag-need-chip ag-need-chip--${needTone(k)}`}>{permission(k)}</li>)}
                    </ul>
                  )}
                  {confirming === s.slug ? (
                    <div className="ag-sk__confirm" role="alertdialog" aria-label={t('ag.lib.delete')}>
                      <span>{n === 0 ? t('ag.lib.deleteConfirm0', { name: s.name }) : plural(t, n, 'ag.lib.deleteConfirm1', 'ag.lib.deleteConfirm', { name: s.name })}</span>
                      <div className="row">
                        <button type="button" className="btn btn--danger btn--sm" disabled={busy === s.slug} onClick={() => void remove(s.slug)}>{t('ag.lib.delete')}</button>
                        <button type="button" className="btn btn--outline btn--sm" onClick={() => setConfirming(null)}>{t('ag.cancel')}</button>
                      </div>
                    </div>
                  ) : (
                    <div className="ag-sk__foot">
                      <span className="small muted">
                        {plural(t, n, 'ag.lib.usedBy1', 'ag.lib.usedBy')}
                        {s.files.length > 0 ? ` · ${plural(t, s.files.length, 'ag.lib.files1', 'ag.lib.files')}` : ''}
                      </span>
                      <span className="ag-sk__tools">
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(s)} aria-label={t('ag.lib.editLabel', { name: s.name })}>{t('ag.lib.edit')}</button>
                        <button type="button" className="btn btn--ghost btn--sm ag-sk__del" onClick={() => setConfirming(s.slug)} aria-label={t('ag.lib.deleteLabel', { name: s.name })}>{t('ag.lib.delete')}</button>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      {editing && (
        <SkillForm
          skill={editing === 'new' ? null : editing}
          allPermissions={PERMISSION_KEYS}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      )}
    </section>
  );
}

function SkillForm({ skill, allPermissions, onClose, onSaved }: {
  skill: Skill | null;
  allPermissions: readonly PermissionKey[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useStore();
  const { t, permission } = useI18n();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [instructions, setInstructions] = useState(skill?.instructions ?? '');
  const [needs, setNeeds] = useState<PermissionKey[]>(skill?.needs ?? ['fs.read']);
  const [connectors, setConnectors] = useState((skill?.connectors ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = skill?.slug ?? slugify(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!slugify(name)) { setError(t('ag.skill.nameRequired')); return; }
    setBusy(true); setError(null);
    const body: SkillBody = {
      name: name.trim(), description: description.trim(), instructions,
      needs: allPermissions.filter((k) => needs.includes(k)), connectors: parseList(connectors),
    };
    try {
      if (skill) await api.updateSkill(skill.slug, body);
      else await api.createSkill(body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={skill ? t('ag.skill.editTitle', { name: skill.name }) : t('ag.skill.newTitle')} onClose={onClose} wide>
      <form className="stack ag-skill-form" onSubmit={submit}>
        <div className="ag-grid">
          <label className="field">
            <span className="field__label">{t('ag.skill.name')}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ag.skill.namePlaceholder')} maxLength={100} autoFocus />
          </label>
          <label className="field">
            <span className="field__label">{t('ag.skill.description')}</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('ag.skill.descriptionPlaceholder')} maxLength={300} />
          </label>
        </div>
        <label className="field">
          <span className="field__label">{t('ag.skill.instructions')}</span>
          <textarea className="input textarea ag-mono" rows={10} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t('ag.skill.instructionsPlaceholder')} spellCheck={false} />
          <span className="small muted">{t('ag.skill.instructionsHint')}</span>
        </label>
        <fieldset className="ag-needs-pick">
          <legend className="field__label">{t('ag.skill.needs')}</legend>
          {allPermissions.map((k) => (
            <label key={k} className="check ag-needs-pick__opt">
              <input
                type="checkbox"
                checked={needs.includes(k)}
                onChange={(e) => setNeeds((cur) => (e.target.checked ? [...cur, k] : cur.filter((x) => x !== k)))}
              />
              <span>{permission(k)}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span className="field__label">{t('ag.skill.connectors')}</span>
          <input className="input" value={connectors} onChange={(e) => setConnectors(e.target.value)} placeholder="gmail, Runbooks share" />
          <span className="small muted">{t('ag.skill.connectorsHint')}</span>
        </label>
        <p className="small muted">{t('ag.skill.folder', { slug: slug || '…' })}</p>
        <div className="ag-actions">
          {error && <span className="form-error" role="alert">{error}</span>}
          <span className="ag-actions__spacer" />
          <button type="button" className="btn btn--outline" onClick={onClose}>{t('ag.cancel')}</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>{skill ? t('ag.skill.save') : t('ag.skill.add')}</button>
        </div>
      </form>
    </Dialog>
  );
}
