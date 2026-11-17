import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_PERMISSIONS, TEMPLATE_FORMAT,
  type Agent, type ApplyTemplateResponse, type RuntimeAdapter, type TeamTemplate, type WsEvent,
} from '@sebeto/shared';
import type { AppContext, Repos } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createSkillStore, type SkillStore } from '../skills/store.js';
import { createServer } from '../api/server.js';
import { applyTemplate, exportTemplate } from '../services/templates.js';
import { BUILTIN_TEMPLATES } from './builtins.js';
import { createTemplateStore } from './store.js';
import { parseTemplate, templateProblems } from './schema.js';
import { safePermissions, topoOrder, uniqueName } from './team.js';

const TOKEN = 'k'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let repos: Repos;
let skills: SkillStore;
let events: WsEvent[];

function adapter(id: string, installed: boolean, models: string[] = []): RuntimeAdapter {
  return {
    id, displayName: id, capabilities: { tools: true, resume: true, costReport: true },
    detect: async () => (installed ? { installed } : { installed, problem: 'not installed' }),
    models: async () => models,
    // eslint-disable-next-line require-yield
    run: async function* () { return; },
  };
}

function makeCtx(adapters: RuntimeAdapter[] = [adapter('mock', true, ['mock']), adapter('claude-cli', true, ['haiku', 'sonnet'])]): AppContext {
  return {
    config: { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 1, runtimes: adapters.map((a) => a.id), version: '0.3.0' },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    repos,
    queue: {} as AppContext['queue'],
    bus: { publish: (e) => { events.push(e); }, subscribe: () => () => undefined },
    state: {} as AppContext['state'],
    gate: {} as AppContext['gate'],
    snapshots: {} as AppContext['snapshots'],
    runtimes: { get: (id) => adapters.find((a) => a.id === id), list: () => adapters },
    skills,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-templates-'));
  ({ repos } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  skills = createSkillStore(dir, (slug) => repos.agents.list().filter((a) => a.skills.includes(slug)).map((a) => a.id));
  skills.seedIfEmpty();
  events = [];
});
afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const byName = (agents: Agent[], name: string) => agents.find((a) => a.name === name)!;

function smallTemplate(patch: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    format: TEMPLATE_FORMAT, id: 'x', name: 'Patch crew', description: 'Two people', builtin: false,
    agents: [
      { key: 'boss', name: 'Patch Lead', role: 'Lead', job: 'Plan patching.', reportsTo: null, skills: ['patch-notes'] },
      { key: 'tech', name: 'Patch Tech', role: 'Tech', job: 'Patch.', reportsTo: 'boss', skills: ['patch-notes', 'cve-triage'], runtime: 'claude-cli', model: 'haiku' },
    ],
    skills: [{ slug: 'patch-notes', name: 'Patch notes', description: 'Write patch notes', instructions: '# Patch notes\n- Keep it short.', needs: ['fs.write'] }],
    ...patch,
  };
}

