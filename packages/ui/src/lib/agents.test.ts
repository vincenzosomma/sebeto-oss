import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type Agent, type ConnectorInfo, type Skill, type Ticket } from '@sebeto/shared';
import {
  allowedLevels, buildChart, buildTree, checkMove, deletePlan, pickDefaultAgent, connectorsForAgent, descendantIds, filterSkills, missingConnectors, needStatuses,
  parseList, reportsToOptions, skillNeeds, slugify, toggleConnectorAccess,
} from './agents';
import { needTone } from '../components/SkillLibrary';

const agent = (id: string, name: string, reportsTo: string | null = null, extra: Partial<Agent> = {}): Agent => ({
  id, name, role: '', job: '', runtime: 'mock', model: null, reportsTo, heartbeatMinutes: 60, monthlyBudgetUsd: 10,
  permissions: { ...DEFAULT_PERMISSIONS }, paused: false, createdAt: '2026-11-01T00:00:00Z', skills: [], ...extra,
});
const skill = (slug: string, needs: Skill['needs'], extra: Partial<Skill> = {}): Skill => ({
  slug, name: slug, description: '', instructions: '', needs, connectors: [], files: [], version: 1,
  updatedAt: '2026-11-01T00:00:00Z', usedBy: [], ...extra,
});
const connector = (id: string, name: string, allowedAgents: string[] | null, extra: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id, name, catalogId: 'folder', transport: { type: 'stdio', command: 'x', args: [] }, settings: [], enabled: true,
  allowedAgents, tools: [], status: 'connected', error: null, createdAt: '2026-11-01T00:00:00Z', ...extra,
});

// Analyst → Comms, Analyst → Researcher → Intern; Sysadmin → Automation
const team = [
  agent('a', 'Analyst'),
  agent('c', 'Comms writer', 'a'),
  agent('r', 'Researcher', 'a'),
  agent('i', 'Intern', 'r'),
  agent('s', 'Sysadmin'),
  agent('u', 'Automation', 's'),
];

describe('buildTree', () => {
  it('orders depth-first with siblings by name and counts direct reports', () => {
    const rows = buildTree(team);
    expect(rows.map((r) => `${r.agent.name}:${r.depth}`)).toEqual([
      'Analyst:0', 'Comms writer:1', 'Researcher:1', 'Intern:2', 'Sysadmin:0', 'Automation:1',
    ]);
    expect(rows.find((r) => r.agent.id === 'a')?.directReports).toBe(2);
    expect(rows.find((r) => r.agent.id === 'i')?.directReports).toBe(0);
  });
  it('puts agents with an unknown manager at the top level', () => {
    const rows = buildTree([agent('x', 'Orphan', 'gone')]);
    expect(rows).toEqual([expect.objectContaining({ depth: 0, directReports: 0 })]);
  });
  it('never loses agents caught in a cycle', () => {
    const rows = buildTree([agent('p', 'P', 'q'), agent('q', 'Q', 'p'), agent('z', 'Z', 'z')]);
    expect(rows.map((r) => r.agent.id).sort()).toEqual(['p', 'q', 'z']);
  });
});

describe('reports to', () => {
  it('finds every agent below one', () => {
    expect([...descendantIds(team, 'a')].sort()).toEqual(['c', 'i', 'r']);
    expect(descendantIds(team, 'i').size).toBe(0);
  });
  it('excludes the agent itself and its descendants', () => {
    expect(reportsToOptions(team, 'a').map((x) => x.id).sort()).toEqual(['s', 'u']);
    expect(reportsToOptions(team, 'r').map((x) => x.id).sort()).toEqual(['a', 'c', 's', 'u']);
    expect(reportsToOptions(team, null)).toHaveLength(team.length);
  });
});

describe('skill needs', () => {
  const lib = [skill('notice', ['email.send', 'fs.write']), skill('cve', ['web.read', 'fs.read']), skill('other', ['prod.change'])];
  it('unions the needs of the assigned skills in standard order', () => {
    expect(skillNeeds(lib, ['notice', 'cve'])).toEqual(['fs.read', 'fs.write', 'web.read', 'email.send']);
    expect(skillNeeds(lib, [])).toEqual([]);
    expect(skillNeeds(lib, ['missing'])).toEqual([]);
  });
  it('warns when the agent has Never for a needed permission', () => {
    const a = agent('a', 'A', null, { skills: ['notice'], permissions: { ...DEFAULT_PERMISSIONS, 'email.send': 'never' } });
    expect(needStatuses(lib, a)).toEqual([
      { key: 'fs.write', level: 'allow', blocked: false },
      { key: 'email.send', level: 'never', blocked: true },
    ]);
  });
  it('never offers Allow for production changes', () => {
    expect(allowedLevels('prod.change')).toEqual(['ask', 'never']);
    expect(allowedLevels('fs.read')).toEqual(['allow', 'ask', 'never']);
  });
  it('colours permissions by risk', () => {
    expect(needTone('fs.read')).toBe('read');
    expect(needTone('fs.write')).toBe('edit');
    expect(needTone('email.send')).toBe('ask');
    expect(needTone('prod.change')).toBe('prod');
  });
});

