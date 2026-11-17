/**
 * Integration test for the `delegate` Board MCP tool against real storage (v0.8 agent communication).
 * Proves the delegation wiring that the unit tests in server.test.ts cannot reach with the gate fakes:
 * a child ticket is created, assigned to the named report, and the parent is made to wait for it.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AppContext, Repos } from '../contracts.js';
import { openDatabase } from '../storage/index.js';
import { createPermissionGate } from '../gate/index.js';
import { createStateMachine } from '../state/state-machine.js';
import { createToolServer, type SebetoToolServer } from './index.js';

let dir: string;
let repos: Repos;
let db: { close(): void };
let tools: SebetoToolServer;
let httpServer: http.Server;
let baseUrl = '';
const clients: Client[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-delegate-'));
  ({ repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  const bus = { publish: () => {}, subscribe: () => () => {} } as unknown as AppContext['bus'];
  const queue = { enqueue: () => ({ id: 'job' }) } as unknown as AppContext['queue'];
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const ctx = {
    config: { version: '0.8.0-test', workspaceDir: dir }, log: silent, repos, queue, bus, state, gate,
    snapshots: { init: async () => undefined },
    runtimes: { get: () => undefined, list: () => [] },
  } as unknown as AppContext;
  tools = createToolServer(ctx, { baseUrl: () => baseUrl, allowPrivateFetch: true });
  httpServer = http.createServer((req, res) => { void tools.handleHttp(req, res); });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  httpServer.closeAllConnections();
  await new Promise<void>((r) => httpServer.close(() => r()));
  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
});

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(tools.url()), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  return { text: content.map((c) => c.text).join(''), isError: !!res.isError };
}

/** A token scope bound to a real session + run for the given ticket/agent. */
function tokenFor(ticketId: string, agentId: string): string {
  const s = repos.sessions.create({ ticketId, agentId, runtime: 'mock', model: null, reason: 'new' });
  const r = repos.runs.create({ sessionId: s.id, ticketId, jobId: null, trigger: 'start' });
  return tools.issueToken({ ticketId, sessionId: s.id, runId: r.id, agentId });
}

describe('delegate (integration, real storage)', () => {
  it('creates a child ticket for the named report and makes the parent wait for it', async () => {
    const manager = repos.agents.create({ name: 'Lead', role: 'Lead', permissions: { 'ticket.create': 'allow' } });
    const analyst = repos.agents.create({ name: 'Ann', role: 'Analyst', reportsTo: manager.id });
    const parent = repos.tickets.create({ title: 'Investigate outage', goal: 'Find the cause', agentId: manager.id });

    const client = await connect(tokenFor(parent.id, manager.id));
    const res = await call(client, 'delegate', { title: 'Analyse logs', goal: 'Review the logs and summarise the likely causes', to_role: 'Analyst' });
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/Delegated to Ann/);

    const children = repos.tickets.childrenOf(parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.parentId).toBe(parent.id);
    expect(children[0]!.agentId).toBe(analyst.id);
    expect(children[0]!.title).toBe('Analyse logs');
    // The parent now waits for the child (the scheduler wakes it when the child is done).
    expect(repos.tickets.get(parent.id)!.dependsOn).toContain(children[0]!.id);

    // read_ticket surfaces the delegation to the manager.
    const read = await call(client, 'read_ticket');
    expect(read.text).toContain(`T-${children[0]!.number}`);
    expect(read.text).toContain('Ann');
  });

  it('asks the owner first when ticket.create is "ask", then delegates once allowed', async () => {
    const manager = repos.agents.create({ name: 'Lead', role: 'Lead' }); // ticket.create defaults to 'ask'
    repos.agents.create({ name: 'Ann', role: 'Analyst', reportsTo: manager.id });
    const parent = repos.tickets.create({ title: 'Plan', goal: 'Plan the work', agentId: manager.id });
    const client = await connect(tokenFor(parent.id, manager.id));

    const args = { title: 'Analyse logs', goal: 'Review the logs', to_role: 'Analyst' };
    const first = await call(client, 'delegate', args);
    expect(first.text).toMatch(/Permission requested/);
    expect(repos.tickets.childrenOf(parent.id)).toHaveLength(0);

    const pending = repos.permissions.pendingForTicket(parent.id)[0]!;
    expect(pending.key).toBe('ticket.create');
    gate().decide(pending.id, 'allow');

    const second = await call(client, 'delegate', args);
    expect(second.isError).toBe(false);
    expect(repos.tickets.childrenOf(parent.id)).toHaveLength(1);
  });
});

// The gate instance for decisions in the second test (re-created over the same repos is fine: the
// decision is stored on the request row, not in memory).
function gate() {
  const bus = { publish: () => {}, subscribe: () => () => {} } as unknown as AppContext['bus'];
  const queue = { enqueue: () => ({ id: 'job' }) } as unknown as AppContext['queue'];
  return createPermissionGate({ repos, state: createStateMachine(repos, bus), queue, bus });
}
