/**
 * Permission gate: the single place that decides whether an agent may perform a side effect
 * (docs/15 Architecture Review.md items 2, 3 and 4). Sebeto tools call `check` before acting;
 * runtimes never see the policy, so every model gets the same rules.
 */
import { ALWAYS_ASK, DEFAULT_PERMISSIONS, TICKET_SCOPED_KEYS } from '@sebeto/shared';
import type { CommandSpec, ConnectorActivation, Id, PermissionDecision, PermissionKey, PermissionLevel, PermissionRequest } from '@sebeto/shared';
import type { EventBus, GateDecision, JobQueue, PermissionGate, Repos, StateMachine } from '../contracts.js';

/**
 * Keys that send something out of the sandbox. After the run has read untrusted content
 * (a web page, an email…) these are forced to 'ask' whatever the setting, so a prompt-injected
 * page cannot silently make the agent exfiltrate data. `web.read` is deliberately NOT outbound:
 * reading more pages is how research works, and it carries no payload of ours.
 */
export const OUTBOUND_KEYS: readonly PermissionKey[] = ['email.send', 'tool.change', 'script.run', 'prod.change'];

export interface GateDeps { repos: Repos; state: StateMachine; queue: JobQueue; bus: EventBus }

export interface GateCheckInput {
  ticketId: Id; runId: Id | null; agentId: Id | null; key: PermissionKey; title: string; detail: string;
  untrustedInput?: boolean; provenance?: string | null;
  /** For run_command: the exact command, so it can match (or become) a trusted command. */
  command?: CommandSpec | null;
}

/** Only plain (non-production) commands can be trusted. */
export const TRUSTABLE_KEY: PermissionKey = 'script.run';

/** Effective level for an agent/key, applying the ALWAYS_ASK clamp and the untrusted-input rule. */
export function effectiveLevel(
  stored: PermissionLevel | undefined, key: PermissionKey, untrustedInput: boolean,
): PermissionLevel {
  let level = stored ?? DEFAULT_PERMISSIONS[key];
  // ALWAYS_ASK keys can never be 'allow', even if the DB was edited by hand. 'never' stays 'never'.
  if (ALWAYS_ASK.includes(key) && level === 'allow') level = 'ask';
  if (untrustedInput && OUTBOUND_KEYS.includes(key) && level === 'allow') level = 'ask';
  return level;
}