describe('built-in templates', () => {
  it('are valid, safe and use the starter skill slugs', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.name)).toEqual(['Service Desk team', 'Infrastructure team', 'Security team', 'DevOps team', 'Red Team']);
    // v0.4: every built-in carries its team (slug = template id) with routing hints.
    expect(BUILTIN_TEMPLATES.map((t) => t.id)).toEqual(['service-desk', 'infrastructure', 'security', 'devops', 'red-team']);
    for (const t of BUILTIN_TEMPLATES) expect(t.team?.routingHints?.length).toBeGreaterThan(30);
    for (const t of BUILTIN_TEMPLATES) {
      expect(() => parseTemplate(t)).not.toThrow();
      for (const a of t.agents) {
        expect(a.permissions?.['email.send']).not.toBe('allow');
        expect(a.permissions?.['script.run']).not.toBe('allow');
        expect(a.permissions?.['prod.change']).not.toBe('allow');
        for (const slug of a.skills) expect(t.skills.some((s) => s.slug === slug)).toBe(true);
      }
    }
    const slugs = BUILTIN_TEMPLATES.flatMap((t) => t.skills.map((s) => s.slug));
    expect(slugs).toEqual(expect.arrayContaining(['incident-summary', 'maintenance-notice', 'cve-triage']));
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.id, t] as const))('applies %s: hierarchy, skills created/reused, names deduped the second time', async (_id, t) => {
    const ctx = makeCtx();
    const first = await applyTemplate(ctx, { templateId: t.id });
    expect(first.agents.map((a) => a.name)).toEqual(t.agents.map((a) => a.name));
    const lead = first.agents[0]!;
    expect(lead.reportsTo).toBeNull();
    for (const a of first.agents.slice(1)) expect(a.reportsTo).toBe(lead.id);
    for (const [i, a] of first.agents.entries()) {
      expect(a.skills).toEqual(t.agents[i]!.skills);
      expect(a.runtime).toBe('claude-cli'); // installed real runtime preferred over the test agent
      expect(a.model).toBeNull();
      expect(a.permissions['email.send']).not.toBe('allow');
      expect(a.permissions['prod.change']).not.toBe('allow');
    }
    const starters = ['incident-summary', 'maintenance-notice', 'cve-triage'];
    expect(first.skillsReused.sort()).toEqual(t.skills.map((s) => s.slug).filter((s) => starters.includes(s)).sort());
    expect(first.skillsCreated.sort()).toEqual(t.skills.map((s) => s.slug).filter((s) => !starters.includes(s)).sort());
    for (const slug of first.skillsCreated) expect(skills.get(slug)?.instructions.length).toBeGreaterThan(50);
    expect(events.filter((e) => e.type === 'agent.updated')).toHaveLength(t.agents.length);
    expect(events).toContainEqual({ type: 'skills.changed' });
    expect(events.at(-1)).toEqual({ type: 'teams.changed' });
    // v0.4: the template created a team: slug = template id, lead = top agent, every agent a member.
    expect(first.team).toMatchObject({ slug: t.id, name: t.team!.name, leadAgentId: lead.id, routingHints: t.team!.routingHints });
    expect([...first.team!.memberIds].sort()).toEqual(first.agents.map((a) => a.id).sort());
    for (const a of first.agents) expect(a.teamId).toBe(first.team!.id);

    const second = await applyTemplate(ctx, { templateId: t.id, reportsTo: lead.id });
    expect(second.agents.map((a) => a.name)).toEqual(t.agents.map((a) => `${a.name} 2`));
    expect(second.agents[0]!.reportsTo).toBe(lead.id);
    expect(second.skillsCreated).toEqual([]);
    expect(second.skillsReused.sort()).toEqual(t.skills.map((s) => s.slug).sort());
    expect(second.team).toMatchObject({ slug: `${t.id}-2`, name: `${t.team!.name} 2`, leadAgentId: second.agents[0]!.id });
    expect(repos.agents.list()).toHaveLength(t.agents.length * 2);
    const third = await applyTemplate(ctx, { templateId: t.id });
    expect(third.agents[0]!.name).toBe(`${t.agents[0]!.name} 3`);
  });

  it('never overwrites an existing skill with the same slug', async () => {
    skills.update('incident-summary', { name: 'Incident summary', description: 'Mine', instructions: '# My own version' });
    const res = await applyTemplate(makeCtx(), { templateId: 'service-desk' });
    expect(res.skillsReused).toContain('incident-summary');
    expect(skills.get('incident-summary')!.instructions).toBe('# My own version');
  });

  it('uses the default agent\'s runtime, else the test agent when nothing real is installed', async () => {
    const res = await applyTemplate(makeCtx([adapter('mock', true), adapter('claude-cli', false)]), { templateId: 'security' });
    expect(res.agents.every((a) => a.runtime === 'mock')).toBe(true);
    repos.agents.create({ name: 'Local', runtime: 'ollama' });
    const res2 = await applyTemplate(makeCtx([adapter('mock', true), adapter('claude-cli', true), adapter('ollama', true, ['qwen3'])]), { templateId: 'security' });
    expect(res2.agents.every((a) => a.runtime === 'ollama')).toBe(true);
  });
});

