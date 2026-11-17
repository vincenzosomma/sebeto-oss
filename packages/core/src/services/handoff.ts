/**
 * Hand-offs between agents (2026-11-16). An agent that is the wrong one for a ticket calls the tool
 * `hand_off` with a team, a teammate, or the Chief of Staff (re-route), and a note. Its run cannot
 * reassign the ticket while it is running, so the request is kept here and applied by the executor
 * right after the run ends: the ticket gets the new team/agent (runtime locks and scopes still apply),
 * a "handoff" message with the note goes on the chat, and the new agent starts a fresh session
 * with the goal, the note and the previous agent's last message.
 * Limit: MAX_HANDOFFS per ticket; after that the ticket goes to Needs you.
 */
import type { Agent, Id, Team, Ticket } from '@sebeto/shared';
import type { AppContext } from '../contracts.js';
import { agentForTeam, route, routeInputOf } from './routing.js';
import { PRIORITY_USER_RUN, updateTicket } from './tickets.js';
import { CHIEF_OF_STAFF } from './intake.js';

export const MAX_HANDOFFS = 3;

export type HandoffTarget = { kind: 'chief' } | { kind: 'team'; team: Team } | { kind: 'agent'; agent: Agent };
export interface HandoffRequest { target: HandoffTarget; note: string; fromAgentId: Id | null }

const pending = new WeakMap<AppContext, Map<Id, HandoffRequest>>();
const mapOf = (ctx: AppContext) => {
  let m = pending.get(ctx);
  if (!m) pending.set(ctx, (m = new Map()));
  return m;
};

const norm = (s: string) => s.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+team$/, '');

/** Who "to" means: the Chief of Staff, a team (name or slug), or an agent (name or role). */
export function resolveHandoffTarget(ctx: AppContext, to: string, fromAgentId: Id | null): HandoffTarget | { error: string } {
  const want = norm(to);
  if (!want) return { error: 'Say who should take the ticket.' };
  if (['chief of staff', 'chief', 'cos', 'router', 'routing', 'auto', 'automatic'].includes(want)) return { kind: 'chief' };
  const teams = ctx.repos.teams?.list() ?? [];
  const team = teams.find((t) => norm(t.name) === want || t.slug === want);
  if (team) return { kind: 'team', team };
  const agents = ctx.repos.agents.list().filter((a) => !a.paused && a.id !== fromAgentId);
  const agent = agents.find((a) => norm(a.name) === want) ?? agents.find((a) => norm(a.role) === want);
  if (agent) return { kind: 'agent', agent };
  const names = [...teams.map((t) => `${t.name} (team)`), ...agents.map((a) => `${a.name} (${a.role})`)].slice(0, 40).join(', ');
  return { error: `Nobody called "${to}". Use "Chief of Staff" to have the ticket re-routed, or one of: ${names}.` };
}

export function handoffCount(ctx: AppContext, ticketId: Id): number {
  return ctx.repos.audit.listForTicket(ticketId, { limit: 500 }).items.filter((e) => (e.data as { handoff?: unknown } | null)?.handoff).length;
}

export function requestHandoff(ctx: AppContext, ticketId: Id, req: HandoffRequest): void {
  mapOf(ctx).set(ticketId, req);
}

export function hasPendingHandoff(ctx: AppContext, ticketId: Id): boolean {
  return mapOf(ctx).has(ticketId);
}

function say(ctx: AppContext, ticketId: Id, role: 'handoff' | 'system', author: string, text: string): void {
  const message = ctx.repos.messages.create({ ticketId, role, author, text });
  ctx.bus.publish({ type: 'message.created', message });
}

function toNeedsYou(ctx: AppContext, ticket: Ticket, why: string): void {
  say(ctx, ticket.id, 'system', 'Sebeto', why);
  try { ctx.state.transition(ticket.id, 'needs_you', 'rule', { note: why }); } catch { /* already there */ }
}

/** Called by the executor after a run ended (not cancelled). Never throws. */
export async function applyHandoff(ctx: AppContext, ticketId: Id): Promise<void> {
  const req = mapOf(ctx).get(ticketId);
  if (!req) return;
  mapOf(ctx).delete(ticketId);
  const ticket = ctx.repos.tickets.get(ticketId);
  if (!ticket || ticket.deletedAt) return;
  const fromName = (req.fromAgentId && ctx.repos.agents.get(req.fromAgentId)?.name) || 'The agent';
  try {
    if (ctx.repos.permissions.pendingForTicket(ticketId).length) {
      toNeedsYou(ctx, ticket, `${fromName} asked to hand this ticket over, but an approval is still waiting. Decide it first, then reassign if needed.`);
      return;
    }
    if (handoffCount(ctx, ticketId) >= MAX_HANDOFFS) {
      toNeedsYou(ctx, ticket, `This ticket was already handed over ${MAX_HANDOFFS} times; choose who should take it.`);
      return;
    }
    let teamId: Id | null = ticket.teamId ?? null;
    let agentId: Id | null = null;
    let via = '';
    const input = { ...routeInputOf(ticket), goal: `${ticket.goal}\n\nHand-off note from ${fromName}: ${req.note}` };
    if (req.target.kind === 'chief') {
      const d = await route(ctx, input, { ticketId });
      teamId = d.teamId;
      agentId = d.agentId;
      via = ` by the ${CHIEF_OF_STAFF} (${d.reason})`;
    } else if (req.target.kind === 'team') {
      teamId = req.target.team.id;
      agentId = agentForTeam(ctx, req.target.team, input)?.id ?? null;
      if (agentId === req.fromAgentId) {
        const others = ctx.repos.agents.list().filter((a) => a.teamId === teamId && a.id !== req.fromAgentId && !a.paused);
        agentId = others[0]?.id ?? null;
      }
    } else {
      agentId = req.target.agent.id;
      teamId = req.target.agent.teamId ?? teamId;
    }
    if (!agentId || agentId === ticket.agentId) {
      toNeedsYou(ctx, ticket, `${fromName} handed this ticket over${via}, but nobody else fits. Choose who should take it. Note: ${req.note}`);
      return;
    }
    const updated = updateTicket(ctx, ticketId, { agentId, teamId });
    const to = ctx.repos.agents.get(agentId);
    const teamName = updated.teamId ? ctx.repos.teams?.get(updated.teamId)?.name : null;
    const event = ctx.repos.audit.append({
      ticketId, kind: 'info',
      summary: `Handed over by ${fromName} to ${to?.name ?? 'another agent'}${teamName ? ` (${teamName})` : ''}${via}`,
      data: { handoff: { from: req.fromAgentId, to: agentId, teamId: updated.teamId ?? null, target: req.target.kind } },
    });
    ctx.bus.publish({ type: 'event.created', event });
    say(ctx, ticketId, 'handoff', fromName, `Handed over to ${to?.name ?? 'another agent'}${teamName ? ` (${teamName})` : ''}: ${req.note}`);
    const last = ctx.repos.messages.listForTicket(ticketId, { limit: 30 }).items.filter((m) => m.role === 'agent').at(-1);
    const brief = [
      `This ticket was handed over to you by ${fromName}. Their note: ${req.note}`,
      last ? `Their last message on the ticket:\n${last.text.slice(0, 3000)}` : null,
      'Continue from here; do not redo work that is already done.',
    ].filter(Boolean).join('\n\n');
    ctx.queue.enqueue('run.start', { ticketId, text: brief }, { priority: PRIORITY_USER_RUN, dedupeKey: `start:${ticketId}` });
  } catch (err) {
    toNeedsYou(ctx, ticket, `The hand-over from ${fromName} did not work: ${(err as Error).message}`);
  }
}
