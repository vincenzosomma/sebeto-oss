/**
 * Small in-memory fakes of the core contracts, shared by executor and scheduler tests.
 * Test-only: not exported from the package entry point.
 */
import { DEFAULT_PERMISSIONS, nowIso, uuidv7 } from '@sebeto/shared';
import type { Agent, AuditEvent, Message, PermissionRequest, Run, RuntimeAdapter, Session, StatusTransition, Ticket, WsEvent } from '@sebeto/shared';
import type { AppContext, Job, JobKind, JobPayload, Logger, ToolServer } from '../../contracts.js';
import { createMockAdapter } from '../../runtimes/mock.js';
import { createRuntimeRegistry } from '../../runtimes/registry.js';

export interface Fakes {
  ctx: AppContext;
  tickets: Map<string, Ticket>;
  agents: Map<string, Agent>;
  sessions: Map<string, Session>;
  runs: Map<string, Run>;
  messages: Message[];
  audit: AuditEvent[];
  permissions: Map<string, PermissionRequest>;
  transitions: StatusTransition[];
  jobs: Job[];
  /** Arguments of every queue.prune() call. */
  prunes: Array<number | undefined>;
  failures: Array<{ id: string; error: string; retryAt?: Date }>;
  events: WsEvent[];
  revoked: string[];
  /** Mark a folder dirty so the next snapshot commit returns a new oid. */
  touch(folder: string, path: string): void;
  addTicket(p?: Partial<Ticket>): Ticket;
  addAgent(p?: Partial<Agent>): Agent;
  agentSpend: Map<string, number>;
}

