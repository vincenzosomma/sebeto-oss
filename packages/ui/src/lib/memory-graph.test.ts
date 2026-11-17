import { describe, expect, it } from 'vitest';
import type { MemoryGraphNode } from '@sebeto/shared';
import { bounds, createSimulation, nodeRadius, settle, wikiToLinks } from './memory-graph';
import { MockMemory } from '../api/mock-memory';

const node = (id: string, degree = 1): MemoryGraphNode => ({ id, title: id, kind: 'system', untrusted: false, status: 'approved', teamSlug: null, degree });

describe('memory graph layout', () => {
  it('settles, keeps linked nodes closer than unlinked ones, and is deterministic', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id));
    const edges = [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }];
    const s1 = createSimulation(nodes, edges);
    expect(settle(s1, 2000)).toBeGreaterThan(0);
    expect(s1.running()).toBe(false);
    const d = (x: string, y: string) => Math.hypot(s1.byId.get(x)!.x - s1.byId.get(y)!.x, s1.byId.get(x)!.y - s1.byId.get(y)!.y);
    expect(d('a', 'b')).toBeLessThan(d('a', 'c'));
    const s2 = createSimulation(nodes, edges);
    settle(s2, 2000);
    expect(s2.byId.get('a')!.x).toBeCloseTo(s1.byId.get('a')!.x, 6);
    for (const n of s1.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
    const b = bounds(s1.nodes);
    expect(b.w).toBeGreaterThan(0);
  });

  it('handles a few hundred nodes quickly and keeps earlier positions', () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node(`n${i}`, i % 7));
    const edges = nodes.slice(1).map((n, i) => ({ from: n.id, to: `n${Math.floor(i / 3)}` }));
    const t0 = Date.now();
    const s = createSimulation(nodes, edges);
    settle(s, 150);
    expect(Date.now() - t0).toBeLessThan(5000);
    const prev = new Map(s.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const again = createSimulation(nodes, edges, prev);
    expect(again.byId.get('n5')!.x).toBe(prev.get('n5')!.x);
    expect(again.alpha).toBeLessThan(1);
    expect(nodeRadius(0)).toBe(4);
    expect(nodeRadius(100)).toBe(14);
  });

  it('turns wikilinks into internal links', () => {
    expect(wikiToLinks('See [[FS01]] and [[VPN gateway|the gateway]] or [[Note#Part]].')).toBe(
      'See [FS01](#memory:FS01) and [the gateway](#memory:VPN%20gateway) or [Note](#memory:Note).',
    );
  });
});

describe('mock memory', () => {
  it('has a demo graph with missing targets, untrusted notes and a hidden proposal', () => {
    let changes = 0;
    const m = new MockMemory(() => { changes++; });
    const g = m.graph();
    expect(g.nodes.some((n) => n.kind === 'missing')).toBe(true);
    expect(g.nodes.some((n) => n.untrusted)).toBe(true);
    expect(g.nodes.some((n) => n.status === 'proposed')).toBe(false);
    expect(m.graph({ proposed: true }).nodes.some((n) => n.status === 'proposed')).toBe(true);
    const fs01 = m.list({ q: 'fs01', kind: 'system', status: 'approved' })[0]!;
    expect(m.get(fs01.id).backlinks.length).toBeGreaterThan(0);
    const centred = m.graph({ center: fs01.id, depth: 1 });
    expect(centred.nodes.length).toBeLessThan(g.nodes.length);
    const proposal = m.list({ status: 'proposed' })[0]!;
    expect(m.approve(proposal.id).status).toBe('approved');
    m.remove(proposal.id);
    expect(changes).toBe(2);
  });
});
