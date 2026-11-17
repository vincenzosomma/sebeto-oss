/**
 * Ticket status state machine (docs/15 Architecture Review.md item 9): the core decides status,
 * agents only propose, the user can override anything. Every transition is recorded with its cause.
 */
import { STATUS_LABELS, type Id, type StatusCause, type TicketStatus } from '@sebeto/shared';
import type { EventBus, Repos, StateMachine } from '../contracts.js';

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
    readonly cause: StatusCause,
  ) {
    super(`Transition ${from} -> ${to} is not allowed for cause '${cause}'`);
    this.name = 'InvalidTransitionError';
  }
}

/** Statuses an agent (or a rule) may set while work is in flight. */
const WORKING: ReadonlySet<TicketStatus> = new Set(['in_progress', 'needs_you', 'blocked']);

export function canTransition(from: TicketStatus, to: TicketStatus, cause: StatusCause): boolean {
  if (from === to) return true;
  switch (cause) {
    case 'user':
      return true;
    case 'rule':
      // Rules may only complete a ticket the user has been asked about (e.g. approved deliverable).
      return WORKING.has(to) || (to === 'done' && from === 'needs_you');
    case 'agent':
      // Agents never complete or shelve tickets, and cannot touch backlog/done tickets.
      return WORKING.has(from) && WORKING.has(to);
    default:
      return false;
  }
}

function summarize(to: TicketStatus, cause: StatusCause, note?: string): string {
  const base = `Moved to ${STATUS_LABELS.en[to]} (${cause})`;
  return note ? `${base}: ${note}` : base;
}

export function createStateMachine(repos: Repos, bus: EventBus): StateMachine {
  return {
    canTransition,
    transition(ticketId: Id, to: TicketStatus, cause: StatusCause, opts = {}) {
      const result = repos.tx(() => {
        const ticket = repos.tickets.get(ticketId);
        if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
        if (ticket.status === to) return { ticket, event: null };
        if (!canTransition(ticket.status, to, cause)) throw new InvalidTransitionError(ticket.status, to, cause);

        const runId = opts.runId ?? null;
        const note = opts.note ?? null;
        const updated = repos.tickets.update(ticketId, { status: to });
        repos.transitions.append({ ticketId, from: ticket.status, to, cause, runId, note });
        const event = repos.audit.append({
          ticketId,
          runId,
          kind: 'status',
          summary: summarize(to, cause, opts.note),
          data: { from: ticket.status, to, cause, note },
        });
        return { ticket: updated, event };
      });

      // Publish only after the transaction committed.
      if (result.event) {
        bus.publish({ type: 'ticket.updated', ticket: result.ticket });
        bus.publish({ type: 'event.created', event: result.event });
      }
      return result.ticket;
    },
  };
}
