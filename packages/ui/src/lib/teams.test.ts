import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type Agent, type AuditEvent, type Team } from '@sebeto/shared';
import { agentsForTeam, latestRouting, mockRoute, teamList } from './teams';
import { initialState, reducer } from '../store/reducer';
import { MockApi } from '../api/mock';

const agent = (id: string, name: string, teamId: string | null, extra: Partial<Agent> = {}): Agent => ({
  id, name, role: '', job: '', runtime: 'claude-cli', model: null, reportsTo: null, heartbeatMinutes: 60, monthlyBudgetUsd: 20,
  permissions: { ...DEFAULT_PERMISSIONS }, paused: false, createdAt: `2026-11-0${id.length}T00:00:00Z`, skills: [], teamId, ...extra,
});
const team = (id: string, name: string, hints: string, lead: string | null): Team => ({
  id, slug: name.toLowerCase(), name, description: '', color: '#0E5A8A', leadAgentId: lead, routingHints: hints, memberIds: [], runtime: null, model: null, lockRuntime: false, requireScope: false, claudeConnectors: [], createdAt: '', updatedAt: '',
});

describe('team helpers', () => {
  const infra = team('t1', 'Infrastructure', 'servers, VPN, firewall', 'a1');
  const desk = team('t2', 'Service Desk', 'password resets, printers', 'a2');
  const agents = [agent('a2', 'Desk Lead', 't2'), agent('a1', 'Infra Lead', 't1'), agent('a3', 'Zed', null), agent('a4', 'Infra Two', 't1')];

  it('sorts teams and puts team members (lead first) before others', () => {
    expect(teamList({ t2: desk, t1: infra }).map((t) => t.name)).toEqual(['Infrastructure', 'Service Desk']);
    expect(agentsForTeam(agents, infra).map((a) => a.name)).toEqual(['Infra Lead', 'Infra Two', 'Desk Lead', 'Zed']);
    expect(agentsForTeam(agents, null).map((a) => a.name)).toEqual(['Desk Lead', 'Infra Lead', 'Infra Two', 'Zed']);
  });

  it('finds the latest routing decision in the audit events', () => {
    const ev = (summary: string, data: AuditEvent['data']): AuditEvent => ({ id: summary, ticketId: 't', runId: null, kind: 'info', summary, data, createdAt: '' });
    const d = { teamId: 't1', agentId: 'a1', reason: 'mentions VPN → Infrastructure', by: 'rules' as const, confidence: 0.9 };
    expect(latestRouting([ev('Ticket created', null)])).toBeNull();
    expect(latestRouting([ev('Routed', { routing: { ...d, teamId: null } }), ev('Routed again', { routing: d }), ev('Reassigned', null)])!.decision).toEqual(d);
  });

  it('demo routing: clear winner gets the lead; nothing matches → fallback', () => {
    expect(mockRoute({ title: 'VPN down', goal: 'office' }, [infra, desk], agents)).toMatchObject({ teamId: 't1', agentId: 'a1', by: 'rules' });
    expect(mockRoute({ title: 'Hello', goal: 'world' }, [infra, desk], agents)).toMatchObject({ teamId: null, by: 'fallback' });
  });
});

describe('teams in the store', () => {
  it('loads teams and drops a filter on a deleted team', () => {
    let s = reducer(initialState(), { type: 'teamsLoaded', teams: [team('t1', 'A', '', null)] });
    s = reducer(s, { type: 'setTeamFilter', teamId: 't1' });
    expect(s.teamFilter).toBe('t1');
    s = reducer(s, { type: 'teamsLoaded', teams: [] });
    expect(s.teamFilter).toBeNull();
    expect(reducer(s, { type: 'ws', event: { type: 'teams.changed' } }).versions['teams.changed']).toBe(1);
  });
});

describe('mock API teams', () => {
  it('creates tickets with a team or automatic routing, filters by team, applies templates as teams', async () => {
    const api = new MockApi({ speed: 0 });
    const teams = await api.listTeams();
    const infra = teams.find((t) => t.slug === 'infrastructure')!;
    const auto = await api.createTicket({ title: 'VPN down in Naples', goal: 'Nobody can connect', teamId: 'auto' });
    expect((await api.getTicket(auto.id)).ticket.teamId).toBe(infra.id);
    const manual = await api.createTicket({ title: 'Anything', goal: 'x', teamId: infra.id });
    expect(manual.teamId).toBe(infra.id);
    expect(infra.memberIds).toContain(manual.agentId);
    const page = await api.listTickets({ teamId: infra.id });
    expect(page.items.every((t) => t.teamId === infra.id)).toBe(true);
    const applied = await api.applyTemplate({ templateId: 'red-team' });
    expect(applied.team).toMatchObject({ slug: 'red-team', name: 'Red Team', leadAgentId: applied.agents[0]!.id });
    expect(applied.agents.every((a) => a.permissions['script.run'] === 'ask')).toBe(true);
  });
});
