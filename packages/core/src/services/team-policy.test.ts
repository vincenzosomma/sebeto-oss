/**
 * v0.4 F (team AI + lock) and G (written scope before starting): services, API, executor, prompt.
 * Real SQLite, queue, state machine and executor; runtimes are scripted fakes that record each run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { MAX_SCOPE_CHARS, type Agent, type AgentEvent, type RuntimeAdapter, type Team, type Ticket, type TicketRun, type WsEvent } from '@sebeto/shared';
import type { AppContext, NewSecurityEvent, PlanningTurn, Snapshots } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createJobQueue } from '../queue/index.js';
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createPermissionGate } from '../gate/index.js';
import { createRuntimeRegistry } from '../runtimes/index.js';
import { createExecutor, type ExecutorHandle } from '../executor/executor.js';
import { buildSystemPrompt } from '../executor/prompts.js';
import { createSkillStore } from '../skills/store.js';
import { createServer } from '../api/server.js';
import { createTeam, createTeamChecked, updateTeam, updateTeamChecked } from './teams.js';
import { createAgent, updateAgent } from './agents.js';
import { clearTicketScope, createTicket, postMessage, routeTicket, setTicketScope, startTicket, updateTicket } from './tickets.js';
import { applyTemplate, exportTemplate } from './templates.js';
import { teamAiPolicy } from './team-policy.js';

const TOKEN = 'p'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

interface Recorded { runtime: string; model: string | null | undefined; systemPrompt: string; prompt: string }

function fakeRuntime(id: string, displayName: string, opts: { installed?: boolean; models?: string[]; runs: Recorded[] }): RuntimeAdapter {
  return {
    id, displayName, capabilities: { tools: false, resume: true, costReport: true },
    detect: async () => ({ installed: opts.installed ?? true }),
    models: async () => opts.models ?? [],
    async *run(r: TicketRun): AsyncGenerator<AgentEvent> {
      opts.runs.push({ runtime: id, model: r.model, systemPrompt: r.systemPrompt, prompt: r.prompt });
      yield { kind: 'text', text: `done on ${id}` };
      yield { kind: 'done', costUsd: 0, tokensIn: 1, tokensOut: 1 };
    },
  };
}

interface H {
  dir: string; db: Database.Database; ctx: AppContext; executor: ExecutorHandle; runs: Recorded[];
  security: NewSecurityEvent[]; events: WsEvent[]; turns: string[];
}

function harness(): H {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-policy-'));
  const { repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir });
  const bus = createEventBus();
  const events: WsEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const queue = createJobQueue(db);
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const snapshots: Snapshots = { init: async (f) => { fs.mkdirSync(f, { recursive: true }); }, commit: async () => 'oid-1', restore: async () => 'oid-2', diff: async () => [] };
  const runs: Recorded[] = [];
  const security: NewSecurityEvent[] = [];
  const turns: string[] = [];
  const planningTurn: PlanningTurn = async (input) => { turns.push(input.prompt); return { text: '{"teamSlug": null}', costUsd: 0, model: null }; };
  const runtimes = createRuntimeRegistry([
    fakeRuntime('mock', 'Test agent', { runs }),
    fakeRuntime('claude-cli', 'Claude Code', { runs, models: ['sonnet', 'haiku'] }),
    fakeRuntime('ollama', 'Ollama', { runs, models: ['qwen3-vl:4b-instruct', 'llama3'] }),
    fakeRuntime('codex', 'Codex', { runs, installed: false }),
  ]);
  const skills = createSkillStore(dir, (slug) => repos.agents.list().filter((a) => a.skills.includes(slug)).map((a) => a.id));
  skills.seedIfEmpty();
  const ctx: AppContext = {
    config: { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 2, runtimes: ['mock', 'claude-cli', 'ollama', 'codex'], version: 'test' },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    repos, queue, bus, state, gate, snapshots, runtimes, skills, planningTurn,
    securityLog: { record: (e) => { security.push(e); return null; }, lockdown: () => false },
  };
  const executor = createExecutor(ctx, { pollMs: 10_000 });
  ctx.executor = executor;
  return { dir, db, ctx, executor, runs, security, events, turns };
}

let h: H;
let ctx: AppContext;
beforeEach(() => { h = harness(); ctx = h.ctx; });
afterEach(async () => {
  await h.executor.stop();
  ctx.repos.close();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const agent = (name: string, runtime = 'claude-cli', extra: Partial<Parameters<typeof createAgent>[1]> = {}): Agent => createAgent(ctx, { name, runtime, ...extra });
const runOnce = async () => { h.executor.tick(); await h.executor.idle(); };
const ticket = (id: string): Ticket => ctx.repos.tickets.get(id)!;
const lastAudit = (id: string) => ctx.repos.audit.listForTicket(id, { limit: 200 }).items.at(-1)!;

async function lockedTeam(name = 'Red Team', extra: Partial<Parameters<typeof createTeam>[1]> = {}): Promise<{ team: Team; lead: Agent; member: Agent }> {
  const lead = agent(`${name} Lead`);
  const member = agent(`${name} Tester`);
  let team = createTeam(ctx, { name, leadAgentId: lead.id, ...extra });
  updateAgent(ctx, member.id, { teamId: team.id });
  team = updateTeam(ctx, team.id, { runtime: 'ollama', model: 'qwen3-vl:4b-instruct', lockRuntime: true });
  return { team, lead: ctx.repos.agents.get(lead.id)!, member: ctx.repos.agents.get(member.id)! };
}

describe('team AI: create, update, validation', () => {
  it('stores runtime / model / lock / scope and validates them', async () => {
    const t = await createTeamChecked(ctx, { name: 'Ops', runtime: 'ollama', model: 'llama3', requireScope: true });
    expect(t).toMatchObject({ runtime: 'ollama', model: 'llama3', lockRuntime: false, requireScope: true });
    expect(() => createTeam(ctx, { name: 'X', runtime: 'gpt-9' })).toThrow(/not enabled/);
    expect(() => createTeam(ctx, { name: 'Y', lockRuntime: true })).toThrow(/before locking/);
    await expect(createTeamChecked(ctx, { name: 'Z', runtime: 'ollama', model: 'not-a-model' })).rejects.toThrow(/does not offer/);
    // A runtime that cannot list models (not installed) accepts any model name.
    expect((await createTeamChecked(ctx, { name: 'W', runtime: 'codex', model: 'anything' })).model).toBe('anything');

    // Changing the runtime resets the model; clearing the runtime while locked is refused.
    const u = await updateTeamChecked(ctx, t.id, { runtime: 'claude-cli' });
    expect(u).toMatchObject({ runtime: 'claude-cli', model: null });
    await expect(updateTeamChecked(ctx, t.id, { model: 'llama3' })).rejects.toThrow(/does not offer/);
    updateTeam(ctx, t.id, { lockRuntime: true });
    expect(() => updateTeam(ctx, t.id, { runtime: null })).toThrow(/before locking/);
    expect(updateTeam(ctx, t.id, { runtime: null, lockRuntime: false })).toMatchObject({ runtime: null, model: null, lockRuntime: false });
    expect(updateTeam(ctx, t.id, { requireScope: false }).requireScope).toBe(false);

    const kinds = h.security.filter((e) => e.category === 'config' && e.action.startsWith('team.')).map((e) => `${e.action}:${e.severity ?? 'info'}`);
    expect(kinds).toContain('team.runtime_locked:notice');
    expect(kinds).toContain('team.runtime_unlocked:warning');
    expect(kinds).toContain('team.scope_not_required:warning');
  });

  it('applyToMembers on demand; forced when the lock turns on or a locked team changes runtime', () => {
    const a = agent('A');
    const b = agent('B');
    const team = createTeam(ctx, { name: 'Infra', leadAgentId: a.id });
    updateAgent(ctx, b.id, { teamId: team.id });
    updateTeam(ctx, team.id, { runtime: 'ollama' });
    expect(ctx.repos.agents.get(b.id)!.runtime).toBe('claude-cli'); // not applied by default
    updateTeam(ctx, team.id, { applyToMembers: true });
    expect([a.id, b.id].map((id) => ctx.repos.agents.get(id)!.runtime)).toEqual(['ollama', 'ollama']);

    ctx.repos.agents.update(b.id, { runtime: 'claude-cli' });
    h.events.length = 0;
    updateTeam(ctx, team.id, { lockRuntime: true }); // forced
    expect(ctx.repos.agents.get(b.id)!.runtime).toBe('ollama');
    expect(h.events.some((e) => e.type === 'agent.updated' && e.agent.id === b.id)).toBe(true);
    expect(h.events.some((e) => e.type === 'teams.changed')).toBe(true);

    updateTeam(ctx, team.id, { runtime: 'mock' }); // locked team moves: forced
    expect([a.id, b.id].map((id) => ctx.repos.agents.get(id)!.runtime)).toEqual(['mock', 'mock']);
    expect(h.security.some((e) => e.action === 'team.locked_runtime_changed' && e.severity === 'warning')).toBe(true);
    expect(h.security.some((e) => e.action === 'team.ai_applied')).toBe(true);
  });

  it('new members get the team AI; a locked team refuses another runtime (409)', async () => {
    const { team, member } = await lockedTeam();
    expect(member).toMatchObject({ runtime: 'ollama', model: 'qwen3-vl:4b-instruct' });
    // Created into the team: inherits.
    expect(createAgent(ctx, { name: 'New one', teamId: team.id })).toMatchObject({ runtime: 'ollama', model: 'qwen3-vl:4b-instruct' });
    // Created into the team with another runtime: refused.
    expect(() => createAgent(ctx, { name: 'Claude one', runtime: 'claude-cli', teamId: team.id })).toThrow(expect.objectContaining({ statusCode: 409, code: 'runtime_locked' }));
    // Moving in sets the runtime, even when the editor sends the old runtime unchanged.
    const outsider = agent('Outsider');
    expect(updateAgent(ctx, outsider.id, { teamId: team.id, runtime: 'claude-cli', model: 'sonnet' })).toMatchObject({ runtime: 'ollama', model: 'qwen3-vl:4b-instruct' });
    // Explicit switch to another runtime: refused, inside the team or when moving in.
    expect(() => updateAgent(ctx, member.id, { runtime: 'mock' })).toThrow(expect.objectContaining({ code: 'runtime_locked' }));
    const other = agent('Other', 'ollama');
    expect(() => updateAgent(ctx, other.id, { teamId: team.id, runtime: 'mock' })).toThrow(expect.objectContaining({ code: 'runtime_locked' }));
    // Same runtime, another model: fine (the lock is on the runtime).
    expect(updateAgent(ctx, member.id, { runtime: 'ollama', model: 'llama3' }).model).toBe('llama3');
    // Leaving the team frees it.
    updateAgent(ctx, member.id, { teamId: null });
    expect(updateAgent(ctx, member.id, { runtime: 'mock' }).runtime).toBe('mock');
    // An unlocked team with an AI also gives it to joiners (unless they ask for another runtime).
    const free = createTeam(ctx, { name: 'Desk', runtime: 'mock' });
    expect(createAgent(ctx, { name: 'Desk bot', teamId: free.id }).runtime).toBe('mock');
    expect(createAgent(ctx, { name: 'Desk claude', teamId: free.id, runtime: 'claude-cli' }).runtime).toBe('claude-cli');
    // The lead set through the team joins with the team AI.
    const lead2 = agent('Lead two');
    updateTeam(ctx, team.id, { leadAgentId: lead2.id });
    expect(ctx.repos.agents.get(lead2.id)!.runtime).toBe('ollama');
  });

  it('tickets: runtime override and reassignment refused for a locked team; teamAiPolicy', async () => {
    const { team, member } = await lockedTeam();
    await expect(createTicket(ctx, { title: 'Pentest', goal: 'x', teamId: team.id, runtime: 'claude-cli' })).rejects.toMatchObject({ statusCode: 409, code: 'runtime_locked' });
    await expect(createTicket(ctx, { title: 'Pentest', goal: 'x', agentId: member.id, runtime: 'claude-cli' })).rejects.toMatchObject({ code: 'runtime_locked' });
    const ok = await createTicket(ctx, { title: 'Pentest', goal: 'x', teamId: team.id, runtime: 'ollama' });
    expect(teamAiPolicy(ctx, ok)).toEqual({ locked: true, runtime: 'ollama', model: 'qwen3-vl:4b-instruct' });

    const t = await createTicket(ctx, { title: 'Recon', goal: 'x', teamId: team.id });
    const outsider = agent('Claude helper');
    expect(() => updateTicket(ctx, t.id, { agentId: outsider.id })).toThrow(expect.objectContaining({ code: 'runtime_locked' }));
    // Moving a Claude ticket into the locked team with its Claude agent kept is refused too.
    const c = await createTicket(ctx, { title: 'Other', goal: 'x', agentId: outsider.id, teamId: null });
    ctx.repos.sessions.create({ ticketId: c.id, agentId: outsider.id, runtime: 'claude-cli', model: null, reason: 'new' }); // started: agent stays
    expect(() => updateTicket(ctx, c.id, { teamId: team.id })).toThrow(expect.objectContaining({ code: 'runtime_locked' }));
    // Reassigning inside the team is fine.
    expect(updateTicket(ctx, t.id, { agentId: member.id }).agentId).toBe(member.id);
    expect(teamAiPolicy(ctx, c)).toEqual({ locked: false, runtime: null, model: null });
  });
});

describe('executor: the lock is the real guarantee', () => {
  it('refuses a run on the wrong runtime even when the DB was changed behind the API (SQL)', async () => {
    const { team, lead } = await lockedTeam();
    const t = await createTicket(ctx, { title: 'Scan', goal: 'Scan the lab', teamId: team.id, agentId: lead.id });
    h.db.prepare("UPDATE agents SET runtime = 'claude-cli' WHERE id = ?").run(lead.id);
    startTicket(ctx, t.id);
    await runOnce();
    expect(h.runs).toEqual([]); // nothing reached any runtime
    expect(ticket(t.id).status).toBe('blocked');
    const notes = ctx.repos.audit.listForTicket(t.id, { limit: 50 }).items.map((e) => e.summary).join('\n');
    expect(notes).toMatch(/locked to Ollama/);
    const ev = h.security.find((e) => e.action === 'team.runtime_lock_refused')!;
    expect(ev).toMatchObject({ category: 'system', severity: 'critical', ticketId: t.id });

    // A ticket override written directly in the DB is refused too.
    h.db.prepare("UPDATE agents SET runtime = 'ollama' WHERE id = ?").run(lead.id);
    h.db.prepare("UPDATE tickets SET runtime = 'mock' WHERE id = ?").run(t.id);
    postMessage(ctx, t.id, 'go on');
    await runOnce();
    expect(h.runs).toEqual([]);
    expect(h.security.filter((e) => e.action === 'team.runtime_lock_refused')).toHaveLength(2);

    // Fixed: runs on the locked runtime.
    h.db.prepare('UPDATE tickets SET runtime = NULL WHERE id = ?').run(t.id);
    postMessage(ctx, t.id, 'go on');
    await runOnce();
    expect(h.runs.map((r) => r.runtime)).toEqual(['ollama']);
  });
});

describe('routing never sends a locked team ticket to the planning model', () => {
  it('rules only, the ticket stays where it is', async () => {
    const { team, member } = await lockedTeam();
    createTeam(ctx, { name: 'Facilities', routingHints: 'desks, badges' });
    const t = await createTicket(ctx, { title: 'Something odd', goal: 'Have a look', teamId: team.id, agentId: member.id });
    const { decision, ticket: after } = await routeTicket(ctx, t.id);
    expect(h.turns).toEqual([]);
    expect(decision).toMatchObject({ by: 'fallback', teamId: team.id, agentId: member.id });
    expect(decision.reason).toMatch(/locked to Ollama; routing by rules only/);
    expect(after.teamId).toBe(team.id);
    // An unlocked ticket still asks the Chief of Staff when the rules are not sure.
    const free = await createTicket(ctx, { title: 'Something odd', goal: 'Have a look', teamId: null, agentId: agent('Free').id });
    await routeTicket(ctx, free.id);
    expect(h.turns).toHaveLength(1);
  });
});

describe('templates with a team AI', () => {
  it('Red Team: requireScope built in; runtime + lock from the request; warnings when it cannot be honoured', async () => {
    const red = await applyTemplate(ctx, { templateId: 'red-team', runtime: 'ollama', model: 'qwen3-vl:4b-instruct', lockRuntime: true });
    expect(red.team).toMatchObject({ runtime: 'ollama', model: 'qwen3-vl:4b-instruct', lockRuntime: true, requireScope: true });
    expect(red.agents.every((a) => a.runtime === 'ollama' && a.model === 'qwen3-vl:4b-instruct')).toBe(true);
    expect(red.warnings).toBeUndefined();
    expect(h.security.some((e) => e.action === 'team.runtime_locked')).toBe(true);

    // Not installed → unlocked, with a warning. Unknown model → default model. Unknown runtime → usual AI.
    const r2 = await applyTemplate(ctx, { templateId: 'red-team', runtime: 'codex', lockRuntime: true });
    expect(r2.team).toMatchObject({ runtime: 'codex', lockRuntime: false, requireScope: true });
    expect(r2.warnings?.join(' ')).toMatch(/not installed/);
    const r3 = await applyTemplate(ctx, { templateId: 'devops', runtime: 'ollama', model: 'gpt-x' });
    expect(r3.team).toMatchObject({ runtime: 'ollama', model: null, lockRuntime: false, requireScope: false });
    expect(r3.warnings?.join(' ')).toMatch(/does not offer/);
    const r4 = await applyTemplate(ctx, { templateId: 'security', runtime: 'gpt-9', lockRuntime: true });
    expect(r4.team).toMatchObject({ runtime: null, lockRuntime: false });
    expect(r4.warnings?.join(' ')).toMatch(/not enabled/);

    // Export carries the team AI; importing it back keeps it.
    const file = exportTemplate(ctx, [red.team!.leadAgentId!]);
    expect(file.team).toMatchObject({ runtime: 'ollama', model: 'qwen3-vl:4b-instruct', lockRuntime: true, requireScope: true });
    const again = await applyTemplate(ctx, { template: file });
    expect(again.team).toMatchObject({ runtime: 'ollama', lockRuntime: true, requireScope: true });
  });
});

describe('written scope (G)', () => {
  async function scopedTeamTicket() {
    const lead = agent('Lead', 'mock');
    const team = createTeam(ctx, { name: 'Red Team', leadAgentId: lead.id, requireScope: true });
    const t = await createTicket(ctx, { title: 'Test the lab web app', goal: 'Find issues', teamId: team.id });
    return { team, lead, t };
  }

  it('set / clear: validation, SCOPE.md, events without the text, refused while running', async () => {
    const { t } = await scopedTeamTicket();
    await expect(setTicketScope(ctx, t.id, { text: 'x', confirm: false as unknown as true })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setTicketScope(ctx, t.id, { text: '   ', confirm: true })).rejects.toMatchObject({ code: 'scope_empty' });
    await expect(setTicketScope(ctx, t.id, { text: 'a'.repeat(MAX_SCOPE_CHARS + 1), confirm: true })).rejects.toMatchObject({ code: 'scope_too_long' });
    const secret = 'Targets: 10.0.0.5 only. Window: 2026-11-14 09:00-12:00. Contact: SOC +39 081 555';
    h.events.length = 0;
    const s = await setTicketScope(ctx, t.id, { text: secret, fileName: 'roe.md', confirm: true });
    expect(s.scope).toMatchObject({ text: secret, fileName: 'roe.md' });
    expect(s.scope!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket(t.id).scope?.sha256).toBe(s.scope!.sha256);
    expect(fs.readFileSync(path.join(t.folder, 'SCOPE.md'), 'utf8')).toContain(secret);
    expect(h.events.some((e) => e.type === 'ticket.updated' && e.ticket.scope?.sha256 === s.scope!.sha256)).toBe(true);
    const ev = h.security.find((e) => e.action === 'ticket.scope_set')!;
    expect(ev).toMatchObject({ category: 'ticket', data: { sha256: s.scope!.sha256, length: secret.length, fileName: 'roe.md' } });
    const everything = JSON.stringify([h.security, ctx.repos.audit.listForTicket(t.id, { limit: 100 }).items]);
    expect(everything).not.toContain('10.0.0.5');

    // While a run is active: refused.
    const session = ctx.repos.sessions.create({ ticketId: t.id, agentId: null, runtime: 'mock', model: null, reason: 'new' });
    const run = ctx.repos.runs.create({ sessionId: session.id, ticketId: t.id, jobId: null, trigger: 'start' });
    await expect(setTicketScope(ctx, t.id, { text: 'other', confirm: true })).rejects.toMatchObject({ code: 'run_active' });
    await expect(clearTicketScope(ctx, t.id)).rejects.toMatchObject({ code: 'run_active' });
    ctx.repos.runs.update(run.id, { status: 'succeeded' });

    const cleared = await clearTicketScope(ctx, t.id);
    expect(cleared.scope).toBeNull();
    expect(fs.existsSync(path.join(t.folder, 'SCOPE.md'))).toBe(false);
    expect(h.security.find((e) => e.action === 'ticket.scope_cleared')).toMatchObject({ data: { sha256: s.scope!.sha256 } });
  });

  it('no scope = no start: API 409, executor refusal for every path, then the scope reaches the prompt', async () => {
    const { team, lead, t } = await scopedTeamTicket();
    expect(() => startTicket(ctx, t.id)).toThrow(expect.objectContaining({ statusCode: 409, code: 'scope_required' }));
    expect(() => postMessage(ctx, t.id, 'start please')).toThrow(expect.objectContaining({ code: 'scope_required' }));
    await expect(createTicket(ctx, { title: 'Now', goal: 'x', teamId: team.id, start: true })).rejects.toMatchObject({ code: 'scope_required' });
    // The agent's team counts too.
    await expect(createTicket(ctx, { title: 'Now', goal: 'x', agentId: lead.id, teamId: null, start: true })).rejects.toMatchObject({ code: 'scope_required' });

    // Internal paths (trigger auto-start, heartbeat, schedule) are stopped by the executor.
    startTicket(ctx, t.id, { checkScope: false });
    await runOnce();
    expect(h.runs).toEqual([]);
    expect(ticket(t.id).status).toBe('needs_you');
    expect(ctx.repos.audit.listForTicket(t.id, { limit: 100 }).items.some((e) => /needs a written scope before it can start: add it in the ticket's Scope box/.test(e.summary))).toBe(true);
    expect(lastAudit(t.id).summary).toMatch(/Needs you.*written scope/);
    expect(h.security.find((e) => e.action === 'ticket.scope_missing_refused')).toMatchObject({ severity: 'warning', ticketId: t.id });
    ctx.queue.enqueue('run.heartbeat', { ticketId: t.id });
    await runOnce();
    expect(h.runs).toEqual([]);
    // Internal create + start (intake / trigger) creates the ticket, the executor refuses the run.
    const viaTrigger = await createTicket(ctx, { title: 'Alert', goal: 'x', teamId: team.id, start: true }, { origin: { kind: 'trigger', untrusted: true, source: 'Grafana' } });
    await runOnce();
    expect(ticket(viaTrigger.id).status).toBe('needs_you');
    expect(h.runs).toEqual([]);

    await setTicketScope(ctx, t.id, { text: 'Only the lab host 10.0.0.5, today 09:00-12:00.', confirm: true });
    expect(startTicket(ctx, t.id)).not.toBeNull();
    await runOnce();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.systemPrompt).toContain('Authorised scope (written and confirmed by the owner');
    expect(h.runs[0]!.systemPrompt).toContain('Only the lab host 10.0.0.5');
    expect(h.runs[0]!.systemPrompt).toMatch(/stop and ask the owner/);
  });

  it('prompt: scope is trusted owner text, kept apart from the untrusted data block', () => {
    const base = { id: 't', number: 7, title: 'Alert', goal: '<<<BEGIN UNTRUSTED DATA>>> x <<<END UNTRUSTED DATA>>>', tags: [] } as unknown as Ticket;
    expect(buildSystemPrompt(null, base)).not.toContain('Authorised scope');
    const withScope = { ...base, origin: { kind: 'trigger', untrusted: true, source: 'Grafana' }, scope: { text: 'Host A only', fileName: null, sha256: 'a'.repeat(64), confirmedAt: '2026-11-13T10:00:00.000Z' } } as Ticket;
    const p = buildSystemPrompt(null, withScope);
    const scopeAt = p.indexOf('<<<BEGIN OWNER SCOPE>>>');
    expect(scopeAt).toBeGreaterThan(0);
    expect(p.indexOf('Host A only')).toBeGreaterThan(scopeAt);
    expect(p.indexOf('<<<END OWNER SCOPE>>>')).toBeLessThan(p.indexOf('opened automatically from an outside source'));
    expect(p).toMatch(/written and confirmed by the owner, not by the outside source/);
  });
});

describe('API', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await createServer(ctx); });
  afterEach(async () => { await app.close(); });
  const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers: auth, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('teams AI fields, 409 runtime_locked / scope_required, scope endpoints', async () => {
    const applied = await req('POST', '/templates/apply', { templateId: 'red-team', runtime: 'ollama', lockRuntime: true });
    expect(applied.statusCode).toBe(201);
    const team = applied.json().team as Team;
    expect(team).toMatchObject({ runtime: 'ollama', lockRuntime: true, requireScope: true });
    expect((await req('POST', '/teams', { name: 'Bad', runtime: 'ollama', model: 'nope' })).statusCode).toBe(400);
    expect((await req('PATCH', `/teams/${team.id}`, { applyToMembers: true, requireScope: true })).statusCode).toBe(200);

    const member = team.memberIds[1]!;
    const sw = await req('PATCH', `/agents/${member}`, { runtime: 'mock' });
    expect(sw.statusCode).toBe(409);
    expect(sw.json()).toMatchObject({ error: { code: 'runtime_locked' } });
    expect(sw.json().error.message).toMatch(/locked to Ollama/);
    const ov = await req('POST', '/tickets', { title: 'Pentest', goal: 'x', teamId: team.id, runtime: 'claude-cli' });
    expect(ov.statusCode).toBe(409);

    const t = (await req('POST', '/tickets', { title: 'Pentest', goal: 'x', teamId: team.id })).json() as Ticket;
    expect(t.scope).toBeNull();
    const start = await req('POST', `/tickets/${t.id}/start`);
    expect(start.statusCode).toBe(409);
    expect(start.json().error.code).toBe('scope_required');
    expect((await req('POST', '/tickets', { title: 'Go', goal: 'x', teamId: team.id, start: true })).statusCode).toBe(409);
    expect((await req('POST', `/tickets/${t.id}/messages`, { text: 'hi' })).statusCode).toBe(409);

    expect((await req('PUT', `/tickets/${t.id}/scope`, { text: 'Host A', confirm: false })).statusCode).toBe(400);
    expect((await req('PUT', `/tickets/${t.id}/scope`, { text: 'Host A' })).statusCode).toBe(400);
    expect((await req('PUT', `/tickets/${t.id}/scope`, { text: 'Host A', fileName: 'x'.repeat(201), confirm: true })).statusCode).toBe(400);
    const put = await req('PUT', `/tickets/${t.id}/scope`, { text: 'Host A', fileName: 'scope.txt', confirm: true });
    expect(put.statusCode).toBe(200);
    expect(put.json().scope).toMatchObject({ text: 'Host A', fileName: 'scope.txt' });
    expect((await req('GET', `/tickets/${t.id}`)).json().ticket.scope.text).toBe('Host A');
    expect((await req('POST', `/tickets/${t.id}/start`)).statusCode).toBe(202);
    const del = await req('DELETE', `/tickets/${t.id}/scope`);
    expect(del.statusCode).toBe(200);
    expect(del.json().scope).toBeNull();
  });
});
