/**
 * A small force-directed layout for the Memory map (v0.4 §E), no dependencies: every pair of
 * nodes pushes apart, every link pulls its ends together, a weak pull keeps everything near the
 * centre. Positions start on a deterministic spiral (same graph = same picture). Pure and
 * synchronous so it can be tested; the component calls tick() once per animation frame.
 */
import type { MemoryGraphEdge, MemoryGraphNode } from '@sebeto/shared';

export interface SimNode { id: string; x: number; y: number; vx: number; vy: number; fixed: boolean; r: number }

export interface Simulation {
  nodes: SimNode[];
  byId: Map<string, SimNode>;
  /** Cooling: 1 when started, the simulation stops below ALPHA_MIN. */
  alpha: number;
  tick(): void;
  /** Wake the simulation up again (after a drag). */
  reheat(alpha?: number): void;
  running(): boolean;
}

export const ALPHA_MIN = 0.02;
const REPULSION = 900;
const SPRING = 0.04;
const LINK_LENGTH = 70;
const GRAVITY = 0.012;
const DAMPING = 0.82;
const MAX_SPEED = 30;

/** Radius by number of links (4 … 14). */
export function nodeRadius(degree: number): number {
  return Math.min(14, 4 + Math.sqrt(Math.max(0, degree)) * 2.6);
}

export function createSimulation(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], previous?: Map<string, { x: number; y: number }>): Simulation {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const sorted = [...nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id));
  const sim: SimNode[] = sorted.map((n, i) => {
    const old = previous?.get(n.id);
    const rad = 18 * Math.sqrt(i + 0.5);
    return { id: n.id, x: old?.x ?? Math.cos(i * golden) * rad, y: old?.y ?? Math.sin(i * golden) * rad, vx: 0, vy: 0, fixed: false, r: nodeRadius(n.degree) };
  });
  const byId = new Map(sim.map((n) => [n.id, n]));
  const degree = new Map<string, number>();
  for (const e of edges) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1); }
  const links = edges.map((e) => [byId.get(e.from), byId.get(e.to)] as const).filter((l): l is readonly [SimNode, SimNode] => !!l[0] && !!l[1]);
  const state: Simulation = {
    nodes: sim,
    byId,
    alpha: previous && sim.every((n) => previous.has(n.id)) ? 0.3 : 1,
    tick() {
      if (state.alpha < ALPHA_MIN) return;
      const a = state.alpha;
      const n = sim.length;
      for (let i = 0; i < n; i++) {
        const p = sim[i]!;
        for (let j = i + 1; j < n; j++) {
          const q = sim[j]!;
          let dx = p.x - q.x;
          let dy = p.y - q.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = (i - j) * 0.1 || 0.1; dy = 0.1; d2 = dx * dx + dy * dy; }
          if (d2 > 250_000) continue; // far apart: ignore (keeps big graphs fast)
          const f = (REPULSION * a) / d2;
          const fx = dx * f;
          const fy = dy * f;
          p.vx += fx; p.vy += fy;
          q.vx -= fx; q.vy -= fy;
        }
      }
      for (const [s, t] of links) {
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - LINK_LENGTH) * SPRING * a) / d;
        s.vx += dx * f; s.vy += dy * f;
        t.vx -= dx * f; t.vy -= dy * f;
      }
      for (const p of sim) {
        if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
        // Notes without links drift outwards; pull them back a little harder.
        const g = (degree.get(p.id) ? GRAVITY : GRAVITY * 4) * a;
        p.vx = (p.vx - p.x * g) * DAMPING;
        p.vy = (p.vy - p.y * g) * DAMPING;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > MAX_SPEED) { p.vx *= MAX_SPEED / sp; p.vy *= MAX_SPEED / sp; }
        p.x += p.vx;
        p.y += p.vy;
      }
      state.alpha *= 0.985;
    },
    reheat(alpha = 0.3) { state.alpha = Math.max(state.alpha, alpha); },
    running: () => state.alpha >= ALPHA_MIN,
  };
  return state;
}

/** Run the simulation to rest (or maxTicks). */
export function settle(sim: Simulation, maxTicks = 400): number {
  let i = 0;
  while (sim.running() && i < maxTicks) { sim.tick(); i++; }
  return i;
}

/** Bounding box of the nodes, padded. */
export function bounds(nodes: SimNode[], pad = 30): { x: number; y: number; w: number; h: number } {
  if (!nodes.length) return { x: -100, y: -100, w: 200, h: 200 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r); minY = Math.min(minY, n.y - n.r);
    maxX = Math.max(maxX, n.x + n.r); maxY = Math.max(maxY, n.y + n.r);
  }
  return { x: minX - pad, y: minY - pad, w: Math.max(80, maxX - minX + pad * 2), h: Math.max(80, maxY - minY + pad * 2) };
}

/** Turn [[Name]] / [[Name|label]] into Markdown links the viewer can catch (#memory:<name>). */
export function wikiToLinks(body: string): string {
  return body.replace(/\[\[([^\]\n|#]{1,200})(?:#[^\]\n|]*)?(?:\|([^\]\n]{1,200}))?\]\]/g, (_m, target: string, label?: string) =>
    `[${(label ?? target).trim().replace(/[[\]]/g, '')}](#memory:${encodeURIComponent(target.trim())})`);
}
