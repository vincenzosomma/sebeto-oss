/**
 * Scheduler: cheap, code-side heartbeats (docs/15 #8, docs/10 "Wake-ups").
 * The model is called ONLY when there is work. Every interval:
 *
 *  1. Heartbeats: for each non-paused agent whose heartbeat is due (heartbeatMinutes > 0),
 *     look at its `in_progress` tickets with no active run. Enqueue `run.heartbeat`
 *     (priority 30, dedupeKey per ticket) only when, since the ticket's latest run started:
 *       - a dependency moved to `done`, or
 *       - a pending item exists: a user or handoff message the agent has not seen yet.
 *     (Answered permission requests are NOT counted: the gate enqueues `run.permission` itself.)
 *
 *  2. Deferred starts: enqueue `run.start` (priority 10) for `backlog` tickets whose
 *     `dependsOn` are all `done` AND that were explicitly started. Assumption (v0.1, no schema
 *     field for it): "explicitly started" = the ticket has an audit event of kind 'info' with
 *     `data.startWhenReady === true`, written by `requestStartWhenReady()` when the user presses
 *     Start on a ticket whose dependencies are not done yet. Tickets that already ran are skipped.
 *
 *  3. Housekeeping: at most once per hour, delete finished (done/failed) jobs older than the
 *     retention period (`queue.prune()`, 14 days by default). One cheap DELETE, no model call.
 *
 *  4. v0.7 Q: the daily automatic backup (`ctx.backups.tick()`), when due; never during an emergency stop.
 */
import type { Agent, Id, Ticket, TicketStatus } from '@sebeto/shared';
import type { AppContext, Scheduler } from '../contracts.js';

export interface SchedulerOptions {
  /** Tick interval in ms (default 60 s). */
  intervalMs?: number;
  /** Clock (ms), injectable for tests. */
  now?: () => number;
}

export interface SchedulerHandle extends Scheduler {
  /** Run one scheduling pass now; returns what was enqueued. */
  tick(): { heartbeats: Id[]; starts: Id[] };
}

export const HEARTBEAT_PRIORITY = 30;
export const START_PRIORITY = 10;
/** How often the scheduler prunes old finished jobs. */
export const PRUNE_INTERVAL_MS = 60 * 60_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;

/**
 * Mark a backlog ticket to start automatically once all its dependencies are done
 * (called by the API when the user presses Start on a ticket that has to wait).
 */
export function requestStartWhenReady(ctx: AppContext, ticketId: Id): void {
  const event = ctx.repos.audit.append({ ticketId, kind: 'info', summary: 'Will start automatically when the tickets it depends on are completed.', data: { startWhenReady: true } });
  ctx.bus.publish({ type: 'event.created', event });
}

export function createScheduler(ctx: AppContext, opts: SchedulerOptions = {}): SchedulerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const { repos, log } = ctx;
  const lastBeat = new Map<Id, number>();
  let lastPrune = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setInterval> | null = null;

  function listByStatus(status: TicketStatus): Ticket[] {
    const out: Ticket[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = repos.tickets.list({ status, cursor, limit: PAGE_LIMIT });
      out.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /** ISO time the latest run started ('' when the ticket never ran), and whether it is still running. */
  function lastRun(ticketId: Id): { since: string; active: boolean; any: boolean } {
    const run = repos.runs.listForTicket(ticketId, 1)[0];
    return { since: run?.startedAt ?? '', active: run?.status === 'running' || run?.status === 'queued', any: Boolean(run) };
  }

  function hasWork(ticket: Ticket, since: string): boolean {
    // A dependency finished after the agent last worked on this ticket.
    for (const depId of ticket.dependsOn) {
      const dep = repos.tickets.get(depId);
      if (dep?.status !== 'done') continue;
      if (repos.transitions.listForTicket(depId).some((t) => t.to === 'done' && t.createdAt > since)) return true;
    }
    // An unseen user / handoff message (e.g. sent while a run was busy).
    const msgs = repos.messages.listForTicket(ticket.id, { limit: PAGE_LIMIT }).items;
    return msgs.some((m) => (m.role === 'user' || m.role === 'handoff') && m.createdAt > since);
  }

  function heartbeats(agents: Agent[], t: number): Id[] {
    const due = agents.filter((a) => !a.paused && a.heartbeatMinutes > 0 && t - (lastBeat.get(a.id) ?? Number.NEGATIVE_INFINITY) >= a.heartbeatMinutes * 60_000);
    if (!due.length) return [];
    for (const a of due) lastBeat.set(a.id, t);
    const dueIds = new Set(due.map((a) => a.id));
    const enqueued: Id[] = [];
    for (const ticket of listByStatus('in_progress')) {
      if (!ticket.agentId || !dueIds.has(ticket.agentId)) continue;
      const run = lastRun(ticket.id);
      if (run.active) continue;
      if (!hasWork(ticket, run.since)) continue; // no work → no model call
      ctx.queue.enqueue('run.heartbeat', { ticketId: ticket.id }, { priority: HEARTBEAT_PRIORITY, dedupeKey: `heartbeat:${ticket.id}` });
      enqueued.push(ticket.id);
    }
    return enqueued;
  }

  function deferredStarts(agentsById: Map<Id, Agent>): Id[] {
    const enqueued: Id[] = [];
    for (const ticket of listByStatus('backlog')) {
      if (!ticket.dependsOn.length) continue;
      if (ticket.agentId && agentsById.get(ticket.agentId)?.paused) continue;
      if (!ticket.dependsOn.every((id) => repos.tickets.get(id)?.status === 'done')) continue;
      if (lastRun(ticket.id).any) continue;
      const requested = repos.audit.listForTicket(ticket.id, { limit: PAGE_LIMIT }).items.some((e) => e.kind === 'info' && e.data?.['startWhenReady'] === true);
      if (!requested) continue;
      ctx.queue.enqueue('run.start', { ticketId: ticket.id }, { priority: START_PRIORITY, dedupeKey: `start:${ticket.id}` });
      enqueued.push(ticket.id);
    }
    return enqueued;
  }

  function pruneJobs(t: number): void {
    if (t - lastPrune < PRUNE_INTERVAL_MS) return;
    lastPrune = t;
    try {
      const removed = ctx.queue.prune();
      if (removed) log.debug({ removed }, 'pruned old finished jobs');
      // v0.4 security log retention (deletes only the oldest events; records how many).
      (ctx.securityLog as { prune?: (nowMs?: number) => number } | undefined)?.prune?.(t);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'job prune failed');
    }
  }

  function tick(): { heartbeats: Id[]; starts: Id[] } {
    pruneJobs(now());
    // v0.4 §D: due schedules and mail rules (cheap; mail polls run in the background, never overlapping).
    try {
      ctx.triggers?.tick(new Date(now()));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'trigger tick failed');
    }
    // v0.7 Q: the daily automatic backup (runs in the background; skipped during the emergency stop).
    try {
      void ctx.backups?.tick(new Date(now()));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'backup tick failed');
    }
    // v0.5 I: no check-ins and no deferred starts during the emergency stop (the executor would
    // refuse them anyway; skipping here keeps the tickets free of repeated refusal notes).
    if (ctx.securityLog?.lockdown()) return { heartbeats: [], starts: [] };
    try {
      const agents = repos.agents.list();
      const result = { heartbeats: heartbeats(agents, now()), starts: deferredStarts(new Map(agents.map((a) => [a.id, a]))) };
      if (result.heartbeats.length || result.starts.length) log.debug(result, 'scheduler enqueued work');
      return result;
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'scheduler tick failed');
      return { heartbeats: [], starts: [] };
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
