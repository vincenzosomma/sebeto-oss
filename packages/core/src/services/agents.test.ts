import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WsEvent } from '@sebeto/shared';
import { createEventBus } from '../bus/event-bus.js';
import { createMcpHub, type McpHub } from '../connectors/mcp-hub.js';
import type { SecretStore } from '../connectors/secrets.js';
import type { AppContext, Repos } from '../contracts.js';
import { createJobQueue } from '../queue/job-queue.js';
import { openDatabase } from '../storage/database.js';
import { deleteAgent } from './agents.js';
import { AppError } from './errors.js';

describe('deleteAgent (real SQLite)', () => {
  let dir: string;
  let repos: Repos;
  let db: ReturnType<typeof openDatabase>['db'];
  let ctx: AppContext;
  let events: WsEvent[];
  let hub: McpHub;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-agents-'));
    ({ repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
    const bus = createEventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
    hub = createMcpHub({
      workspaceDir: dir,
      secrets: {} as SecretStore,
      connect: async () => ({ listTools: async () => [], callTool: async () => ({ text: '', isError: false }), close: async () => undefined }),
    });
    ctx = {
      config: { workspaceDir: dir }, repos, bus, queue: createJobQueue(db), connectors: hub,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    } as unknown as AppContext;
  });

  afterEach(async () => {
    await hub.closeAll();
    repos.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const code = (fn: () => unknown): string | undefined => {
    try { fn(); } catch (err) { return err instanceof AppError ? `${err.statusCode} ${err.code}` : String(err); }
    return undefined;
  };

  it('moves open tickets to the default agent and reports up to the manager', () => {
    const cos = repos.agents.create({ name: 'Chief of Staff', runtime: 'claude-cli' });
    const lead = repos.agents.create({ name: 'Service Desk Lead', runtime: 'claude-cli', reportsTo: cos.id });
    const writer = repos.agents.create({ name: 'Comms writer', runtime: 'claude-cli', reportsTo: lead.id });
    const analyst = repos.agents.create({ name: 'Analyst', runtime: 'claude-cli', reportsTo: lead.id });
    const open = repos.tickets.create({ title: 'Draft maintenance notice', goal: 'x', agentId: lead.id });
    const session = repos.sessions.create({ ticketId: open.id, agentId: lead.id, runtime: 'claude-cli', model: null, reason: 'new' });
    repos.tickets.update(open.id, { currentSessionId: session.id });
    const done = repos.tickets.create({ title: 'Old report', goal: 'y', agentId: lead.id });
    db.prepare("UPDATE tickets SET status = 'done' WHERE id = ?").run(done.id);
    repos.agents.setSkills(lead.id, ['incident-summary']);

    expect(deleteAgent(ctx, lead.id)).toEqual({ ok: true, reassignedTickets: 1, movedReports: 2 });

    expect(repos.agents.get(lead.id)).toBeUndefined();
    const moved = repos.tickets.get(open.id)!;
    expect(moved.agentId).toBe(cos.id);
    expect(moved.currentSessionId).toBeNull();
    expect(repos.tickets.get(done.id)!.agentId).toBeNull(); // done tickets stay done; FK sets NULL
    expect(repos.audit.listForTicket(open.id).items.map((e) => e.summary))
      .toContain('Agent Service Desk Lead was removed; reassigned to Chief of Staff. The new agent starts a fresh session.');
    expect(repos.agents.get(writer.id)!.reportsTo).toBe(cos.id);
    expect(repos.agents.get(analyst.id)!.reportsTo).toBe(cos.id);
    // Old sessions keep their history with agent_id NULL; skill assignments cascade.
    expect(repos.sessions.get(session.id)!.agentId).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_skills WHERE agent_id = ?').get(lead.id)).toEqual({ n: 0 });

    const types = events.map((e) => e.type);
    expect(types).toContain('agent.deleted');
    expect(events.filter((e) => e.type === 'agent.updated')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'ticket.updated')).toHaveLength(1);
    expect(types).not.toContain('connectors.changed');
  });

  it('makes reports top-level when the deleted agent had no manager, and skips the test agent as default', () => {
    const mock = repos.agents.create({ name: 'Test agent', runtime: 'mock' });
    const top = repos.agents.create({ name: 'Chief of Staff', runtime: 'claude-cli' });
    const infra = repos.agents.create({ name: 'Infrastructure Lead', runtime: 'claude-cli', reportsTo: top.id });
    const t = repos.tickets.create({ title: 'Renew certificates', goal: 'x', agentId: top.id });
    deleteAgent(ctx, top.id);
    expect(repos.agents.get(infra.id)!.reportsTo).toBeNull();
    expect(repos.tickets.get(t.id)!.agentId).toBe(infra.id);
    expect(repos.agents.get(mock.id)).toBeDefined();
  });

  it('removes the agent from connector lists; an emptied list stays empty (nobody)', async () => {
    const a = repos.agents.create({ name: 'Sysadmin', runtime: 'claude-cli' });
    const b = repos.agents.create({ name: 'Analyst', runtime: 'claude-cli' });
    const both = await hub.add({ name: 'Service Desk', catalogId: 'custom', transport: { type: 'stdio', command: 'node', args: ['sd.js'] }, allowedAgents: [a.id, b.id] });
    const only = await hub.add({ name: 'CMDB', catalogId: 'custom', transport: { type: 'stdio', command: 'node', args: ['cmdb.js'] }, allowedAgents: [a.id] });
    const everyone = await hub.add({ name: 'Wiki', catalogId: 'custom', transport: { type: 'stdio', command: 'node', args: ['wiki.js'] } });
    events.length = 0;

    deleteAgent(ctx, a.id);

    expect(hub.get(both.id)!.allowedAgents).toEqual([b.id]);
    expect(hub.get(only.id)!.allowedAgents).toEqual([]);
    expect(hub.get(everyone.id)!.allowedAgents).toBeNull();
    expect(events.filter((e) => e.type === 'connectors.changed')).toHaveLength(1);
  });

  it('refuses unknown, last and busy agents', () => {
    expect(code(() => deleteAgent(ctx, 'nope'))).toBe('404 not_found');
    const only = repos.agents.create({ name: 'Assistant', runtime: 'claude-cli' });
    expect(code(() => deleteAgent(ctx, only.id))).toBe('409 last_agent');

    const other = repos.agents.create({ name: 'Analyst', runtime: 'claude-cli' });
    const t = repos.tickets.create({ title: 'Summarise incidents', goal: 'x', agentId: only.id });
    // A job for its ticket is being executed.
    ctx.queue.enqueue('run.start', { ticketId: t.id });
    const job = ctx.queue.claim('w1')!;
    expect(code(() => deleteAgent(ctx, only.id))).toBe('409 agent_busy');
    ctx.queue.complete(job.id);
    // A run is going.
    const s = repos.sessions.create({ ticketId: t.id, agentId: only.id, runtime: 'claude-cli', model: null, reason: 'new' });
    const run = repos.runs.create({ sessionId: s.id, ticketId: t.id, jobId: null, trigger: 'user' });
    expect(code(() => deleteAgent(ctx, only.id))).toBe('409 agent_busy');
    expect(repos.agents.get(only.id)).toBeDefined();
    expect(repos.tickets.get(t.id)!.agentId).toBe(only.id);
    repos.runs.update(run.id, { status: 'succeeded' });
    expect(deleteAgent(ctx, only.id).reassignedTickets).toBe(1);
    expect(repos.tickets.get(t.id)!.agentId).toBe(other.id);
  });
});
