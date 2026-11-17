import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_PERMISSIONS, splitAttachmentNote, type Agent, type AuditEvent, type Message, type PermissionRequest, type Run, type RuntimeAdapter,
  type Project, type Ticket, type TicketStatus, type TrustedCommand, type WsEvent,
} from '@sebeto/shared';
import type { AppContext, CoreConfig, EventBus, Job, JobQueue, Repos, Snapshots } from '../contracts.js';
import { createServer, buildUiCsp } from './server.js';
import { createHostCheck, createOriginCheck, hostnameOf, tokenMatches } from './security.js';
import { seedDefaults } from '../services/index.js';
import { MailError } from '../connectors/mail.js';

// ------------------------------------------------------------------ in-memory fakes
const TOKEN = 't'.repeat(40);
let seq = 0;
const nid = () => `id-${++seq}`;
const now = () => new Date().toISOString();

function fakeRepos(): Repos {
  const tickets = new Map<string, Ticket>();
  const agents = new Map<string, Agent>();
  const runs = new Map<string, Run>();
  const messages: Message[] = [];
  const audit: AuditEvent[] = [];
  const perms = new Map<string, PermissionRequest>();
  let num = 0;
  return {
    tickets: {
      create(i) {
        const t: Ticket = {
          id: nid(), number: ++num, title: i.title, goal: i.goal, status: 'backlog', agentId: i.agentId ?? null,
          runtime: i.runtime ?? null, model: i.model ?? null, currentSessionId: null, folder: `/ws/tickets/T-${num}`,
          costCapUsd: i.costCapUsd ?? 5, costUsd: 0, parentId: i.parentId ?? null, dependsOn: i.dependsOn ?? [],
          createdAt: now(), updatedAt: now(),
        };
        tickets.set(t.id, t);
        return t;
      },
      get: (id) => tickets.get(id),
      childrenOf: (parentId) => [...tickets.values()].filter((t) => t.parentId === parentId),
      delete: (id: string) => tickets.delete(id),
      list(q) {
        const all = [...tickets.values()].filter((t) => !q.status || t.status === q.status).filter((t) => !q.q || t.title.includes(q.q));
        const start = q.cursor ? Number(q.cursor) : 0;
        const limit = q.limit ?? 50;
        const items = all.slice(start, start + limit);
        return { items, nextCursor: start + limit < all.length ? String(start + limit) : null };
      },
      update(id, patch) {
        const t = { ...tickets.get(id)!, ...patch, updatedAt: now() };
        tickets.set(id, t);
        return t;
      },
      addCost(id, usd) {
        const t = tickets.get(id)!;
        t.costUsd += usd;
        return t;
      },
    },
    agents: {
      create(i) {
        const a: Agent = {
          id: nid(), skills: [], name: i.name, role: i.role ?? '', job: i.job ?? '', runtime: i.runtime ?? 'mock', model: i.model ?? null,
          reportsTo: i.reportsTo ?? null, heartbeatMinutes: i.heartbeatMinutes ?? 15, monthlyBudgetUsd: i.monthlyBudgetUsd ?? 20,
          permissions: { ...DEFAULT_PERMISSIONS, ...i.permissions }, paused: false, createdAt: now(),
        };
        agents.set(a.id, a);
        return a;
      },
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      update(id, patch) {
        if (patch.reportsTo === id) throw new Error('reportsTo cycle');
        const a = { ...agents.get(id)!, ...patch };
        agents.set(id, a);
        return a;
      },
      monthSpendUsd: () => 0,
      setSkills: () => { throw new Error('not in fake'); },
      removeSkillEverywhere: () => 0,
    },
    sessions: {} as Repos['sessions'],
    runs: {
      create(i) {
        const r: Run = {
          id: nid(), sessionId: i.sessionId, ticketId: i.ticketId, jobId: i.jobId, trigger: i.trigger, status: 'running',
          startedAt: now(), endedAt: null, tokensIn: 0, tokensOut: 0, costUsd: 0, exitReason: null, snapshotBefore: null, snapshotAfter: null,
        };
        runs.set(r.id, r);
        return r;
      },
      get: (id) => runs.get(id),
      update(id, patch) {
        const r = { ...runs.get(id)!, ...patch };
        runs.set(id, r);
        return r;
      },
      listForTicket: (ticketId) => [...runs.values()].filter((r) => r.ticketId === ticketId).reverse(),
      failOrphans: () => 0,
    },
    messages: {
      create(i) {
        const m: Message = { id: nid(), ticketId: i.ticketId, runId: i.runId ?? null, role: i.role, author: i.author, text: i.text, createdAt: now() };
        messages.push(m);
        return m;
      },
      listForTicket: (ticketId) => ({ items: messages.filter((m) => m.ticketId === ticketId), nextCursor: null }),
    },
    audit: {
      append(i) {
        const e: AuditEvent = { id: nid(), ticketId: i.ticketId, runId: i.runId ?? null, kind: i.kind, summary: i.summary, data: i.data ?? null, createdAt: now() };
        audit.push(e);
        return e;
      },
      listForTicket: (ticketId) => ({ items: audit.filter((e) => e.ticketId === ticketId), nextCursor: null }),
    },
    permissions: {
      create(i) {
        const p: PermissionRequest = { ...i, command: i.command ?? null, alwaysAllowed: false, taskScoped: false, id: nid(), state: 'pending', createdAt: now(), decidedAt: null };
        perms.set(p.id, p);
        return p;
      },
      get: (id) => perms.get(id),
      decide(id, state) {
        const p = { ...perms.get(id)!, state, decidedAt: now() };
        perms.set(id, p);
        return p;
      },
      listForTicket: (ticketId) => [...perms.values()].filter((p) => p.ticketId === ticketId),
      pendingForTicket: (ticketId) => [...perms.values()].filter((p) => p.ticketId === ticketId && p.state === 'pending'),
      consume: () => false,
      consumedAt: (id) => (perms.has(id) ? null : undefined),
    },
    transitions: {} as Repos['transitions'],
    projects: (() => {
      const list: Project[] = [];
      const repo: Repos['projects'] = {
        get: (id) => list.find((p) => p.id === id),
        findByName: (n) => list.find((p) => p.name.toLowerCase() === n.trim().toLowerCase()),
        list: () => list.map((p) => ({ ...p, counts: {}, costUsd: 0 })),
        create(i) { const p: Project = { id: nid(), ...i, archived: false, createdAt: now(), updatedAt: now() }; list.push(p); return p; },
        update(id, patch) { const p = list.find((x) => x.id === id)!; Object.assign(p, patch, { updatedAt: now() }); return p; },
        remove(id) { const i = list.findIndex((p) => p.id === id); if (i < 0) return false; list.splice(i, 1); return true; },
        tags: () => [],
      };
      return repo;
    })(),
    trusted: (() => {
      const list: TrustedCommand[] = [];
      return {
        add(i) {
          const found = list.find((t) => t.shell === i.shell && t.command === i.command.trim());
          if (found) return found;
          const t: TrustedCommand = { id: nid(), shell: i.shell, command: i.command.trim(), requestId: i.requestId ?? null, createdAt: now() };
          list.push(t);
          return t;
        },
        find: (c) => list.find((t) => t.shell === c.shell && t.command === c.command.trim()),
        list: () => [...list],
        remove(id) {
          const i = list.findIndex((t) => t.id === id);
          if (i < 0) return false;
          list.splice(i, 1);
          return true;
        },
      } satisfies Repos['trusted'];
    })(),
    tx: (fn) => fn(),
    close: () => undefined,
  };
}

