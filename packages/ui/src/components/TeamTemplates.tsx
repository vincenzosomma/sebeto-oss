import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { ApplyTemplateResponse, Id, TeamTemplate } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage } from '../lib/format';
import { buildTree, plural } from '../lib/agents';
import { checkTeamFile, connectorLabel, teamFileName, templateTree } from '../lib/templates';
import { Dialog } from './Dialog';
import { TeamAiFields, useRuntimes, type TeamAiValue } from './TeamAi';
import { suggestedTemplateAi } from '../lib/team-ai';
import { localizeTemplate } from '../i18n/builtin-teams';

/**
 * Team templates (v0.3, packages/shared/src/templates.ts): the "Add a team" and "Export team"
 * buttons of the Agents & skills page, and their dialogs.
 */
export function TeamTemplateActions({ selectedId }: { selectedId: Id | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<'add' | 'export' | null>(null);
  return (
    <span className="tt-actions">
      <button type="button" className="btn btn--outline btn--sm" onClick={() => setOpen('add')}>{t('tt.add')}</button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen('export')}>{t('tt.export')}</button>
      {open === 'add' && <AddTeamDialog onClose={() => setOpen(null)} />}
      {open === 'export' && <ExportTeamDialog selectedId={selectedId} onClose={() => setOpen(null)} />}
    </span>
  );
}

