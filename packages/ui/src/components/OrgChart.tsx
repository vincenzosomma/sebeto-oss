/**
 * Org chart editor (v0.3, docs/17 Agents & Skills.md): the "Hierarchy" of the Agents & skills page as a
 * list or as an org chart, with drag and drop to change reporting lines. Dropping an agent onto another
 * one makes it report to that agent; dropping it onto "You" makes it top level. Drops that would make a
 * loop are refused with a message. Keyboard users change the line with the "Reports to" field.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, useDraggable, useDroppable, useSensor, useSensors,
  type Announcements, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import type { Agent, Id } from '@sebeto/shared';
import { useStore } from '../store/StoreProvider';
import { useI18n } from '../i18n/I18nProvider';
import { errorMessage } from '../lib/format';
import { buildChart, buildTree, checkMove, descendantIds, plural, type ChartNode } from '../lib/agents';
import { AgentTeamChip } from './Teams';

export type HierarchyView = 'list' | 'chart';

const VIEW_KEY = 'sebeto.agents.view';
const YOU = 'oc:you';
const dropId = (id: Id) => `oc:to:${id}`;
/** Drop target id → manager id (null = "You", undefined = not a target). */
const managerOf = (over: unknown): Id | null | undefined => {
  const v = String(over ?? '');
  if (v === YOU) return null;
  return v.startsWith('oc:to:') ? v.slice(6) : undefined;
};

/** The saved List / Org chart choice (per browser; falls back to the list). */
export function useHierarchyView(): [HierarchyView, (v: HierarchyView) => void] {
  const [view, setView] = useState<HierarchyView>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'chart' ? 'chart' : 'list'; } catch { return 'list'; }
  });
  const set = useCallback((v: HierarchyView) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: keep it for this visit */ }
  }, []);
  return [view, set];
}

export function ViewToggle({ view, onChange }: { view: HierarchyView; onChange: (v: HierarchyView) => void }) {
  const { t } = useI18n();
  return (
    <div className="oc-toggle" role="group" aria-label={t('oc.view.label')}>
      {(['list', 'chart'] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={`oc-toggle__btn${view === v ? ' oc-toggle__btn--on' : ''}`}
          aria-pressed={view === v}
          onClick={() => onChange(v)}
        >
          {t(v === 'list' ? 'oc.view.list' : 'oc.view.chart')}
        </button>
      ))}
    </div>
  );
}

/** What every node needs while dragging: who is dragged and where it may not go. */
interface DragState {
  dragId: Id | null;
  /** The dragged agent and everyone below it: dropping there would make a loop. */
  blocked: Set<Id>;
  selectedId: Id | null;
  onSelect: (id: Id) => void;
  runtimeName: (id: string) => string;
}
const DragCtx = createContext<DragState | null>(null);
const useDrag = () => useContext(DragCtx)!;

/** Draggable + droppable agent node; returns props for the element and its drop state class. */
function useAgentDnd(agent: Agent) {
  const { dragId, blocked } = useDrag();
  const drag = useDraggable({ id: agent.id });
  const drop = useDroppable({ id: dropId(agent.id) });
  const { setNodeRef: setDragRef } = drag;
  const { setNodeRef: setDropRef } = drop;
  const ref = useCallback((el: HTMLElement | null) => { setDragRef(el); setDropRef(el); }, [setDragRef, setDropRef]);
  let cls = '';
  if (drag.isDragging) cls = ' oc-dragging';
  else if (dragId && drop.isOver) cls = blocked.has(agent.id) ? ' oc-drop-bad' : ' oc-drop-ok';
  else if (dragId && blocked.has(agent.id)) cls = ' oc-drop-off';
  return { ref, listeners: drag.listeners, attributes: drag.attributes, cls };
}

/** "You" at the top: dropping an agent here makes it top level. */
function YouTarget({ chart }: { chart: boolean }) {
  const { t } = useI18n();
  const { dragId } = useDrag();
  const { setNodeRef, isOver } = useDroppable({ id: YOU });
  const cls = dragId && isOver ? ' oc-drop-ok' : '';
  return (
    <div ref={setNodeRef} className={`${chart ? 'oc-you' : 'ag-you oc-you-row'}${cls}`}>
      <span className={chart ? 'oc-you__avatar' : 'ag-you__avatar'} aria-hidden="true">{t('ag.tree.you').charAt(0)}</span>
      {chart ? (
        <span className="oc-you__text">
          <strong>{t('ag.tree.you')}</strong>
          <span className="small muted">{t('ag.tree.owner')}</span>
        </span>
      ) : (
        <>
          <strong>{t('ag.tree.you')}</strong>
          <span className="small muted">{t('ag.tree.owner')}</span>
        </>
      )}
    </div>
  );
}

