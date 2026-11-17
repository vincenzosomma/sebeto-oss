/**
 * TEST-ONLY in-memory fakes of Repos / StateMachine / JobQueue / EventBus, used by the gate and
 * tool-server tests while the real implementations live elsewhere. Not exported from index.ts.
 */
import { DEFAULT_PERMISSIONS, uuidv7 } from '@sebeto/shared';
import type { Agent, AuditEvent, CommandSpec, Message, PermissionRequest, Run, Ticket, TicketStatus, TrustedCommand, WsEvent } from '@sebeto/shared';
import type { EventBus, Job, JobQueue, Repos, StateMachine } from '../contracts.js';

const now = () => new Date().toISOString();
const page = <T>(items: T[]) => ({ items, nextCursor: null });

export interface Fakes {
  repos: Repos;
  state: StateMachine & { calls: Array<{ ticketId: string; to: TicketStatus; cause: string }> };
  queue: JobQueue & { jobs: Job[] };
  bus: EventBus & { events: WsEvent[] };
  tickets: Map<string, Ticket>;
  agents: Map<string, Agent>;
  runs: Map<string, Run>;
  messages: Message[];
  audit: AuditEvent[];
  permissions: Map<string, PermissionRequest>;
  trusted: TrustedCommand[];
  addTicket(folder: string, patch?: Partial<Ticket>): Ticket;
  addAgent(patch?: Partial<Agent>): Agent;
  addRun(ticketId: string): Run;
}