interface Harness {
  ctx: AppContext;
  jobs: Array<{ kind: Job['kind']; payload: Job['payload']; opts?: { priority?: number; dedupeKey?: string } }>;
  events: WsEvent[];
  restored: Array<[string, string]>;
  initialized: string[];
  cancelled: string[];
}

function fakeAdapter(id: string, installed: boolean): RuntimeAdapter {
  return {
    id, displayName: id.toUpperCase(), capabilities: { tools: true, resume: true, costReport: true },
    detect: async () => ({ installed, version: installed ? '1.0.0' : undefined }),
    models: async () => [`${id}-model`],
    // eslint-disable-next-line require-yield
    run: async function* () { return; },
  };
}

function makeHarness(configPatch: Partial<CoreConfig> & { allowedHosts?: string[] } = {}): Harness {
  const h: Harness = { jobs: [], events: [], restored: [], initialized: [], cancelled: [], ctx: undefined as unknown as AppContext };
  const listeners = new Set<(e: WsEvent) => void>();
  const bus: EventBus = {
    publish(e) {
      h.events.push(e);
      for (const l of listeners) l(e);
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const repos = fakeRepos();
  const queue: JobQueue = {
    enqueue(kind, payload, opts) {
      h.jobs.push({ kind, payload, ...(opts ? { opts } : {}) });
      return { id: nid(), kind, payload, priority: opts?.priority ?? 10, state: 'queued', attempts: 0, runAfter: now(), lockedBy: null, lastError: null, createdAt: now() };
    },
    claim: () => undefined, complete: () => undefined, fail: () => undefined, recoverStale: () => 0, depth: () => h.jobs.length, prune: () => 0,
  };
  const snapshots: Snapshots = {
    init: async (f) => { h.initialized.push(f); },
    commit: async () => 'oid',
    restore: async (f, oid) => { h.restored.push([f, oid]); return 'restored-oid'; },
    diff: async () => [],
  };
  const adapters = [fakeAdapter('mock', true), fakeAdapter('claude-cli', false)];
  h.ctx = {
    config: { workspaceDir: '/ws', host: '127.0.0.1', port: 0, apiToken: TOKEN, maxParallelRuns: 3, runtimes: ['mock', 'claude-cli'], version: '0.1.0', ...configPatch },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    repos,
    queue,
    bus,
    state: {
      transition(id, to: TicketStatus) {
        const t = repos.tickets.update(id, { status: to });
        bus.publish({ type: 'ticket.updated', ticket: t });
        return t;
      },
      canTransition: () => true,
    },
    gate: {
      check: () => ({ outcome: 'allow' }),
      requestConnector: () => ({ outcome: 'deny', reason: 'not in this test' }),
      decide(id, decision) {
        const p = repos.permissions.decide(id, decision === 'allow' ? 'allowed' : 'denied');
        bus.publish({ type: 'permission.updated', request: p });
        return p;
      },
    },
    snapshots,
    runtimes: { get: (id) => adapters.find((a) => a.id === id), list: () => adapters },
    executor: { start: () => undefined, stop: async () => undefined, cancel: (id) => { h.cancelled.push(id); return true; }, activeRuns: () => 0 },
  };
  return h;
}

const auth = { authorization: `Bearer ${TOKEN}` };

// ------------------------------------------------------------------ tests
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('buildUiCsp (web UI Content-Security-Policy)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-csp-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('allows the served inline script by its sha256 hash and locks the rest down', () => {
    const script = "(function(){document.documentElement.setAttribute('data-theme','dark');})();";
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html><head><script>${script}</script><script src="./a.js"></script></head></html>`);
    const csp = buildUiCsp(dir);
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    // only the inline (no-src) script is hashed; the external one is covered by 'self'
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).not.toContain("'unsafe-inline' 'sha256"); // scripts never fall back to unsafe-inline
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('without an index.html, script-src has no inline allowance', () => {
    const csp = buildUiCsp(dir);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('sha256-');
  });
});

describe('security helpers', () => {
  it('tokenMatches is exact', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
    expect(tokenMatches('abc', '')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });

  it('hostnameOf strips ports', () => {
    expect(hostnameOf('LocalHost:7600')).toBe('localhost');
    expect(hostnameOf('[::1]:7600')).toBe('[::1]');
    expect(hostnameOf('example.com')).toBe('example.com');
  });

  it('host check: loopback bind only accepts loopback names', () => {
    const ok = createHostCheck({ apiToken: TOKEN, bindHost: '127.0.0.1' });
    expect(ok('127.0.0.1:7600')).toBe(true);
    expect(ok('localhost:1')).toBe(true);
    expect(ok('[::1]:7600')).toBe(true);
    expect(ok('evil.com')).toBe(false);
    expect(ok('127.0.0.1.evil.com:7600')).toBe(false);
    expect(ok(undefined)).toBe(false);
  });

  it('host check: wildcard bind accepts any host; extra hosts honoured', () => {
    expect(createHostCheck({ apiToken: TOKEN, bindHost: '0.0.0.0' })('my-server:7600')).toBe(true);
    expect(createHostCheck({ apiToken: TOKEN, bindHost: '127.0.0.1', allowedHosts: ['sebeto.lan'] })('sebeto.lan:7600')).toBe(true);
  });

  it('origin check', () => {
    const ok = createOriginCheck({ apiToken: TOKEN, bindHost: '0.0.0.0', allowedOrigins: ['https://ok.example'] });
    expect(ok(undefined, 'srv:7600')).toBe(true);
    expect(ok('http://srv:7600', 'srv:7600')).toBe(true);
    expect(ok('https://ok.example', 'srv:7600')).toBe(true);
    expect(ok('http://evil.com', 'srv:7600')).toBe(false);
    expect(ok('null', 'srv:7600')).toBe(false);
    expect(ok('http://localhost:5173', '127.0.0.1:7600')).toBe(true);
    expect(ok('http://localhost:5173', 'srv:7600')).toBe(false);
  });
});

describe('API server', () => {
  let h: Harness;
  let app: FastifyInstance;

  beforeEach(async () => {
    h = makeHarness();
    app = await createServer(h.ctx);
  });
  afterEach(async () => {
    await app.close();
  });

  describe('auth', () => {
    it('rejects a missing token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    });

    it('rejects a wrong token and a query token on normal routes', async () => {
      expect((await app.inject({ url: '/api/v1/health', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/health', headers: { authorization: TOKEN } })).statusCode).toBe(401);
      expect((await app.inject({ url: `/api/v1/health?token=${TOKEN}` })).statusCode).toBe(401);
    });

    it('accepts the right token', async () => {
      const res = await app.inject({ url: '/api/v1/health', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, version: '0.1.0', workspace: '/ws' });
    });

    it('protects unknown /api routes too', async () => {
      expect((await app.inject({ url: '/api/v1/nope' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/v1/nope', headers: auth })).statusCode).toBe(404);
    });

    it('rejects foreign Host headers (DNS rebinding)', async () => {
      const res = await app.inject({ url: '/api/v1/health', headers: { ...auth, host: 'attacker.example:7600' } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden_host');
    });

    it('rejects cross-origin requests, allows same origin', async () => {
      const bad = await app.inject({ url: '/api/v1/health', headers: { ...auth, host: '127.0.0.1:7600', origin: 'https://evil.example' } });
      expect(bad.statusCode).toBe(403);
      expect(bad.json().error.code).toBe('forbidden_origin');
      const good = await app.inject({ url: '/api/v1/health', headers: { ...auth, host: '127.0.0.1:7600', origin: 'http://127.0.0.1:7600' } });
      expect(good.statusCode).toBe(200);
    });

    it('serves the OpenAPI document (auth required) covering every route', async () => {
      expect((await app.inject({ url: '/api/v1/openapi.json' })).statusCode).toBe(401);
      const spec = (await app.inject({ url: '/api/v1/openapi.json', headers: auth })).json();
      expect(spec.openapi).toMatch(/^3\./);
      for (const p of ['/health', '/tickets', '/tickets/{id}', '/tickets/{id}/move', '/tickets/{id}/messages', '/tickets/{id}/attachments', '/tickets/{id}/attachments/{name}', '/tickets/{id}/start',
        '/tickets/{id}/cancel', '/tickets/{id}/undo', '/permissions/{id}/decide', '/trusted-commands', '/trusted-commands/{id}', '/connectors', '/connectors/{id}', '/connectors/{id}/refresh', '/connectors/oauth', '/connectors/oauth/{provider}', '/connectors/oauth/{provider}/start', '/connectors/mail', '/settings', '/projects', '/projects/{id}', '/tags', '/skills', '/skills/{slug}', '/agents/{id}/skills', '/intake', '/intake/accept', '/agents', '/agents/{id}', '/runtimes', '/diagnostics', '/events', '/templates', '/templates/{id}', '/templates/apply', '/templates/export', '/costs']) {
        expect(spec.paths[p], p).toBeDefined();
      }
    });
  });

  describe('tickets', () => {
    it('creates a ticket: folder init, audit, event, default agent, optional start', async () => {
      const agent = h.ctx.repos.agents.create({ name: 'Assistant' });
      const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { title: 'Do it', goal: 'g', start: true } });
      expect(res.statusCode).toBe(201);
      const t = res.json() as Ticket;
      expect(t.agentId).toBe(agent.id);
      expect(h.initialized).toEqual([t.folder]);
      expect(h.ctx.repos.audit.listForTicket(t.id).items.map((e) => e.summary)).toEqual(['Ticket created']);
      expect(h.events.map((e) => e.type)).toEqual(['event.created', 'ticket.updated']);
      expect(h.jobs).toEqual([{ kind: 'run.start', payload: { ticketId: t.id }, opts: { priority: 10, dedupeKey: `start:${t.id}` } }]);
    });

    it('does not enqueue without start; "Automatic" (null agentId) picks the default real agent, not the test agent', async () => {
      h.ctx.repos.agents.create({ name: 'Test agent', runtime: 'mock' });
      const assistant = h.ctx.repos.agents.create({ name: 'Assistant', runtime: 'claude-cli' });
      const t = (await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { title: 'x', goal: '', agentId: null } })).json();
      expect(t.agentId).toBe(assistant.id);
      expect(h.jobs).toHaveLength(0);
    });

    it('reassigns a ticket to another agent, which starts a fresh session', async () => {
      const a = h.ctx.repos.agents.create({ name: 'Assistant', runtime: 'claude-cli' });
      const b = h.ctx.repos.agents.create({ name: 'Sysadmin', runtime: 'claude-cli' });
      const t = (await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { title: 'x', goal: 'g', agentId: a.id } })).json();
      h.ctx.repos.tickets.update(t.id, { currentSessionId: 'old-session' });
      const r = await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${t.id}`, headers: auth, payload: { agentId: b.id } });
      expect(r.statusCode).toBe(200);
      expect(r.json().agentId).toBe(b.id);
      expect(r.json().currentSessionId).toBeNull();
    });

    it('validates bodies', async () => {
      const r1 = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { goal: 'no title' } });
      expect(r1.statusCode).toBe(400);
      expect(r1.json().error.code).toBe('invalid_request');
      const r2 = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { title: 't', goal: 'g', agentId: 'missing' } });
      expect(r2.statusCode).toBe(400);
      expect(r2.json().error.code).toBe('unknown_agent');
      const r3 = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: auth, payload: { title: 't', goal: 'g', extra: 1 } });
      expect(r3.statusCode).toBe(400);
      const r4 = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: { ...auth, 'content-type': 'application/json' }, payload: '{bad' });
      expect(r4.statusCode).toBe(400);
    });

    it('lists with filters and passes cursors through', async () => {
      for (const title of ['a', 'b', 'c']) h.ctx.repos.tickets.create({ title, goal: '' });
      const p1 = (await app.inject({ url: '/api/v1/tickets?limit=2', headers: auth })).json();
      expect(p1.items).toHaveLength(2);
      expect(p1.nextCursor).toBe('2');
      const p2 = (await app.inject({ url: `/api/v1/tickets?limit=2&cursor=${p1.nextCursor}`, headers: auth })).json();
      expect(p2.items.map((t: Ticket) => t.title)).toEqual(['c']);
      expect(p2.nextCursor).toBeNull();
      expect((await app.inject({ url: '/api/v1/tickets?status=nope', headers: auth })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/v1/tickets?limit=0', headers: auth })).statusCode).toBe(400);
    });

    it('gets detail and 404s unknown tickets', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const d = (await app.inject({ url: `/api/v1/tickets/${t.id}`, headers: auth })).json();
      expect(d.ticket.id).toBe(t.id);
      expect(d).toMatchObject({ messages: [], events: [], permissions: [], runs: [] });
      const nf = await app.inject({ url: '/api/v1/tickets/nope', headers: auth });
      expect(nf.statusCode).toBe(404);
      expect(nf.json().error.code).toBe('not_found');
    });

    it('patches and moves', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const p = await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${t.id}`, headers: auth, payload: { title: 'b' } });
      expect(p.json().title).toBe('b');
      const m = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/move`, headers: auth, payload: { status: 'done' } });
      expect(m.json().status).toBe('done');
      expect((await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/move`, headers: auth, payload: { status: 'x' } })).statusCode).toBe(400);
    });

    it('posts a message and enqueues a reply (priority 0 when needs_you)', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const r = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/messages`, headers: auth, payload: { text: 'hi' } });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ role: 'user', author: 'You', text: 'hi' });
      expect(h.jobs[0]).toEqual({ kind: 'run.reply', payload: { ticketId: t.id, text: 'hi' }, opts: { priority: 10, dedupeKey: `reply:${t.id}` } });
      h.ctx.repos.tickets.update(t.id, { status: 'needs_you' });
      await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/messages`, headers: auth, payload: { text: 'yes' } });
      expect(h.jobs[1]!.opts!.priority).toBe(0);
      expect((await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/messages`, headers: auth, payload: { text: '  ' } })).statusCode).toBe(400);
    });

    it('attaches files in the chat: saved in attachments/, served back, named in the message', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-att-'));
      h.ctx.repos.tickets.update(t.id, { folder } as Partial<Ticket>);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const up = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/attachments`, headers: auth, payload: { name: '../My screen shot.PNG', data: png.toString('base64') } });
      expect(up.statusCode).toBe(201);
      expect(up.json()).toEqual({ name: 'My-screen-shot.png', path: 'attachments/My-screen-shot.png', size: 7, type: 'image/png' });
      expect(fs.readFileSync(path.join(folder, 'attachments', 'My-screen-shot.png'))).toEqual(png);
      // same name again: never overwritten
      const again = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/attachments`, headers: auth, payload: { name: 'My screen shot.png', data: png.toString('base64') } });
      expect(again.json().name).toBe('My-screen-shot-2.png');
      expect((await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/attachments`, headers: auth, payload: { name: 'x.svg', data: 'PHN2Zz4=' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/attachments`, payload: { name: 'a.png', data: 'AA==' } })).statusCode).toBe(401);
      const got = await app.inject({ url: `/api/v1/tickets/${t.id}/attachments/My-screen-shot.png`, headers: auth });
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.rawPayload).toEqual(png);
      expect((await app.inject({ url: `/api/v1/tickets/${t.id}/attachments/..%2Fsecret`, headers: auth })).statusCode).toBe(404);
      const m = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/messages`, headers: auth, payload: { text: '', attachments: ['My-screen-shot.png'] } });
      expect(m.statusCode).toBe(201);
      expect(m.json().text).toMatch(/^See the attached file\(s\)\.\n\n📎 Attached \(in the ticket folder\): attachments\/My-screen-shot\.png\n\(Open them/);
      expect((await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/messages`, headers: auth, payload: { text: 'x', attachments: ['nope.png'] } })).statusCode).toBe(400);
      expect(splitAttachmentNote(m.json().text)).toEqual({ text: 'See the attached file(s).', files: ['My-screen-shot.png'] });
      expect(splitAttachmentNote('plain')).toEqual({ text: 'plain', files: [] });
      fs.rmSync(folder, { recursive: true, force: true });
    });

    it('starts and cancels', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const s = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/start`, headers: auth });
      expect(s.statusCode).toBe(202);
      expect(h.jobs[0]!.kind).toBe('run.start');
      const c = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/cancel`, headers: auth });
      expect(c.json()).toEqual({ ok: true, cancelled: true });
      expect(h.cancelled).toEqual([t.id]);
    });

    it('undoes a run by restoring its snapshotBefore', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const run = h.ctx.repos.runs.create({ sessionId: 's', ticketId: t.id, jobId: null, trigger: 'start' });
      h.ctx.repos.runs.update(run.id, { status: 'succeeded', snapshotBefore: 'before-oid' });
      const r = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/undo`, headers: auth, payload: { runId: run.id } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true, snapshot: 'restored-oid' });
      expect(h.restored).toEqual([[t.folder, 'before-oid']]);
      expect(h.ctx.repos.audit.listForTicket(t.id).items.at(-1)!.kind).toBe('snapshot');
      expect((await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/undo`, headers: auth, payload: { runId: 'zz' } })).statusCode).toBe(404);
    });

    it('refuses undo while a run is active or without snapshot', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const run = h.ctx.repos.runs.create({ sessionId: 's', ticketId: t.id, jobId: null, trigger: 'start' });
      const r1 = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/undo`, headers: auth, payload: { runId: run.id } });
      expect(r1.statusCode).toBe(409);
      expect(r1.json().error.code).toBe('no_snapshot');
      h.ctx.repos.runs.update(run.id, { snapshotBefore: 'x' });
      const r2 = await app.inject({ method: 'POST', url: `/api/v1/tickets/${t.id}/undo`, headers: auth, payload: { runId: run.id } });
      expect(r2.json().error.code).toBe('run_active');
    });
  });

  describe('permissions', () => {
    it('decides pending requests once', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const p = h.ctx.repos.permissions.create({ ticketId: t.id, runId: null, agentId: null, key: 'email.send', title: 'Send', detail: 'd', provenance: null });
      const r = await app.inject({ method: 'POST', url: `/api/v1/permissions/${p.id}/decide`, headers: auth, payload: { decision: 'allow' } });
      expect(r.json().state).toBe('allowed');
      const again = await app.inject({ method: 'POST', url: `/api/v1/permissions/${p.id}/decide`, headers: auth, payload: { decision: 'deny' } });
      expect(again.statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/v1/permissions/nope/decide', headers: auth, payload: { decision: 'deny' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/v1/permissions/${p.id}/decide`, headers: auth, payload: { decision: 'maybe' } })).statusCode).toBe(400);
    });
  });

  describe('trusted commands', () => {
    it('lists and removes trusted commands; "always" only for plain commands', async () => {
      const t = h.ctx.repos.tickets.create({ title: 'a', goal: '' });
      const mail = h.ctx.repos.permissions.create({ ticketId: t.id, runId: null, agentId: null, key: 'email.send', title: 'Send', detail: 'd', provenance: null });
      const bad = await app.inject({ method: 'POST', url: `/api/v1/permissions/${mail.id}/decide`, headers: auth, payload: { decision: 'always' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('not_trustable');

      h.ctx.repos.trusted.add({ shell: 'powershell', command: 'Get-PSDrive' });
      const list = await app.inject({ method: 'GET', url: '/api/v1/trusted-commands', headers: auth });
      expect(list.json()).toHaveLength(1);
      const id = list.json()[0].id as string;
      const del = await app.inject({ method: 'DELETE', url: `/api/v1/trusted-commands/${id}`, headers: auth });
      expect(del.statusCode).toBe(204);
      expect(h.events.some((e) => e.type === 'trusted.changed')).toBe(true);
      expect((await app.inject({ method: 'GET', url: '/api/v1/trusted-commands', headers: auth })).json()).toEqual([]);
      expect((await app.inject({ method: 'DELETE', url: `/api/v1/trusted-commands/${id}`, headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/v1/trusted-commands' })).statusCode).toBe(401);
    });
  });

  describe('mail connector', () => {
    it('reports status, connects (password never echoed), maps errors, disconnects', async () => {
      expect((await app.inject({ url: '/api/v1/connectors/mail', headers: auth })).json()).toEqual({ connected: false });
      const body = { provider: 'gmail', address: 'me@gmail.com', password: 'abcd efgh ijkl mnop' };
      expect((await app.inject({ method: 'PUT', url: '/api/v1/connectors/mail', headers: auth, payload: body })).statusCode).toBe(503);

      let connected = false;
      h.ctx.mail = {
        status: () => (connected
          ? { connected: true, provider: 'gmail', address: 'me@gmail.com', connectedAt: now(), servers: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 }, calendar: false }
          : { connected: false }),
        async connect(b) {
          if (b.password === 'wrong') throw new MailError('Gmail refused the login.', 'auth');
          if (b.password === 'offline') throw new MailError('Could not reach the mail server.', 'network');
          connected = true;
          return this.status();
        },
        async disconnect() { connected = false; return { provider: 'gmail' as const, revokedAtProvider: false }; },
        open: async () => null,
        openCalendar: async () => null,
        completeSignIn: async () => ({ connected: false }),
      };
      const bad = await app.inject({ method: 'PUT', url: '/api/v1/connectors/mail', headers: auth, payload: { ...body, password: 'wrong' } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('mail_auth');
      expect((await app.inject({ method: 'PUT', url: '/api/v1/connectors/mail', headers: auth, payload: { ...body, password: 'offline' } })).statusCode).toBe(502);
      expect((await app.inject({ method: 'PUT', url: '/api/v1/connectors/mail', headers: auth, payload: { ...body, extra: 1 } })).statusCode).toBe(400);

      const ok = await app.inject({ method: 'PUT', url: '/api/v1/connectors/mail', headers: auth, payload: body });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ connected: true, address: 'me@gmail.com' });
      expect(ok.body).not.toContain('abcd');
      const out = await app.inject({ method: 'DELETE', url: '/api/v1/connectors/mail', headers: auth });
      expect(out.json()).toEqual({ ok: true, provider: 'gmail', revokedAtProvider: false, accountUrl: 'https://myaccount.google.com/apppasswords' });
      expect((await app.inject({ url: '/api/v1/connectors/mail', headers: auth })).json()).toEqual({ connected: false });
      expect((await app.inject({ url: '/api/v1/connectors/mail' })).statusCode).toBe(401);
    });
  });

  describe('sign-in callback', () => {
    it('needs no API token, only a loopback Host; escapes the page; connects the mailbox on success', async () => {
      const completed: string[] = [];
      h.ctx.oauth = {
        apps: async () => [], setCustomApp: async () => { throw new Error('x'); }, start: async () => 'https://login.example/authorize',
        tokens: async () => null, signOut: async () => ({ revokedAtProvider: false }),
        callback: async (q) => {
          if (q.state !== 'good') throw new MailError('This sign-in link has expired <script>alert(1)</script>', 'invalid');
          return { provider: 'microsoft', email: 'mario@contoso.it' };
        },
      };
      h.ctx.mail = {
        status: () => ({ connected: false }), connect: async () => ({ connected: false }), disconnect: async () => ({ provider: null, revokedAtProvider: false }),
        open: async () => null, openCalendar: async () => null,
        completeSignIn: async (p, email) => { completed.push(`${p}:${email}`); return { connected: true, provider: p, address: email!, connectedAt: now(), servers: null, calendar: true }; },
      };
      const bad = await app.inject({ url: '/oauth/callback?code=c&state=nope' });
      expect(bad.statusCode).toBe(400);
      expect(bad.headers['content-type']).toContain('text/html');
      expect(bad.body).not.toContain('<script>alert');
      expect(bad.body).toContain('&lt;script&gt;');
      const ok = await app.inject({ url: '/oauth/callback?code=c&state=good' });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('mario@contoso.it');
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(completed).toEqual(['microsoft:mario@contoso.it']);
      expect(h.events.some((e) => e.type === 'connectors.changed')).toBe(true);
      expect((await app.inject({ url: '/oauth/callback?code=c&state=good', headers: { host: 'evil.example' } })).statusCode).toBe(403);
      const start = await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/microsoft/start', headers: auth });
      expect(start.json()).toEqual({ authUrl: 'https://login.example/authorize' });
      expect((await app.inject({ method: 'POST', url: '/api/v1/connectors/oauth/yahoo/start', headers: auth })).statusCode).toBe(400);
    });
  });

  describe('agents & runtimes', () => {
    it('creates, lists and patches agents', async () => {
      const c = await app.inject({ method: 'POST', url: '/api/v1/agents', headers: auth, payload: { name: 'Analyst', runtime: 'mock', permissions: { 'web.read': 'allow' } } });
      expect(c.statusCode).toBe(201);
      const a = c.json() as Agent;
      expect(a.permissions['web.read']).toBe('allow');
      expect(h.events.at(-1)!.type).toBe('agent.updated');
      expect((await app.inject({ url: '/api/v1/agents', headers: auth })).json()).toHaveLength(1);
      const p = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${a.id}`, headers: auth, payload: { paused: true, permissions: { 'email.send': 'never' } } });
      expect(p.json()).toMatchObject({ paused: true, permissions: { 'web.read': 'allow', 'email.send': 'never' } });
      const cyc = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${a.id}`, headers: auth, payload: { reportsTo: a.id } });
      expect(cyc.statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/agents/nope', headers: auth, payload: {} })).statusCode).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/agents/nope', headers: auth })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/api/v1/agents', headers: auth, payload: { name: 'X', runtime: 'nope' } })).json().error.code).toBe('unknown_runtime');
      expect((await app.inject({ method: 'POST', url: '/api/v1/agents', headers: auth, payload: { name: 'X', permissions: { 'bad.key': 'allow' } } })).statusCode).toBe(400);
    });

    it('lists runtimes with detection and models', async () => {
      const r = (await app.inject({ url: '/api/v1/runtimes', headers: auth })).json();
      expect(r).toEqual([
        { id: 'mock', displayName: 'MOCK', detection: { installed: true, version: '1.0.0' }, models: ['mock-model'] },
        { id: 'claude-cli', displayName: 'CLAUDE-CLI', detection: { installed: false }, models: [] },
      ]);
    });

    it('seedDefaults creates one Assistant on the mock runtime when Claude is missing', async () => {
      const a = await seedDefaults(h.ctx);
      expect(a).toMatchObject({ name: 'Assistant', runtime: 'mock' });
      expect(await seedDefaults(h.ctx)).toBeUndefined();
      expect(h.ctx.repos.agents.list()).toHaveLength(1);
    });
  });

  describe('settings (setup wizard)', () => {
    it('setupCompleted: false on a fresh workspace, PATCH true/false round-trips, invalid values rejected', async () => {
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const { createSettingsStore } = await import('../settings.js');
      const dir = mkdtempSync(join(tmpdir(), 'sebeto-settings-'));
      h.ctx.settings = createSettingsStore(dir);
      expect((await app.inject({ url: '/api/v1/settings', headers: auth })).json()).toEqual({ intakeModel: 'haiku', setupCompleted: false, newTicketTeam: 'manual', autoTags: true, budgetBlocks: true });
      const done = await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth, payload: { setupCompleted: true } });
      expect(done.json()).toEqual({ intakeModel: 'haiku', setupCompleted: true, newTicketTeam: 'manual', autoTags: true, budgetBlocks: true });
      // Saved on disk: a new store (app restart) reads it back.
      expect(createSettingsStore(dir).get().setupCompleted).toBe(true);
      const again = await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth, payload: { setupCompleted: false } });
      expect(again.json().setupCompleted).toBe(false);
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth, payload: { setupCompleted: 'yes' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth, payload: { other: 1 } })).statusCode).toBe(400);
    });

    it('a workspace that already has tickets counts as set up', async () => {
      const { mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const { createSettingsStore } = await import('../settings.js');
      h.ctx.settings = createSettingsStore(mkdtempSync(join(tmpdir(), 'sebeto-settings-')));
      h.ctx.repos.tickets.create({ title: 'Renew the VPN certificate', goal: 'Before it expires' });
      expect((await app.inject({ url: '/api/v1/settings', headers: auth })).json().setupCompleted).toBe(true);
    });

    it('without a settings store: defaults on GET (set up once tickets exist), 503 on PATCH', async () => {
      expect((await app.inject({ url: '/api/v1/settings', headers: auth })).json().setupCompleted).toBe(false);
      expect((await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth, payload: { setupCompleted: true } })).statusCode).toBe(503);
    });
  });

  describe('diagnostics', () => {
    it('needs the token; returns the report; ?download=1 makes it a file; never contains the API token', async () => {
      expect((await app.inject({ url: '/api/v1/diagnostics' })).statusCode).toBe(401);
      const res = await app.inject({ url: '/api/v1/diagnostics', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBeUndefined();
      const report = res.json();
      expect(report.format).toBe('sebeto-diagnostics/1');
      expect(report.app.version).toBe('0.1.0');
      expect(report.runtimes.map((r: { id: string; models: number }) => [r.id, r.models])).toEqual([['mock', 1], ['claude-cli', 0]]);
      expect(res.body).not.toContain(TOKEN);
      const dl = await app.inject({ url: '/api/v1/diagnostics?download=1', headers: auth });
      expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="sebeto-diagnostics-\d{4}-\d{2}-\d{2}\.json"$/);
    });
  });

  describe('events websocket', () => {
    it('rejects without token and forwards bus events with token', async () => {
      await app.ready();
      const ctx = { headers: { host: '127.0.0.1:7600' } };
      await expect(app.injectWS('/api/v1/events', ctx)).rejects.toThrow(/401/);
      await expect(app.injectWS(`/api/v1/events?token=${TOKEN}`, { headers: { host: 'evil.example' } })).rejects.toThrow(/403/);
      const ws = await app.injectWS(`/api/v1/events?token=${TOKEN}`, ctx);
      const got = new Promise<WsEvent>((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)))));
      h.ctx.bus.publish({ type: 'ticket.deleted', ticketId: 'x' });
      expect(await got).toEqual({ type: 'ticket.deleted', ticketId: 'x' });
      ws.terminate();
    });
  });

  describe('mcp', () => {
    it('returns 503 without a tool server and delegates to handleHttp without the API token', async () => {
      expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(503);
      const seen: unknown[] = [];
      h.ctx.tools = {
        url: () => 'http://127.0.0.1/mcp', issueToken: () => 'x', revokeToken: () => undefined,
        handleHttp: (_req: unknown, res: import('node:http').ServerResponse, body: unknown) => {
          seen.push(body);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"jsonrpc":"2.0"}');
        },
      } as AppContext['tools'];
      const r = await app.inject({ method: 'POST', url: '/mcp', payload: { hello: 1 } });
      expect(r.statusCode).toBe(200);
      expect(seen).toEqual([{ hello: 1 }]);
      expect((await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'evil.example' }, payload: {} })).statusCode).toBe(403);
    });
  });
});

describe('UI serving', () => {
  it('serves index.html with SPA fallback and keeps /api 404s as JSON', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'sebeto-ui-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Sebeto</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const h = makeHarness({ uiDir: dir });
    const app = await createServer(h.ctx);
    try {
      const root = await app.inject({ url: '/?token=abc' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('Sebeto');
      expect(root.headers['referrer-policy']).toBe('no-referrer');
      expect((await app.inject({ url: '/app.js' })).body).toContain('console.log');
      const deep = await app.inject({ url: '/tickets/123' });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain('Sebeto');
      const api404 = await app.inject({ url: '/api/v1/missing', headers: auth });
      expect(api404.statusCode).toBe(404);
      expect(api404.json().error.code).toBe('not_found');
    } finally {
      await app.close();
    }
  });
});
