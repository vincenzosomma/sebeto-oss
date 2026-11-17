/**
 * v0.4 teams (packages/shared/src/teams.ts; docs/28 v0.4 Plan.md §C): team chips, the sidebar team
 * filter, the Teams dialog (create / edit / delete, default for new tickets), the Team picker and
 * the live routing suggestion of the new-ticket form.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { PROJECT_COLORS, type Id, type RouteDecision, type RoutePreviewBody, type Team, type TeamChoice } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage } from '../lib/format';
import { teamList } from '../lib/teams';
import { Dialog } from './Dialog';
import { LockIcon, TeamAiBadge, TeamAiFields, useRuntimes, type TeamAiValue } from './TeamAi';
import { entityColor } from '../lib/theme';
import type { ClaudeConnectorInfo } from '@sebeto/shared';

/** A small coloured chip with the team name (cards, org chart, lists). */
export function TeamChip({ team, small = false }: { team: Team; small?: boolean }) {
  return (
    <span className={`tm-chip${small ? ' tm-chip--small' : ''}`} title={team.lockRuntime && team.runtime ? `${team.name} · ${team.runtime}` : team.name}>
      <span className="tm-chip__dot" style={{ background: entityColor(team.color) }} aria-hidden="true" />
      <span className="tm-chip__name">{team.name}</span>
      {team.lockRuntime && team.runtime && <LockIcon />}
    </span>
  );
}

/** The team chip of an agent, or nothing. */
export function AgentTeamChip({ teamId, small = true }: { teamId: Id | null | undefined; small?: boolean }) {
  const { state } = useStore();
  const team = teamId ? state.teams?.[teamId] : undefined;
  return team ? <TeamChip team={team} small={small} /> : null;
}

/** Sidebar: filter the board by team. */
export function TeamsNav({ onPicked }: { onPicked: () => void }) {
  const { state, actions } = useStore();
  const { t } = useI18n();
  const [manage, setManage] = useState(false);
  const teams = teamList(state.teams);
  const pick = (f: Id | 'none' | null) => { actions.setTeamFilter(f); onPicked(); };
  return (
    <nav aria-label={t('tm.heading')}>
      <div className="pj-head">
        <h2 className="section-label">{t('tm.heading')}</h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setManage(true)}>{t('tm.manage')}</button>
      </div>
      <ul className="views">
        {teams.map((tm) => (
          <li key={tm.id}>
            <button type="button" className={`view-btn${state.teamFilter === tm.id ? ' view-btn--active' : ''}`} aria-pressed={state.teamFilter === tm.id}
              onClick={() => pick(state.teamFilter === tm.id ? null : tm.id)}>
              <span className="pj-name"><span className="pj-dot" style={{ background: entityColor(tm.color) }} aria-hidden="true" />{tm.name}{tm.lockRuntime && tm.runtime && <span className="ai-nav-lock" title={tm.runtime}><LockIcon /></span>}</span>
              <span className="count">{tm.memberIds.length}</span>
            </button>
          </li>
        ))}
        {teams.length > 0 && (
          <li>
            <button type="button" className={`view-btn${state.teamFilter === 'none' ? ' view-btn--active' : ''}`} aria-pressed={state.teamFilter === 'none'}
              onClick={() => pick(state.teamFilter === 'none' ? null : 'none')}>
              <span className="muted">{t('tm.none')}</span>
            </button>
          </li>
        )}
        {teams.length === 0 && (
          <li><button type="button" className="view-btn" onClick={() => setManage(true)}><span className="muted">{t('tm.create')}</span></button></li>
        )}
      </ul>
      {manage && <TeamsDialog onClose={() => setManage(false)} />}
    </nav>
  );
}

/** The Team picker. allowAuto adds "Automatic"; the value '' means no team. */
export function TeamSelect({ value, onChange, allowAuto = false, disabled = false, label = true }: {
  value: TeamChoice | undefined; onChange: (v: TeamChoice) => void; allowAuto?: boolean; disabled?: boolean; label?: boolean;
}) {
  const { state } = useStore();
  const { t } = useI18n();
  const teams = teamList(state.teams);
  const select = (
    <select className="input" value={value ?? ''} disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} aria-label={label ? undefined : t('tm.team')}>
      {allowAuto && <option value="auto">{t('tm.auto')}</option>}
      <option value="">{t('tm.none')}</option>
      {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
    </select>
  );
  if (!label) return select;
  return (
    <label className="field">
      <span className="field__label">{t('tm.team')}</span>
      {select}
    </label>
  );
}