describe('applying an imported template object', () => {
  it('creates skills and agents, keeps the runtime and model only when offered', async () => {
    const res = await applyTemplate(makeCtx(), { template: smallTemplate() });
    expect(res.skillsCreated).toEqual(['patch-notes']);
    expect(res.skillsReused).toEqual(['cve-triage']); // from the library, not in the file
    const tech = byName(res.agents, 'Patch Tech');
    expect(tech).toMatchObject({ runtime: 'claude-cli', model: 'haiku', skills: ['patch-notes', 'cve-triage'], reportsTo: byName(res.agents, 'Patch Lead').id });

    const t = smallTemplate();
    t.agents[1]!.model = 'gpt-9';
    t.agents[0]!.runtime = 'codex'; // not enabled here → workspace default
    const res2 = await applyTemplate(makeCtx(), { template: t });
    expect(byName(res2.agents, 'Patch Tech 2').model).toBeNull();
    expect(byName(res2.agents, 'Patch Lead 2').runtime).toBe('claude-cli');
  });

  it('only keeps permissions that are at least as strict as the defaults', async () => {
    const t = smallTemplate();
    t.agents[0]!.permissions = { 'email.send': 'allow', 'script.run': 'allow', 'prod.change': 'allow', 'fs.write': 'never', 'web.read': 'allow' };
    const lead = (await applyTemplate(makeCtx(), { template: t })).agents[0]!;
    expect(lead.permissions).toEqual({ ...DEFAULT_PERMISSIONS, 'fs.write': 'never' });
    expect(safePermissions({ 'fs.read': 'never' })).toEqual({ 'fs.read': 'never' });
  });

  it('orders managers first even when the file lists reports first', async () => {
    const t = smallTemplate();
    t.agents.reverse();
    expect(topoOrder(t.agents).map((a) => a.key)).toEqual(['boss', 'tech']);
    const res = await applyTemplate(makeCtx(), { template: t });
    expect(res.agents.map((a) => a.name)).toEqual(['Patch Tech', 'Patch Lead']); // template order in the response
    expect(res.agents[0]!.reportsTo).toBe(res.agents[1]!.id);
  });

  it('refuses unknown skills and unknown managers without creating anything', async () => {
    const t = smallTemplate();
    t.agents[0]!.skills = ['does-not-exist'];
    await expect(applyTemplate(makeCtx(), { template: t })).rejects.toMatchObject({ code: 'unknown_skill' });
    await expect(applyTemplate(makeCtx(), { template: smallTemplate(), reportsTo: 'nope' })).rejects.toMatchObject({ code: 'unknown_agent' });
    expect(repos.agents.list()).toHaveLength(0);
    expect(skills.get('patch-notes')).toBeUndefined();
  });

  it('dedupes names case-insensitively', () => {
    const taken = new Set(['comms writer', 'comms writer 2']);
    expect(uniqueName('Comms Writer', taken)).toBe('Comms Writer 3');
    expect(uniqueName('Other', taken)).toBe('Other');
  });
});

describe('export', () => {
  it('round-trips: export → apply gives the same team shape and skills', async () => {
    const ctx = makeCtx();
    await applyTemplate(ctx, { templateId: 'infrastructure' });
    const lead = repos.agents.list().find((a) => a.name === 'Infrastructure Lead')!;
    repos.agents.update(lead.id, { model: 'sonnet' });
    const outsider = repos.agents.create({ name: 'Assistant', runtime: 'mock' });

    const sub = exportTemplate(ctx, [lead.id]);
    expect(() => parseTemplate(sub)).not.toThrow();
    expect(sub.agents.map((a) => a.name)).toEqual(['Infrastructure Lead', 'Sysadmin Assistant', 'Automation Engineer', 'Capacity Planner']);
    expect(sub.agents.some((a) => a.name === outsider.name)).toBe(false);
    expect(sub.agents[0]).toMatchObject({ key: 'infrastructure-lead', reportsTo: null, runtime: 'claude-cli', model: 'sonnet' });
    expect(sub.agents[1]!.reportsTo).toBe('infrastructure-lead');
    expect(sub.skills.map((s) => s.slug).sort()).toEqual(['capacity-report', 'change-plan', 'incident-summary', 'runbook-writer']);
    expect(sub.skills.find((s) => s.slug === 'change-plan')!.instructions).toBe(skills.get('change-plan')!.instructions);
    const text = JSON.stringify(sub);
    for (const a of repos.agents.list()) expect(text).not.toContain(a.id);

    // A middle manager's subtree: its manager outside the set becomes null.
    const sys = repos.agents.list().find((a) => a.name === 'Sysadmin Assistant')!;
    expect(exportTemplate(ctx, [sys.id]).agents).toMatchObject([{ name: 'Sysadmin Assistant', reportsTo: null }]);

    const res = await applyTemplate(ctx, { template: sub });
    expect(res.skillsCreated).toEqual([]);
    expect(res.agents.map((a) => a.name)).toEqual(sub.agents.map((a) => `${a.name} 2`));
    expect(res.agents[0]).toMatchObject({ model: 'sonnet', runtime: 'claude-cli', reportsTo: null });
    for (const a of res.agents.slice(1)) expect(a.reportsTo).toBe(res.agents[0]!.id);
    expect(res.agents.map((a) => a.skills)).toEqual(sub.agents.map((a) => a.skills));
    expect(res.agents.map((a) => a.permissions)).toEqual(repos.agents.list().filter((a) => sub.agents.some((s) => s.name === a.name)).map((a) => a.permissions));

    const whole = exportTemplate(ctx, []);
    expect(whole.agents).toHaveLength(repos.agents.list().length);
    expect(new Set(whole.agents.map((a) => a.key)).size).toBe(whole.agents.length);
  });
});