/** One row of the list view (same look as before, now draggable). */
function ListNode({ agent, depth }: { agent: Agent; depth: number }) {
  const { t } = useI18n();
  const { selectedId, onSelect, runtimeName } = useDrag();
  const { ref, listeners, attributes, cls } = useAgentDnd(agent);
  const active = agent.id === selectedId;
  return (
    <li style={{ paddingLeft: `${depth * 16}px` }}>
      <button
        ref={ref}
        type="button"
        {...attributes}
        {...listeners}
        className={`ag-node oc-node${active ? ' ag-node--active' : ''}${cls}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => onSelect(agent.id)}
      >
        {depth > 0 && <span className="ag-node__branch" aria-hidden="true">└</span>}
        <span className={`ag-node__dot${agent.paused ? ' ag-node__dot--paused' : ''}`} aria-hidden="true" />
        <span className="ag-node__text">
          <span className="ag-node__name">{agent.name}</span>
          <span className="ag-node__meta">
            {runtimeName(agent.runtime)}{agent.model ? ` · ${agent.model}` : ''}
            {agent.paused ? ` · ${t('ag.tree.paused')}` : ''}
          </span>
          <span className="ag-node__count">{plural(t, agent.skills.length, 'ag.tree.skills1', 'ag.tree.skills')} <AgentTeamChip teamId={agent.teamId} /></span>
        </span>
      </button>
    </li>
  );
}

/** One box of the org chart. */
function ChartBox({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const { t } = useI18n();
  const { selectedId, onSelect, runtimeName } = useDrag();
  const { ref, listeners, attributes, cls } = useAgentDnd(agent);
  const active = agent.id === selectedId;
  return (
    <button
      ref={ref}
      type="button"
      {...attributes}
      {...listeners}
      className={`oc-box${compact ? ' oc-box--compact' : ''}${active ? ' oc-box--active' : ''}${agent.paused ? ' oc-box--paused' : ''}${cls}`}
      aria-current={active ? 'true' : undefined}
      onClick={() => onSelect(agent.id)}
    >
      <span className="oc-box__name">{agent.name}</span>
      {agent.role && <span className="oc-box__role">{agent.role}</span>}
      <span className="oc-box__chips">
        <span className="oc-chip oc-chip--rt" title={runtimeName(agent.runtime)}>{runtimeName(agent.runtime)}</span>
        <span className="oc-chip">{plural(t, agent.skills.length, 'ag.tree.skills1', 'ag.tree.skills')}</span>
        {agent.paused && <span className="oc-chip oc-chip--paused">{t('oc.paused')}</span>}
        <AgentTeamChip teamId={agent.teamId} />
      </span>
    </button>
  );
}

/**
 * A box and its reports. Reports that have no reports of their own are stacked under the box (like the
 * mockup), so wide teams stay narrow; mixed groups spread out side by side with connecting lines.
 */
function ChartBranch({ node }: { node: ChartNode }) {
  const kids = node.children;
  const stacked = kids.length >= 2 && kids.every((k) => k.children.length === 0);
  return (
    <li className="oc-li">
      <ChartBox agent={node.agent} />
      {kids.length > 0 && (stacked ? (
        <ul className="oc-stack">
          {kids.map((k) => <li key={k.agent.id} className="oc-stack__li"><ChartBox agent={k.agent} compact /></li>)}
        </ul>
      ) : (
        <ul className="oc-ul">{kids.map((k) => <ChartBranch key={k.agent.id} node={k} />)}</ul>
      ))}
    </li>
  );
}

function OrgChartView({ agents }: { agents: Agent[] }) {
  const { t } = useI18n();
  const forest = useMemo(() => buildChart(agents), [agents]);
  return (
    // Scrolls sideways when the team is wider than the page; focusable so keyboard users can scroll it.
    <div className="oc-scroll" role="region" aria-label={t('oc.chart.label')} tabIndex={0}>
      <div className="oc-tree">
        <YouTarget chart />
        {forest.length > 0 && (
          <ul className="oc-ul oc-ul--root">{forest.map((n) => <ChartBranch key={n.agent.id} node={n} />)}</ul>
        )}
      </div>
    </div>
  );
}

/**
 * The hierarchy (list or org chart) with drag and drop. Moves call PATCH /agents/:id { reportsTo }.
 */
export function Hierarchy({ view, agents, selectedId, onSelect, runtimeName, empty }: {
  view: HierarchyView;
  agents: Agent[];
  selectedId: Id | null;
  onSelect: (id: Id) => void;
  runtimeName: (id: string) => string;
  /** Shown instead of the agents when there are none. */
  empty: ReactNode;
}) {
  const { api, dispatch } = useStore();
  const { t } = useI18n();
  const [dragId, setDragId] = useState<Id | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  const rows = useMemo(() => buildTree(agents), [agents]);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const blocked = useMemo(() => {
    if (!dragId) return new Set<Id>();
    return new Set([dragId, ...descendantIds(agents, dragId)]);
  }, [agents, dragId]);

  const nameOf = (id: unknown) => byId.get(String(id))?.name ?? '';
  const targetName = (over: unknown) => {
    const m = managerOf(over);
    return m === undefined ? '' : m === null ? t('ag.tree.you') : nameOf(m);
  };

  /** Validate and save a new manager for `id` (null = top level). */
  const move = async (id: Id, managerId: Id | null) => {
    const agent = byId.get(id);
    if (!agent) return;
    const check = checkMove(agents, id, managerId);
    if (!check.ok) {
      if (check.reason === 'loop') setMsg({ ok: false, text: t('oc.loop', { name: agent.name, manager: nameOf(managerId) }) });
      return;
    }
    setMsg({ ok: true, text: t('oc.moving', { name: agent.name }) });
    try {
      const next = await api.updateAgent(id, { reportsTo: managerId });
      dispatch({ type: 'agentUpserted', agent: next });
      setMsg({ ok: true, text: managerId ? t('oc.moved', { name: agent.name, manager: nameOf(managerId) }) : t('oc.movedTop', { name: agent.name }) });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };

  const onDragStart = (e: DragStartEvent) => { setDragId(String(e.active.id)); setMsg(null); };
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const managerId = managerOf(e.over?.id);
    if (managerId !== undefined) void move(String(e.active.id), managerId);
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => nameOf(active.id),
    onDragOver: ({ active, over }) => (over ? t('oc.dragOver', { name: nameOf(active.id), target: targetName(over.id) }) : undefined),
    onDragEnd: () => undefined,
    onDragCancel: ({ active }) => nameOf(active.id),
  };

  const ctx: DragState = { dragId, blocked, selectedId, onSelect, runtimeName };
  const dragged = dragId ? byId.get(dragId) : undefined;

  return (
    <DragCtx.Provider value={ctx}>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragId(null)}
        accessibility={{ announcements, screenReaderInstructions: { draggable: t('oc.dragHelp') } }}
      >
        <div className={`oc-hier oc-hier--${view}`}>
          {view === 'chart' ? (
            agents.length === 0 ? <><YouTarget chart={false} />{empty}</> : <OrgChartView agents={agents} />
          ) : (
            <>
              <YouTarget chart={false} />
              {rows.length === 0 ? empty : (
                <ul className="ag-tree__list">
                  {rows.map(({ agent, depth }) => <ListNode key={agent.id} agent={agent} depth={depth} />)}
                </ul>
              )}
            </>
          )}
          {msg && (
            <p className={`oc-msg${msg.ok ? '' : ' oc-msg--error'}`} role={msg.ok ? 'status' : 'alert'}>
              <span>{msg.text}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMsg(null)}>{t('error.dismiss')}</button>
            </p>
          )}
          {agents.length > 1 && <p className="small muted oc-hint">{t('oc.dragHint')}</p>}
        </div>
        <DragOverlay dropAnimation={null}>
          {dragged ? <div className="oc-ghost">{dragged.name}</div> : null}
        </DragOverlay>
      </DndContext>
    </DragCtx.Provider>
  );
}
