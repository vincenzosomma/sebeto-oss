/**
 * v0.5 I: the emergency stop at the API (docs/29 v0.5 Plan.md §I).
 *
 * While the lockdown is on, every API action that would wake an agent (Start, Create + start, a
 * reply, a permission decision that resumes the agent, accepting intake proposals with start) is
 * refused with 409 `lockdown` and a plain message, BEFORE anything is created or queued. Each refusal
 * is one security event `system.run_refused` (category system, severity warning, data.route).
 *
 * The executor keeps its own check (the real guarantee); its refusals are recorded through the audit
 * mirror (`data.lockdown === true`), so a request refused here never reaches it and is never logged twice.
 */
import { LOCKDOWN_MESSAGE, TEAM_POLICY_ERRORS, type Id } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { USER_ACTOR, currentActor } from '../security/actor.js';
import { AppError } from './errors.js';

/** Route labels used in the security event (`data.route`). */
export const LOCKDOWN_ROUTES = {
  create: 'POST /tickets (start)',
  start: 'POST /tickets/:id/start',
  message: 'POST /tickets/:id/messages',
  decide: 'POST /permissions/:id/decide',
  intakeAccept: 'POST /intake/accept (start)',
} as const;

export function lockdownError(): AppError {
  return new AppError(409, TEAM_POLICY_ERRORS.lockdown, LOCKDOWN_MESSAGE);
}

export function isLockedDown(ctx: AppContext): boolean {
  try {
    return !!ctx.securityLog?.lockdown();
  } catch {
    return false;
  }
}

/** Throws 409 `lockdown` (and records one security event) while the emergency stop is on. */
export function assertNotLockedDown(ctx: AppContext, route: string, ticketId: Id | null = null): void {
  if (!isLockedDown(ctx)) return;
  let agentId: Id | null = null;
  let label = '';
  if (ticketId) {
    const t = ctx.repos.tickets.get(ticketId);
    agentId = t?.agentId ?? null;
    if (t) label = ` for T-${t.number}`;
  }
  try {
    ctx.securityLog?.record({
      category: 'system', action: 'system.run_refused', severity: 'warning', actor: currentActor() ?? USER_ACTOR,
      ticketId, agentId,
      summary: `Emergency stop is on: refused a request that would wake an agent${label} (${route}).`,
      data: { route, reason: 'lockdown' },
    });
  } catch { /* the refusal stands even if the log fails */ }
  throw lockdownError();
}