/** "mentions VPN → Infrastructure" → "mentions VPN" (the team is shown separately). */
export function shortReason(reason: string): string {
  return reason.replace(/^Chief of Staff:\s*/, '').split(' → ')[0]!.trim();
}

/** Live "Suggested: Infrastructure → Infrastructure Lead (mentions VPN)" for the new-ticket form (rules only, debounced). */
export function RouteSuggestion({ input, onDecision }: { input: RoutePreviewBody; onDecision?: (d: RouteDecision | null) => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(input);
  const empty = !input.title.trim() && !input.goal.trim();
  useEffect(() => {
    if (empty) { setDecision(null); onDecision?.(null); return; }
    let live = true;
    setBusy(true);
    const timer = setTimeout(() => {
      api.previewRoute({ ...input, rulesOnly: true }).then(
        (d) => { if (live) { setDecision(d); onDecision?.(d); setBusy(false); } },
        () => { if (live) { setDecision(null); onDecision?.(null); setBusy(false); } },
      );
    }, 450);
    return () => { live = false; clearTimeout(timer); };
  }, [api, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (empty) return null;
  if (busy && !decision) return <p className="small muted tm-suggest" role="status">{t('tm.suggesting')}</p>;
  if (!decision || !decision.teamId) return <p className="small muted tm-suggest" role="status">{t('tm.noSuggestion')}</p>;
  const team = state.teams?.[decision.teamId];
  const agent = decision.agentId ? state.agents[decision.agentId] : undefined;
  const target = `${team?.name ?? '?'}${agent ? ` → ${agent.name}` : ''}`;
  return (
    <p className="small tm-suggest" role="status">
      {team && <span className="pj-dot" style={{ background: entityColor(team.color) }} aria-hidden="true" />}
      {t('tm.suggested', { target })} <span className="muted">({shortReason(decision.reason)})</span>
    </p>
  );
}

/** Create, edit (name, lead, colour, routing hints) and delete teams; the default for new tickets. */
export function TeamsDialog({ onClose }: { onClose: () => void }) {
  const { state, api, actions } = useStore();
  const { t } = useI18n();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [autoTags, setAutoTags] = useState<boolean | null>(null);
  const [budgetBlocks, setBudgetBlocks] = useState<boolean | null>(null);
  const teams = teamList(state.teams);
  const runtimes = useRuntimes();

  useEffect(() => {
    void actions.loadTeams();
    api.getSettings().then((s) => { setAuto(s.newTicketTeam === 'auto'); setAutoTags(s.autoTags !== false); setBudgetBlocks(s.budgetBlocks !== false); }, () => setAuto(null));
  }, [api, actions]);

  const remove = async (id: string) => {
    try { await api.deleteTeam(id); setConfirmDelete(null); await actions.loadTeams(); } catch (e) { setError(errorMessage(e)); }
  };
  const toggleAuto = async (on: boolean) => {
    setAuto(on);
    try { await api.updateSettings({ newTicketTeam: on ? 'auto' : 'manual' }); } catch (e) { setError(errorMessage(e)); setAuto(!on); }
  };

  const toggleAutoTags = async (on: boolean) => {
    setAutoTags(on);
    try { await api.updateSettings({ autoTags: on }); } catch (e) { setError(errorMessage(e)); setAutoTags(!on); }
  };

  const toggleBudgetBlocks = async (on: boolean) => {
    setBudgetBlocks(on);
    try { await api.updateSettings({ budgetBlocks: on }); } catch (e) { setError(errorMessage(e)); setBudgetBlocks(!on); }
  };

  return (
    <Dialog title={editing ? t(editing === 'new' ? 'tm.newTitle' : 'tm.editTitle') : t('tm.manageTitle')} onClose={onClose} wide>
      {error && <p className="mail-error" role="alert">{error}</p>}
      {editing ? (
        <TeamForm team={editing === 'new' ? null : editing} onDone={() => { setEditing(null); void actions.loadTeams(); }} onError={setError} />
      ) : (
        <div className="pj-manage">
          <p className="small muted">{t('tm.intro')}</p>
          <button type="button" className="btn btn--primary btn--sm pj-new" onClick={() => setEditing('new')}>{t('tm.create')}</button>
          {auto !== null && (
            <label className="check tm-default">
              <input type="checkbox" checked={auto} onChange={(e) => void toggleAuto(e.target.checked)} />
              <span>{t('tm.defaultAuto')}</span>
            </label>
          )}
          {autoTags !== null && (
            <label className="check tm-default">
              <input type="checkbox" checked={autoTags} onChange={(e) => void toggleAutoTags(e.target.checked)} />
              <span>{t('tm.autoTags')}</span>
            </label>
          )}
          {budgetBlocks !== null && (
            <label className="check tm-default">
              <input type="checkbox" checked={budgetBlocks} onChange={(e) => void toggleBudgetBlocks(e.target.checked)} />
              <span>{t('tm.budgetBlocks')}</span>
            </label>
          )}
          {teams.length === 0 ? <p className="trusted__empty">{t('tm.empty')}</p> : (
            <ul className="pj-list">
              {teams.map((tm) => {
                const lead = tm.leadAgentId ? state.agents[tm.leadAgentId] : undefined;
                const members = tm.memberIds.map((id) => state.agents[id]?.name).filter(Boolean);
                return (
                  <li key={tm.id} className="pj-row">
                    <div className="pj-row__main">
                      <span className="pj-name"><span className="pj-dot" style={{ background: entityColor(tm.color) }} aria-hidden="true" /><strong>{tm.name}</strong><span className="small muted">{tm.slug}</span><TeamAiBadge team={tm} runtimes={runtimes} />{tm.requireScope && <span className="ai-badge ai-badge--scope">{t('scope.title')}</span>}</span>
                      <span className="small muted">
                        {t('tm.leadLine', { name: lead?.name ?? t('tm.noLead') })} · {t('tm.members', { count: tm.memberIds.length })}
                        {members.length > 0 ? `: ${members.join(', ')}` : ''}
                      </span>
                      {tm.routingHints && <span className="small pj-brief">{t('tm.hints')}: {tm.routingHints}</span>}
                      {tm.claudeConnectors?.length > 0 && <span className="small pj-brief">{t('tm.claudeLine', { names: tm.claudeConnectors.join(', ') })}</span>}
                    </div>
                    {confirmDelete === tm.id ? (
                      <span className="row pj-confirm">
                        <span className="small">{t('tm.deleteConfirm')}</span>
                        <button type="button" className="btn btn--danger btn--sm" onClick={() => void remove(tm.id)}>{t('tm.delete')}</button>
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(null)}>{t('tm.cancel')}</button>
                      </span>
                    ) : (
                      <span className="row">
                        <button type="button" className="btn btn--outline btn--sm" onClick={() => setEditing(tm)}>{t('tm.edit')}</button>
                        <button type="button" className="btn btn--ghost btn--sm pj-del" onClick={() => setConfirmDelete(tm.id)}>{t('tm.delete')}</button>
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

function TeamForm({ team, onDone, onError }: { team: Team | null; onDone: () => void; onError: (m: string | null) => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const [name, setName] = useState(team?.name ?? '');
  const [hints, setHints] = useState(team?.routingHints ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [lead, setLead] = useState(team?.leadAgentId ?? '');
  const [color, setColor] = useState(team?.color ?? PROJECT_COLORS[Object.keys(state.teams ?? {}).length % PROJECT_COLORS.length]!);
  const [busy, setBusy] = useState(false);
  const agents = Object.values(state.agents).sort((a, b) => a.name.localeCompare(b.name));
  // v0.4 F/G: the team's AI, its lock and the scope rule.
  const runtimes = useRuntimes();
  const [ai, setAi] = useState<TeamAiValue>({ runtime: team?.runtime ?? '', model: team?.model ?? '', lockRuntime: !!team?.lockRuntime, requireScope: !!team?.requireScope });
  const [applied, setApplied] = useState<string | null>(null);
  const [claude, setClaude] = useState<string[]>([...(team?.claudeConnectors ?? [])]);
  const aiBody = { runtime: ai.runtime || null, model: ai.runtime ? ai.model.trim() || null : null, lockRuntime: !!ai.runtime && ai.lockRuntime, requireScope: ai.requireScope };
  const applyNow = async () => {
    if (!team) return;
    setBusy(true); onError(null); setApplied(null);
    try {
      await api.updateTeam(team.id, { ...aiBody, applyToMembers: true });
      setApplied(t('ai.applied'));
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); onError(null);
    try {
      const body = { name: name.trim(), routingHints: hints, description, color, leadAgentId: lead || null, ...aiBody, claudeConnectors: claude };
      if (team) await api.updateTeam(team.id, body);
      else await api.createTeam(body);
      onDone();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack pj-form" onSubmit={save}>
      <label className="field">
        <span className="field__label">{t('tm.name')}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('tm.namePlaceholder')} required maxLength={80} />
      </label>
      <label className="field">
        <span className="field__label">{t('tm.lead')}</span>
        <select className="input" value={lead} onChange={(e) => setLead(e.target.value)}>
          <option value="">{t('tm.noLead')}</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.role ? `${a.name} (${a.role})` : a.name}</option>)}
        </select>
        <span className="small muted">{t('tm.leadHint')}</span>
      </label>
      <label className="field">
        <span className="field__label">{t('tm.hints')}</span>
        <textarea className="input textarea" rows={3} value={hints} onChange={(e) => setHints(e.target.value)} placeholder={t('tm.hintsPlaceholder')} maxLength={2000} />
        <span className="small muted">{t('tm.hintsHint')}</span>
      </label>
      <label className="field">
        <span className="field__label">{t('tm.description')}</span>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      </label>
      <TeamClaudeConnectors selected={claude} onChange={setClaude} />
      <TeamAiFields value={ai} onChange={(v) => { setAi(v); setApplied(null); }} runtimes={runtimes} onApply={team ? () => void applyNow() : undefined} applyBusy={busy} hint={applied} />
      <div className="field">
        <span className="field__label">{t('tm.color')}</span>
        <span className="pj-colors" role="radiogroup" aria-label={t('tm.color')}>
          {PROJECT_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color.toUpperCase() === c} aria-label={c}
              className={`pj-swatch${color.toUpperCase() === c ? ' pj-swatch--on' : ''}`} style={{ background: entityColor(c) }} onClick={() => setColor(c)} />
          ))}
        </span>
      </div>
      <span className="row">
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !name.trim()}>{t('tm.save')}</button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onDone}>{t('tm.cancel')}</button>
      </span>
    </form>
  );
}

/** v0.9: the owner's Claude connectors every member of the team may use (Claude Code agents only). */
function TeamClaudeConnectors({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  const { state, api } = useStore();
  const { t } = useI18n();
  const [list, setList] = useState<ClaudeConnectorInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true); setError(null);
    try { setList(await api.listClaudeConnectors()); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  // Names known without asking Claude Code: chosen here, or ticked on any agent or any team.
  const known = [
    ...selected,
    ...Object.values(state.agents).flatMap((a) => a.claudeConnectors ?? []),
    ...Object.values(state.teams ?? {}).flatMap((tm) => tm.claudeConnectors ?? []),
    ...(list ?? []).filter((c) => c.connected).map((c) => c.name),
  ];
  const names = [...new Set(known)].sort((a, b) => a.localeCompare(b));
  return (
    <fieldset className="field">
      <legend className="field__label">{t('tm.claude')}</legend>
      {names.length === 0 && <span className="small muted">{t('tm.claudeNone')}</span>}
      {names.map((n) => (
        <label key={n} className="check">
          <input type="checkbox" checked={selected.includes(n)} onChange={(e) => onChange(e.target.checked ? [...selected, n] : selected.filter((x) => x !== n))} />
          <span>{n}</span>
          {list && !list.some((c) => c.name === n && c.connected) && <span className="small muted"> · {t('ag.claudeConn.missing')}</span>}
        </label>
      ))}
      <span className="row">
        <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => void load()}>{busy ? t('ag.claudeConn.loading') : t('ag.claudeConn.load')}</button>
      </span>
      {error && <p className="mail-error small" role="alert">{error}</p>}
      <span className="small muted">{t('tm.claudeHint')}</span>
    </fieldset>
  );
}
