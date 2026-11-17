import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type Agent, type RuntimeInfo } from '@sebeto/shared';
import { initialChoice, pickDefaultAgent, runtimeStatus, setupForced, sortRuntimes } from './setup';

const agent = (name: string, runtime: string, createdAt: string, patch: Partial<Agent> = {}): Agent => ({
  id: name, name, role: '', job: '', runtime, model: null, reportsTo: null, heartbeatMinutes: 15, monthlyBudgetUsd: 20,
  permissions: { ...DEFAULT_PERMISSIONS }, paused: false, skills: [], createdAt, ...patch,
});
const rt = (id: string, installed: boolean, extra: Partial<RuntimeInfo['detection']> = {}, models: string[] = []): RuntimeInfo => ({
  id, displayName: id, detection: { installed, ...extra }, models,
});

describe('setup wizard helpers', () => {
  it('maps detection to Ready / Needs sign-in / Not installed', () => {
    expect(runtimeStatus(rt('claude-cli', true, { loggedIn: true }))).toBe('ready');
    expect(runtimeStatus(rt('ollama', true))).toBe('ready');
    expect(runtimeStatus(rt('claude-cli', true, { loggedIn: false }))).toBe('signin');
    expect(runtimeStatus(rt('ollama', false, { problem: 'Not found' }))).toBe('missing');
  });

  it('picks the default agent like the core: oldest active real agent, the test agent only as a last resort', () => {
    const a = agent('Test', 'mock', '2026-01-01');
    const b = agent('Paused', 'claude-cli', '2026-01-02', { paused: true });
    const c = agent('Analyst', 'claude-cli', '2026-01-03');
    const d = agent('Later', 'ollama', '2026-01-04');
    expect(pickDefaultAgent([d, c, b, a])?.name).toBe('Analyst');
    expect(pickDefaultAgent([b, a])?.name).toBe('Paused');
    expect(pickDefaultAgent([a])?.name).toBe('Test');
    expect(pickDefaultAgent([])).toBeUndefined();
  });

  it('sorts ready real runtimes first and the test agent last', () => {
    const list = [rt('mock', true), rt('ollama', false), rt('claude-cli', true, { loggedIn: false }), rt('codex', true)];
    expect(sortRuntimes(list).map((r) => r.id)).toEqual(['codex', 'claude-cli', 'ollama', 'mock']);
  });

  it('proposes a ready real runtime, keeping the agent model only when offered', () => {
    const claude = rt('claude-cli', true, { loggedIn: true }, ['sonnet', 'haiku']);
    const ollama = rt('ollama', true, {}, ['qwen3']);
    const mock = rt('mock', true, {}, ['mock']);
    // The seeded test agent moves to the first ready real runtime.
    expect(initialChoice(agent('A', 'mock', 'x'), [mock, claude])).toEqual({ runtime: 'claude-cli', model: null });
    // An agent already on a ready runtime keeps it, and its model if offered.
    expect(initialChoice(agent('A', 'ollama', 'x', { model: 'qwen3' }), [claude, ollama])).toEqual({ runtime: 'ollama', model: 'qwen3' });
    expect(initialChoice(agent('A', 'claude-cli', 'x', { model: 'gone' }), [claude])).toEqual({ runtime: 'claude-cli', model: null });
    // Nothing real is ready: stay on the test agent.
    expect(initialChoice(agent('A', 'mock', 'x'), [mock, rt('claude-cli', false)])).toEqual({ runtime: 'mock', model: null });
    // Nothing ready at all: show what the agent has.
    expect(initialChoice(agent('A', 'claude-cli', 'x', { model: 'opus' }), [rt('claude-cli', false)])).toEqual({ runtime: 'claude-cli', model: 'opus' });
    expect(initialChoice(undefined, [])).toBeNull();
  });

  it('reads ?setup=1', () => {
    expect(setupForced('http://127.0.0.1:5198/?mock=1&setup=1')).toBe(true);
    expect(setupForced('http://127.0.0.1:5198/?mock=1')).toBe(false);
    expect(setupForced('not a url')).toBe(false);
  });
});
