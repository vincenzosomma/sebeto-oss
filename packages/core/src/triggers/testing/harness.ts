/** Test harness for triggers: a real in-memory SQLite workspace with fakes for snapshots and the security log. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WsEvent } from '@sebeto/shared';
import type { AppContext, Job, NewSecurityEvent } from '../../contracts.js';
import { openDatabase } from '../../storage/index.js';
import { createJobQueue } from '../../queue/index.js';
import { createEventBus } from '../../bus/index.js';
import { createStateMachine } from '../../state/index.js';
import { createPermissionGate } from '../../gate/index.js';
import { createRuntimeRegistry, createMockAdapter } from '../../runtimes/index.js';
import { createSecretStore, plainFileProtector } from '../../connectors/secrets.js';

export const TEST_TOKEN = 'test-session-token-0123456789';

export interface Harness {
  ctx: AppContext;
  dir: string;
  events: WsEvent[];
  security: NewSecurityEvent[];
  jobs: () => Job[];
  setLockdown(on: boolean): void;
  close(): void;
}

export function createHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-triggers-'));
  const { repos, db } = openDatabase({ file: ':memory:', workspaceDir: dir });
  const queue = createJobQueue(db);
  const bus = createEventBus();
  const events: WsEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const state = createStateMachine(repos, bus);
  const gate = createPermissionGate({ repos, state, queue, bus });
  const security: NewSecurityEvent[] = [];
  let locked = false;
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const ctx: AppContext = {
    config: { workspaceDir: dir, host: '127.0.0.1', port: 0, apiToken: TEST_TOKEN, maxParallelRuns: 1, runtimes: ['mock'], version: 'test' },
    log: silent, repos, queue, bus, state, gate,
    snapshots: { init: async () => {}, commit: async () => 'oid', restore: async () => 'oid', diff: async () => [] },
    runtimes: createRuntimeRegistry([createMockAdapter()]),
    secrets: createSecretStore(dir, plainFileProtector()),
    securityLog: { record: (e) => { security.push(e); return null; }, lockdown: () => locked },
  };
  return {
    ctx, dir, events, security,
    jobs: () => db.prepare('SELECT * FROM jobs').all() as Job[],
    setLockdown: (on) => { locked = on; },
    close: () => {
      repos.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