export function createFakes(opts: { adapters?: RuntimeAdapter[]; maxParallelRuns?: number; withTools?: boolean } = {}): Fakes {
  const tickets = new Map<string, Ticket>();
  const agents = new Map<string, Agent>();
  const sessions = new Map<string, Session>();
  const runs = new Map<string, Run>();
  const messages: Message[] = [];
  const audit: AuditEvent[] = [];
  const permissions = new Map<string, PermissionRequest>();
  const consumedAt = new Map<string, string>();
  const transitions: StatusTransition[] = [];
  const jobs: Job[] = [];
  const prunes: Array<number | undefined> = [];
  const failures: Fakes['failures'] = [];
  const events: WsEvent[] = [];
  const revoked: string[] = [];
  const agentSpend = new Map<string, number>();
  const dedupe = new Map<string, string>();
  const snap = new Map<string, { n: number; dirty: string[]; diffs: Map<string, string[]> }>();
  let ticketNo = 0;

  const must = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`${what} not found`);
    return v;
  };
  const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

  const tools: ToolServer = {
    url: () => 'http://127.0.0.1:1/mcp',
    issueToken: (s) => `token-${s.runId}`,
    revokeToken: (t) => void revoked.push(t),
  };

  const ctx: AppContext = {
    config: { workspaceDir: '/ws', host: '127.0.0.1', port: 0, apiToken: 'x', maxParallelRuns: opts.maxParallelRuns ?? 4, runtimes: ['mock'], version: '0.1.0' },
    log,
    repos: {
      tickets: {
        create: () => { throw new Error('not used'); },
        get: (id) => tickets.get(id),
        childrenOf: (parentId) => [...tickets.values()].filter((t) => t.parentId === parentId),
        delete: (id) => tickets.delete(id),
        list: (q) => {
          const items = [...tickets.values()].filter((t) => !q.status || t.status === q.status);
          return { items, nextCursor: null };
        },
        update: (id, patch) => {
          const t = { ...must(tickets.get(id), 'ticket'), ...patch, updatedAt: nowIso() };
          tickets.set(id, t);
          return t;
        },
        addCost: (id, usd) => {
          const t = must(tickets.get(id), 'ticket');
          const u = { ...t, costUsd: t.costUsd + usd };
          tickets.set(id, u);
          return u;
        },
      },
      agents: {
        create: () => { throw new Error('not used'); },
        setSkills: () => { throw new Error('not used'); },
        removeSkillEverywhere: () => 0,
        get: (id) => agents.get(id),
        list: () => [...agents.values()],
        update: (id, patch) => {
          const a = { ...must(agents.get(id), 'agent'), ...patch };
          agents.set(id, a);
          return a;
        },
        monthSpendUsd: (id) => agentSpend.get(id) ?? 0,
      },
      sessions: {
        create: (i) => {
          const s: Session = { id: uuidv7(), ticketId: i.ticketId, agentId: i.agentId, runtime: i.runtime, model: i.model, externalSessionId: i.externalSessionId ?? null, reason: i.reason, startedAt: nowIso(), endedAt: null };
          sessions.set(s.id, s);
          return { ...s };
        },
        get: (id) => (sessions.has(id) ? { ...sessions.get(id)! } : undefined),
        setExternalId: (id, ext) => {
          const s = { ...must(sessions.get(id), 'session'), externalSessionId: ext };
          sessions.set(id, s);
          return s;
        },
        end: (id) => {
          const s = { ...must(sessions.get(id), 'session'), endedAt: nowIso() };
          sessions.set(id, s);
          return s;
        },
        listForTicket: (tid) => [...sessions.values()].filter((s) => s.ticketId === tid),
      },
      runs: {
        create: (i) => {
          const r: Run = { id: uuidv7(), sessionId: i.sessionId, ticketId: i.ticketId, jobId: i.jobId, trigger: i.trigger, status: 'running', startedAt: nowIso(), endedAt: null, tokensIn: 0, tokensOut: 0, costUsd: 0, exitReason: null, snapshotBefore: null, snapshotAfter: null };
          runs.set(r.id, r);
          return r;
        },
        get: (id) => runs.get(id),
        update: (id, patch) => {
          const r = { ...must(runs.get(id), 'run'), ...patch };
          runs.set(id, r);
          return r;
        },
        listForTicket: (tid, limit) => [...runs.values()].filter((r) => r.ticketId === tid).reverse().slice(0, limit ?? 50),
        failOrphans: () => 0,
      },
      messages: {
        create: (i) => {
          const m: Message = { id: uuidv7(), ticketId: i.ticketId, runId: i.runId ?? null, role: i.role, author: i.author, text: i.text, createdAt: nowIso() };
          messages.push(m);
          return m;
        },
        listForTicket: (tid) => ({ items: messages.filter((m) => m.ticketId === tid), nextCursor: null }),
      },
      audit: {
        append: (i) => {
          const e: AuditEvent = { id: uuidv7(), ticketId: i.ticketId, runId: i.runId ?? null, kind: i.kind, summary: i.summary, data: i.data ?? null, createdAt: nowIso() };
          audit.push(e);
          return e;
        },
        listForTicket: (tid) => ({ items: audit.filter((e) => e.ticketId === tid), nextCursor: null }),
      },
      permissions: {
        create: (i) => {
          const p: PermissionRequest = { ...i, command: i.command ?? null, alwaysAllowed: false, taskScoped: false, id: uuidv7(), state: 'pending', createdAt: nowIso(), decidedAt: null };
          permissions.set(p.id, p);
          return p;
        },
        get: (id) => permissions.get(id),
        decide: (id, state) => {
          const p = { ...must(permissions.get(id), 'permission'), state, decidedAt: nowIso() };
          permissions.set(id, p);
          return p;
        },
        listForTicket: (tid) => [...permissions.values()].filter((p) => p.ticketId === tid),
        pendingForTicket: (tid) => [...permissions.values()].filter((p) => p.ticketId === tid && p.state === 'pending'),
        consume: (id) => {
          if (permissions.get(id)?.state !== 'allowed' || consumedAt.has(id)) return false;
          consumedAt.set(id, nowIso());
          return true;
        },
        consumedAt: (id) => (permissions.has(id) ? consumedAt.get(id) ?? null : undefined),
      },
      transitions: {
        append: (t) => {
          const st: StatusTransition = { ...t, id: uuidv7(), createdAt: nowIso() };
          transitions.push(st);
          return st;
        },
        listForTicket: (tid) => transitions.filter((t) => t.ticketId === tid),
      },
      projects: { get: () => undefined, findByName: () => undefined, list: () => [], create: () => { throw new Error('not in fake'); }, update: () => { throw new Error('not in fake'); }, remove: () => false, tags: () => [] },
      trusted: { add: () => { throw new Error('not in fake'); }, find: () => undefined, list: () => [], remove: () => false },
      tx: (fn) => fn(),
      close: () => undefined,
    },
    queue: {
      enqueue: (kind: JobKind, payload: JobPayload, o = {}) => {
        if (o.dedupeKey) {
          const existing = jobs.find((j) => j.id === dedupe.get(o.dedupeKey!) && j.state === 'queued');
          if (existing) return existing;
        }
        const j: Job = { id: uuidv7(), kind, payload, priority: o.priority ?? 10, state: 'queued', attempts: 0, runAfter: (o.runAfter ?? new Date(0)).toISOString(), lockedBy: null, lastError: null, createdAt: nowIso() };
        jobs.push(j);
        if (o.dedupeKey) dedupe.set(o.dedupeKey, j.id);
        return j;
      },
      claim: (worker) => {
        const now = new Date().toISOString();
        const due = jobs.filter((j) => j.state === 'queued' && j.runAfter <= now).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
        const j = due[0];
        if (!j) return undefined;
        j.state = 'running';
        j.lockedBy = worker;
        return { ...j };
      },
      complete: (id) => {
        must(jobs.find((j) => j.id === id), 'job').state = 'done';
      },
      fail: (id, error, retryAt) => {
        const j = must(jobs.find((x) => x.id === id), 'job');
        failures.push({ id, error, retryAt });
        j.lastError = error;
        j.attempts++;
        if (retryAt) {
          j.state = 'queued';
          j.runAfter = retryAt.toISOString();
        } else j.state = 'failed';
      },
      recoverStale: () => 0,
      depth: () => jobs.filter((j) => j.state === 'queued').length,
      prune: (days) => {
        prunes.push(days);
        return 0;
      },
    },
    bus: { publish: (e) => void events.push(e), subscribe: () => () => undefined },
    state: {
      transition: (ticketId, to, cause, o) => {
        const t = must(tickets.get(ticketId), 'ticket');
        if (t.status === to) return t;
        transitions.push({ id: uuidv7(), ticketId, from: t.status, to, cause, runId: o?.runId ?? null, note: o?.note ?? null, createdAt: nowIso() });
        const u = { ...t, status: to };
        tickets.set(ticketId, u);
        events.push({ type: 'ticket.updated', ticket: u });
        return u;
      },
      canTransition: () => true,
    },
    gate: {
      check: () => ({ outcome: 'allow' }),
      requestConnector: () => ({ outcome: 'deny', reason: 'not in this fake' }),
      decide: (id) => must(permissions.get(id), 'permission'),
    },
    snapshots: {
      init: async (folder) => void (snap.has(folder) || snap.set(folder, { n: 0, dirty: [], diffs: new Map() })),
      commit: async (folder) => {
        const s = must(snap.get(folder), 'snapshot repo');
        const prev = `oid-${s.n}`;
        if (s.dirty.length || s.n === 0) {
          s.n++;
          s.diffs.set(`${prev}..oid-${s.n}`, s.dirty);
          s.dirty = [];
        }
        return `oid-${s.n}`;
      },
      restore: async (_folder, oid) => oid,
      diff: async (folder, from, to) => (snap.get(folder)?.diffs.get(`${from}..${to}`) ?? []).map((path) => ({ path, change: 'modified' as const })),
    },
    runtimes: createRuntimeRegistry(opts.adapters ?? [createMockAdapter()]),
    tools: opts.withTools === false ? undefined : tools,
  };

  const fakes: Fakes = {
    ctx, tickets, agents, sessions, runs, messages, audit, permissions, transitions, jobs, prunes, failures, events, revoked, agentSpend,
    touch: (folder, path) => {
      const s = snap.get(folder) ?? { n: 0, dirty: [] as string[], diffs: new Map<string, string[]>() };
      s.dirty.push(path);
      snap.set(folder, s);
    },
    addTicket: (p = {}) => {
      // Real tickets always end up with an agent; give test tickets the default test agent unless one is set.
      if (p.agentId === undefined) {
        const existing = [...agents.values()].find((a) => a.name === 'Default test agent');
        p = { ...p, agentId: (existing ?? fakes.addAgent({ name: 'Default test agent' })).id };
      }
      const t: Ticket = {
        id: uuidv7(), number: ++ticketNo, title: 'Write a report', goal: 'Summarise the numbers', status: 'backlog', agentId: null, runtime: null, model: null,
        currentSessionId: null, folder: `/ws/tickets/T-${ticketNo}`, costCapUsd: 2, costUsd: 0, parentId: null, dependsOn: [], createdAt: nowIso(), updatedAt: nowIso(), ...p,
      };
      tickets.set(t.id, t);
      return t;
    },
    addAgent: (p = {}) => {
      const a: Agent = {
        id: uuidv7(), skills: [], name: 'Analyst', role: 'data analyst', job: 'Turn numbers into clear reports.', runtime: 'mock', model: null, reportsTo: null,
        heartbeatMinutes: 10, monthlyBudgetUsd: 20, permissions: { ...DEFAULT_PERMISSIONS }, paused: false, createdAt: nowIso(), ...p,
      };
      agents.set(a.id, a);
      return a;
    },
  };
  return fakes;
}