function AddTeamDialog({ onClose }: { onClose: () => void }) {
  const { state, api, dispatch } = useStore();
  const { t } = useI18n();
  const [templates, setTemplates] = useState<TeamTemplate[] | null>(null);
  const [reportsTo, setReportsTo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<TeamTemplate | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // v0.4 F: the AI for the team about to be added (per template; the Red Team suggests a local one).
  const runtimes = useRuntimes();
  const [aiFor, setAiFor] = useState<string | null>(null);
  const [ai, setAi] = useState<TeamAiValue>({ runtime: '', model: '', lockRuntime: false, requireScope: false });
  const [aiLocal, setAiLocal] = useState(false);
  const chooseAi = (tpl: TeamTemplate) => {
    const s = suggestedTemplateAi(tpl.id, tpl.team?.runtime ?? null, runtimes);
    setAi({ runtime: s?.runtime ?? '', model: tpl.team?.model ?? '', lockRuntime: s?.lock ?? !!tpl.team?.lockRuntime, requireScope: !!tpl.team?.requireScope });
    setAiLocal(!!s?.local);
    setAiFor(tpl.id);
  };

  const agentRows = useMemo(() => buildTree(Object.values(state.agents)), [state.agents]);

  const load = useCallback(() => api.listTemplates().then(setTemplates, (e) => setError(errorMessage(e))), [api]);
  useEffect(() => { void load(); }, [load, state.templatesVersion]);

  const summary = (r: ApplyTemplateResponse) => t('tt.result', {
    agents: plural(t, r.agents.length, 'tt.agents1', 'tt.agents'),
    skills: plural(t, r.skillsCreated.length, 'tt.skills1', 'tt.skills'),
    reused: r.skillsReused.length ? plural(t, r.skillsReused.length, 'tt.result.reused1', 'tt.result.reused') : '',
  });

  const apply = async (key: string, body: { templateId?: string; template?: TeamTemplate }) => {
    setBusy(key);
    setError(null);
    setResult(null);
    try {
      const aiChoice = aiFor === key ? { runtime: ai.runtime || null, model: ai.runtime ? ai.model || null : null, lockRuntime: !!ai.runtime && ai.lockRuntime } : {};
      const res = await api.applyTemplate({ ...body, ...aiChoice, reportsTo: reportsTo || null });
      for (const agent of res.agents) dispatch({ type: 'agentUpserted', agent });
      setResult(res.warnings?.length ? `${summary(res)} ${t('ai.warnings', { list: res.warnings.join(' ') })}` : summary(res));
      setAiFor(null);
      if (body.template) setImported(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (template: TeamTemplate) => {
    setBusy('save');
    setError(null);
    setResult(null);
    try {
      const saved = await api.saveTemplate(template);
      setImported(null);
      setResult(t('tt.savedOk', { name: saved.name }));
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(`del:${id}`);
    setError(null);
    try {
      await api.deleteTemplate(id);
      setConfirmDelete(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setResult(null);
    const check = checkTeamFile(await file.text());
    if (check.ok) setImported(check.template);
    else {
      setImported(null);
      setError(t(check.error));
    }
  };

  return (
    <Dialog title={t('tt.title')} onClose={onClose} wide>
      <p className="small">{t('tt.intro')}</p>
      <label className="field tt-report">
        <span className="field__label">{t('tt.reportTo')}</span>
        <select className="input" value={reportsTo} onChange={(e) => setReportsTo(e.target.value)}>
          <option value="">{t('tt.you')}</option>
          {agentRows.map(({ agent, depth }) => (
            <option key={agent.id} value={agent.id}>{`${'  '.repeat(depth)}${agent.name}`}</option>
          ))}
        </select>
      </label>
      {result && <p className="tt-result small" role="status">{result}</p>}
      {error && <p className="tt-error small" role="alert">{t('error.generic', { message: error })}</p>}

      {imported && (
        <div className="tt-import-preview">
          <p className="section-label">{t('tt.preview')}</p>
          <TemplateCard template={imported} preview>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null} onClick={() => apply('import', { template: imported })}>
              {busy === 'import' ? t('tt.applying') : t('tt.apply')}
            </button>
            <button type="button" className="btn btn--outline btn--sm" disabled={busy !== null} onClick={() => save(imported)}>{t('tt.saveTemplate')}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setImported(null)}>{t('tt.cancel')}</button>
          </TemplateCard>
        </div>
      )}

      {templates === null ? (
        <p className="small muted" role="status">{t('tt.loading')}</p>
      ) : (
        <ul className="tt-grid">
          {templates.map((tpl) => (
            <li key={tpl.id}>
              <TemplateCard template={tpl}>
                {aiFor === tpl.id && (
                  <div className="tt-ai">
                    <TeamAiFields value={ai} onChange={(v) => { setAi(v); setAiLocal(false); }} runtimes={runtimes} showScope={false} hint={aiLocal && ai.runtime ? t('ai.redLocal') : null} />
                  </div>
                )}
                <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null}
                  onClick={() => (aiFor === tpl.id ? apply(tpl.id, { templateId: tpl.id }) : chooseAi(tpl))}>
                  {busy === tpl.id ? t('tt.applying') : t('tt.apply')}
                </button>
                {aiFor === tpl.id && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAiFor(null)}>{t('tt.cancel')}</button>}
                {!tpl.builtin && confirmDelete !== tpl.id && (
                  <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => setConfirmDelete(tpl.id)}>{t('tt.delete')}</button>
                )}
                {!tpl.builtin && confirmDelete === tpl.id && (
                  <div className="tt-confirm" role="group">
                    <span className="small">{t('tt.confirmDelete', { name: tpl.name })}</span>
                    <button type="button" className="btn btn--danger btn--sm" disabled={busy !== null} onClick={() => remove(tpl.id)}>{t('tt.delete')}</button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(null)}>{t('tt.cancel')}</button>
                  </div>
                )}
              </TemplateCard>
            </li>
          ))}
        </ul>
      )}

      <div className="tt-import">
        <input ref={fileRef} type="file" accept="application/json,.json" className="tt-file" onChange={onFile} aria-label={t('tt.import')} tabIndex={-1} />
        <button type="button" className="btn btn--outline btn--sm" onClick={() => fileRef.current?.click()}>{t('tt.import')}</button>
        <span className="small muted">{t('tt.importHint')}</span>
      </div>
    </Dialog>
  );
}

function TemplateCard({ template: stored, preview = false, children }: { template: TeamTemplate; preview?: boolean; children: ReactNode }) {
  const { t, locale } = useI18n();
  // v0.5 M: built-in templates are shown in the UI language; the stored template stays as it is.
  const template = useMemo(() => localizeTemplate(stored, locale), [stored, locale]);
  const rows = templateTree(template);
  const connectors = template.suggestedConnectors ?? [];
  return (
    <article className="tt-card" aria-label={template.name}>
      <header className="tt-card__head">
        <h3 className="tt-card__name">{template.name}</h3>
        {!preview && <span className={`chip${template.builtin ? '' : ' chip--tuff'}`}>{template.builtin ? t('tt.builtin') : t('tt.saved')}</span>}
      </header>
      {template.description && <p className="tt-card__desc small">{template.description}</p>}
      <ul className="tt-tree" aria-label={t('tt.teamLabel', { name: template.name })}>
        {rows.map(({ agent, depth }) => (
          <li key={agent.key} style={{ paddingLeft: `${depth * 16}px` }} title={agent.job || undefined}>
            {depth > 0 && <span className="tt-tree__branch" aria-hidden="true">└</span>}
            <span className="tt-tree__name">{agent.name}</span>
            {agent.role && <span className="tt-tree__role"> · {agent.role}</span>}
          </li>
        ))}
      </ul>
      <p className="tt-card__meta small muted">
        {plural(t, template.agents.length, 'tt.agents1', 'tt.agents')} · {plural(t, template.skills.length, 'tt.skills1', 'tt.skills')}
        {connectors.length > 0 && <> · {t('tt.connectors', { list: connectors.map(connectorLabel).join(', ') })}</>}
      </p>
      <div className="tt-card__actions">{children}</div>
    </article>
  );
}

function ExportTeamDialog({ selectedId, onClose }: { selectedId: Id | null; onClose: () => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const rows = useMemo(() => buildTree(Object.values(state.agents)), [state.agents]);
  const [what, setWhat] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      // Fetched through the API client (bearer token in a header), then saved from a Blob.
      const template = await api.exportTemplate(what ? [what] : []);
      const file = teamFileName();
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(template, null, 2)}\n`], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaved(file);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('tt.exportTitle')} onClose={onClose}>
      <p className="small">{t('tt.exportIntro')}</p>
      <label className="field">
        <span className="field__label">{t('tt.exportWhat')}</span>
        <select className="input" value={what} onChange={(e) => setWhat(e.target.value)}>
          <option value="">{t('tt.exportAll')}</option>
          {rows.filter((r) => r.directReports > 0 || r.agent.id === selectedId).map(({ agent }) => (
            <option key={agent.id} value={agent.id}>{t('tt.exportBelow', { name: agent.name })}</option>
          ))}
        </select>
      </label>
      {error && <p className="tt-error small" role="alert">{t('error.generic', { message: error })}</p>}
      <div className="tt-export-actions">
        {saved && <span className="small muted" role="status">{t('tt.downloaded', { file: saved })}</span>}
        <button type="button" className="btn btn--primary" disabled={busy || rows.length === 0} onClick={download}>{t('tt.download')}</button>
      </div>
    </Dialog>
  );
}