describe('several teams in one file (v0.9)', () => {
  it('a whole-workspace export carries every team, and importing it rebuilds them', async () => {
    const ctx = makeCtx();
    await applyTemplate(ctx, { templateId: 'infrastructure' });
    await applyTemplate(ctx, { templateId: 'security' });
    repos.agents.create({ name: 'Assistant', runtime: 'mock' }); // no team
    const before = repos.teams!.list();
    expect(before).toHaveLength(2);

    const whole = exportTemplate(ctx, []);
    expect(() => parseTemplate(whole)).not.toThrow();
    expect(whole.team).toBeUndefined();
    expect(whole.teams!.map((t) => t.name).sort()).toEqual(before.map((t) => t.name).sort());
    const infra = whole.teams!.find((t) => t.name === before.find((x) => x.slug === 'infrastructure')!.name)!;
    expect(infra.leadKey).toBe('infrastructure-lead');
    expect(infra.memberKeys).toHaveLength(4);
    expect(whole.teams!.flatMap((t) => t.memberKeys)).not.toContain('assistant');

    const res = await applyTemplate(ctx, { template: whole });
    expect(res.teams).toHaveLength(2);
    const after = repos.teams!.list().filter((t) => !before.some((b) => b.id === t.id));
    expect(after).toHaveLength(2);
    for (const t of after) {
      const members = repos.agents.list().filter((a) => a.teamId === t.id);
      const lead = members.find((a) => a.id === t.leadAgentId)!;
      expect(lead.name).toMatch(/Lead 2$/);
      expect(members.every((m) => m.name.endsWith(' 2'))).toBe(true);
    }
    expect(repos.agents.list().find((a) => a.name === 'Assistant 2')!.teamId ?? null).toBeNull();
  });

  it('refuses members that are not agents or are in two teams', () => {
    const base = { format: 'sebeto-team/1', id: 'x', name: 'X', description: '', builtin: false, skills: [],
      agents: [{ key: 'a', name: 'A', role: '', job: '', reportsTo: null, skills: [] }, { key: 'b', name: 'B', role: '', job: '', reportsTo: null, skills: [] }] };
    expect(() => parseTemplate({ ...base, teams: [{ name: 'T1', memberKeys: ['a', 'zz'] }] })).toThrow(/not an agent/);
    expect(() => parseTemplate({ ...base, teams: [{ name: 'T1', memberKeys: ['a'] }, { name: 'T2', memberKeys: ['a', 'b'] }] })).toThrow(/two teams/);
    expect(() => parseTemplate({ ...base, teams: [{ name: 'T1', memberKeys: ['a'], leadKey: 'b' }] })).toThrow(/lead/);
  });
});

describe('validation', () => {
  it('reports cycles, unknown managers and duplicates', () => {
    const t = smallTemplate();
    t.agents[0]!.reportsTo = 'tech';
    expect(templateProblems(t).join(' ')).toMatch(/circle/);
    t.agents[0]!.reportsTo = 'ghost';
    expect(templateProblems(t).join(' ')).toMatch(/not in the team/);
    t.agents[1]!.key = 'boss';
    expect(templateProblems(t).join(' ')).toMatch(/Two agents/);
  });
});

describe('saved templates store', () => {
  it('saves with an id from the name, lists after the built-ins, skips broken files', () => {
    const store = createTemplateStore(dir);
    const saved = store.save({ ...smallTemplate(), builtin: true, id: 'service-desk' });
    expect(saved).toMatchObject({ id: 'patch-crew', builtin: false });
    expect(store.save(smallTemplate()).id).toBe('patch-crew-2');
    const sameAsBuiltin = store.save({ ...smallTemplate(), name: 'Security' });
    expect(sameAsBuiltin.id).toBe('security-2');

    fs.writeFileSync(path.join(dir, 'templates', 'broken.json'), '{ not json', 'utf8');
    const bad = { ...smallTemplate(), agents: [{ ...smallTemplate().agents[0]!, reportsTo: 'boss' }] };
    fs.writeFileSync(path.join(dir, 'templates', 'cycle.json'), JSON.stringify(bad), 'utf8');
    fs.writeFileSync(path.join(dir, 'templates', 'sneaky.json'), JSON.stringify({ ...smallTemplate(), name: 'Sneaky', builtin: true }), 'utf8');
    const skipped: string[] = [];
    const list = createTemplateStore(dir, (f) => skipped.push(path.basename(f))).list();
    expect(list.map((t) => t.id)).toEqual(['service-desk', 'infrastructure', 'security', 'devops', 'red-team', 'patch-crew', 'patch-crew-2', 'security-2', 'sneaky']);
    expect(list.find((t) => t.id === 'sneaky')!.builtin).toBe(false);
    expect(skipped.sort()).toEqual(['broken.json', 'cycle.json']);

    store.remove('patch-crew');
    expect(store.get('patch-crew')).toBeUndefined();
    expect(() => store.remove('service-desk')).toThrow(/Built-in/);
    expect(() => store.remove('nope')).toThrow(/Unknown/);
  });
});

