import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  PERMISSION_KEYS,
  type Agent, type ClaudeConnectorInfo, type ConnectorInfo, type CreateAgentBody, type Id, type PermissionKey, type PermissionLevel,
  type RuntimeInfo, type Skill, type UpdateAgentBody,
  type Team,
} from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { errorMessage } from '../lib/format';
import {
  allowedLevels, buildTree, connectorsForAgent, missingConnectors, needStatuses, plural, reportsToOptions, toggleConnectorAccess,
} from '../lib/agents';
import { SkillLibrary } from './SkillLibrary';
import { TeamTemplateActions } from './TeamTemplates';
import { Hierarchy, ViewToggle, useHierarchyView } from './OrgChart';
import { DeleteAgentButton } from './DeleteAgent';
import { TeamSelect, TeamsDialog } from './Teams';
import { LockIcon } from './TeamAi';
import { lockedTeam } from '../lib/team-ai';
import { HeaderActions } from './HeaderActions';

const LEVEL_KEY: Record<PermissionLevel, MessageKey> = { allow: 'ag.level.allow', ask: 'ag.level.ask', never: 'ag.level.never' };

/** The "Agents & skills" page (docs/17 Agents & Skills.md): hierarchy, agent editor, skill library. */
export function AgentsPage({ onMenu }: { onMenu: () => void }) {
  const { state, api, dispatch } = useStore();
  const { t } = useI18n();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useHierarchyView();
  const [teamsOpen, setTeamsOpen] = useState(false);

  const agents = useMemo(() => Object.values(state.agents), [state.agents]);
  const rows = useMemo(() => buildTree(agents), [agents]);
  const selected = selectedId ? state.agents[selectedId] ?? null : null;

  const loadSkills = useCallback(() => api.listSkills().then(setSkills, (e) => setError(errorMessage(e))), [api]);
  useEffect(() => { void loadSkills(); }, [loadSkills, state.skillsVersion]);
  useEffect(() => {
    api.listAgents().then((list) => dispatch({ type: 'agentsLoaded', agents: list }), (e) => setError(errorMessage(e)));
  }, [api, dispatch]);
  // Reloaded when connectors change: AI connections are runtimes too (v0.7 R).
  useEffect(() => {
    api.listRuntimes().then(setRuntimes, () => setRuntimes([]));
  }, [api, state.connectorsVersion]);
  useEffect(() => {
    api.listConnectors().then((r) => setConnectors(r.installed), () => setConnectors([]));
  }, [api, state.connectorsVersion]);

  // Select the first agent once they are loaded (and again if the selected one disappears).
  useEffect(() => {
    if (creating) return;
    if (!selectedId || !state.agents[selectedId]) setSelectedId(rows[0]?.agent.id ?? null);
  }, [rows, selectedId, state.agents, creating]);

  const assign = async (agent: Agent, slugs: string[]) => {
    setError(null);
    try {
      const next = await api.assignSkills(agent.id, slugs);
      dispatch({ type: 'agentUpserted', agent: next });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const skillCount = skills?.length ?? 0;

  return (
    <div className="ag">
      <header className="header">
        <button type="button" className="icon-btn header__menu" onClick={onMenu} aria-label={t('header.menu')}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="header__text">
          <h1 className="header__title">{t('ag.title')}</h1>
          <p className="header__summary">{t('ag.summary', { agents: agents.length, skills: skillCount })}</p>
        </div>
        <HeaderActions />
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{t('error.generic', { message: error })}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setError(null)}>{t('error.dismiss')}</button>
        </div>
      )}
      {notice && (
        <div className="oc-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNotice(null)}>{t('error.dismiss')}</button>
        </div>
      )}
      <div className={`ag-cols${view === 'chart' ? ' oc-cols' : ''}`}>
        <section className={`ag-tree${view === 'chart' ? ' oc-wide' : ''}`} aria-labelledby="ag-tree-title">
          <div className="ag-col-head">
            <h2 id="ag-tree-title" className="ag-col-title">{t('ag.tree.heading')}</h2>
            <button type="button" className="btn btn--tuff btn--sm" onClick={() => setCreating(true)}>{t('ag.new')}</button>
            <TeamTemplateActions selectedId={selectedId} />
            <button type="button" className="btn btn--outline btn--sm" onClick={() => setTeamsOpen(true)}>
              {t('tm.heading')} ({Object.keys(state.teams ?? {}).length})
            </button>
          </div>
          {teamsOpen && <TeamsDialog onClose={() => setTeamsOpen(false)} />}
          <ViewToggle view={view} onChange={setView} />
          <Hierarchy
            view={view}
            agents={agents}
            selectedId={creating ? null : selectedId}
            onSelect={(id) => { setCreating(false); setSelectedId(id); }}
            runtimeName={(id) => runtimeName(runtimes, id)}
            empty={<p className="small muted">{t('ag.tree.empty')}</p>}
          />
          <p className="small muted ag-tree__hint">{t('ag.tree.hint')}</p>
        </section>

        <section className="ag-main" aria-label={t('ag.details')}>
          {creating ? (
            <NewAgentForm
              agents={agents}
              runtimes={runtimes}
              parentId={selectedId}
              onCancel={() => setCreating(false)}
              onCreated={(a) => { dispatch({ type: 'agentUpserted', agent: a }); setCreating(false); setSelectedId(a.id); }}
            />
          ) : selected ? (
            <AgentEditor
              key={selected.id}
              agent={selected}
              agents={agents}
              runtimes={runtimes}
              skills={skills ?? []}
              connectors={connectors}
              onConnectorsChanged={(updated) => setConnectors((cs) => cs.map((c) => (c.id === updated.id ? updated : c)))}
              onUnassign={(slug) => assign(selected, selected.skills.filter((s) => s !== slug))}
              onDeleted={(summary) => { setNotice(summary); setSelectedId(null); }}
            />
          ) : (
            <p className="ag-card muted">{t('ag.select')}</p>
          )}
        </section>

        <SkillLibrary
          skills={skills}
          agents={agents}
          target={creating ? null : selected}
          onToggle={(slug) => {
            if (!selected) return;
            void assign(selected, selected.skills.includes(slug) ? selected.skills.filter((s) => s !== slug) : [...selected.skills, slug]);
          }}
          onChanged={loadSkills}
        />
      </div>
    </div>
  );
}