describe('connectors', () => {
  const list = [
    connector('1', 'Runbooks share', ['s']),
    connector('2', 'Wiki', null, { catalogId: 'confluence' }),
    connector('3', 'Old', null, { enabled: false }),
  ];
  it('lists the enabled connectors an agent may use', () => {
    expect(connectorsForAgent(list, 's').map((c) => c.id)).toEqual(['1', '2']);
    expect(connectorsForAgent(list, 'a').map((c) => c.id)).toEqual(['2']);
  });
  it('reports connectors that the skills expect but the agent cannot use', () => {
    const lib = [skill('rb', [], { connectors: ['Runbooks share', 'gmail'] }), skill('kb', [], { connectors: ['confluence'] })];
    const usable = connectorsForAgent(list, 'a');
    expect(missingConnectors(lib, ['rb', 'kb'], usable, false)).toEqual(['Runbooks share', 'gmail']);
    expect(missingConnectors(lib, ['rb', 'kb'], connectorsForAgent(list, 's'), true)).toEqual([]);
  });
});

describe('text helpers', () => {
  it('filters skills by name, description or slug', () => {
    const lib = [skill('b-one', [], { name: 'Beta', description: 'firewall CVEs' }), skill('a-two', [], { name: 'Alpha' })];
    expect(filterSkills(lib, '').map((s) => s.name)).toEqual(['Alpha', 'Beta']);
    expect(filterSkills(lib, 'CVE').map((s) => s.name)).toEqual(['Beta']);
    expect(filterSkills(lib, 'a-two').map((s) => s.name)).toEqual(['Alpha']);
  });
  it('parses comma lists', () => {
    expect(parseList(' gmail, Runbooks share ,,gmail')).toEqual(['gmail', 'Runbooks share']);
    expect(parseList('')).toEqual([]);
  });
  it('derives folder names', () => {
    expect(slugify('Incident summary')).toBe('incident-summary');
    expect(slugify('  Città & CVE: triage!  ')).toBe('citta-cve-triage');
    expect(slugify('!!!')).toBe('');
  });
});

describe('toggleConnectorAccess', () => {
  const all = ['a', 'b', 'c'];
  it('unticking from everyone lists the others; ticking the last one goes back to everyone', () => {
    expect(toggleConnectorAccess(null, 'b', all, false)).toEqual(['a', 'c']);
    expect(toggleConnectorAccess(['a', 'c'], 'b', all, true)).toBeNull();
    expect(toggleConnectorAccess(['a'], 'c', all, true)).toEqual(['a', 'c']);
    expect(toggleConnectorAccess(['a'], 'a', all, false)).toEqual([]);
    expect(toggleConnectorAccess(null, 'a', all, true)).toBeNull();
  });
});

describe('org chart editor helpers', () => {
  // You -> cos -> (lead -> (writer, analyst)), infra
  const team = [
    agent('cos', 'Chief of Staff'),
    agent('lead', 'Service Desk Lead', 'cos'),
    agent('writer', 'Comms writer', 'lead'),
    agent('analyst', 'Analyst', 'lead'),
    agent('infra', 'Infrastructure Lead', 'cos'),
  ];

  it('checkMove rejects loops, self and no-op moves', () => {
    expect(checkMove(team, 'writer', 'infra')).toEqual({ ok: true });
    expect(checkMove(team, 'lead', null)).toEqual({ ok: true });
    expect(checkMove(team, 'cos', 'writer')).toEqual({ ok: false, reason: 'loop' });
    expect(checkMove(team, 'lead', 'analyst')).toEqual({ ok: false, reason: 'loop' });
    expect(checkMove(team, 'lead', 'lead')).toEqual({ ok: false, reason: 'self' });
    expect(checkMove(team, 'writer', 'lead')).toEqual({ ok: false, reason: 'same' });
    expect(checkMove(team, 'cos', null)).toEqual({ ok: false, reason: 'same' });
    expect(checkMove(team, 'ghost', null)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('buildChart nests agents like the tree', () => {
    const chart = buildChart(team);
    expect(chart.map((n) => n.agent.id)).toEqual(['cos']);
    expect(chart[0]!.children.map((n) => n.agent.id)).toEqual(['infra', 'lead']);
    expect(chart[0]!.children[1]!.children.map((n) => n.agent.id)).toEqual(['analyst', 'writer']);
    // An orphan (unknown manager) is shown at the top level.
    expect(buildChart([...team, agent('x', 'Orphan', 'gone')]).map((n) => n.agent.id)).toEqual(['cos', 'x']);
  });

  it('pickDefaultAgent prefers the oldest active real agent', () => {
    const mock = agent('m', 'Test agent', null, { runtime: 'mock', createdAt: '2026-01-01T00:00:00Z' });
    const paused = agent('p', 'Paused', null, { runtime: 'claude-cli', paused: true, createdAt: '2026-02-01T00:00:00Z' });
    const real = agent('r', 'Real', null, { runtime: 'claude-cli', createdAt: '2026-03-01T00:00:00Z' });
    expect(pickDefaultAgent([mock, paused, real])?.id).toBe('r');
    expect(pickDefaultAgent([mock, paused])?.id).toBe('p');
    expect(pickDefaultAgent([mock])?.id).toBe('m');
  });

  it('deletePlan counts open tickets and reports, and names where they go', () => {
    const real = team.map((a, i) => ({ ...a, runtime: 'claude-cli', createdAt: `2026-0${i + 1}-01T00:00:00Z` }));
    const tk = (id: string, agentId: string, status: Ticket['status']) => ({ id, agentId, status }) as Ticket;
    const plan = deletePlan(real, [tk('1', 'lead', 'backlog'), tk('2', 'lead', 'needs_you'), tk('3', 'lead', 'done'), tk('4', 'cos', 'backlog')], 'lead');
    expect(plan).toMatchObject({ openTickets: 2, reports: 2, last: false });
    expect(plan.target?.id).toBe('cos');
    expect(plan.manager?.id).toBe('cos');
    expect(deletePlan(real, [], 'cos').manager).toBeNull();
    expect(deletePlan([real[0]!], [], 'cos').last).toBe(true);
  });
});
