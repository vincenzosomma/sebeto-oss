/**
 * Executor: claims jobs from the queue and executes agent runs (docs/15 #6, #9).
 *
 *  - At most `config.maxParallelRuns` runs at once, and at most ONE active run per ticket.
 *  - The core decides the final status through the state machine (cause 'rule'); agent
 *    `status` events are only proposals.
 *  - The loop never crashes: every job is wrapped, failures are audited and retried with
 *    exponential backoff when transient.
 */
import { DEFAULT_PERMISSIONS, nowIso, uuidv7 } from '@sebeto/shared';
import type { Agent, AgentEvent, Id, PermissionRequest, Run, RunStatus, RunTrigger, RuntimeId, Session, SessionReason, Ticket, TicketStatus } from '@sebeto/shared';
import type { AppContext, Executor, Job, JobKind } from '../contracts.js';
import { SCOPE_REQUIRED_NOTE, lockViolation, scopeRequiredBy } from '../services/team-policy.js';
import { DEFAULT_AGENT_NAME, buildPrompt, buildSystemPrompt } from './prompts.js';
import { buildCompactionBrief, listTicketFiles, needsCompaction } from './compaction.js';
import { pickDefaultAgent } from '../default-agent.js';
import { claudeConnectorsFor } from '../connectors/claude-access.js';

export interface ExecutorOptions {
  workerId?: string;
  /** How often the loop polls the queue (ms). Default 500. */
  pollMs?: number;
  /** Max attempts for transient failures (default 3). */
  maxAttempts?: number;
  /** Base backoff for retries (ms). Default 5000 → 5 s, 10 s, 20 s… */
  backoffMs?: number;
}

/** Executor plus helpers used by tests and by graceful shutdown. */
export interface ExecutorHandle extends Executor {
  /** Claim and start as many jobs as capacity allows; returns how many runs were started. */
  tick(): number;
  /** Resolve when no run is active (does not claim new jobs by itself). */
  idle(): Promise<void>;
}

export const BUSY_RETRY_MS = 2000;

const TRIGGER_BY_KIND: Record<JobKind, RunTrigger> = {
  'run.start': 'start',
  'run.reply': 'user',
  'run.heartbeat': 'heartbeat',
  'run.message': 'message',
  'run.permission': 'permission',
};

/** Errors worth retrying: I/O hiccups, busy DB, spawn races. Everything else fails at once. */
export function isTransientError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(code)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(timeout|timed out|temporar|busy|locked|ECONNRESET)\b/i.test(msg);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

/** What happened during the run, used to decide the final status. */
interface RunOutcome {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  isError: boolean;
  errors: string[];
  question: string | null;
  proposal: Extract<AgentEvent, { kind: 'status' }> | null;
}

