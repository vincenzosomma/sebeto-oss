import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7, type ConnectorInfo, type RuntimeAdapter } from '@sebeto/shared';
import type { AppContext, Repos } from '../contracts.js';
import { MIGRATIONS, openDatabase } from '../storage/index.js';
import { createSettingsStore } from '../settings.js';
import { buildDiagnostics, diagnosticsFileName } from './diagnostics.js';

// Values that must never reach the report.
const API_TOKEN = 'api-token-7f3c9a1e5b2d8f4a6c0e9b7d';
const MCP_TOKEN = 'mcp-scope-token-Zx9Kq2Lm7Np4Rs8Tv1Wy';
const REFRESH_TOKEN = '1//0gRefReshT0kenAbCdEfGhIjKlMnOpQrStUv';
const APP_PASSWORD = 'abcd efgh ijkl mnop';
const CLIENT_ID = '0c8b7a6d-1111-2222-3333-client-id-xyz';
const CLIENT_SECRET = 'GOCSPX-ClientSecretValue123';
const ENV_SECRET = 'xoxb-1234567890-SlackBotTokenValue';
const TICKET_TITLE = 'Renew the VPN certificate for the Posillipo office';
const TICKET_GOAL = 'Ask Mario before the switch on Friday';
const MESSAGE = 'Here is the private message body about payroll';
const USER = 'mario.rossi';
const HOME = `C:\\Users\\${USER}`;

let dir: string;
let repos: Repos;

