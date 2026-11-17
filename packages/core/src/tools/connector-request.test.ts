/** v0.9: an agent asks the owner to turn on a Claude connector (request_claude_connector), over MCP. */
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
import { createEventBus } from '../bus/index.js';
import { createStateMachine } from '../state/index.js';
import { createJobQueue } from '../queue/index.js';
import { createPermissionGate } from '../gate/index.js';
import { decidePermission } from '../services/tickets.js';
import { claudeConnectorsFor } from '../connectors/claude-access.js';
import { createToolServer, matchClaudeConnector, type SebetoToolServer } from './index.js';

const LIST = [
  { name: 'claude.ai Atlassian – Acme', connected: true },
  { name: 'claude.ai Atlassian MCP', connected: false },
  { name: 'claude.ai Slack', connected: true },
  { name: 'claude.ai Gmail', connected: true },
  { name: 'claude.ai Google Calendar', connected: true },
];

let dir: string;
let repos: Repos;
let ctx: AppContext;
let tools: SebetoToolServer;
let httpServer: http.Server;
let baseUrl = '';
const clients: Client[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-connreq-'));
  let db;
  ({ repos, db } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
  const bus = createEventBus();
  const state = createStateMachine(repos, bus);
  const queue = createJobQueue(db);
  ctx = {
    config: { version: '0.9.0-test', workspaceDir: dir, apiToken: 'x'.repeat(32) }, log: { info() {}, warn() {}, error() {}, debug() {} },
    repos, bus, state, queue, gate: createPermissionGate({ repos, state, queue, bus }),
    securityLog: { record: () => null, lockdown: () => false },
  } as unknown as AppContext;
  tools = createToolServer(ctx, { baseUrl: () => baseUrl, listClaudeConnectors: async () => LIST });
  httpServer = http.createServer((req, res) => { void tools.handleHttp(req, res); });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  httpServer.closeAllConnections();
  await new Promise<void>((r) => httpServer.close(() => r()));
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(runtime = 'claude-cli', slug = 'infra') {
  const team = repos.teams!.create({ slug, name: slug === 'infra' ? 'Infrastructure' : slug, description: '', color: '#0E5A8A', leadAgentId: null, routingHints: '' });
  const agent = repos.agents.create({ name: 'Infrastructure Lead', runtime, teamId: team.id });
  const ticket = repos.tickets.create({ title: 'Record in Jira', goal: 'g', agentId: agent.id });
  fs.mkdirSync(ticket.folder, { recursive: true });
  const session = repos.sessions.create({ ticketId: ticket.id, agentId: agent.id, runtime, model: null, reason: 'new' });
  const run = repos.runs.create({ sessionId: session.id, ticketId: ticket.id, jobId: null, trigger: 'start' });
  const token = tools.issueToken({ ticketId: ticket.id, sessionId: session.id, runId: run.id, agentId: agent.id });
  return { team, agent, ticket, token };
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(tools.url()), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  return { text: (res.content as Array<{ text: string }>).map((c) => c.text).join(''), isError: !!res.isError };
}

describe('matchClaudeConnector', () => {
  it('finds by exact name or a word, maps Jira/Confluence to Atlassian, ignores disconnected ones', () => {
    expect(matchClaudeConnector(LIST, 'claude.ai slack')).toEqual({ found: 'claude.ai Slack' });
    expect(matchClaudeConnector(LIST, 'Jira')).toEqual({ found: 'claude.ai Atlassian – Acme' });
    expect(matchClaudeConnector(LIST, 'calendar')).toEqual({ found: 'claude.ai Google Calendar' });
    expect(matchClaudeConnector(LIST, 'claude.ai')).toMatchObject({ candidates: expect.arrayContaining(['claude.ai Slack', 'claude.ai Gmail']) });
    expect(matchClaudeConnector(LIST, 'Notion')).toMatchObject({ candidates: expect.arrayContaining(['claude.ai Slack']) });
  });
});

describe('request_claude_connector', () => {
  it('asks the owner; "allow" turns it on for the agent and resumes it', async () => {
    const { agent, ticket, token } = setup();
    const client = await connect(token);
    const r = await call(client, 'request_claude_connector', { connector: 'Jira', reason: 'Create the HELP ticket and resolve it' });
    expect(r.text).toContain('Asked the owner to turn on "claude.ai Atlassian – Acme"');
    const [req] = repos.permissions.pendingForTicket(ticket.id);
    expect(req!.connector).toEqual({ name: 'claude.ai Atlassian – Acme', teamId: agent.teamId, teamName: 'Infrastructure' });
    expect(req!.detail).toContain('Create the HELP ticket');
    expect(repos.tickets.get(ticket.id)!.status).toBe('needs_you');
    // Asking again while pending reuses the request.
    await call(client, 'request_claude_connector', { connector: 'claude.ai Atlassian – Acme', reason: 'again please' });
    expect(repos.permissions.listForTicket(ticket.id)).toHaveLength(1);

    expect(() => decidePermission(ctx, req!.id, 'task')).toThrow();
    decidePermission(ctx, req!.id, 'allow');
    expect(repos.agents.get(agent.id)!.claudeConnectors).toEqual(['claude.ai Atlassian – Acme']);
    expect(repos.permissions.get(req!.id)!.state).toBe('allowed');
    expect(repos.teams!.get(agent.teamId!)!.claudeConnectors).toEqual([]);
  });

  it('"team" turns it on for every member of the team', async () => {
    const { agent, team, ticket, token } = setup();
    const client = await connect(token);
    await call(client, 'request_claude_connector', { connector: 'slack', reason: 'Post the update in the thread' });
    const [req] = repos.permissions.pendingForTicket(ticket.id);
    decidePermission(ctx, req!.id, 'team');
    expect(repos.teams!.get(team.id)!.claudeConnectors).toEqual(['claude.ai Slack']);
    expect(repos.agents.get(agent.id)!.claudeConnectors).toEqual([]);
    expect(claudeConnectorsFor(repos.agents.get(agent.id), undefined, repos.teams!.get(team.id))).toEqual(['claude.ai Slack']);
  });

  it('deny keeps it off; an already-on connector needs no request; local agents do not get the tool', async () => {
    const { agent, ticket, token } = setup();
    const client = await connect(token);
    await call(client, 'request_claude_connector', { connector: 'Gmail', reason: 'Read the reply from the supplier' });
    const [req] = repos.permissions.pendingForTicket(ticket.id);
    decidePermission(ctx, req!.id, 'deny');
    expect(repos.agents.get(agent.id)!.claudeConnectors).toEqual([]);

    repos.agents.update(agent.id, { claudeConnectors: ['claude.ai Slack'] });
    expect((await call(client, 'request_claude_connector', { connector: 'Slack', reason: 'Need Slack please' })).text).toContain('already turned on');

    const local = setup('ollama', 'red-team');
    const names = (await (await connect(local.token)).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('request_claude_connector');
  });
});
