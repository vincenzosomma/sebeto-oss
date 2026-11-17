import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@sebeto/shared';
import { MockApi } from './mock';
import { HttpClient } from './client';
import { ApiHttpError } from './types';

describe('MockApi skills', () => {
  it('seeds IT Ops skills and assigns some to agents', async () => {
    const api = new MockApi({ speed: 0 });
    const skills = await api.listSkills();
    expect(skills.map((s) => s.slug)).toEqual(expect.arrayContaining(['incident-summary', 'maintenance-notice', 'cve-triage', 'runbook-writer']));
    const agents = await api.listAgents();
    const analyst = agents.find((a) => a.name === 'Analyst')!;
    expect(analyst.skills).toContain('incident-summary');
    expect(skills.find((s) => s.slug === 'incident-summary')!.usedBy).toContain(analyst.id);
    // The demo has a small org chart.
    expect(agents.some((a) => a.reportsTo === analyst.id)).toBe(true);
  });

  it('creates, updates and deletes a skill, and emits skills.changed', async () => {
    const api = new MockApi({ speed: 0 });
    const events: WsEvent[] = [];
    const stop = api.subscribe((e) => events.push(e));
    const created = await api.createSkill({ name: 'Backup restore test', description: 'Restores one backup.', instructions: '1. Pick a backup.', needs: ['fs.read'] });
    expect(created).toMatchObject({ slug: 'backup-restore-test', version: 1, needs: ['fs.read'], connectors: [], usedBy: [] });
    await expect(api.createSkill({ name: 'Backup  restore test!', description: '', instructions: '' })).rejects.toMatchObject({ status: 409 });
    await expect(api.createSkill({ name: '***', description: '', instructions: '' })).rejects.toBeInstanceOf(ApiHttpError);

    const updated = await api.updateSkill('backup-restore-test', { name: 'Backup restore check', description: 'x', instructions: 'y', connectors: ['Runbooks share'] });
    expect(updated).toMatchObject({ slug: 'backup-restore-test', name: 'Backup restore check', version: 2, needs: ['fs.read'], connectors: ['Runbooks share'] });
    await expect(api.updateSkill('nope', { name: 'a', description: '', instructions: '' })).rejects.toMatchObject({ status: 404 });

    await api.deleteSkill('backup-restore-test');
    expect((await api.listSkills()).some((s) => s.slug === 'backup-restore-test')).toBe(false);
    expect(events.filter((e) => e.type === 'skills.changed')).toHaveLength(3);
    stop();
  });

  it('assigns skills, replacing the list, and unassigns them when a skill is deleted', async () => {
    const api = new MockApi({ speed: 0 });
    const events: WsEvent[] = [];
    api.subscribe((e) => events.push(e));
    const agent = (await api.listAgents()).find((a) => a.name === 'Automation engineer')!;
    const next = await api.assignSkills(agent.id, ['runbook-writer', 'cve-triage', 'runbook-writer']);
    expect(next.skills).toEqual(['runbook-writer', 'cve-triage']);
    expect(events).toContainEqual({ type: 'agent.updated', agent: next });
    expect((await api.listSkills()).find((s) => s.slug === 'cve-triage')!.usedBy).toContain(agent.id);
    await expect(api.assignSkills(agent.id, ['unknown'])).rejects.toMatchObject({ status: 400 });
    await expect(api.assignSkills('missing', [])).rejects.toMatchObject({ status: 404 });

    await api.deleteSkill('cve-triage');
    const after = (await api.listAgents()).find((a) => a.id === agent.id)!;
    expect(after.skills).toEqual(['runbook-writer']);
  });
});

describe('HttpClient skills routes', () => {
  it('uses the contract routes', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const api = new HttpClient({ origin: 'http://h', token: () => 'tok', fetchImpl });
    const body = { name: 'A b', description: '', instructions: '' };
    await api.listSkills();
    await api.createSkill(body);
    await api.updateSkill('a b', body);
    await api.deleteSkill('a-b');
    await api.assignSkills('ag1', ['a-b']);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://h/api/v1/skills',
      'POST http://h/api/v1/skills',
      'PUT http://h/api/v1/skills/a%20b',
      'DELETE http://h/api/v1/skills/a-b',
      'PUT http://h/api/v1/agents/ag1/skills',
    ]);
    expect(calls[4]!.body).toEqual({ skills: ['a-b'] });
  });
});