beforeEach(() => {
  dir = path.join(os.tmpdir(), `sebeto-diag-${uuidv7()}`);
  fs.mkdirSync(dir, { recursive: true });
  ({ repos } = openDatabase({ file: path.join(dir, 'sebeto.db'), workspaceDir: dir }));
});
afterEach(() => {
  repos.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function adapter(id: string, installed: boolean): RuntimeAdapter {
  return {
    id, displayName: id === 'claude-cli' ? 'Claude Code' : 'Test agent', capabilities: { tools: true, resume: true, costReport: true },
    detect: async () => (installed ? { installed, version: '2.0.1', loggedIn: true } : { installed, problem: `Not found in ${HOME}\\AppData\\npm` }),
    models: async () => ['haiku', 'sonnet'],
    // eslint-disable-next-line require-yield
    run: async function* () { return; },
  };
}

function makeCtx(): AppContext {
  const workspaceDir = `${HOME}\\.sebeto\\workspace`;
  const connector: ConnectorInfo = {
    id: uuidv7(), name: 'Jira (Mario)', catalogId: 'custom',
    transport: { type: 'stdio', command: `${HOME}\\tools\\jira-mcp.exe`, args: ['--token', MCP_TOKEN] },
    settings: [{ name: 'SLACK_TOKEN', secret: true, value: ENV_SECRET }, { name: 'JIRA_USER', secret: false, value: 'mario.rossi@contoso.it' }],
    enabled: true, allowedAgents: null, status: 'error',
    error: `spawn ${HOME}\\tools\\jira-mcp.exe failed: Authorization: Bearer ${MCP_TOKEN}`,
    tools: [
      { name: 'search', description: 'd', level: 'read', reviewed: true, suggested: 'read', inputSchema: {}, fingerprint: 'f1' },
      { name: 'create', description: 'd', level: 'change', reviewed: false, suggested: 'change', inputSchema: {}, fingerprint: 'f2' },
      { name: 'list', description: 'd', level: 'read', reviewed: true, suggested: 'read', inputSchema: {}, fingerprint: 'f3' },
    ],
    createdAt: new Date().toISOString(),
  };
  const http: ConnectorInfo = {
    ...connector, id: uuidv7(), catalogId: 'github', transport: { type: 'http', url: `https://mcp.contoso.com:8443/v1/sse?api_key=${MCP_TOKEN}` },
    settings: [], status: 'connected', error: null, tools: [],
  };
  const settings = createSettingsStore(dir);
  return {
    config: { workspaceDir, host: '127.0.0.1', port: 0, apiToken: API_TOKEN, maxParallelRuns: 3, runtimes: ['mock', 'claude-cli'], version: '0.2.0' },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    repos,
    queue: {} as AppContext['queue'],
    bus: { publish: () => undefined, subscribe: () => () => undefined },
    state: {} as AppContext['state'],
    gate: {} as AppContext['gate'],
    snapshots: {} as AppContext['snapshots'],
    runtimes: { get: () => undefined, list: () => [adapter('mock', true), adapter('claude-cli', false)] },
    settings,
    mail: {
      status: () => ({ connected: true, provider: 'gmail', address: 'mario.rossi@gmail.com', connectedAt: new Date().toISOString(), servers: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 }, calendar: true }),
      connect: async () => { throw new Error('not used'); },
      disconnect: async () => ({ provider: null, revokedAtProvider: false }),
      open: async () => null,
      openCalendar: async () => null,
      completeSignIn: async () => ({ connected: false }),
    },
    oauth: {
      apps: async () => [
        { provider: 'microsoft', source: 'custom', clientId: CLIENT_ID, tenant: 'contoso.onmicrosoft.com', hasSecret: false },
        { provider: 'google', source: 'builtin', clientId: CLIENT_SECRET, tenant: null, hasSecret: true },
      ],
    } as unknown as AppContext['oauth'],
    connectors: { list: () => [connector, http] } as unknown as AppContext['connectors'],
  };
}

function seed(ctx: AppContext): void {
  const t = repos.tickets.create({ title: TICKET_TITLE, goal: TICKET_GOAL });
  repos.tickets.create({ title: 'Second', goal: '' });
  const session = repos.sessions.create({ ticketId: t.id, agentId: null, runtime: 'mock', model: null, reason: 'new' });
  repos.messages.create({ ticketId: t.id, role: 'user', author: 'you', text: MESSAGE });
  const ok = repos.runs.create({ sessionId: session.id, ticketId: t.id, jobId: null, trigger: 'start' });
  repos.runs.update(ok.id, { status: 'succeeded', endedAt: new Date().toISOString() });
  const failed = repos.runs.create({ sessionId: session.id, ticketId: t.id, jobId: null, trigger: 'user' });
  repos.runs.update(failed.id, { status: 'failed', endedAt: new Date().toISOString(), exitReason: `IMAP login failed for mario.rossi@gmail.com with password=${APP_PASSWORD.replace(/ /g, '')}` });
  repos.audit.append({ ticketId: t.id, kind: 'error', summary: `Could not refresh: refresh_token=${REFRESH_TOKEN} (${HOME}\\.sebeto\\workspace\\secrets\\google.json)` });
  repos.audit.append({ ticketId: t.id, kind: 'error', summary: `fetch https://8.8.8.8/private/path?token=${API_TOKEN} failed` });
  repos.audit.append({ ticketId: t.id, kind: 'info', summary: `Ticket created: ${TICKET_TITLE}` });
  void ctx;
}

describe('diagnostics report', () => {
  it('has versions, counts, runtimes, settings and connectors without details', async () => {
    const ctx = makeCtx();
    seed(ctx);
    const report = await buildDiagnostics(ctx, { redaction: { homeDir: HOME, userName: USER } });

    expect(report.format).toBe('sebeto-diagnostics/1');
    expect(report.app).toMatchObject({ version: '0.2.0', node: process.versions.node, platform: process.platform, arch: process.arch, maxParallelRuns: 3, enabledRuntimes: ['mock', 'claude-cli'] });
    expect(report.app.workspace).toBe('<home>\\.sebeto\\workspace');
    expect(report.app.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(report.storage).toMatchObject({
      schemaVersion: MIGRATIONS.length, ticketsByStatus: { backlog: 2 }, agents: 0, skills: null,
      runsLast7Days: { succeeded: 1, failed: 1 }, jobsByState: {},
    });
    expect(report.storage.dbBytes).toBeGreaterThan(0);
    expect(report.runtimes).toEqual([
      { id: 'mock', displayName: 'Test agent', installed: true, version: '2.0.1', loggedIn: true, problem: null, models: 2 },
      { id: 'claude-cli', displayName: 'Claude Code', installed: false, version: null, loggedIn: null, problem: 'Not found in <home>\\AppData\\npm', models: 0 },
    ]);
    expect(report.settings).toEqual({ intakeModel: 'haiku', setupCompleted: true });
    expect(report.connectors.mail).toEqual({ connected: true, provider: 'gmail', address: 'm***@gmail.com', calendar: true });
    expect(report.connectors.oauthApps).toEqual([{ provider: 'microsoft', source: 'custom' }, { provider: 'google', source: 'builtin' }]);
    expect(report.connectors.custom).toEqual([
      { catalogId: 'custom', transport: 'stdio', host: null, enabled: true, status: 'error', error: 'spawn <home>\\tools\\jira-mcp.exe failed: Authorization: <secret>', toolsByLevel: { read: 2, change: 1 }, unreviewedTools: 1 },
      { catalogId: 'github', transport: 'http', host: 'mcp.contoso.com:8443', enabled: true, status: 'connected', error: null, toolsByLevel: {}, unreviewedTools: 0 },
    ]);
    expect(report.recentProblems.errors.map((e) => e.ticket)).toEqual(['T-1', 'T-1']);
    expect(report.recentProblems.errors[0]!.summary).toBe('fetch https://<ip> failed');
    expect(report.recentProblems.errors[1]!.summary).toBe('Could not refresh: refresh_token=<secret> (<secret>\\google.json)');
    expect(report.recentProblems.failedRuns).toEqual([
      { ticket: 'T-1', at: expect.any(String), trigger: 'user', exitReason: 'IMAP login failed for m***@gmail.com with password=<secret>' },
    ]);
  });

  it('never contains tokens, passwords, client ids/secrets, home folders, e-mail addresses or ticket text', async () => {
    const ctx = makeCtx();
    seed(ctx);
    const json = JSON.stringify(await buildDiagnostics(ctx, { redaction: { homeDir: HOME, userName: USER } }));
    for (const forbidden of [
      API_TOKEN, MCP_TOKEN, REFRESH_TOKEN, APP_PASSWORD, APP_PASSWORD.replace(/ /g, ''), CLIENT_ID, CLIENT_SECRET, ENV_SECRET,
      'contoso.onmicrosoft.com', 'SLACK_TOKEN', 'JIRA_USER', 'jira-mcp.exe --token', '--token', '/v1/sse', 'api_key',
      TICKET_TITLE, TICKET_GOAL, MESSAGE, 'Jira (Mario)', 'mario.rossi', 'mario', HOME, 'C:\\\\Users', '8.8.8.8', 'imap.gmail.com', 'workspace\\\\secrets', 'workspace/secrets',
    ]) expect(json, forbidden).not.toContain(forbidden);
  });

  it('works without optional parts (no stats, mail, oauth, connectors, skills)', async () => {
    const ctx = makeCtx();
    const bare: AppContext = { ...ctx, repos: { ...repos, stats: undefined }, mail: undefined, oauth: undefined, connectors: undefined, settings: undefined };
    const report = await buildDiagnostics(bare, { redaction: { homeDir: HOME, userName: USER } });
    expect(report.storage).toEqual({ schemaVersion: null, dbBytes: null, ticketsByStatus: {}, agents: 0, skills: null, runsLast7Days: {}, jobsByState: {} });
    expect(report.connectors).toEqual({ mail: { connected: false }, oauthApps: [], custom: [] });
    expect(report.recentProblems).toEqual({ errors: [], failedRuns: [] });
  });

  it('names the download file by date', () => {
    expect(diagnosticsFileName(new Date('2026-11-11T10:00:00Z'))).toBe('sebeto-diagnostics-2026-11-11.json');
  });
});
