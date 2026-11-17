import { describe, expect, it } from 'vitest';
import { TEMPLATE_FORMAT, type TeamTemplate } from '@sebeto/shared';
import { checkTeamFile, teamFileName, templateTree } from './templates';
import { MOCK_TEMPLATES } from '../api/mock-templates';
import { MockApi } from '../api/mock';

const team = (): TeamTemplate => ({
  format: TEMPLATE_FORMAT, id: 'x', name: 'Crew', description: '', builtin: true,
  agents: [
    { key: 'b', name: 'Tech', role: 'r', job: 'j', reportsTo: 'a', skills: [] },
    { key: 'a', name: 'Lead', role: 'r', job: 'j', reportsTo: null, skills: [] },
  ],
  skills: [],
});

describe('team templates helpers', () => {
  it('builds the small tree with managers first', () => {
    expect(templateTree(team()).map((r) => [r.agent.name, r.depth])).toEqual([['Lead', 0], ['Tech', 1]]);
  });

  it('checks imported files lightly', () => {
    const ok = checkTeamFile(JSON.stringify(team()));
    expect(ok.ok && ok.template.builtin).toBe(false);
    expect(checkTeamFile('{oops')).toEqual({ ok: false, error: 'tt.err.json' });
    expect(checkTeamFile(JSON.stringify({ ...team(), format: 'other' }))).toEqual({ ok: false, error: 'tt.err.format' });
    const cycle = team();
    cycle.agents[1]!.reportsTo = 'b';
    expect(checkTeamFile(JSON.stringify(cycle))).toEqual({ ok: false, error: 'tt.err.cycle' });
    const ghost = team();
    ghost.agents[0]!.reportsTo = 'ghost';
    expect(checkTeamFile(JSON.stringify(ghost))).toEqual({ ok: false, error: 'tt.err.reports' });
    const big = { ...team(), agents: Array.from({ length: 31 }, (_, i) => ({ key: `k${i}`, name: 'n', role: '', job: '', reportsTo: null, skills: [] })) };
    expect(checkTeamFile(JSON.stringify(big))).toEqual({ ok: false, error: 'tt.err.tooBig' });
  });

  it('names the export file by date', () => {
    expect(teamFileName(new Date(2026, 10, 11, 9))).toBe('sebeto-team-2026-11-11.json');
  });

  it('demo mode: the three built-in teams apply, dedupe names and export', async () => {
    expect(MOCK_TEMPLATES.map((t) => t.id)).toEqual(['service-desk', 'infrastructure', 'security', 'devops', 'red-team']);
    const api = new MockApi({ speed: 0 });
    const first = await api.applyTemplate({ templateId: 'security' });
    expect(first.agents.map((a) => a.name)).toEqual(['Security Lead', 'CVE Researcher', 'Access Reviewer']);
    expect(first.agents[1]!.reportsTo).toBe(first.agents[0]!.id);
    expect(first.skillsReused).toContain('cve-triage');
    const second = await api.applyTemplate({ templateId: 'security' });
    expect(second.agents[0]!.name).toBe('Security Lead 2');
    const exported = await api.exportTemplate([first.agents[0]!.id]);
    expect(exported.agents).toHaveLength(3);
    expect(checkTeamFile(JSON.stringify(exported)).ok).toBe(true);
    await expect(api.deleteTemplate('security')).rejects.toMatchObject({ status: 409 });
    const saved = await api.saveTemplate(exported);
    expect(saved.builtin).toBe(false);
    await api.deleteTemplate(saved.id);
  });
});
