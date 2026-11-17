import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type Agent, type AgentEvent, type RuntimeAdapter, type Ticket, type TicketRun } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { acceptIntake, buildIntakePrompt, buildIntakeSystemPrompt, intakeTurn, parseIntakeOutput } from './intake.js';

const agent = (id: string, name: string, runtime = 'claude-cli', createdAt = '2026-01-01'): Agent => ({
  id, skills: [], name, role: `${name} role`, job: `${name} job`, runtime, model: null, reportsTo: null, heartbeatMinutes: 0,
  monthlyBudgetUsd: 10, permissions: { ...DEFAULT_PERMISSIONS }, paused: false, createdAt,
});
const AGENTS = [agent('a-sys', 'Sysadmin'), agent('a-test', 'Test agent', 'mock', '2025-01-01')];

describe('parseIntakeOutput', () => {
  it('reads a JSON reply (also inside a ```json fence) and normalises proposals', () => {
    const raw = 'Sure!\n```json\n' + JSON.stringify({
      reply: 'Two tickets.',
      proposals: [
        { key: 'p1', title: 'Check disk space', goal: 'List drives under 15%.', agentId: 'a-sys', costCapUsd: 1, dependsOn: [], why: 'Infra work' },
        { key: 'p2', title: 'Email the report', goal: 'Send it to the team.', agentId: 'ghost', costCapUsd: 0, dependsOn: ['p1', 'p9', 'p2'] },
        { title: '', goal: 'invalid: no title' },
      ],
    }) + '\n```';
    const out = parseIntakeOutput(raw, AGENTS);
    expect(out.reply).toBe('Two tickets.');
    expect(out.proposals).toHaveLength(2);
    expect(out.proposals[0]).toEqual({ key: 'p1', title: 'Check disk space', goal: 'List drives under 15%.', agentId: 'a-sys', costCapUsd: 1, dependsOn: [], why: 'Infra work' });
    // Unknown agent → Automatic; bad cap → default; unknown/self dependencies dropped.
    expect(out.proposals[1]).toMatchObject({ agentId: null, costCapUsd: 2, dependsOn: ['p1'] });
  });

  it('treats plain text as a reply without proposals', () => {
    expect(parseIntakeOutput('Which servers do you mean?', AGENTS)).toEqual({ reply: 'Which servers do you mean?', proposals: [] });
    expect(parseIntakeOutput('', AGENTS).proposals).toEqual([]);
  });

  it('builds prompts with the team (test agent flagged) and the conversation', () => {
    const sys = buildIntakeSystemPrompt(AGENTS, '2026-11-10');
    expect(sys).toContain('id "a-sys": Sysadmin (Sysadmin role)');
    expect(sys).toContain('[free test agent, no AI');
    expect(sys).toContain('Today is 2026-11-10');
    expect(buildIntakePrompt([{ role: 'user', text: 'Need X' }, { role: 'assistant', text: 'Which?' }, { role: 'user', text: 'FS01' }]))
      .toContain('Owner: Need X\n\nChief of Staff: Which?\n\nOwner: FS01');
  });
});

