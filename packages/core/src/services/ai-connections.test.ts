/**
 * v0.7 R: AI connections (OpenAI-compatible endpoints) through the API, the secrets store, the
 * security log and the v0.4 F team lock. Real SQLite, queue, executor and API; the endpoints are a
 * fake fetch (no network).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { aiConnectionRuntimeId, type AgentEvent, type AiConnection, type RuntimeAdapter, type RuntimeInfo } from '@sebeto/shared';
import type { AppContext, NewSecurityEvent, Snapshots } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createJobQueue } from '../queue/index.js';
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createPermissionGate } from '../gate/index.js';
import { createRuntimeRegistry } from '../runtimes/index.js';
import { createExecutor, type ExecutorHandle } from '../executor/executor.js';
import { createServer } from '../api/server.js';
import { createSecretStore, plainFileProtector } from '../connectors/secrets.js';
import { createAiConnectionStore, secretNameOf } from '../connectors/ai-connections.js';
import { createTeam, updateTeam } from './teams.js';
import { createAgent, updateAgent } from './agents.js';
import { createTicket, startTicket } from './tickets.js';
import { lockViolation } from './team-policy.js';

const TOKEN = 'o'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
const KEY = 'sk-or-v1-THISISTHESECRETKEY0123456789';

interface Sent { url: string; authorization: string | null; body: Record<string, unknown> | null }

function fakeRuntime(id: string, runs: string[]): RuntimeAdapter {
  return {
    id, displayName: id === 'ollama' ? 'Ollama' : id, capabilities: { tools: false, resume: true, costReport: true },
    detect: async () => ({ installed: true }), models: async () => (id === 'ollama' ? ['qwen3-vl:4b-instruct'] : []),
    async *run(): AsyncGenerator<AgentEvent> { runs.push(id); yield { kind: 'done', costUsd: 0 }; },
  };
}

interface H { dir: string; db: Database.Database; ctx: AppContext; app: FastifyInstance; executor: ExecutorHandle; sent: Sent[]; logs: string[]; security: NewSecurityEvent[]; runs: string[] }

async function harness(): Promise<H> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-aiconn-'));
  const { repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir });
  const bus = createEventBus();
  const queue = createJobQueue(db);
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const snapshots: Snapshots = { init: async (f) => { fs.mkdirSync(f, { recursive: true }); }, commit: async () => 'oid-1', restore: async () => 'oid-2', diff: async () => [] };
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    sent.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.pathname.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'qwen3-4b' }, { id: 'openai/gpt-4o-mini' }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done on the endpoint.' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } }), { status: 200 });
  }) as typeof fetch;
  const secrets = createSecretStore(dir, plainFileProtector());
  const aiConnections = createAiConnectionStore({ workspaceDir: dir, secrets, adapterOptions: { fetchImpl } });
  const runs: string[] = [];
  const runtimes = createRuntimeRegistry([fakeRuntime('mock', runs), fakeRuntime('claude-cli', runs), fakeRuntime('ollama', runs)], () => aiConnections.adapters());
  const logs: string[] = [];
  const logFn = (...a: unknown[]) => { logs.push(JSON.stringify(a)); };
  const security: NewSecurityEvent[] = [];
  const ctx: AppContext = {
    config: { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 2, runtimes: ['mock', 'claude-cli', 'ollama', 'openai'], version: 'test' },
    log: { info: logFn, warn: logFn, error: logFn, debug: logFn },
    repos, queue, bus, state, gate, snapshots, runtimes, secrets, aiConnections,
    securityLog: { record: (e) => { security.push(e); return null; }, lockdown: () => false },
  };
  const executor = createExecutor(ctx, { pollMs: 10_000 });
  ctx.executor = executor;
  const app = await createServer(ctx);
  return { dir, db, ctx, app, executor, sent, logs, security, runs };
}

let h: H;
beforeEach(async () => { h = await harness(); });
afterEach(async () => {
  await h.app.close();
  await h.executor.stop();
  h.ctx.repos.close();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  h.app.inject({ method, url: `/api/v1${url}`, headers: auth, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

async function add(body: Record<string, unknown>): Promise<AiConnection> {
  const res = await api('POST', '/ai-connections', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as AiConnection;
}

const lmStudio = () => add({ name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', kind: 'local', defaultModel: 'qwen3-4b' });
const openRouter = () => add({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', kind: 'remote', apiKey: KEY, defaultModel: 'openai/gpt-4o-mini' });

/** Everything the core wrote or said: API answers, files, logs, security events. */
function everythingVisible(extra: string[] = []): string {
  const files = ['ai-connections.json', 'settings.json'].map((f) => { try { return fs.readFileSync(path.join(h.dir, f), 'utf8'); } catch { return ''; } });
  return [...extra, ...files, ...h.logs, JSON.stringify(h.security)].join('\n');
}

