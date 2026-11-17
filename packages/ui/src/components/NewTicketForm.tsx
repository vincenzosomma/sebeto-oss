import { useEffect, useId, useState, type FormEvent } from 'react';
import type { TeamChoice } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { TagEditor } from './Projects';
import { RouteSuggestion, TeamSelect } from './Teams';
import { agentsForTeam } from '../lib/teams';
import { ticketScopeTeam } from '../lib/team-ai';

export function NewTicketForm() {
  const { state, actions, api } = useStore();
  const { t, status } = useI18n();
  const id = useId();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [agentId, setAgentId] = useState('');
  const [startNow, setStartNow] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  // Default project = the one the board is filtered on.
  const project = projectId ?? (state.projectFilter && state.projectFilter !== 'none' ? state.projectFilter : '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // v0.4 team: the workspace default ('manual' = no team, 'auto' = Automatic) until the owner picks one.
  const [defaultTeam, setDefaultTeam] = useState<TeamChoice>(null);
  const [teamChoice, setTeamChoice] = useState<TeamChoice | undefined>(undefined);
  useEffect(() => {
    api.getSettings().then((s) => setDefaultTeam(s.newTicketTeam === 'auto' ? 'auto' : null), () => undefined);
  }, [api, state.versions['teams.changed']]);
  const hasTeams = Object.keys(state.teams ?? {}).length > 0;
  const team = hasTeams ? (teamChoice === undefined ? defaultTeam : teamChoice) : null;
  const chosenTeam = team && team !== 'auto' ? state.teams?.[team] : undefined;
  const agents = agentsForTeam(Object.values(state.agents), chosenTeam);
  // v0.4 G: a team (or the chosen agent's team) that needs a written scope: the ticket cannot start yet.
  const scopeTeam = ticketScopeTeam({ teamId: chosenTeam?.id ?? null, agentId: agentId || null }, state.teams, state.agents);
  const valid = !!title.trim() && !!goal.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const ticket = await actions.create({
      title: title.trim(),
      goal: goal.trim(),
      agentId: agentId || null,
      projectId: project || null,
      tags,
      ...(hasTeams ? { teamId: team } : {}),
      start: startNow && !scopeTeam && !state.lockdown,
    });
    setBusy(false);
    if (ticket) {
      setTitle('');
      setGoal('');
      setStartNow(false);
      setTags([]);
      setProjectId(null);
      setTeamChoice(undefined);
      setAgentId('');
      setNotice(t('new.created', { number: ticket.number, column: status(ticket.status) }));
      actions.select(ticket.id);
    }
  };

  return (
    <section className="new-ticket" aria-labelledby={`${id}-h`}>
      <h2 className="section-label" id={`${id}-h`}>{t('new.heading')}</h2>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field__label">{t('new.title')}</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('new.titlePlaceholder')}
            required
            maxLength={200}
          />
        </label>
        <label className="field">
          <span className="field__label">{t('new.goal')}</span>
          <textarea
            className="input textarea"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t('new.goalPlaceholder')}
            required
            rows={3}
          />
        </label>
        {hasTeams && (
          <>
            <TeamSelect value={team} allowAuto onChange={(v) => { setTeamChoice(v); setAgentId(''); }} />
            {team === 'auto' && <RouteSuggestion input={{ title, goal, tags, projectId: project || null }} />}
          </>
        )}
        <label className="field">
          <span className="field__label">{t('new.agent')}</span>
          <select className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">{t('new.agentAuto')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{chosenTeam && a.teamId === chosenTeam.id ? '★ ' : ''}{a.role ? `${a.name} (${a.role})` : a.name}</option>
            ))}
          </select>
          {chosenTeam && <span className="small muted">{t('tm.agentTeamHint')}</span>}
        </label>
        {Object.keys(state.projects ?? {}).length > 0 && (
          <label className="field">
            <span className="field__label">{t('pj.project')}</span>
            <select className="input" value={project} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{t('pj.noProject')}</option>
              {Object.values(state.projects ?? {}).filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
        <div className="field">
          <span className="field__label">{t('tg.heading')}</span>
          <TagEditor tags={tags} onChange={setTags} />
        </div>
        <label className="check">
          <input type="checkbox" checked={startNow && !scopeTeam && !state.lockdown} disabled={!!scopeTeam || state.lockdown} onChange={(e) => setStartNow(e.target.checked)} />
          <span>{t('new.startNow')}</span>
        </label>
        {state.lockdown ? <p className="small scope__notice" role="note">{t('sec.lockdown.startBlocked')}</p>
          : scopeTeam && <p className="small scope__notice" role="note">{t('scope.newNote')}</p>}
        <button className="btn btn--tuff" type="submit" disabled={busy || !valid}>
          {t('new.submit')}
        </button>
        <p className="small notice" role="status">{notice}</p>
      </form>
    </section>
  );
}