describe('templates API', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  beforeEach(async () => {
    ctx = makeCtx();
    app = await createServer(ctx);
  });
  afterEach(async () => { await app.close(); });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, headers: auth, payload: payload as object });

  it('lists, saves, applies, exports and deletes', async () => {
    const list = (await app.inject({ url: '/api/v1/templates', headers: auth })).json() as TeamTemplate[];
    expect(list.map((t) => t.id)).toEqual(['service-desk', 'infrastructure', 'security', 'devops', 'red-team']);

    const saved = await post('/templates', smallTemplate());
    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({ id: 'patch-crew', builtin: false });
    expect(events).toContainEqual({ type: 'templates.changed' });

    const applied = await post('/templates/apply', { templateId: 'patch-crew' });
    expect(applied.statusCode).toBe(201);
    const body = applied.json() as ApplyTemplateResponse;
    expect(body.agents.map((a) => a.name)).toEqual(['Patch Lead', 'Patch Tech']);

    const exp = await app.inject({ url: `/api/v1/templates/export?agentIds=${body.agents[0]!.id}`, headers: auth });
    expect(exp.statusCode).toBe(200);
    expect((exp.json() as TeamTemplate).agents).toHaveLength(2);
    // v0.4: an imported template without team settings gets a team named after it; the export carries it.
    expect(body.team).toMatchObject({ name: 'Patch crew', slug: 'patch-crew', routingHints: '' });
    expect((exp.json() as TeamTemplate).team).toMatchObject({ name: 'Patch crew', slug: 'patch-crew' });
    expect((exp.json() as TeamTemplate).name).toBe('Patch crew');
    expect((await app.inject({ url: '/api/v1/templates/export?agentIds=missing', headers: auth })).statusCode).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: '/api/v1/templates/service-desk', headers: auth })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/templates/patch-crew', headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/templates/patch-crew', headers: auth })).statusCode).toBe(404);
    expect((await post('/templates/apply', { templateId: 'patch-crew' })).statusCode).toBe(404);
  });

  it('rejects cycles, unknown keys, duplicate keys and oversized templates', async () => {
    const cycle = smallTemplate();
    cycle.agents[0]!.reportsTo = 'tech';
    const r1 = await post('/templates/apply', { template: cycle });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.message).toMatch(/circle/);

    const r2 = await post('/templates', { ...smallTemplate(), extra: 1 });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error.message).toMatch(/extra|Unrecognized/);
    const r2b = await post('/templates/apply', { template: { ...smallTemplate(), agents: [{ ...smallTemplate().agents[0]!, secret: 'x' }] } });
    expect(r2b.statusCode).toBe(400);
    const r2c = await post('/templates/apply', { template: smallTemplate({ agents: [{ ...smallTemplate().agents[0]!, permissions: { 'root.all': 'allow' } as never }] }) });
    expect(r2c.statusCode).toBe(400);

    const dup = smallTemplate();
    dup.agents[1]!.key = 'boss';
    dup.agents[1]!.reportsTo = null;
    expect((await post('/templates/apply', { template: dup })).statusCode).toBe(400);

    const many = smallTemplate({
      agents: Array.from({ length: 31 }, (_, i) => ({ key: `a${i}`, name: `Agent ${i}`, role: '', job: '', reportsTo: null, skills: [] })),
    });
    expect((await post('/templates/apply', { template: many })).statusCode).toBe(400);
    const longSkill = smallTemplate();
    longSkill.skills[0]!.instructions = 'x'.repeat(20_001);
    expect((await post('/templates', longSkill)).statusCode).toBe(400);
    const tooManySkills = smallTemplate({
      skills: Array.from({ length: 51 }, (_, i) => ({ slug: `s-${i}`, name: `S ${i}`, description: '', instructions: 'do it' })),
    });
    expect((await post('/templates', tooManySkills)).statusCode).toBe(400);

    expect((await post('/templates/apply', {})).statusCode).toBe(400);
    expect((await post('/templates/apply', { templateId: 'security', template: smallTemplate() })).statusCode).toBe(400);
    expect(repos.agents.list()).toHaveLength(0);
  });
});
