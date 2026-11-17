/**
 * One plain planning turn on the cheap planning model (v0.4): the default agent's runtime, the
 * workspace planning model (Settings → Planning model), no Sebeto tools, every permission 'never', an
 * empty scratch folder, a fresh session, a small budget and a timeout. Used by ticket routing, the
 * intake chat, memory notes and session categories.
 *
 * v0.6 O: `planningTurnOf(ctx)` is the ONLY way to run a turn, so it is the one place where every
 * call is recorded in `planning_calls` (purpose, ticket, AI, cost, tokens, ok; never any text) for
 * the Costs page. The injected test turn is recorded the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PERMISSION_KEYS, uuidv7, type PermissionKey, type PermissionLevel } from '@sebeto/shared';
import type { AppContext, PlanningCallRecord, PlanningTurn, PlanningTurnInput, PlanningTurnResult } from '../contracts.js';
import { pickDefaultAgent } from '../default-agent.js';

const NO_PERMISSIONS = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, 'never'])) as Record<PermissionKey, PermissionLevel>;

export type PlanningErrorCode = 'no_agent' | 'runtime_unavailable' | 'timeout' | 'failed';

export class PlanningError extends Error {
  constructor(message: string, readonly code: PlanningErrorCode = 'failed') {
    super(message);
    this.name = 'PlanningError';
  }
}

/**
 * The planning turn to use: the injected one (tests) or the default runtime-backed one, wrapped so
 * every call (successful or failed) is recorded. Recording never breaks the call.
 */
export function planningTurnOf(ctx: AppContext): PlanningTurn {
  const inner: PlanningTurn = ctx.planningTurn ?? ((input) => runPlanningTurn(ctx, input));
  return async (input) => {
    const at = new Date().toISOString();
    let res: PlanningTurnResult;
    try {
      res = await inner(input);
    } catch (err) {
      const e = err as PlanningError & { runtime?: string; model?: string | null; costUsd?: number };
      record(ctx, {
        at, purpose: input.purpose, ticketId: input.ticketId ?? null, runtime: e.runtime ?? input.runtime ?? '',
        model: e.model ?? input.model ?? null, costUsd: e.costUsd ?? 0, tokensIn: 0, tokensOut: 0, ok: false,
      });
      throw err;
    }
    record(ctx, {
      at, purpose: input.purpose, ticketId: input.ticketId ?? null, runtime: res.runtime ?? input.runtime ?? '',
      model: res.model ?? null, costUsd: res.costUsd || 0, tokensIn: res.tokensIn ?? 0, tokensOut: res.tokensOut ?? 0, ok: true,
    });
    return res;
  };
}

function record(ctx: AppContext, call: PlanningCallRecord): void {
  try {
    ctx.repos.costs?.recordPlanningCall({ ...call, costUsd: Math.max(0, Number.isFinite(call.costUsd) ? call.costUsd : 0) });
  } catch (err) {
    ctx.log.warn({ err: (err as Error).message, purpose: call.purpose }, 'planning call not recorded');
  }
}

export async function runPlanningTurn(ctx: AppContext, input: PlanningTurnInput): Promise<PlanningTurnResult> {
  let adapter;
  let model: string | null | undefined;
  if (input.runtime) {
    // A fixed runtime (e.g. a team locked to one AI): that runtime or nothing, never a fallback.
    adapter = ctx.runtimes.get(input.runtime);
    if (!adapter) throw new PlanningError(`the AI "${input.runtime}" is not available`, 'runtime_unavailable');
    model = input.model ?? null;
  } else {
    const lead = pickDefaultAgent(ctx.repos.agents.list());
    adapter = lead ? ctx.runtimes.get(lead.runtime) : undefined;
    if (!lead || !adapter) throw new PlanningError('no agent is available to plan', 'no_agent');
    // Explicit model > workspace planning model (if this runtime offers it) > the agent's model.
    const preferred = ctx.settings?.get().intakeModel ?? null;
    const offered = !input.model && preferred ? await adapter.models().catch(() => [] as string[]) : [];
    model = input.model ?? (preferred && offered.includes(preferred) ? preferred : lead.model);
  }

  const cwd = path.join(ctx.config.workspaceDir, 'intake');
  await fs.promises.mkdir(cwd, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let text = '';
  let costUsd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let error: string | null = null;
  try {
    for await (const ev of adapter.run({
      ticketId: input.purpose === 'intake' ? 'intake' : 'routing', runId: uuidv7(), newExternalSessionId: randomUUID(), cwd, model,
      systemPrompt: input.systemPrompt, prompt: input.prompt, permissions: NO_PERMISSIONS, budgetUsd: input.budgetUsd, signal: controller.signal,
    })) {
      if (ev.kind === 'text') text += (text ? '\n' : '') + ev.text;
      else if (ev.kind === 'ask') text += (text ? '\n' : '') + ev.question;
      else if (ev.kind === 'error') error = ev.message;
      else if (ev.kind === 'usage' || ev.kind === 'done') {
        if (ev.costUsd !== undefined) costUsd = ev.costUsd;
        if (ev.tokensIn !== undefined) tokensIn = ev.tokensIn;
        if (ev.tokensOut !== undefined) tokensOut = ev.tokensOut;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const fail = (message: string, code: PlanningErrorCode) =>
    Object.assign(new PlanningError(message, code), { runtime: adapter.id, model: model ?? null, costUsd });
  if (controller.signal.aborted) throw fail('the planning model took too long', 'timeout');
  if (!text.trim() && error) throw fail(error, 'failed');
  ctx.log.info({ runtime: adapter.id, model, costUsd, purpose: input.purpose }, 'planning turn');
  return { text, costUsd, model: model ?? null, runtime: adapter.id, tokensIn, tokensOut };
}