describe('intakeTurn', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-intake-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function ctxWith(events: AgentEvent[], seen: TicketRun[] = []): AppContext {
    const adapter: RuntimeAdapter = {
      id: 'claude-cli', displayName: 'x', capabilities: { tools: true, resume: true, costReport: true },
      detect: async () => ({ installed: true }), models: async () => [],
      async *run(r) { seen.push(r); for (const e of events) yield e; },
    };
    return {
      config: { workspaceDir: dir }, log: { info() {}, warn() {}, error() {}, debug() {} },
      repos: { agents: { list: () => AGENTS } }, runtimes: { get: (id: string) => (id === 'claude-cli' ? adapter : undefined), list: () => [adapter] },
    } as unknown as AppContext;
  }

  it('runs the default real agent runtime with no tools or permissions and returns proposals + cost', async () => {
    const seen: TicketRun[] = [];
    const json = JSON.stringify({ reply: 'One ticket.', proposals: [{ key: 'p1', title: 'Check certs', goal: 'Find certs expiring in 30 days.', agentId: 'a-sys', costCapUsd: 2, dependsOn: [] }] });
    const ctx = ctxWith([{ kind: 'text', text: json }, { kind: 'done', costUsd: 0.004 }], seen);
    const res = await intakeTurn(ctx, { messages: [{ role: 'user', text: 'Check our certificates' }], model: 'haiku' });
    expect(res).toMatchObject({ reply: 'One ticket.', costUsd: 0.004, model: 'haiku' });
    expect(res.proposals[0]!.title).toBe('Check certs');
    const run = seen[0]!;
    expect(run.mcp).toBeUndefined();
    expect(Object.values(run.permissions).every((l) => l === 'never')).toBe(true);
    expect(run.cwd).toBe(path.join(dir, 'intake'));
    expect(run.model).toBe('haiku');
    expect(run.budgetUsd).toBeLessThanOrEqual(0.25);
  });

  it('uses the planning model setting when the runtime offers it, else the agent model', async () => {
    const seen: TicketRun[] = [];
    const ctx = ctxWith([{ kind: 'text', text: '{"reply":"ok","proposals":[]}' }], seen);
    (ctx.runtimes.get('claude-cli') as RuntimeAdapter).models = async () => ['sonnet', 'haiku'];
    (ctx as { settings?: unknown }).settings = { get: () => ({ intakeModel: 'haiku' }), update: () => ({ intakeModel: 'haiku' }) };
    expect((await intakeTurn(ctx, { messages: [{ role: 'user', text: 'x' }] })).model).toBe('haiku');
    (ctx as { settings?: unknown }).settings = { get: () => ({ intakeModel: 'llama3' }), update: () => ({ intakeModel: 'llama3' }) };
    expect((await intakeTurn(ctx, { messages: [{ role: 'user', text: 'x' }] })).model).toBeNull(); // not offered → agent default (null)
    expect(seen.map((r) => r.model)).toEqual(['haiku', null]);
  });

  it('requires the last message to be from the owner', async () => {
    await expect(intakeTurn(ctxWith([]), { messages: [{ role: 'assistant', text: 'hi' }] })).rejects.toThrow(/last message/);
  });

  it('reports a runtime error when there is no text', async () => {
    await expect(intakeTurn(ctxWith([{ kind: 'error', message: 'not logged in' }, { kind: 'done', isError: true }]), { messages: [{ role: 'user', text: 'x' }] }))
      .rejects.toThrow(/not logged in/);
  });
});

describe('acceptIntake', () => {
  it('creates tickets in order and maps dependencies to the new ids', async () => {
    const created: Array<{ title: string; dependsOn?: string[]; start?: boolean; agentId?: string | null }> = [];
    let n = 0;
    const ctx = {
      repos: {
        agents: { list: () => AGENTS, get: (id: string) => AGENTS.find((a) => a.id === id) },
        tickets: {
          create: (i: { title: string; dependsOn: string[] }) => ({ ...i, id: `t${++n}`, number: n, status: 'backlog', folder: '/x' }) as unknown as Ticket,
          get: (id: string) => ({ id, status: 'backlog', dependsOn: [] }),
        },
        audit: { append: (e: object) => ({ id: 'e', ...e }) },
      },
      snapshots: { init: async () => undefined },
      bus: { publish: () => undefined },
      runtimes: { get: () => undefined },
      queue: { enqueue: () => ({ id: 'j' }) },
    } as unknown as AppContext;
    const realCreate = ctx.repos.tickets.create;
    ctx.repos.tickets.create = ((i: Parameters<typeof realCreate>[0]) => { created.push(i); return realCreate(i); }) as typeof realCreate;

    const tickets = await acceptIntake(ctx, {
      proposals: [
        { key: 'p1', title: 'Collect', goal: 'g', agentId: 'a-sys', costCapUsd: 1, dependsOn: [] },
        { key: 'p2', title: 'Report', goal: 'g', agentId: null, costCapUsd: 1, dependsOn: ['p1'] },
      ],
    });
    expect(tickets.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(created[1]!.dependsOn).toEqual(['t1']);
    expect(created[1]!.agentId).toBe('a-sys'); // null = Automatic → default real agent

    await expect(acceptIntake(ctx, { proposals: [{ key: 'p2', title: 'Report', goal: 'g', agentId: null, costCapUsd: 1, dependsOn: ['p1'] }] }))
      .rejects.toThrow(/not created before it/);
    await expect(acceptIntake(ctx, { proposals: [] })).rejects.toThrow(/Nothing to create/);
  });
});
