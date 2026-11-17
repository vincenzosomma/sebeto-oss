/** Pure helpers for teams and routing in the UI (v0.4, packages/shared/src/teams.ts). */
import type { Agent, AuditEvent, Id, RouteDecision, RoutePreviewBody, Team } from '@sebeto/shared';
import { pickDefaultAgent } from './agents';

/** Teams sorted by name (empty while not loaded). */
export function teamList(teams: Record<Id, Team> | null | undefined): Team[] {
  return Object.values(teams ?? {}).sort((a, b) => a.name.localeCompare(b.name));
}

/** Agents sorted by name, the given team's members first (lead first among them). */
export function agentsForTeam(agents: Agent[], team: Team | null | undefined): Agent[] {
  const rank = (a: Agent) => (!team ? 1 : a.id === team.leadAgentId ? 0 : a.teamId === team.id ? 0.5 : 1);
  return [...agents].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The latest routing decision of a ticket, from its audit events (core writes data.routing). */
export function latestRouting(events: AuditEvent[]): { summary: string; decision: RouteDecision; at: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const r = (e.data as { routing?: RouteDecision } | null)?.routing;
    if (r && typeof r.reason === 'string') return { summary: e.summary, decision: r, at: e.createdAt };
  }
  return null;
}

/** "Infrastructure → Infrastructure Lead" for a decision (names from the current lists). */
export function decisionLabel(d: RouteDecision, teams: Record<Id, Team> | null, agents: Record<Id, Agent>): { team: string | null; agent: string | null } {
  return {
    team: d.teamId ? teams?.[d.teamId]?.name ?? null : null,
    agent: d.agentId ? agents[d.agentId]?.name ?? null : null,
  };
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * A small version of the core's routing rules for the demo mode (?mock=1): count the team's hint
 * words found in the ticket; a clear winner gets it, else no team and the default agent.
 */
export function mockRoute(input: RoutePreviewBody, teams: Team[], agents: Agent[]): RouteDecision {
  const text = ` ${words(`${input.title} ${input.goal} ${(input.tags ?? []).join(' ')}`).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const scored = teams.map((t) => {
    const terms = t.routingHints.split(/[,;/\n]/).map((x) => words(x).trim()).filter((x) => x.length >= 2);
    const hits = terms.filter((term) => text.includes(` ${term} `) || text.includes(` ${term.replace(/s$/, '')} `));
    return { team: t, score: hits.length, hits };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1]?.score ?? 0;
  if (!best || best.score === 0 || best.score === second) {
    const fallback = pickDefaultAgent(agents);
    return { teamId: null, agentId: fallback?.id ?? null, reason: 'The rules were not sure: no team, the default agent.', by: 'fallback', confidence: 0 };
  }
  const members = agents.filter((a) => a.teamId === best.team.id && !a.paused);
  const agent = members.find((a) => a.id === best.team.leadAgentId) ?? members[0] ?? pickDefaultAgent(agents);
  return {
    teamId: best.team.id, agentId: agent?.id ?? null, by: 'rules', confidence: 0.8,
    reason: `mentions ${best.hits.slice(0, 3).join(' and ')} → ${best.team.name}`,
  };
}
