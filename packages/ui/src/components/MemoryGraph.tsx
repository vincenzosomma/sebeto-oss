/**
 * The Memory map (v0.4 §E): an Obsidian-like graph drawn in SVG with a small force simulation
 * (lib/memory-graph.ts). Pan by dragging the background, zoom with the wheel / pinch / buttons,
 * drag a dot to move it, click (or Enter on) a dot to open the note. Missing link targets are
 * hollow, untrusted notes have a warning ring, proposals are dashed.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MemoryGraph as Graph, MemoryGraphNode } from '@sebeto/shared';
import { useI18n } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/catalog';
import { bounds, createSimulation, type Simulation } from '../lib/memory-graph';

interface View { x: number; y: number; k: number }

export function MemoryGraph({ graph, selectedId, onOpen }: { graph: Graph; selectedId: string | null; onOpen: (node: MemoryGraphNode) => void }) {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation | null>(null);
  const [, setFrame] = useState(0);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 800, h: 520 });
  const sizeRef = useRef(size);
  const [hover, setHover] = useState<string | null>(null);
  const fitted = useRef(false);
  const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  // New data: keep the positions of nodes we already placed.
  useEffect(() => {
    const prev = simRef.current ? new Map(simRef.current.nodes.map((n) => [n.id, { x: n.x, y: n.y }])) : undefined;
    simRef.current = createSimulation(graph.nodes, graph.edges, prev);
    fitted.current = false;
    let raf = 0;
    let ticks = 0;
    const loop = () => {
      const sim = simRef.current;
      if (!sim) return;
      for (let i = 0; i < 3; i++) sim.tick();
      ticks++;
      if (!fitted.current && (!sim.running() || ticks > 40)) { fit(); fitted.current = !sim.running() || ticks > 120; }
      setFrame((f) => f + 1);
      if (sim.running()) raf = requestAnimationFrame(loop);
      else fit();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const next = { w: Math.max(200, e.contentRect.width), h: Math.max(200, e.contentRect.height) };
      const old = sizeRef.current;
      sizeRef.current = next;
      setSize(next);
      // A new size (phone rotation, window resize): show the whole map again.
      if (Math.abs(old.w - next.w) > 1 || Math.abs(old.h - next.h) > 1) fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function fit() {
    const sim = simRef.current;
    if (!sim) return;
    const b = bounds(sim.nodes);
    const { w, h } = sizeRef.current;
    const k = Math.min(2.5, Math.max(0.15, Math.min(w / b.w, h / b.h)));
    setView({ k, x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k });
  }

  // ---- pointer handling: one pointer = pan or drag a node; two pointers = pinch zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; startX: number; startY: number; moved: boolean; view: View } | null>(null);
  const pinch = useRef<{ dist: number; view: View; cx: number; cy: number } | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (p: { x: number; y: number }) => ({ x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k });

  const zoomAt = (factor: number, at: { x: number; y: number }, base: View = view) => {
    const k = Math.min(4, Math.max(0.1, base.k * factor));
    setView({ k, x: at.x - ((at.x - base.x) / base.k) * k, y: at.y - ((at.y - base.y) / base.k) * k });
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, view, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      drag.current = null;
      return;
    }
    const id = (e.target as Element).closest?.('[data-node]')?.getAttribute('data-node') ?? undefined;
    drag.current = { kind: id ? 'node' : 'pan', ...(id ? { id } : {}), startX: p.x, startY: p.y, moved: false, view };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [{ x: number; y: number }, { x: number; y: number }];
      zoomAt(Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.dist, { x: pinch.current.cx, y: pinch.current.cy }, pinch.current.view);
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (Math.hypot(p.x - d.startX, p.y - d.startY) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.kind === 'pan') {
      setView({ ...d.view, x: d.view.x + p.x - d.startX, y: d.view.y + p.y - d.startY });
    } else if (d.id && simRef.current) {
      const n = simRef.current.byId.get(d.id);
      if (!n) return;
      const w = toWorld(p);
      n.x = w.x; n.y = w.y; n.fixed = true;
      simRef.current.reheat(0.1);
      setFrame((f) => f + 1);
      kick();
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'node' && d.id) {
      const n = simRef.current?.byId.get(d.id);
      if (n) n.fixed = false;
      if (!d.moved) {
        const node = nodesById.get(d.id);
        if (node) onOpen(node);
      }
    }
  };

  const kickRaf = useRef(0);
  const kick = () => {
    if (kickRaf.current) return;
    const loop = () => {
      const sim = simRef.current;
      if (!sim || !sim.running()) { kickRaf.current = 0; return; }
      sim.tick();
      setFrame((f) => f + 1);
      kickRaf.current = requestAnimationFrame(loop);
    };
    kickRaf.current = requestAnimationFrame(loop);
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const sim = simRef.current;
  const showAllLabels = graph.nodes.length <= 40 || view.k >= 1.3;
  const neighbours = useMemo(() => {
    const focus = hover ?? selectedId;
    if (!focus) return null;
    const s = new Set([focus]);
    for (const e of graph.edges) { if (e.from === focus) s.add(e.to); if (e.to === focus) s.add(e.from); }
    return s;
  }, [graph, hover, selectedId]);

  return (
    <div className="mg">
      <svg
        ref={svgRef}
        className="mg__svg"
        role="group"
        aria-label={t('mem.graph.aria')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {sim && graph.edges.map((e) => {
            const a = sim.byId.get(e.from);
            const b = sim.byId.get(e.to);
            if (!a || !b) return null;
            const dim = neighbours && !(neighbours.has(e.from) && neighbours.has(e.to));
            return <line key={`${e.from}>${e.to}`} className={`mg__edge${dim ? ' mg__edge--dim' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {sim && graph.nodes.map((n) => {
            const p = sim.byId.get(n.id);
            if (!p) return null;
            const dim = neighbours && !neighbours.has(n.id);
            const label = showAllLabels || n.degree >= 3 || n.id === hover || n.id === selectedId;
            return (
              <g
                key={n.id}
                data-node={n.id}
                className={`mg__node mg__node--${n.kind}${n.status === 'proposed' ? ' mg__node--proposed' : ''}${n.id === selectedId ? ' mg__node--selected' : ''}${dim ? ' mg__node--dim' : ''}`}
                transform={`translate(${p.x},${p.y})`}
                tabIndex={0}
                role="button"
                aria-label={`${n.title} (${t(`mem.kind.${n.kind}` as MessageKey)})${n.untrusted ? `, ${t('mem.badge.untrusted')}` : ''}`}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(n); } }}
              >
                {n.untrusted && <circle className="mg__ring" r={p.r + 3.5} />}
                <circle className="mg__dot" r={p.r} />
                {label && <text className="mg__label" y={p.r + 11} fontSize={Math.max(8, Math.min(14, 11 / Math.sqrt(view.k)))}>{n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title}</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="mg__zoom">
        <button type="button" className="icon-btn" aria-label={t('mem.zoomIn')} onClick={() => zoomAt(1.3, { x: size.w / 2, y: size.h / 2 })}>+</button>
        <button type="button" className="icon-btn" aria-label={t('mem.zoomOut')} onClick={() => zoomAt(1 / 1.3, { x: size.w / 2, y: size.h / 2 })}>−</button>
        <button type="button" className="icon-btn mg__fit" aria-label={t('mem.zoomReset')} title={t('mem.zoomReset')} onClick={fit}>⤢</button>
      </div>
    </div>
  );
}