function runtimeName(runtimes: RuntimeInfo[], id: string): string {
  return runtimes.find((r) => r.id === id)?.displayName ?? id;
}

/** Runtime ids to offer: the detected ones plus the agent's current one (it may not be installed here). */
function runtimeChoices(runtimes: RuntimeInfo[], current: string): Array<{ id: string; label: string }> {
  const out = runtimes.map((r) => ({ id: r.id, label: r.displayName }));
  if (current && !out.some((r) => r.id === current)) out.push({ id: current, label: current });
  return out;
}

function ModelField({ runtimes, runtime, value, onChange, disabled = false }: { runtimes: RuntimeInfo[]; runtime: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  const models = runtimes.find((r) => r.id === runtime)?.models ?? [];
  return (
    <label className="field">
      <span className="field__label">{t('ag.model')}</span>
      {models.length > 0 ? (
        <select className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('ag.modelDefault')}</option>
          {[...models, ...(value && !models.includes(value) ? [value] : [])].map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input className="input" value={value} disabled={disabled} placeholder={t('ag.modelDefault')} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function ReportsToField({ agents, selfId, value, onChange }: { agents: Agent[]; selfId: Id | null; value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const options = reportsToOptions(agents, selfId);
  return (
    <label className="field">
      <span className="field__label">{t('ag.reportsTo')}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('ag.reportsToYou')}</option>
        {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </label>
  );
}

interface Draft {
  name: string;
  role: string;
  job: string;
  reportsTo: string;
  teamId: string;
  runtime: string;
  model: string;
  heartbeatMinutes: string;
  monthlyBudgetUsd: string;
  paused: boolean;
  permissions: Record<PermissionKey, PermissionLevel>;
  claudeConnectors: string[];
}

function toDraft(a: Agent): Draft {
  return {
    name: a.name, role: a.role, job: a.job, reportsTo: a.reportsTo ?? '', teamId: a.teamId ?? '', runtime: a.runtime, model: a.model ?? '',
    heartbeatMinutes: String(a.heartbeatMinutes), monthlyBudgetUsd: String(a.monthlyBudgetUsd), paused: a.paused,
    permissions: { ...a.permissions },
    claudeConnectors: [...(a.claudeConnectors ?? [])],
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The owner's own Claude connectors this agent (on Claude Code) may use, each call approved through Sebeto. */
function ClaudeConnectorsBlock({ selected, onChange, team }: { selected: string[]; onChange: (v: string[]) => void; team?: Team | null }) {
  const { api } = useStore();
  const { t } = useI18n();
  const [list, setList] = useState<ClaudeConnectorInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true); setError(null);
    try { setList(await api.listClaudeConnectors()); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  // Connectors turned on for every agent (workspace setting, saved at once, not with the agent form).
  const [all, setAll] = useState<string[]>([]);
  // Tools the owner marked as look-ups (workspace setting): one name per line.
  const [lookups, setLookups] = useState('');
  const [savedLookups, setSavedLookups] = useState('');
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getSettings().then((s) => {
      if (!live) return;
      setAll(s.claudeConnectorsAllAgents ?? []);
      const text = (s.claudeLookupTools ?? []).join('\n');
      setLookups(text); setSavedLookups(text);
    }, () => undefined);
    return () => { live = false; };
  }, [api]);
  const saveLookups = async () => {
    setError(null); setLookupNote(null);
    const names = lookups.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    try {
      const text = ((await api.updateSettings({ claudeLookupTools: names })).claudeLookupTools ?? []).join('\n');
      setLookups(text); setSavedLookups(text); setLookupNote(t('ag.claudeConn.lookupsSaved'));
    } catch (err) { setError(errorMessage(err)); }
  };
  const toggleAll = async (n: string, on: boolean) => {
    const next = on ? [...all.filter((x) => x !== n), n] : all.filter((x) => x !== n);
    setAll(next); setError(null);
    try { setAll((await api.updateSettings({ claudeConnectorsAllAgents: next })).claudeConnectorsAllAgents ?? []); }
    catch (err) { setAll(all); setError(t('ag.claudeConn.allError', { error: errorMessage(err) })); }
  };
  // Show what is chosen even before the (slow) list arrives.
  const fromTeam = team?.claudeConnectors ?? [];
  const names = [...new Set([...(list ?? []).filter((c) => c.connected).map((c) => c.name), ...selected, ...all, ...fromTeam])].sort((a, b) => a.localeCompare(b));
  const status = (n: string) => list?.find((c) => c.name === n);
  return (
    <div className="ag-block">
      <h3 className="ag-h3">{t('ag.claudeConn.heading')}</h3>
      <p className="small muted">{t('ag.claudeConn.intro')}</p>
      <ul className="ag-conn-list">
        {names.map((n) => (
          <li key={n} className="ag-conn">
            <label className="check ag-conn__check">
              <input type="checkbox" checked={selected.includes(n) || all.includes(n) || fromTeam.includes(n)} disabled={all.includes(n) || fromTeam.includes(n)} onChange={(e) => onChange(e.target.checked ? [...selected, n] : selected.filter((x) => x !== n))} />
              <span className="ag-conn__name">{n}</span>
            </label>
            {all.includes(n) && <span className="small muted">{t('ag.claudeConn.viaAll')}</span>}
            {!all.includes(n) && fromTeam.includes(n) && <span className="small muted">{t('ag.claudeConn.viaTeam', { team: team?.name ?? '' })}</span>}
            {list && <span className="small muted">{status(n)?.status ?? t('ag.claudeConn.missing')}</span>}
            <label className="check small" title={t('ag.claudeConn.allTitle')}>
              <input type="checkbox" checked={all.includes(n)} onChange={(e) => void toggleAll(n, e.target.checked)} />
              <span>{t('ag.claudeConn.all')}</span>
            </label>
          </li>
        ))}
        {!names.length && <li className="small muted">{t('ag.claudeConn.none')}</li>}
      </ul>
      <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => void load()}>{busy ? t('ag.claudeConn.loading') : t('ag.claudeConn.load')}</button>
      {error && <p className="mail-error small" role="alert">{error}</p>}
      <p className="small muted">{t('ag.claudeConn.hint')}</p>
      <label className="field">
        <span className="field__label">{t('ag.claudeConn.lookups')}</span>
        <textarea className="input textarea" rows={3} value={lookups} onChange={(e) => { setLookups(e.target.value); setLookupNote(null); }} placeholder="quality_projects" spellCheck={false} />
        <span className="small muted">{t('ag.claudeConn.lookupsHint')}</span>
      </label>
      <span className="row">
        <button type="button" className="btn btn--outline btn--sm" disabled={lookups === savedLookups} onClick={() => void saveLookups()}>{t('ag.claudeConn.lookupsSave')}</button>
        {lookupNote && <span className="small muted" role="status">{lookupNote}</span>}
      </span>
    </div>
  );
}

function AgentEditor({ agent, agents, runtimes, skills, connectors, onConnectorsChanged, onUnassign, onDeleted }: {
  agent: Agent;
  agents: Agent[];
  runtimes: RuntimeInfo[];
  skills: Skill[];
  connectors: ConnectorInfo[];
  onConnectorsChanged: (c: ConnectorInfo) => void;
  onUnassign: (slug: string) => void;
  onDeleted: (summary: string) => void;
}) {
  const { state, api, dispatch } = useStore();
  const { t, permission } = useI18n();
  const base = useMemo(() => toDraft(agent), [agent]);
  const [draft, setDraft] = useState<Draft>(base);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = !sameDraft(draft, base);

  // Live updates from elsewhere replace the form only while there are no unsaved edits.
  const [lastBase, setLastBase] = useState(base);
  if (lastBase !== base) {
    setLastBase(base);
    if (sameDraft(draft, lastBase)) setDraft(base);
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setDraft((d) => ({ ...d, [k]: v })); setNote(null); };
  const manager = agent.reportsTo ? agents.find((a) => a.id === agent.reportsTo) : null;
  const direct = agents.filter((a) => a.reportsTo === agent.id).length;
  const needs = needStatuses(skills, { skills: agent.skills, permissions: draft.permissions });
  const usable = connectorsForAgent(connectors, agent.id);
  // v0.4 F: an agent of a locked team runs only on the team's AI (the core refuses anything else).
  const lockTeam = lockedTeam(state.teams, draft.teamId || null);
  const mailOn = !!state.mail?.connected;
  const missing = missingConnectors(skills, agent.skills, usable, mailOn);
  const [connBusy, setConnBusy] = useState<string | null>(null);

  // Tick or untick this agent on a connector (the connector keeps its own list of allowed agents).
  const toggleConnector = async (c: ConnectorInfo, on: boolean) => {
    setConnBusy(c.id); setError(null);
    try {
      const allowedAgents = toggleConnectorAccess(c.allowedAgents, agent.id, agents.map((a) => a.id), on);
      onConnectorsChanged(await api.updateConnector(c.id, { allowedAgents }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setConnBusy(null);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) { setError(t('ag.nameRequired')); return; }
    setBusy(true); setError(null); setNote(null);
    const body: UpdateAgentBody = {
      name: draft.name.trim(), role: draft.role, job: draft.job, reportsTo: draft.reportsTo || null,
      teamId: draft.teamId || null,
      // A locked team sets the runtime and model itself.
      ...(lockTeam ? {} : { runtime: draft.runtime, model: draft.model.trim() || null }),
      heartbeatMinutes: Math.max(0, Math.round(Number(draft.heartbeatMinutes) || 0)),
      monthlyBudgetUsd: Math.max(0, Number(draft.monthlyBudgetUsd) || 0),
      paused: draft.paused, permissions: draft.permissions,
      claudeConnectors: draft.claudeConnectors,
    };
    try {
      const next = await api.updateAgent(agent.id, body);
      dispatch({ type: 'agentUpserted', agent: next });
      setDraft(toDraft(next));
      setNote(t('ag.saved'));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ag-card ag-editor" onSubmit={save}>
      <div className="ag-editor__top">
        <div className="ag-editor__who">
          <span className="small muted">
            {direct === 0
              ? t('ag.reportsLine0', { name: manager?.name ?? t('ag.tree.you') })
              : plural(t, direct, 'ag.reportsLine1', 'ag.reportsLine', { name: manager?.name ?? t('ag.tree.you') })}
          </span>
          <h2 className="ag-editor__name">{agent.name}</h2>
        </div>
        <div className="ag-editor__badges">
          <span className="ag-pill ag-pill--blue">{runtimeName(runtimes, agent.runtime)}</span>
          <span className="ag-pill">{agent.model || t('ag.modelDefault')}</span>
          {agent.paused && <span className="ag-pill ag-pill--warn">{t('ag.tree.paused')}</span>}
        </div>
      </div>

      <div className="ag-block">
        <div className="ag-block__head">
          <h3 className="ag-h3">{t('ag.skills.heading')}</h3>
          <span className="small muted">{t('ag.skills.hint')}</span>
        </div>
        {agent.skills.length === 0 ? <p className="small muted">{t('ag.skills.empty')}</p> : (
          <ul className="ag-chips">
            {agent.skills.map((slug) => {
              const name = skills.find((s) => s.slug === slug)?.name ?? slug;
              return (
                <li key={slug} className="ag-skill-chip">
                  {name}
                  <button type="button" className="ag-skill-chip__x" onClick={() => onUnassign(slug)} aria-label={t('ag.skills.remove', { name })}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="ag-block">
        <h3 className="ag-h3">{t('ag.needs.heading')}</h3>
        {needs.length === 0 ? <p className="small muted">{t('ag.needs.empty')}</p> : (
          <ul className="ag-needs">
            {needs.map((n) => (
              <li key={n.key} className={`ag-need${n.blocked ? ' ag-need--blocked' : ''}`}>
                <span className="ag-need__label">{permission(n.key)}</span>
                <span className={`ag-level ag-level--${n.level}`}>{t(LEVEL_KEY[n.level])}</span>
                {n.blocked && <span className="ag-need__warn" role="note">{t('ag.needs.blocked')}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="small muted">{t('ag.needs.hint')}</p>
      </div>

      <div className="ag-block">
        <h3 className="ag-h3">{t('ag.conn.heading')}</h3>
        <ul className="ag-conn-list">
          {mailOn && state.mail?.connected && (
            <li className="ag-conn">
              <span className="ag-conn__name">{t('ag.conn.mailbox')}</span>
              <span className="small muted">{t('ag.conn.mailboxHint', { level: t(LEVEL_KEY[draft.permissions['email.read']]) })}</span>
            </li>
          )}
          {connectors.map((c) => {
            const allowed = c.allowedAgents === null || c.allowedAgents.includes(agent.id);
            const on = c.tools.filter((x) => x.reviewed && x.level !== 'off').length;
            return (
              <li key={c.id} className="ag-conn">
                <label className="check ag-conn__check">
                  <input type="checkbox" checked={allowed} disabled={connBusy === c.id} onChange={(e) => void toggleConnector(c, e.target.checked)} />
                  <span className="ag-conn__name">{c.name}</span>
                </label>
                <span className="small muted">
                  {!c.enabled ? t('ag.conn.off') : t('ag.conn.tools', { n: on })}
                  {allowed && c.allowedAgents === null ? ` · ${t('ag.conn.everyone')}` : ''}
                </span>
              </li>
            );
          })}
          {!mailOn && connectors.length === 0 && <li className="small muted">{t('ag.conn.none')}</li>}
        </ul>
        {missing.length > 0 && <p className="ag-warn small" role="note">{t('ag.conn.missing', { names: missing.join(', ') })}</p>}
        <p className="small muted">{t('ag.conn.hint')}</p>
      </div>

      {(lockTeam?.runtime ?? draft.runtime) === 'claude-cli' && (
        <ClaudeConnectorsBlock selected={draft.claudeConnectors} onChange={(v) => set('claudeConnectors', v)} team={agent.teamId ? state.teams?.[agent.teamId] ?? null : null} />
      )}

      <div className="ag-block">
        <h3 className="ag-h3">{t('ag.details')}</h3>
        <div className="ag-grid">
          <label className="field">
            <span className="field__label">{t('ag.name')}</span>
            <input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} required maxLength={100} />
          </label>
          <label className="field">
            <span className="field__label">{t('ag.role')}</span>
            <input className="input" value={draft.role} onChange={(e) => set('role', e.target.value)} maxLength={200} />
          </label>
          <ReportsToField agents={agents} selfId={agent.id} value={draft.reportsTo} onChange={(v) => set('reportsTo', v)} />
          <TeamSelect value={draft.teamId || null} onChange={(v) => set('teamId', v && v !== 'auto' ? v : '')} />
          <label className="field">
            <span className="field__label">{t('ag.runtime')}</span>
            <select className="input" value={lockTeam?.runtime ?? draft.runtime} disabled={!!lockTeam} onChange={(e) => setDraft((d) => ({ ...d, runtime: e.target.value, model: '' }))}>
              {runtimeChoices(runtimes, lockTeam?.runtime ?? draft.runtime).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            {lockTeam && <span className="small muted ai-locked-by"><LockIcon /> {t('ai.lockedBy', { team: lockTeam.name })}</span>}
          </label>
          <ModelField runtimes={runtimes} runtime={lockTeam?.runtime ?? draft.runtime} value={lockTeam && lockTeam.id !== agent.teamId ? lockTeam.model ?? '' : draft.model} disabled={!!lockTeam} onChange={(v) => set('model', v)} />
          <label className="field">
            <span className="field__label">{t('ag.checkin')}</span>
            <input className="input" type="number" min={0} max={10080} step={5} value={draft.heartbeatMinutes} onChange={(e) => set('heartbeatMinutes', e.target.value)} />
            <span className="small muted">{t('ag.checkinHint')}</span>
          </label>
          <label className="field">
            <span className="field__label">{t('ag.budget')}</span>
            <input className="input" type="number" min={0} step={1} value={draft.monthlyBudgetUsd} onChange={(e) => set('monthlyBudgetUsd', e.target.value)} />
          </label>
          <label className="check ag-grid__check">
            <input type="checkbox" checked={draft.paused} onChange={(e) => set('paused', e.target.checked)} />
            <span>{t('ag.paused')}</span>
          </label>
        </div>
        <label className="field">
          <span className="field__label">{t('ag.job')}</span>
          <textarea className="input textarea" rows={3} value={draft.job} placeholder={t('ag.jobPlaceholder')} onChange={(e) => set('job', e.target.value)} />
        </label>
      </div>

      <div className="ag-block">
        <h3 className="ag-h3">{t('ag.perms.heading')}</h3>
        <p className="small muted">{t('ag.perms.hint')}</p>
        <div className="ag-perms">
          {PERMISSION_KEYS.map((key) => (
            <fieldset key={key} className="ag-perm">
              <legend className="ag-perm__label">{permission(key)}</legend>
              <div className="ag-seg">
                {(['allow', 'ask', 'never'] as const).map((level) => {
                  const ok = allowedLevels(key).includes(level);
                  return (
                    <label key={level} className={`ag-seg__opt ag-seg__opt--${level}${draft.permissions[key] === level ? ' ag-seg__opt--on' : ''}${ok ? '' : ' ag-seg__opt--off'}`}>
                      <input
                        type="radio"
                        className="sr-only"
                        name={`perm-${key}`}
                        value={level}
                        checked={draft.permissions[key] === level}
                        disabled={!ok}
                        onChange={() => set('permissions', { ...draft.permissions, [key]: level })}
                      />
                      {t(LEVEL_KEY[level])}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
        <p className="small muted">{t('ag.perms.prodHint')}</p>
      </div>

      <div className="ag-actions">
        <DeleteAgentButton agent={agent} agents={agents} onDeleted={onDeleted} />
        {error && <span className="form-error" role="alert">{error}</span>}
        {note && <span className="notice" role="status">{note}</span>}
        <span className="ag-actions__spacer" />
        {dirty && <button type="button" className="btn btn--outline" onClick={() => { setDraft(base); setError(null); }} disabled={busy}>{t('ag.reset')}</button>}
        <button type="submit" className="btn btn--primary" disabled={busy || !dirty}>{busy ? t('ag.saving') : t('ag.save')}</button>
      </div>
    </form>
  );
}

function NewAgentForm({ agents, runtimes, parentId, onCancel, onCreated }: {
  agents: Agent[];
  runtimes: RuntimeInfo[];
  parentId: Id | null;
  onCancel: () => void;
  onCreated: (a: Agent) => void;
}) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const defaultRuntime = runtimes.find((r) => r.id === 'claude-cli')?.id ?? runtimes.find((r) => r.id !== 'mock')?.id ?? runtimes[0]?.id ?? 'claude-cli';
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [reportsTo, setReportsTo] = useState(parentId ?? '');
  const [runtime, setRuntime] = useState(defaultRuntime);
  const [model, setModel] = useState('');
  const [checkin, setCheckin] = useState('60');
  const [job, setJob] = useState('');
  const [teamId, setTeamId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Runtimes may arrive after the form opened.
  useEffect(() => { setRuntime((r) => (runtimes.some((x) => x.id === r) ? r : defaultRuntime)); }, [runtimes, defaultRuntime]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError(t('ag.nameRequired')); return; }
    setBusy(true); setError(null);
    const newLock = lockedTeam(state.teams, teamId || null);
    const body: CreateAgentBody = {
      name: name.trim(), role: role.trim(), job: job.trim(), ...(newLock ? {} : { runtime, model: model.trim() || null }),
      reportsTo: reportsTo || null, heartbeatMinutes: Math.max(0, Math.round(Number(checkin) || 0)),
      ...(teamId ? { teamId } : {}),
    };
    try {
      onCreated(await api.createAgent(body));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="ag-card ag-card--new" onSubmit={submit}>
      <div className="ag-col-head">
        <h2 className="ag-editor__name">{t('ag.newAgent.title')}</h2>
        <button type="button" className="btn btn--outline btn--sm" onClick={onCancel}>{t('ag.cancel')}</button>
      </div>
      <div className="ag-grid">
        <label className="field">
          <span className="field__label">{t('ag.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('ag.namePlaceholder')} maxLength={100} autoFocus />
        </label>
        <label className="field">
          <span className="field__label">{t('ag.role')}</span>
          <input className="input" value={role} onChange={(e) => setRole(e.target.value)} placeholder={t('ag.rolePlaceholder')} maxLength={200} />
        </label>
        <ReportsToField agents={agents} selfId={null} value={reportsTo} onChange={setReportsTo} />
        <TeamSelect value={teamId || null} onChange={(v) => {
          const id = v && v !== 'auto' ? v : '';
          setTeamId(id);
          // A team with an AI gives it to new members.
          const tm = id ? state.teams?.[id] : undefined;
          if (tm?.runtime) { setRuntime(tm.runtime); setModel(tm.model ?? ''); }
        }} />
        <label className="field">
          <span className="field__label">{t('ag.runtime')}</span>
          <select className="input" value={runtime} disabled={!!lockedTeam(state.teams, teamId || null)} onChange={(e) => { setRuntime(e.target.value); setModel(''); }}>
            {runtimeChoices(runtimes, runtime).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          {lockedTeam(state.teams, teamId || null) && <span className="small muted ai-locked-by"><LockIcon /> {t('ai.lockedBy', { team: lockedTeam(state.teams, teamId || null)!.name })}</span>}
        </label>
        <ModelField runtimes={runtimes} runtime={runtime} value={model} disabled={!!lockedTeam(state.teams, teamId || null)} onChange={setModel} />
        <label className="field">
          <span className="field__label">{t('ag.checkin')}</span>
          <input className="input" type="number" min={0} max={10080} step={5} value={checkin} onChange={(e) => setCheckin(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field__label">{t('ag.job')}</span>
        <textarea className="input textarea" rows={3} value={job} placeholder={t('ag.jobPlaceholder')} onChange={(e) => setJob(e.target.value)} />
      </label>
      <div className="ag-actions">
        {error && <span className="form-error" role="alert">{error}</span>}
        <span className="small muted">{t('ag.createdHint')}</span>
        <span className="ag-actions__spacer" />
        <button type="submit" className="btn btn--primary" disabled={busy}>{t('ag.create')}</button>
      </div>
    </form>
  );
}