export function createFakes(): Fakes {
  const tickets = new Map<string, Ticket>();
  const agents = new Map<string, Agent>();
  const runs = new Map<string, Run>();
  const messages: Message[] = [];
  const audit: AuditEvent[] = [];
  const permissions = new Map<string, PermissionRequest>();
  const consumedAt = new Map<string, string>();
  const trusted: TrustedCommand[] = [];
  const events: WsEvent[] = [];
  const jobs: Job[] = [];
  const calls: Fakes['state']['calls'] = [];
  const unsupported = () => { throw new Error('not implemented in fake'); };

  const bus = { events, publish: (e: WsEvent) => { events.push(e); }, subscribe: () => () => {} };

  const repos = {
    tickets: {
      create: unsupported, list: unsupported, addCost: unsupported,
      childrenOf: (parentId: string) => [...tickets.values()].filter((t) => t.parentId === parentId),
      get: (id: string) => tickets.get(id),
      update: (id: string, patch: Partial<Ticket>) => {
        const t = { ...tickets.get(id)!, ...patch, updatedAt: now() };
        tickets.set(id, t);
        return t;
      },
    },
    agents: {
      create: unsupported, list: () => [...agents.values()], update: unsupported, monthSpendUsd: () => 0,
      get: (id: string) => agents.get(id),
    },
    sessions: { create: unsupported, get: unsupported, setExternalId: unsupported, end: unsupported, listForTicket: () => [] },
    runs: {
      create: unsupported, update: unsupported, listForTicket: () => [], failOrphans: () => 0,
      get: (id: string) => runs.get(id),
    },
    messages: {
      create: (input: { ticketId: string; runId?: string | null; role: Message['role']; author: string; text: string }) => {
        const m: Message = { id: uuidv7(), runId: input.runId ?? null, createdAt: now(), ...input } as Message;
        messages.push(m);
        return m;
      },
      listForTicket: (ticketId: string) => page(messages.filter((m) => m.ticketId === ticketId)),
    },
    audit: {
      append: (input: { ticketId: string; runId?: string | null; kind: AuditEvent['kind']; summary: string; data?: Record<string, unknown> | null }) => {
        const e: AuditEvent = {
          id: uuidv7(), ticketId: input.ticketId, runId: input.runId ?? null, kind: input.kind,
          summary: input.summary, data: input.data ?? null, createdAt: now(),
        };
        audit.push(e);
        return e;
      },
      listForTicket: (ticketId: string) => page(audit.filter((e) => e.ticketId === ticketId)),
    },
    permissions: {
      create: (input: Omit<PermissionRequest, 'id' | 'state' | 'createdAt' | 'decidedAt' | 'command' | 'alwaysAllowed' | 'taskScoped'> & { command?: CommandSpec | null }) => {
        const r: PermissionRequest = { ...input, command: input.command ?? null, alwaysAllowed: false, taskScoped: false, id: uuidv7(), state: 'pending', createdAt: now(), decidedAt: null };
        permissions.set(r.id, r);
        return r;
      },
      get: (id: string) => permissions.get(id),
      decide: (id: string, s: 'allowed' | 'denied', o?: { always?: boolean; taskScoped?: boolean }) => {
        const r = { ...permissions.get(id)!, state: s, alwaysAllowed: s === 'allowed' && !!o?.always, taskScoped: s === 'allowed' && !!o?.taskScoped, decidedAt: now() };
        permissions.set(id, r);
        return r;
      },
      listForTicket: (ticketId: string) => [...permissions.values()].filter((r) => r.ticketId === ticketId),
      pendingForTicket: (ticketId: string) => [...permissions.values()].filter((r) => r.ticketId === ticketId && r.state === 'pending'),
      consume: (id: string) => {
        if (permissions.get(id)?.state !== 'allowed' || consumedAt.has(id)) return false;
        consumedAt.set(id, now());
        return true;
      },
      consumedAt: (id: string) => (permissions.has(id) ? consumedAt.get(id) ?? null : undefined),
    },
    transitions: { append: unsupported, listForTicket: () => [] },
    trusted: {
      add: (input: { shell: string; command: string; requestId?: string | null }) => {
        const command = input.command.trim();
        const found = trusted.find((t) => t.shell === input.shell && t.command === command);
        if (found) return found;
        const t: TrustedCommand = { id: uuidv7(), shell: input.shell, command, requestId: input.requestId ?? null, createdAt: now() };
        trusted.push(t);
        return t;
      },
      find: (spec: CommandSpec) => trusted.find((t) => t.shell === spec.shell && t.command === spec.command.trim()),
      list: () => [...trusted],
      remove: (id: string) => {
        const i = trusted.findIndex((t) => t.id === id);
        if (i < 0) return false;
        trusted.splice(i, 1);
        return true;
      },
    },
    tx: <T>(fn: () => T) => fn(),
    close: () => {},
  } as unknown as Repos;

  const state = {
    calls,
    canTransition: (_from: TicketStatus, to: TicketStatus) => to !== 'done',
    transition: (ticketId: string, to: TicketStatus, cause: 'agent' | 'rule' | 'user') => {
      const t = tickets.get(ticketId);
      if (!t) throw new Error('no ticket');
      // Minimal rule for tests: agents cannot mark a ticket done, and done tickets are frozen.
      if (t.status === 'done' || (cause === 'agent' && to === 'done')) {
        const err = new Error(`Invalid transition ${t.status} -> ${to}`);
        err.name = 'InvalidTransitionError';
        throw err;
      }
      calls.push({ ticketId, to, cause });
      const updated = { ...t, status: to, updatedAt: now() };
      tickets.set(ticketId, updated);
      bus.publish({ type: 'ticket.updated', ticket: updated });
      return updated;
    },
  };

  const queue = {
    jobs,
    enqueue: (kind: Job['kind'], payload: Job['payload'], opts: { priority?: number; dedupeKey?: string } = {}) => {
      const job: Job = {
        id: uuidv7(), kind, payload, priority: opts.priority ?? 10, state: 'queued', attempts: 0,
        runAfter: now(), lockedBy: null, lastError: null, createdAt: now(),
      };
      (job as Job & { dedupeKey?: string }).dedupeKey = opts.dedupeKey;
      jobs.push(job);
      return job;
    },
    claim: () => undefined, complete: () => {}, fail: () => {}, recoverStale: () => 0, depth: () => jobs.length, prune: () => 0,
  };

  let n = 0;
  return {
    repos, state, queue, bus, tickets, agents, runs, messages, audit, permissions, trusted,
    addTicket(folder, patch = {}) {
      n += 1;
      const t: Ticket = {
        id: uuidv7(), number: n, title: `Ticket ${n}`, goal: 'test', status: 'in_progress', agentId: null,
        runtime: null, model: null, currentSessionId: null, folder, costCapUsd: 5, costUsd: 0,
        parentId: null, dependsOn: [], createdAt: now(), updatedAt: now(), ...patch,
      };
      tickets.set(t.id, t);
      return t;
    },
    addAgent(patch = {}) {
      const a: Agent = {
        id: uuidv7(), skills: [], name: 'Tester', role: 'tester', job: 'test', runtime: 'mock', model: null, reportsTo: null,
        heartbeatMinutes: 15, monthlyBudgetUsd: 10, permissions: { ...DEFAULT_PERMISSIONS }, paused: false,
        createdAt: now(), ...patch,
      };
      agents.set(a.id, a);
      return a;
    },
    addRun(ticketId) {
      const r: Run = {
        id: uuidv7(), sessionId: uuidv7(), ticketId, jobId: null, trigger: 'start', status: 'running',
        startedAt: now(), endedAt: null, tokensIn: 0, tokensOut: 0, costUsd: 0, exitReason: null,
        snapshotBefore: null, snapshotAfter: null,
      };
      runs.set(r.id, r);
      return r;
    },
  };
}
