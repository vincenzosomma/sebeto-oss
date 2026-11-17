import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, MAX_SCOPE_CHARS, type Agent, type RuntimeInfo, type Team } from '@sebeto/shared';
import { checkScopeFile, lockedTeam, scopeReady, suggestedTemplateAi, ticketLockTeam, ticketScopeTeam } from './team-ai';
import { MockApi } from '../api/mock';

const agent = (id: string, teamId: string | null): Agent => ({
  id, name: id, role: '', job: '', runtime: 'claude-cli', model: null, reportsTo: null, heartbeatMinutes: 60, monthlyBudgetUsd: 20,
  permissions: { ...DEFAULT_PERMISSIONS }, paused: false, createdAt: '', skills: [], teamId,
});
const team = (id: string, extra: Partial<Team> = {}): Team => ({
  id, slug: id, name: id, description: '', color: '#0E5A8A', leadAgentId: null, routingHints: '', memberIds: [],
  runtime: null, model: null, lockRuntime: false, requireScope: false, claudeConnectors: [], createdAt: '', updatedAt: '', ...extra,
});
const rt = (id: string, installed: boolean): RuntimeInfo => ({ id, displayName: id, detection: { installed }, models: [] });

describe('team AI helpers', () => {
  const teams = { red: team('red', { runtime: 'ollama', lockRuntime: true, requireScope: true }), desk: team('desk', { runtime: 'mock' }) };
  const agents = { a: agent('a', 'red'), b: agent('b', 'desk') };

  it('finds the locked / scope team of a ticket (its team, else its agent\'s)', () => {
    expect(lockedTeam(teams, 'red')?.id).toBe('red');
    expect(lockedTeam(teams, 'desk')).toBeNull();
    expect(ticketLockTeam({ teamId: null, agentId: 'a' }, teams, agents)?.id).toBe('red');
    expect(ticketLockTeam({ teamId: 'desk', agentId: 'b' }, teams, agents)).toBeNull();
    expect(ticketScopeTeam({ teamId: null, agentId: 'a' }, teams, agents)?.id).toBe('red');
    expect(ticketScopeTeam({ teamId: 'desk', agentId: null }, teams, agents)).toBeNull();
  });

  it('suggests a local, locked AI for the Red Team only when installed', () => {
    expect(suggestedTemplateAi('red-team', null, [rt('ollama', true)])).toEqual({ runtime: 'ollama', lock: true, local: true });
    expect(suggestedTemplateAi('red-team', null, [rt('ollama', false)])).toBeNull();
    expect(suggestedTemplateAi('devops', null, [rt('ollama', true)])).toBeNull();
    expect(suggestedTemplateAi('x', 'claude-cli', [])).toEqual({ runtime: 'claude-cli', lock: false, local: false });
  });

  it('checks scope files and text', () => {
    expect(checkScopeFile('roe.md', 10)).toBeNull();
    expect(checkScopeFile('roe.TXT', 10)).toBeNull();
    expect(checkScopeFile('roe.pdf', 10)).toBe('scope.fileType');
    expect(checkScopeFile('roe.txt', 300_000)).toBe('scope.fileBig');
    expect(scopeReady('Host A', true)).toBe(true);
    expect(scopeReady('Host A', false)).toBe(false);
    expect(scopeReady('  ', true)).toBe(false);
    expect(scopeReady('x'.repeat(MAX_SCOPE_CHARS + 1), true)).toBe(false);
  });
});

describe('MockApi: team AI lock and written scope', () => {
  it('applies the Red Team locked on Ollama, refuses other runtimes and starts only with a scope', async () => {
    const api = new MockApi({ speed: 0 });
    const res = await api.applyTemplate({ templateId: 'red-team', runtime: 'ollama', lockRuntime: true });
    expect(res.team).toMatchObject({ runtime: 'ollama', lockRuntime: true, requireScope: true });
    expect(res.agents.every((a) => a.runtime === 'ollama')).toBe(true);
    const member = res.agents[1]!;
    await expect(api.updateAgent(member.id, { runtime: 'claude-cli' })).rejects.toMatchObject({ status: 409, code: 'runtime_locked' });
    await expect(api.createTicket({ title: 'x', goal: 'y', teamId: res.team!.id, runtime: 'claude-cli' })).rejects.toMatchObject({ code: 'runtime_locked' });
    await expect(api.createTicket({ title: 'x', goal: 'y', teamId: res.team!.id, start: true })).rejects.toMatchObject({ code: 'scope_required' });
    const t = await api.createTicket({ title: 'Pentest', goal: 'Lab', teamId: res.team!.id });
    await expect(api.startTicket(t.id)).rejects.toMatchObject({ code: 'scope_required' });
    const scoped = await api.setTicketScope(t.id, { text: 'Lab host only', confirm: true });
    expect(scoped.scope?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(api.startTicket(t.id)).resolves.toBeUndefined();
    expect((await api.clearTicketScope(t.id)).scope).toBeNull();
    // Not installed → unlocked with a warning.
    const codex = await api.applyTemplate({ templateId: 'red-team', runtime: 'codex', lockRuntime: true });
    expect(codex.team).toMatchObject({ runtime: null, lockRuntime: false });
    expect(codex.warnings?.length).toBe(1);
  });
});