export function createPermissionGate(deps: GateDeps): PermissionGate {
  const { repos, state, queue, bus } = deps;

  function audit(req: PermissionRequest, summary: string, data: Record<string, unknown> = {}): void {
    const event = repos.audit.append({
      ticketId: req.ticketId, runId: req.runId, kind: 'permission', summary,
      data: { requestId: req.id, key: req.key, ...data },
    });
    bus.publish({ type: 'event.created', event });
  }

  /** Whether a denial still applies: it was made for this run, or after this run started. */
  function denialApplies(req: PermissionRequest, runId: Id | null): boolean {
    if (!runId) return false;
    if (req.runId === runId) return true;
    const run = repos.runs.get(runId);
    return !!run && req.createdAt >= run.startedAt;
  }

  return {
    check(input: GateCheckInput): GateDecision {
      const agent = input.agentId ? repos.agents.get(input.agentId) : undefined;
      const stored = (agent?.permissions ?? DEFAULT_PERMISSIONS)[input.key];
      const level = effectiveLevel(stored, input.key, !!input.untrustedInput);

      if (level === 'never') {
        return { outcome: 'deny', reason: `The owner has turned off "${input.key}" for this agent.` };
      }
      if (level === 'allow') return { outcome: 'allow' };

      // "Always allow this command": an exact match of a trusted command skips the question. Not
      // after untrusted input (a prompt-injected page must not be able to drive even trusted
      // commands without the owner seeing it), and never for production changes.
      if (input.key === TRUSTABLE_KEY && input.command && !input.untrustedInput) {
        const trusted = repos.trusted.find(input.command);
        if (trusted) {
          const event = repos.audit.append({
            ticketId: input.ticketId, runId: input.runId, kind: 'permission',
            summary: `Trusted command, allowed without asking: ${input.command.command.trim().slice(0, 80)}`,
            data: { trustedCommandId: trusted.id, key: input.key },
          });
          bus.publish({ type: 'event.created', event });
          return { outcome: 'allow' };
        }
      }

      // 'ask': look for an identical earlier request (same ticket + key + detail).
      const same = repos.permissions.listForTicket(input.ticketId)
        .filter((r) => r.key === input.key && r.detail === input.detail);

      // One approval covers the whole ticket when the key is ticket-scoped (reading the mailbox) or
      // the owner chose "Allow for this task" on an earlier identical request. Such grants are reused,
      // not consumed.
      const ticketScoped = TICKET_SCOPED_KEYS.includes(input.key);
      if (same.some((r) => r.state === 'allowed' && (ticketScoped || r.taskScoped))) return { outcome: 'allow' };
      // Allow ONCE: the first allowed grant that this call manages to consume (an atomic
      // UPDATE … WHERE consumed_at IS NULL, so two concurrent checks can't both use it).
      const granted = same.find((r) => r.state === 'allowed' && repos.permissions.consume(r.id));
      if (granted) {
        audit(granted, `Used permission: ${granted.title}`, { consumed: true });
        return { outcome: 'allow' };
      }
      const pending = same.find((r) => r.state === 'pending');
      if (pending) return { outcome: 'pending', request: pending };
      const denied = same.find((r) => r.state === 'denied' && denialApplies(r, input.runId));
      if (denied) return { outcome: 'deny', reason: 'The owner said no to this exact action.' };

      const request = repos.permissions.create({
        ticketId: input.ticketId, runId: input.runId, agentId: input.agentId,
        key: input.key, title: input.title, detail: input.detail,
        provenance: input.provenance ?? null,
        command: input.key === TRUSTABLE_KEY ? input.command ?? null : null,
      });
      bus.publish({ type: 'permission.created', request });
      audit(request, `Asked permission: ${request.title}`, {
        untrustedInput: !!input.untrustedInput, provenance: request.provenance,
      });
      try {
        state.transition(input.ticketId, 'needs_you', 'rule', { runId: input.runId, note: request.title });
      } catch {
        // Invalid transition (e.g. ticket already done/blocked): the request still stands.
      }
      return { outcome: 'pending', request };
    },

    requestConnector(input: { ticketId: Id; runId: Id | null; agentId: Id | null; title: string; detail: string; provenance?: string | null; connector: ConnectorActivation }): GateDecision {
      const same = repos.permissions.listForTicket(input.ticketId)
        .filter((r) => r.connector?.name === input.connector.name && r.agentId === input.agentId);
      const pending = same.find((r) => r.state === 'pending');
      if (pending) return { outcome: 'pending', request: pending };
      const denied = same.find((r) => r.state === 'denied' && denialApplies(r, input.runId));
      if (denied) return { outcome: 'deny', reason: 'The owner said no to turning on this connector.' };
      const request = repos.permissions.create({
        ticketId: input.ticketId, runId: input.runId, agentId: input.agentId, key: 'tool.read',
        title: input.title, detail: input.detail, provenance: input.provenance ?? null, connector: input.connector,
      });
      bus.publish({ type: 'permission.created', request });
      audit(request, `Asked permission: ${request.title}`, { connector: input.connector.name });
      try {
        state.transition(input.ticketId, 'needs_you', 'rule', { runId: input.runId, note: request.title });
      } catch { /* the request still stands */ }
      return { outcome: 'pending', request };
    },

    decide(requestId: Id, decision: PermissionDecision): PermissionRequest {
      const existing = repos.permissions.get(requestId);
      if (!existing) throw new Error(`Permission request ${requestId} not found`);
      // Connector requests: allow (this agent), team (its team) or deny; nothing else.
      if (existing.connector ? (decision === 'task' || decision === 'always') : decision === 'team') {
        throw new Error('That choice does not apply to this request.');
      }
      if (decision === 'team' && !existing.connector?.teamId) throw new Error('This agent has no team.');
      const always = decision === 'always';
      const task = decision === 'task';
      if (always && (existing.key !== TRUSTABLE_KEY || !existing.command)) {
        throw new Error('Only a plain system command can be always allowed.');
      }
      // Production changes must be approved every time; they can't be granted for the whole task.
      if (task && ALWAYS_ASK.includes(existing.key)) {
        throw new Error('This action must be approved each time; it cannot be allowed for the whole task.');
      }
      const target = decision === 'deny' ? 'denied' : 'allowed';
      if (existing.state === target) return existing; // idempotent double-click
      if (existing.state !== 'pending') throw new Error(`Permission request ${requestId} was already ${existing.state}`);

      const request = repos.tx(() => {
        const decided = repos.permissions.decide(requestId, target, { always, taskScoped: task });
        if (always) repos.trusted.add({ ...existing.command!, requestId });
        return decided;
      });
      bus.publish({ type: 'permission.updated', request });
      if (always) bus.publish({ type: 'trusted.changed', commands: repos.trusted.list() });
      const verb = always ? 'Always allowed (trusted command)'
        : decision === 'deny' ? 'Denied'
        : request.connector ? (decision === 'team' ? `Turned on for the team ${request.connector.teamName ?? ''}`.trim() : 'Turned on for this agent')
        : task ? 'Allowed for this task'
        : TICKET_SCOPED_KEYS.includes(request.key) ? 'Allowed for this ticket' : 'Allowed once';
      audit(request, `${verb}: ${request.title}`, { decision });
      // Both outcomes resume the agent: on allow it retries and consumes the grant, on deny it
      // learns the answer and continues with an alternative.
      queue.enqueue('run.permission', { ticketId: request.ticketId, permissionRequestId: request.id }, {
        priority: 0, dedupeKey: `perm:${request.ticketId}`,
      });
      return request;
    },
  };
}
