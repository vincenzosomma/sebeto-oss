import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSIONS, type Agent } from '@sebeto/shared';
import { pickDefaultAgent } from './default-agent.js';

const agent = (name: string, runtime: string, createdAt: string, paused = false): Agent => ({
  id: name, skills: [], name, role: '', job: '', runtime, model: null, reportsTo: null, heartbeatMinutes: 60,
  monthlyBudgetUsd: 20, permissions: { ...DEFAULT_PERMISSIONS }, paused, createdAt,
});

describe('pickDefaultAgent', () => {
  it('prefers the oldest real (non-test) agent', () => {
    const picked = pickDefaultAgent([
      agent('Test agent', 'mock', '2026-01-01T00:00:00Z'),
      agent('Writer', 'claude-cli', '2026-01-03T00:00:00Z'),
      agent('Assistant', 'claude-cli', '2026-01-02T00:00:00Z'),
    ]);
    expect(picked?.name).toBe('Assistant');
  });

  it('skips paused agents when possible', () => {
    const picked = pickDefaultAgent([
      agent('Assistant', 'claude-cli', '2026-01-01T00:00:00Z', true),
      agent('Writer', 'claude-cli', '2026-01-02T00:00:00Z'),
    ]);
    expect(picked?.name).toBe('Writer');
  });

  it('uses the test agent only when it is the only one, and returns undefined when there are none', () => {
    expect(pickDefaultAgent([agent('Test agent', 'mock', '2026-01-01T00:00:00Z')])?.name).toBe('Test agent');
    expect(pickDefaultAgent([])).toBeUndefined();
  });
});