export function createExecutor(ctx: AppContext, opts: ExecutorOptions = {}): ExecutorHandle {
  const workerId = opts.workerId ?? `executor-${uuidv7().slice(-12)}`;
  const pollMs = opts.pollMs ?? 500;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffMs = opts.backoffMs ?? 5000;
  const { repos, bus, log } = ctx;
  const active = new Map<Id, ActiveRun>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  // ---------------------------------------------------------------- small helpers
  const publishTicket = (ticketId: Id): void => {
    const t = repos.tickets.get(ticketId);
    if (t) bus.publish({ type: 'ticket.updated', ticket: t });
  };
  const publishRun = (run: Run): void => bus.publish({ type: 'run.updated', run });
  const audit = (ticketId: Id, runId: Id | null, kind: Parameters<typeof repos.audit.append>[0]['kind'], summary: string, data?: Record<string, unknown> | null): void => {
    try {
      const event = repos.audit.append({ ticketId, runId, kind, summary, data: data ?? null });
      bus.publish({ type: 'event.created', event });
    } catch (err) {
      log.error({ err: errMessage(err), ticketId }, 'audit append failed');
    }
  };
  const message = (ticketId: Id, runId: Id, author: string, text: string): void => {
    const m = repos.messages.create({ ticketId, runId, role: 'agent', author, text });
    bus.publish({ type: 'message.created', message: m });
  };
  /** Status changes go through the state machine; an invalid transition is logged, not fatal. */
  const transition = (ticketId: Id, to: TicketStatus, runId: Id | null, note: string): void => {
    try {
      ctx.state.transition(ticketId, to, 'rule', { runId, note });
    } catch (err) {
      log.warn({ err: errMessage(err), ticketId, to }, 'status transition refused');
    }
  };

  // ---------------------------------------------------------------- session
  function ensureSession(ticket: Ticket, agent: Agent | null, runtime: string, model: string | null): Session {
    let reason: SessionReason = 'new';
    if (ticket.currentSessionId) {
      const current = repos.sessions.get(ticket.currentSessionId);
      if (current && !current.endedAt && current.runtime === runtime) return current;
      // Same runtime but the session was closed after filling its context window.
      if (current && current.endedAt && current.runtime === runtime) reason = 'compaction';
      if (current && current.runtime !== runtime) {
        reason = 'runtime_change';
        if (!current.endedAt) repos.sessions.end(current.id);
      }
    }
    const session = repos.sessions.create({ ticketId: ticket.id, agentId: agent?.id ?? null, runtime, model, reason });
    repos.tickets.update(ticket.id, { currentSessionId: session.id });
    publishTicket(ticket.id);
    return session;
  }

  // ---------------------------------------------------------------- v0.4 team policies
  /** True when the run must not happen (the refusal is recorded and the job completed). */
  function refusedByTeamPolicy(job: Job, ticket: Ticket, agent: Agent, runtimeId: RuntimeId): boolean {
    const locked = lockViolation(ctx, ticket, runtimeId, agent.id);
    if (locked) {
      const want = ctx.runtimes.get(locked.runtime!)?.displayName ?? locked.runtime!;
      const got = ctx.runtimes.get(runtimeId)?.displayName ?? runtimeId;
      const why = ticket.runtime && ticket.runtime !== locked.runtime ? 'this ticket asks for another AI' : `${agent.name} is set to ${got}`;
      audit(ticket.id, null, 'error',
        `Sebeto did not start the agent: the AI of the team "${locked.name}" is locked to ${want}, but ${why}. ` +
        `Set ${agent.name} (and the ticket) back to ${want}, or turn the lock off in Teams, then start again.`,
        { teamId: locked.id, lockedRuntime: locked.runtime, runtime: runtimeId, agentId: agent.id, job: job.kind });
      transition(ticket.id, 'blocked', null, `Team AI locked to ${want}`);
      ctx.securityLog?.record({
        category: 'system', action: 'team.runtime_lock_refused', severity: 'critical', ticketId: ticket.id, agentId: agent.id,
        summary: `Run refused on T-${ticket.number}: the team "${locked.name}" is locked to ${want}, the run would have used ${got}`,
        data: { teamId: locked.id, lockedRuntime: locked.runtime, runtime: runtimeId, ticketRuntime: ticket.runtime ?? null, agentRuntime: agent.runtime, job: job.kind },
      });
      ctx.queue.complete(job.id);
      return true;
    }
    if (!ticket.scope) {
      const needs = scopeRequiredBy(ctx, ticket, agent.id);
      if (needs) {
        audit(ticket.id, null, 'info', `${SCOPE_REQUIRED_NOTE}.`, { teamId: needs.id, scopeRequired: true, job: job.kind });
        transition(ticket.id, 'needs_you', null, 'Waiting for a written scope');
        ctx.securityLog?.record({
          category: 'ticket', action: 'ticket.scope_missing_refused', severity: 'warning', ticketId: ticket.id, agentId: agent.id,
          summary: `Run refused on T-${ticket.number}: the team "${needs.name}" needs a written scope first`,
          data: { teamId: needs.id, job: job.kind },
        });
        ctx.queue.complete(job.id);
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- one job
  async function execute(job: Job, controller: AbortController): Promise<void> {
    const ticketId = job.payload.ticketId;
    let run: Run | undefined;
    let mcpToken: string | undefined;
    try {
      const ticket = repos.tickets.get(ticketId);
      if (!ticket || ticket.deletedAt) {
        log.warn({ jobId: job.id, ticketId }, ticket ? 'job for a deleted ticket dropped' : 'job for unknown ticket dropped');
        ctx.queue.complete(job.id);
        return;
      }
      let agent = ticket.agentId ? repos.agents.get(ticket.agentId) ?? null : null;
      if (!agent) {
        // Never run silently on the fake agent: assign the default real agent, or block with a clear reason.
        const fallback = pickDefaultAgent(repos.agents.list());
        if (!fallback) {
          audit(ticketId, null, 'error', 'This ticket has no agent and there are no agents yet. Create an agent, assign it, then start again.');
          transition(ticketId, 'blocked', null, 'No agent assigned');
          ctx.queue.complete(job.id);
          return;
        }
        repos.tickets.update(ticketId, { agentId: fallback.id });
        audit(ticketId, null, 'info', `No agent was assigned, so ${fallback.name} took this ticket.`);
        agent = fallback;
      }
      const agentName = agent?.name ?? DEFAULT_AGENT_NAME;
      const runtimeId = ticket.runtime ?? agent.runtime;
      const model = ticket.model ?? agent?.model ?? null;

      // v0.4 F/G: team policies, re-checked before EVERY run (start, reply, heartbeat, trigger,
      // schedule, permission resume), from the database as it is now, so nothing changed behind the
      // API's back can bypass them.
      if (refusedByTeamPolicy(job, ticket, agent, runtimeId)) return;

      const adapter = ctx.runtimes.get(runtimeId);
      if (!adapter) {
        audit(ticketId, null, 'error', `The runtime "${runtimeId}" is not available, so the agent could not start.`);
        transition(ticketId, 'blocked', null, `Runtime ${runtimeId} not available`);
        ctx.queue.complete(job.id);
        return;
      }

      // Budget preflight: ticket cap and agent monthly budget are hard stops, unless the owner set
      // budgets to warn only (setting budgetBlocks: false): then the run has no cost limit and the
      // ticket gets a warning each time it runs over.
      const ticketRemaining = ticket.costCapUsd - ticket.costUsd;
      const agentRemaining = agent ? agent.monthlyBudgetUsd - repos.agents.monthSpendUsd(agent.id) : Number.POSITIVE_INFINITY;
      const budgetBlocks = ctx.settings?.get().budgetBlocks !== false;
      const remaining = Math.min(ticketRemaining, agentRemaining);
      const budgetUsd = budgetBlocks ? remaining : Number.POSITIVE_INFINITY;
      if (!budgetBlocks && remaining <= 0) {
        const which = ticketRemaining <= 0 ? `this ticket's cost cap ($${ticket.costCapUsd.toFixed(2)})` : `${agentName}'s monthly budget`;
        audit(ticketId, null, 'cost', `Over budget: ${which} is used up. The agent keeps working because budgets are set to warn only.`, { ticketRemaining, agentRemaining: Number.isFinite(agentRemaining) ? agentRemaining : null, warnOnly: true });
      }
      if (budgetUsd <= 0) {
        const which = ticketRemaining <= 0 ? `this ticket's cost cap ($${ticket.costCapUsd.toFixed(2)})` : `${agentName}'s monthly budget`;
        audit(ticketId, null, 'cost', `Budget reached: ${which} is used up. Raise it to continue.`, { ticketRemaining, agentRemaining: Number.isFinite(agentRemaining) ? agentRemaining : null });
        transition(ticketId, 'blocked', null, 'Budget reached');
        ctx.queue.complete(job.id);
        return;
      }

      const session = ensureSession(ticket, agent, runtimeId, model);
      run = repos.runs.create({ sessionId: session.id, ticketId, jobId: job.id, trigger: TRIGGER_BY_KIND[job.kind] });
      publishRun(run);
      transition(ticketId, 'in_progress', run.id, 'Agent is working');

      await ctx.snapshots.init(ticket.folder);
      const snapshotBefore = await ctx.snapshots.commit(ticket.folder, `Before run ${run.id}`);
      run = repos.runs.update(run.id, { snapshotBefore });

      let mcp: { url: string; token: string } | undefined;
      if (ctx.tools) {
        mcpToken = ctx.tools.issueToken({ ticketId, sessionId: session.id, runId: run.id, agentId: agent?.id ?? null });
        mcp = { url: ctx.tools.url(), token: mcpToken };
      }

      let permission: PermissionRequest | undefined;
      if (job.kind === 'run.permission' && job.payload.permissionRequestId) permission = repos.permissions.get(job.payload.permissionRequestId);

      const outcome: RunOutcome = { tokensIn: 0, tokensOut: 0, costUsd: 0, isError: false, errors: [], question: null, proposal: null };
      let contextTokens = 0;
      let prompt = buildPrompt(job, ticket, permission);
      // First run of a compacted session: start from Sebeto's brief of the ticket so far.
      if (session.reason === 'compaction' && !session.externalSessionId) {
        const brief = buildCompactionBrief({
          ticket,
          messages: repos.messages.listForTicket(ticketId, { limit: 50 }).items,
          events: repos.audit.listForTicket(ticketId, { limit: 80 }).items,
          files: listTicketFiles(ticket.folder),
          pending: repos.permissions.pendingForTicket(ticketId),
        });
        prompt = `${brief}\n\n---\n\n${prompt}`;
      }
      const runId = run.id;
      // The owner's Claude connectors this agent may use: its own ticks plus the all-agents list.
      const claudeConn = claudeConnectorsFor(agent, ctx.settings?.get(), agent?.teamId ? repos.teams?.get(agent.teamId) : null);
      const events = adapter.run({
        ticketId,
        runId,
        externalSessionId: session.externalSessionId ?? undefined,
        newExternalSessionId: session.externalSessionId ? undefined : globalThis.crypto.randomUUID(),
        cwd: ticket.folder,
        model,
        systemPrompt: buildSystemPrompt(agent ? { ...agent, claudeConnectors: claudeConn } : agent, ticket, (agent?.skills ?? []).map((slug) => ctx.skills?.get(slug)).filter((s): s is NonNullable<typeof s> => !!s), ticket.projectId ? repos.projects?.get(ticket.projectId) ?? null : null),
        prompt,
        permissions: agent?.permissions ?? DEFAULT_PERMISSIONS,
        budgetUsd,
        mcp,
        ...(claudeConn.length ? { claudeConnectors: claudeConn } : {}),
        signal: controller.signal,
      });

      for await (const ev of events) {
        switch (ev.kind) {
          case 'session':
            if (ev.externalSessionId && ev.externalSessionId !== session.externalSessionId) {
              repos.sessions.setExternalId(session.id, ev.externalSessionId);
              session.externalSessionId = ev.externalSessionId;
            }
            break;
          case 'text':
            message(ticketId, runId, agentName, ev.text);
            break;
          case 'tool':
            audit(ticketId, runId, 'tool', ev.summary, { tool: ev.name });
            break;
          case 'ask':
            message(ticketId, runId, agentName, ev.question);
            outcome.question = ev.question;
            break;
          case 'status':
            outcome.proposal = ev;
            audit(ticketId, runId, 'info', `${agentName} proposed the status "${ev.status}"${ev.note ? `: ${ev.note}` : ''}.`, { proposal: ev.status, note: ev.note ?? null });
            break;
          case 'error':
            outcome.errors.push(ev.message);
            audit(ticketId, runId, 'error', ev.message);
            break;
          case 'usage':
            // Usage reports are totals for the run so far: take the latest, don't sum.
            outcome.tokensIn = ev.tokensIn;
            outcome.tokensOut = ev.tokensOut;
            if (ev.costUsd !== undefined) outcome.costUsd = ev.costUsd;
            if (ev.contextTokens !== undefined) contextTokens = Math.max(contextTokens, ev.contextTokens);
            break;
          case 'done':
            if (ev.tokensIn !== undefined) outcome.tokensIn = ev.tokensIn;
            if (ev.tokensOut !== undefined) outcome.tokensOut = ev.tokensOut;
            if (ev.costUsd !== undefined) outcome.costUsd = ev.costUsd;
            if (ev.isError) outcome.isError = true;
            break;
        }
      }

      const cancelled = controller.signal.aborted;

      // Snapshot after the run, and record what changed.
      const snapshotAfter = await ctx.snapshots.commit(ticket.folder, `After run ${runId}`);
      if (snapshotAfter !== snapshotBefore) {
        const files = await ctx.snapshots.diff(ticket.folder, snapshotBefore, snapshotAfter);
        if (files.length) {
          const names = files.slice(0, 5).map((f) => f.path).join(', ');
          audit(ticketId, runId, 'snapshot', `Changed ${files.length} file${files.length === 1 ? '' : 's'}: ${names}${files.length > 5 ? ', …' : ''}`, { before: snapshotBefore, after: snapshotAfter, files });
        }
      }

      const failed = outcome.isError || outcome.errors.length > 0;
      const status: RunStatus = cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded';
      run = repos.runs.update(runId, {
        status,
        snapshotAfter,
        endedAt: nowIso(),
        tokensIn: outcome.tokensIn,
        tokensOut: outcome.tokensOut,
        costUsd: outcome.costUsd,
        exitReason: cancelled ? 'Stopped by you' : failed ? (outcome.errors[0] ?? 'Agent reported an error') : outcome.proposal?.status ?? (outcome.question ? 'question' : 'turn finished'),
      });
      publishRun(run);
      if (outcome.costUsd > 0) {
        repos.tickets.addCost(ticketId, outcome.costUsd);
        publishTicket(ticketId);
      }

      // Context compaction for runtimes that don't do it themselves (docs/15 #11).
      if (!cancelled && needsCompaction(contextTokens, adapter.capabilities.contextWindow, adapter.capabilities.nativeCompaction)) {
        repos.sessions.end(session.id);
        const pct = Math.round((contextTokens / adapter.capabilities.contextWindow!) * 100);
        audit(ticketId, runId, 'info', `Context ${pct}% full: the next run starts a fresh session with a summary of this ticket`, { contextTokens, contextWindow: adapter.capabilities.contextWindow, sessionId: session.id });
      }

      // Final status: the core's rules decide (docs/15 #9).
      const [to, note] = decideFinalStatus(outcome, cancelled, repos.permissions.pendingForTicket(ticketId).length > 0);
      transition(ticketId, to, runId, note);
      ctx.queue.complete(job.id);
      // An agent asked to hand the ticket over (tool hand_off): reassign and start the next agent.
      if (!cancelled && ctx.handoffs) {
        void ctx.handoffs.apply(ticketId).catch((err: unknown) => log.warn({ err: errMessage(err), ticketId }, 'hand-over failed'));
      }
    } catch (err) {
      handleFailure(job, ticketId, run, err);
    } finally {
      if (mcpToken && ctx.tools) {
        try {
          ctx.tools.revokeToken(mcpToken);
        } catch (err) {
          log.warn({ err: errMessage(err) }, 'revoke MCP token failed');
        }
      }
    }
  }

  function handleFailure(job: Job, ticketId: Id, run: Run | undefined, err: unknown): void {
    const msg = errMessage(err);
    log.error({ err: msg, jobId: job.id, ticketId }, 'run failed');
    try {
      audit(ticketId, run?.id ?? null, 'error', `The run failed: ${msg}`);
      if (run) publishRun(repos.runs.update(run.id, { status: 'failed', endedAt: nowIso(), exitReason: msg }));
      transition(ticketId, 'blocked', run?.id ?? null, `Run failed: ${msg}`);
    } catch (inner) {
      log.error({ err: errMessage(inner) }, 'failed to record run failure');
    }
    try {
      // job.attempts counts previous attempts; this one is attempts+1.
      const attempt = job.attempts + 1;
      if (isTransientError(err) && attempt < maxAttempts) {
        ctx.queue.fail(job.id, msg, new Date(Date.now() + backoffMs * 2 ** (attempt - 1)));
      } else {
        ctx.queue.fail(job.id, msg);
      }
    } catch (qErr) {
      log.error({ err: errMessage(qErr), jobId: job.id }, 'queue.fail failed');
    }
  }

  // ---------------------------------------------------------------- loop
  function tick(): number {
    let started = 0;
    try {
      while (active.size < Math.max(1, ctx.config.maxParallelRuns)) {
        const job = ctx.queue.claim(workerId);
        if (!job) break;
        const ticketId = job.payload.ticketId;
        // v0.4 emergency stop: while locked down no run may start (security log records the refusal).
        if (ctx.securityLog?.lockdown()) {
          audit(ticketId, null, 'info', 'Emergency stop is on, so Sebeto did not start the agent. Release the emergency stop (Security page), then start again.', { lockdown: true, job: job.kind });
          ctx.queue.fail(job.id, 'Refused: emergency stop (lockdown) is active');
          continue;
        }
        if (active.has(ticketId)) {
          ctx.queue.fail(job.id, 'ticket busy', new Date(Date.now() + BUSY_RETRY_MS));
          continue;
        }
        const controller = new AbortController();
        const entry: ActiveRun = { controller, promise: Promise.resolve() };
        active.set(ticketId, entry);
        entry.promise = execute(job, controller)
          .catch((err: unknown) => log.error({ err: errMessage(err) }, 'executor job crashed'))
          .finally(() => {
            active.delete(ticketId);
            if (running) setImmediate(tick); // pick up follow-up work without waiting for the poll
          });
        started++;
      }
    } catch (err) {
      log.error({ err: errMessage(err) }, 'executor tick failed');
    }
    return started;
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setInterval(tick, pollMs);
      tick();
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
      for (const a of active.values()) a.controller.abort();
      await Promise.allSettled([...active.values()].map((a) => a.promise));
    },
    cancel(ticketId) {
      const a = active.get(ticketId);
      if (!a) return false;
      a.controller.abort();
      return true;
    },
    activeRuns: () => active.size,
    tick,
    async idle() {
      while (active.size) await Promise.allSettled([...active.values()].map((a) => a.promise));
    },
  };
}

/** Pure rule table for the status after a run. Returns [status, note]. */
export function decideFinalStatus(outcome: Pick<RunOutcome, 'isError' | 'errors' | 'question' | 'proposal'>, cancelled: boolean, pendingPermissions: boolean): [TicketStatus, string] {
  if (cancelled) return ['needs_you', 'stopped by you'];
  if (pendingPermissions) return ['needs_you', 'waiting for permission'];
  if (outcome.isError || outcome.errors.length) return ['blocked', outcome.errors[0] ?? 'the agent reported an error'];
  if (outcome.proposal?.status === 'blocked') return ['blocked', outcome.proposal.note ?? 'the agent is blocked'];
  if (outcome.question) return ['needs_you', 'question for you'];
  if (outcome.proposal?.status === 'done') return ['needs_you', 'ready for your review'];
  return ['needs_you', 'turn finished'];
}