describe('AI connections API', () => {
  it('adds a connection whose key goes to the secrets store only, never out', async () => {
    const c = await openRouter();
    expect(c).toMatchObject({ name: 'OpenRouter', kind: 'remote', hasApiKey: true, runtimeId: aiConnectionRuntimeId(c.id), prices: {}, replyTimeoutMin: 30 });
    expect(c).not.toHaveProperty('apiKey');
    expect(await h.ctx.secrets!.get(secretNameOf(c.id))).toBe(KEY);

    const answers = [
      JSON.stringify(c),
      (await api('GET', '/ai-connections')).body,
      (await api('PATCH', `/ai-connections/${c.id}`, { name: 'OpenRouter EU' })).body,
      (await api('POST', `/ai-connections/${c.id}/test`)).body,
      (await api('GET', '/runtimes')).body,
      (await api('GET', '/openapi.json')).body,
    ];
    expect(everythingVisible(answers)).not.toContain(KEY);
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'ai-connections.json'), 'utf8')).connections[0].hasApiKey).toBe(true);
    // ...but it is sent, as a Bearer header, to the connection's own origin only.
    expect(h.sent.length).toBeGreaterThan(0);
    for (const s of h.sent) {
      expect(new URL(s.url).origin).toBe('https://openrouter.ai');
      expect(s.authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it('lists the connection as a runtime with its models; Test connection reports them', async () => {
    const c = await lmStudio();
    const runtimes = (await api('GET', '/runtimes')).json() as RuntimeInfo[];
    expect(runtimes.find((r) => r.id === `openai:${c.id}`)).toMatchObject({ displayName: 'LM Studio (local)', detection: { installed: true }, models: ['openai/gpt-4o-mini', 'qwen3-4b'] });
    const test = (await api('POST', `/ai-connections/${c.id}/test`)).json();
    expect(test).toMatchObject({ ok: true, models: ['openai/gpt-4o-mini', 'qwen3-4b'], problem: null });
    expect(h.sent.every((s) => s.authorization === null)).toBe(true);
  });

  it('refuses plain http to a public host, and a cloud host labelled local', async () => {
    const r1 = await api('POST', '/ai-connections', { name: 'Leaky', baseUrl: 'http://openrouter.ai/api/v1', kind: 'remote', apiKey: KEY });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.message).toMatch(/Use https/);
    const r2 = await api('POST', '/ai-connections', { name: 'Fake local', baseUrl: 'https://openrouter.ai/api/v1', kind: 'local' });
    expect(r2.statusCode).toBe(400);
    const r3 = await api('POST', '/ai-connections', { name: 'LAN', baseUrl: 'http://192.168.1.50:8000/v1', kind: 'local' });
    expect(r3.statusCode).toBe(400);
    expect((await api('POST', '/ai-connections', { name: 'LAN', baseUrl: 'http://192.168.1.50:8000/v1', kind: 'local', allowPrivateHttp: true })).statusCode).toBe(201);
    // Changing an existing connection follows the same rules.
    const c = await openRouter();
    expect((await api('PATCH', `/ai-connections/${c.id}`, { baseUrl: 'http://openrouter.ai/api/v1' })).statusCode).toBe(400);
    expect((await api('POST', '/ai-connections', { name: 'Bad key', baseUrl: 'https://x.example/v1', kind: 'remote', apiKey: 'a b\r\nX-Evil: 1' })).statusCode).toBe(400);
    expect(everythingVisible([r1.body])).not.toContain(KEY);
    expect(h.sent).toEqual([]); // nothing was called
  });

  it('records a security event when a connection is added, changed or removed (never the key)', async () => {
    const c = await openRouter();
    await api('PATCH', `/ai-connections/${c.id}`, { apiKey: `${KEY}-NEW`, prices: { 'openai/gpt-4o-mini': { inputPerM: 0.15, outputPerM: 0.6 } } });
    await api('PATCH', `/ai-connections/${c.id}`, { apiKey: null });
    expect((await api('DELETE', `/ai-connections/${c.id}`)).statusCode).toBe(204);
    const evs = h.security.filter((e) => e.action.startsWith('connector.ai_'));
    expect(evs.map((e) => e.action)).toEqual(['connector.ai_added', 'connector.ai_changed', 'connector.ai_changed', 'connector.ai_removed']);
    expect(evs[0]).toMatchObject({ category: 'connector', severity: 'warning', data: { kind: 'remote', host: 'openrouter.ai', hasApiKey: true } });
    expect(evs[0]!.summary).toMatch(/send their content to that provider/);
    expect(evs[1]!.data).toMatchObject({ changed: ['apiKey', 'prices'] });
    expect(evs[1]!.summary).toMatch(/API key replaced/);
    expect(evs[2]!.summary).toMatch(/API key removed/);
    expect(everythingVisible()).not.toContain(KEY);
    expect(await h.ctx.secrets!.get(secretNameOf(c.id))).toBeNull();
    expect((await api('GET', '/ai-connections')).json()).toEqual([]);
  });

  it('a run on the connection goes through the executor, with the reported cost', async () => {
    const c = await openRouter();
    const a = createAgent(h.ctx, { name: 'Cloud helper', runtime: c.runtimeId, model: 'openai/gpt-4o-mini' });
    const t = await createTicket(h.ctx, { title: 'Summarise', goal: 'Summarise the log', agentId: a.id });
    startTicket(h.ctx, t.id);
    h.executor.tick();
    await h.executor.idle();
    const chat = h.sent.find((s) => s.url.endsWith('/chat/completions'))!;
    expect(chat.body).toMatchObject({ model: 'openai/gpt-4o-mini', stream: false });
    expect(h.ctx.repos.tickets.get(t.id)!.costUsd).toBeCloseTo(0.001, 6);
    expect(everythingVisible()).not.toContain(KEY);
  });

  it('cannot remove a connection an agent or team still uses', async () => {
    const c = await lmStudio();
    const a = createAgent(h.ctx, { name: 'Local helper', runtime: c.runtimeId });
    const res = await api('DELETE', `/ai-connections/${c.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ai_connection_in_use' });
    expect(res.json().error.message).toMatch(/Local helper/);
    updateAgent(h.ctx, a.id, { runtime: 'ollama' });
    expect((await api('DELETE', `/ai-connections/${c.id}`)).statusCode).toBe(204);
    expect(h.ctx.runtimes.get(c.runtimeId)).toBeUndefined();
  });
});

describe('the team lock with AI connections', () => {
  async function lockedTo(runtime: string) {
    const lead = createAgent(h.ctx, { name: 'Lead', runtime: 'claude-cli' });
    let team = createTeam(h.ctx, { name: 'Lab', leadAgentId: lead.id });
    team = updateTeam(h.ctx, team.id, { runtime, lockRuntime: true });
    return { team, lead: h.ctx.repos.agents.get(lead.id)! };
  }

  it('a team locked to one connection cannot switch to another connection, Ollama or Claude', async () => {
    const a = await lmStudio();
    const b = await openRouter();
    const { team, lead } = await lockedTo(a.runtimeId);
    expect(lead.runtime).toBe(a.runtimeId);
    for (const other of [b.runtimeId, 'ollama', 'claude-cli']) {
      expect(() => updateAgent(h.ctx, lead.id, { runtime: other })).toThrow(expect.objectContaining({ statusCode: 409, code: 'runtime_locked' }));
      await expect(createTicket(h.ctx, { title: 'x', goal: 'x', teamId: team.id, runtime: other })).rejects.toMatchObject({ code: 'runtime_locked' });
      expect(lockViolation(h.ctx, { teamId: team.id, agentId: lead.id }, other)?.id).toBe(team.id);
    }
    expect(lockViolation(h.ctx, { teamId: team.id, agentId: lead.id }, a.runtimeId)).toBeNull();
    // Through the API too.
    const res = await api('PATCH', `/agents/${lead.id}`, { runtime: b.runtimeId });
    expect(res.statusCode).toBe(409);
  });

  it('the Red Team locked to Ollama stays on Ollama: no switch to an AI connection', async () => {
    const c = await openRouter();
    const { team, lead } = await lockedTo('ollama');
    expect(() => updateAgent(h.ctx, lead.id, { runtime: c.runtimeId })).toThrow(expect.objectContaining({ code: 'runtime_locked' }));
    await expect(createTicket(h.ctx, { title: 'Recon', goal: 'x', teamId: team.id, runtime: c.runtimeId })).rejects.toMatchObject({ code: 'runtime_locked' });
  });

  it('the executor refuses a run on another connection even when the DB was changed behind the API', async () => {
    const a = await lmStudio();
    const b = await openRouter();
    const { team, lead } = await lockedTo(a.runtimeId);
    const t = await createTicket(h.ctx, { title: 'Scan', goal: 'x', teamId: team.id, agentId: lead.id });
    h.db.prepare('UPDATE agents SET runtime = ? WHERE id = ?').run(b.runtimeId, lead.id);
    startTicket(h.ctx, t.id);
    h.executor.tick();
    await h.executor.idle();
    expect(h.sent.filter((s) => s.url.includes('chat/completions'))).toEqual([]); // nothing reached either endpoint
    expect(h.ctx.repos.tickets.get(t.id)!.status).toBe('blocked');
    expect(h.security.find((e) => e.action === 'team.runtime_lock_refused')).toMatchObject({ severity: 'critical', data: { lockedRuntime: a.runtimeId, runtime: b.runtimeId } });
  });

  it('a locked connection cannot be pointed somewhere else (address or kind), only renamed', async () => {
    const a = await lmStudio();
    await lockedTo(a.runtimeId);
    const moved = await api('PATCH', `/ai-connections/${a.id}`, { baseUrl: 'https://openrouter.ai/api/v1', kind: 'remote' });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.code).toBe('runtime_locked');
    expect((await api('PATCH', `/ai-connections/${a.id}`, { kind: 'remote' })).statusCode).toBe(409);
    expect((await api('PATCH', `/ai-connections/${a.id}`, { baseUrl: 'http://localhost:1234/v1' })).statusCode).toBe(409); // another origin
    const renamed = await api('PATCH', `/ai-connections/${a.id}`, { name: 'LM Studio (lab)', defaultModel: 'llama-3.1-8b' });
    expect(renamed.statusCode).toBe(200);
    expect((await api('DELETE', `/ai-connections/${a.id}`)).statusCode).toBe(409);
  });
});

describe('AI connections file', () => {
  it('survives a restart and skips hand-edited insecure entries', async () => {
    const c = await openRouter();
    const file = path.join(h.dir, 'ai-connections.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { connections: Array<Record<string, unknown>> };
    data.connections.push({ ...data.connections[0], id: '01900000-0000-7000-8000-00000000beef', name: 'Tampered', baseUrl: 'http://evil.example/v1' });
    fs.writeFileSync(file, JSON.stringify(data));
    const again = createAiConnectionStore({ workspaceDir: h.dir, secrets: h.ctx.secrets! });
    expect(again.list().map((x) => x.name)).toEqual([c.name]);
    expect(again.adapters().map((x) => x.id)).toEqual([c.runtimeId]);
  });
});
