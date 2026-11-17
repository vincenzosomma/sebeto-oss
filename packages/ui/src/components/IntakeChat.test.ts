import { describe, expect, it } from 'vitest';
import { acceptedProposals } from './IntakeChat';

const d = (key: string, include: boolean, dependsOn: string[] = []) => ({ key, include, title: key, goal: 'g', agentId: null, costCapUsd: 1, dependsOn });

describe('acceptedProposals', () => {
  it('keeps included proposals and drops dependencies on excluded ones', () => {
    const out = acceptedProposals([d('p1', false), d('p2', true, ['p1']), d('p3', true, ['p2', 'p1'])]);
    expect(out.map((p) => p.key)).toEqual(['p2', 'p3']);
    expect(out[0]!.dependsOn).toEqual([]);
    expect(out[1]!.dependsOn).toEqual(['p2']);
    expect(out[1]).not.toHaveProperty('include');
  });
});
