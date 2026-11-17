#!/usr/bin/env node
/**
 * sebeto-core entry point. The same process runs in Docker (`node dist/main.js`) and inside the
 * Electron shell (utilityProcess). On success it prints exactly one stdout line:
 *   SEBETO_READY {"port":7600,"token":"...","url":"http://127.0.0.1:7600/"}
 * and, under Electron, posts {type:'ready',port,token} to the parent.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import type { AppContext } from './contracts.js';
import { openDatabase } from './storage/index.js';
import { createJobQueue } from './queue/index.js';
import { createEventBus } from './bus/index.js';
import { createStateMachine } from './state/index.js';
import { createPermissionGate } from './gate/index.js';
import { createSnapshots } from './snapshots/index.js';
import { createRuntimeRegistry, createMockAdapter, createClaudeCliAdapter, createCodexCliAdapter, createOllamaAdapter, ollamaPivotModel } from './runtimes/index.js';
import { createToolServer } from './tools/index.js';
import { createExecutor } from './executor/index.js';
import { createScheduler } from './scheduler/index.js';
import { createServer } from './api/index.js';
import { seedDefaults, startSessionLibrary } from './services/index.js';
import { OPENAI_RUNTIME_FAMILY } from '@sebeto/shared';
import { builtinApps, createAiConnectionStore, createMailConnector, createMcpHub, createOAuthManager, createSecretStore, createGoogleClients, createGraphClients } from './connectors/index.js';
import { fileURLToPath } from 'node:url';
import { createSettingsStore } from './settings.js';
import { WorkspaceLockedError, acquireWorkspaceLock } from './workspace-lock.js';
import { createSkillStore } from './skills/index.js';
import { createTriggerEngine } from './triggers/index.js';
import { startSlackNotify } from './triggers/slack-notify.js';
import { applyHandoff } from './services/handoff.js';
import { createSecurityLog, instrumentContext } from './security/index.js';
import { startMemory } from './memory/index.js';
import { createBackupService } from './backup/index.js';

/** Electron utilityProcess exposes process.parentPort (not in @types/node). */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, process.argv.slice(2));
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`sebeto-core: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const log = createLogger();
  log.info({ workspace: config.workspaceDir, host: config.host, port: config.port, version: config.version }, 'starting sebeto-core');

  mkdirSync(config.workspaceDir, { recursive: true });
  // One core per workspace (the desktop app and `npm start` share ~/.sebeto/workspace).
  let releaseLock: () => void;
  try {
    releaseLock = acquireWorkspaceLock(config.workspaceDir);
  } catch (err) {
    if (err instanceof WorkspaceLockedError) {
      process.stderr.write(`sebeto-core: ${err.message}\n`);
      parentPort?.postMessage({ type: 'error', message: err.message });
      process.exit(3);
    }
    throw err;
  }
  process.on('exit', () => releaseLock());
  const { repos, db } = openDatabase({ file: join(config.workspaceDir, 'sebeto.db'), workspaceDir: config.workspaceDir });
  const queue = createJobQueue(db);
  const bus = createEventBus({ onError: (err, event) => log.error({ err: { message: (err as Error)?.message }, type: event.type }, 'event listener failed') });
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const snapshots = createSnapshots();
  const enabled = new Set(config.runtimes);
  const secrets = createSecretStore(config.workspaceDir);
  // v0.7 R: each OpenAI-compatible AI connection is a runtime `openai:<id>` (enabled by 'openai').
  const aiConnections = enabled.has(OPENAI_RUNTIME_FAMILY) ? createAiConnectionStore({ workspaceDir: config.workspaceDir, secrets }) : undefined;
  const runtimes = createRuntimeRegistry(
    [createMockAdapter(), createClaudeCliAdapter(), createCodexCliAdapter(), createOllamaAdapter()].filter((a) => enabled.has(a.id)),
    aiConnections ? () => aiConnections.adapters() : undefined,
  );
  if (enabled.has('ollama')) log.info({ pivotAdvisor: ollamaPivotModel() ?? null }, 'ollama stuck-pivot advisor');

  // Sign in with Microsoft / Google: the redirect needs the real port, known after listen().
  let listenPort = config.port;
  const oauth = createOAuthManager({
    workspaceDir: config.workspaceDir, secrets, port: () => listenPort,
    builtin: builtinApps(process.env, fileURLToPath(new URL('../oauth-apps.json', import.meta.url))),
  });
  const mail = createMailConnector({
    workspaceDir: config.workspaceDir, secrets, oauth,
    providers: { microsoft: createGraphClients, google: createGoogleClients },
  });
  const ctx: AppContext = { config, log, repos, queue, bus, state, gate, snapshots, runtimes, mail, oauth, secrets, settings: createSettingsStore(config.workspaceDir), aiConnections };
  ctx.triggers = createTriggerEngine(ctx);
  ctx.handoffs = { apply: (ticketId) => applyHandoff(ctx, ticketId) };
  ctx.skills = createSkillStore(config.workspaceDir, (slug) => repos.agents.list().filter((a) => a.skills.includes(slug)).map((a) => a.id));
  ctx.skills.seedIfEmpty();
  ctx.connectors = createMcpHub({ workspaceDir: config.workspaceDir, secrets, onChange: () => bus.publish({ type: 'connectors.changed' }) });
  // v0.4 security log: created before anything runs, then the repos and stores are decorated in place.
  ctx.securityLog = createSecurityLog({ db, workspaceDir: config.workspaceDir, bus, log, repos });
  instrumentContext(ctx);
  // Slack DMs to the owner + buttons (after the connectors and the security log exist).
  startSlackNotify(ctx);
  // v0.7 Q: backups (settings in <workspace>/backup.json; the daily automatic one runs from the scheduler).
  ctx.backups = createBackupService({
    db, workspaceDir: config.workspaceDir, appVersion: config.version, secrets, securityLog: ctx.securityLog, log,
    ticketFolders: () => db.prepare<[], { folder: string }>('SELECT folder FROM tickets').all().map((r) => r.folder),
  });

  // Agents run on this machine, so they reach MCP over loopback unless bound to one specific address.
  let baseUrl = '';
  ctx.tools = createToolServer(ctx, { baseUrl: () => baseUrl });
  const executor = createExecutor(ctx);
  const scheduler = createScheduler(ctx);
  ctx.executor = executor;
  ctx.scheduler = scheduler;

  const orphans = repos.runs.failOrphans('Sebeto stopped while this run was in progress');
  const stale = queue.recoverStale();
  if (orphans || stale) log.warn({ orphans, stale }, 'recovered from an unclean shutdown');
  await seedDefaults(ctx);
  // Session library (v0.4 §A): file existing ticket sessions once, then follow ticket changes.
  startSessionLibrary(ctx);
  // Memory graph (v0.4 §E): index <workspace>/memory, then write notes for completed tickets.
  const stopMemory = await startMemory(ctx).catch((err: unknown) => {
    log.warn({ err: { message: (err as Error).message } }, 'memory: could not start');
    return () => undefined;
  });

  const server = await createServer(ctx);
  await server.listen({ host: config.host, port: config.port });
  const port = (server.server.address() as AddressInfo).port;
  listenPort = port;
  const wildcard = config.host === '0.0.0.0' || config.host === '::';
  const loopbackish = wildcard || ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  baseUrl = `http://${loopbackish ? '127.0.0.1' : urlHost(config.host)}:${port}`;

  executor.start();
  scheduler.start();

  const url = `http://${urlHost(config.host)}:${port}/`;
  process.stdout.write(`SEBETO_READY ${JSON.stringify({ port, token: config.apiToken, url })}\n`);
  parentPort?.postMessage({ type: 'ready', port, token: config.apiToken });
  log.info({ port, url }, 'sebeto-core ready');
  ctx.securityLog.record({
    category: 'system', action: 'system.core_started', severity: 'notice',
    summary: `Sebeto ${config.version} started on ${urlHost(config.host)}:${port}.`,
    data: { version: config.version, host: config.host, port, runtimes: config.runtimes, lockdown: ctx.securityLog.lockdown() },
  });
  if (ctx.securityLog.lockdown()) log.warn('emergency stop (lockdown) is still active: no agent will start until it is released');

  let stopping = false;
  const shutdown = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ reason }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      scheduler.stop();
      stopMemory();
      await executor.stop();
      await server.close();
      await ctx.connectors?.closeAll();
      ctx.securityLog?.record({ category: 'system', action: 'system.core_stopped', severity: 'notice', summary: `Sebeto stopped (${reason}).`, data: { reason } });
      repos.close();
    } catch (err) {
      log.error({ err: { message: (err as Error).message } }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  parentPort?.on('message', (e) => {
    const data = e.data as { type?: string } | undefined;
    if (data?.type === 'shutdown') void shutdown('parent');
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`sebeto-core failed to start: ${(err as Error)?.stack ?? String(err)}\n`);
  parentPort?.postMessage({ type: 'error', message: (err as Error)?.message ?? String(err) });
  process.exit(1);
});
