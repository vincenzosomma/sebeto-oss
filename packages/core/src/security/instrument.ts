/**
 * Central security coverage for the code that existed before v0.4: instead of sprinkling calls
 * through every module, the repos and stores on the AppContext are decorated IN PLACE (the gate,
 * the state machine, the executor and the tool server hold the same objects, so they all go through
 * the decorators). Every decorator records after the real call succeeded and never throws.
 *
 *  - repos.audit.append   → mirror of every per-ticket audit event (tool / permission / status / …)
 *  - repos.agents         → created / changed field by field (permission loosening = warning) / paused / deleted / skills
 *  - repos.sessions/runs  → session started / ended, run started / ended (cost, tokens, exit reason)
 *  - repos.tickets        → created, agent reassigned
 *  - repos.trusted        → trusted command added / removed
 *  - settings, skills, connectors, mail, oauth stores → config / connector / auth events (never secrets)
 */
import type {
  Agent, AuditEvent, Id, PermissionKey, PermissionLevel, Run, SecurityActor, SecuritySeverity, Session,
} from '@sebeto/shared';
import { PERMISSION_KEYS } from '@sebeto/shared';
import type { AppContext, NewSecurityEvent, SecurityLogger } from '../contracts.js';
import { SYSTEM_ACTOR, USER_ACTOR, currentActor } from './actor.js';

const LEVEL_RANK: Record<PermissionLevel, number> = { never: 0, ask: 1, allow: 2 };
const PERMISSION_LABEL: Record<string, string> = {
  'fs.read': 'Read files', 'fs.write': 'Change files', 'web.read': 'Read web pages', 'email.read': 'Read email',
  'email.send': 'Send email', 'tool.read': 'Use connector tools (read)', 'tool.change': 'Use connector tools (change)',
  'script.run': 'Run system commands', 'prod.change': 'Change production', 'memory.read': 'Search past sessions',
};
const LEVEL_LABEL: Record<PermissionLevel, string> = { allow: 'Allow', ask: 'Ask', never: 'Never' };
const INSTRUMENTED = Symbol.for('sebeto.security.instrumented');

type Rec = (input: NewSecurityEvent) => void;

function wrap<T extends object, K extends keyof T>(obj: T, key: K, make: (orig: T[K]) => T[K]): void {
  const orig = obj[key];
  if (typeof orig !== 'function') return;
  obj[key] = make((orig as unknown as (...a: unknown[]) => unknown).bind(obj) as T[K]);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Decorate the context. Idempotent; a context without a security log is left alone. */
export function instrumentContext(ctx: AppContext): void {
  const logger: SecurityLogger | undefined = ctx.securityLog;
  if (!logger) return;
  const marked = ctx as unknown as Record<symbol, boolean>;
  if (marked[INSTRUMENTED]) return;
  marked[INSTRUMENTED] = true;
  const { repos } = ctx;

  const rec: Rec = (input) => {
    try { logger.record(input); } catch { /* record never throws, but be safe */ }
  };
  const safe = (fn: () => void) => {
    try { fn(); } catch (err) { ctx.log.warn({ err: (err as Error)?.message }, 'security log: could not describe an event'); }
  };
  const actorNow = (fallback: SecurityActor = SYSTEM_ACTOR): SecurityActor => currentActor() ?? fallback;
  const agentName = (id: Id | null | undefined): string | null => (id ? repos.agents.get(id)?.name ?? null : null);

  // ---- run → session → agent (cached; runs never change session)
  const runCache = new Map<Id, { sessionId: Id | null; agentId: Id | null }>();
  function runInfo(runId: Id | null | undefined): { sessionId: Id | null; agentId: Id | null } {
    if (!runId) return { sessionId: null, agentId: null };
    const hit = runCache.get(runId);
    if (hit) return hit;
    let info = { sessionId: null as Id | null, agentId: null as Id | null };
    try {
      const run = repos.runs.get(runId);
      const session = run?.sessionId && repos.sessions.get ? repos.sessions.get(run.sessionId) : undefined;
      info = { sessionId: run?.sessionId ?? null, agentId: session?.agentId ?? null };
    } catch { /* fakes without sessions */ }
    if (info.sessionId) {
      if (runCache.size > 500) runCache.clear();
      runCache.set(runId, info);
    }
    return info;
  }
  const agentActor = (agentId: Id | null): SecurityActor => ({ type: 'agent', id: agentId, name: agentName(agentId) ?? 'Agent' });

  // ================================================================ audit mirror
  const audit = repos.audit;
  wrap(audit, 'append', (orig) => (input) => {
    const event = orig(input) as AuditEvent;
    safe(() => mirrorAudit(event));
    return event;
  });

  function mirrorAudit(e: AuditEvent): void {
    const d = (e.data ?? {}) as Record<string, unknown>;
    const { sessionId, agentId } = runInfo(e.runId);
    const base = { ticketId: e.ticketId, runId: e.runId, sessionId, agentId, summary: e.summary, data: { auditEventId: e.id, kind: e.kind, ...d } };
    const fromRun = e.runId ? agentActor(agentId) : SYSTEM_ACTOR;
    switch (e.kind) {
      case 'tool': {
        const tool = typeof d['tool'] === 'string' ? d['tool'] : 'call';
        let severity: SecuritySeverity = 'info';
        if (tool === 'run_command' || tool === 'send_email' || tool === 'write_file') severity = 'notice';
        if (d['production'] === true || d['error']) severity = 'warning';
        rec({ ...base, category: 'tool', action: `tool.${tool}`, severity, actor: currentActor() ?? fromRun });
        return;
      }
      case 'permission': {
        const key = d['key'] as PermissionKey | undefined;
        const decision = d['decision'];
        if (decision === 'deny') return rec({ ...base, category: 'permission', action: 'permission.denied', severity: 'warning', actor: actorNow(USER_ACTOR) });
        if (decision === 'always') return rec({ ...base, category: 'permission', action: 'permission.always_allowed', severity: 'notice', actor: actorNow(USER_ACTOR) });
        if (decision === 'allow') return rec({ ...base, category: 'permission', action: 'permission.allowed', severity: key === 'prod.change' ? 'warning' : 'notice', actor: actorNow(USER_ACTOR) });
        if (d['consumed'] === true) return rec({ ...base, category: 'permission', action: 'permission.used', severity: 'info', actor: fromRun });
        if (d['trustedCommandId']) return rec({ ...base, category: 'permission', action: 'permission.trusted_command_used', severity: 'notice', actor: fromRun });
        const risky = key === 'prod.change' || d['untrustedInput'] === true;
        return rec({ ...base, category: 'permission', action: 'permission.requested', severity: risky ? 'warning' : 'notice', actor: fromRun });
      }
      case 'status': {
        const cause = d['cause'];
        const actor = cause === 'user' ? actorNow(USER_ACTOR) : cause === 'agent' ? fromRun : SYSTEM_ACTOR;
        return rec({ ...base, category: 'ticket', action: 'ticket.status_changed', severity: d['to'] === 'blocked' ? 'notice' : 'info', actor });
      }
      case 'snapshot':
        if (d['restoredTo']) return rec({ ...base, category: 'ticket', action: 'ticket.undo', severity: 'notice', actor: actorNow(USER_ACTOR) });
        return rec({ ...base, category: 'tool', action: 'tool.files_changed', severity: 'info', actor: fromRun });
      case 'error':
        return rec({ ...base, category: e.runId ? 'session' : 'ticket', action: e.runId ? 'session.error' : 'ticket.error', severity: 'warning', actor: actorNow(fromRun) });
      case 'cost':
        return rec({ ...base, category: 'session', action: 'session.budget_reached', severity: 'notice', actor: SYSTEM_ACTOR });
      case 'info':
      default:
        if (d['lockdown'] === true) return rec({ ...base, category: 'system', action: 'system.run_refused', severity: 'warning', actor: SYSTEM_ACTOR });
        if (e.summary === 'Ticket created') return; // recorded as ticket.created with more detail
        return rec({ ...base, category: 'ticket', action: 'ticket.activity', severity: 'info', actor: actorNow(e.runId ? fromRun : SYSTEM_ACTOR) });
    }
  }

  // ================================================================ agents
  const agents = repos.agents;
  wrap(agents, 'create', (orig) => (input) => {
    const agent = orig(input) as Agent;
    safe(() => rec({
      category: 'agent', action: 'agent.created', severity: 'notice', agentId: agent.id,
      summary: `Agent ${agent.name} was created (${agent.runtime}${agent.model ? `, ${agent.model}` : ''}).`,
      data: { name: agent.name, role: agent.role, runtime: agent.runtime, model: agent.model, reportsTo: agent.reportsTo, monthlyBudgetUsd: agent.monthlyBudgetUsd, permissions: agent.permissions },
    }));
    return agent;
  });

  wrap(agents, 'update', (orig) => (id, patch) => {
    let before: Agent | undefined;
    try { before = agents.get(id); } catch { before = undefined; }
    const after = orig(id, patch) as Agent;
    if (before) safe(() => describeAgentChange(before!, after));
    return after;
  });

  function describeAgentChange(before: Agent, after: Agent): void {
    const actor = actorNow(SYSTEM_ACTOR);
    for (const key of PERMISSION_KEYS) {
      const from = before.permissions[key];
      const to = after.permissions[key];
      if (from === to || from === undefined || to === undefined) continue;
      const loosened = LEVEL_RANK[to] > LEVEL_RANK[from];
      rec({
        category: 'agent', action: 'agent.permission_changed', severity: loosened ? 'warning' : 'notice', actor, agentId: after.id,
        summary: `${after.name}: "${PERMISSION_LABEL[key] ?? key}" changed from ${LEVEL_LABEL[from]} to ${LEVEL_LABEL[to]}${loosened ? ' (less safe)' : ''}.`,
        data: { key, from, to, loosened },
      });
    }
    if (before.paused !== after.paused) {
      rec({
        category: 'agent', action: after.paused ? 'agent.paused' : 'agent.resumed', severity: 'notice', actor, agentId: after.id,
        summary: `${after.name} was ${after.paused ? 'paused' : 'resumed'}.`, data: { paused: after.paused },
      });
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of ['name', 'role', 'runtime', 'model', 'reportsTo', 'heartbeatMinutes', 'monthlyBudgetUsd'] as const) {
      if (before[f] !== after[f]) changes[f] = { from: before[f], to: after[f] };
    }
    if (before.job !== after.job) changes['job'] = { from: `${before.job.length} characters`, to: `${after.job.length} characters` };
    const extra = after as unknown as Record<string, unknown>;
    const prev = before as unknown as Record<string, unknown>;
    if ('teamId' in extra && prev['teamId'] !== extra['teamId']) changes['teamId'] = { from: prev['teamId'] ?? null, to: extra['teamId'] ?? null };
    const fields = Object.keys(changes);
    if (fields.length) {
      const budgetUp = typeof changes['monthlyBudgetUsd']?.to === 'number' && (changes['monthlyBudgetUsd'].to as number) > (changes['monthlyBudgetUsd'].from as number);
      rec({
        category: 'agent', action: 'agent.updated', severity: budgetUp || changes['runtime'] ? 'notice' : 'info', actor, agentId: after.id,
        summary: `${after.name} was changed: ${fields.join(', ')}.`, data: { changes },
      });
    }
  }

  if (agents.delete) {
    wrap(agents, 'delete', (orig) => (id) => {
      let before: Agent | undefined;
      try { before = agents.get(id); } catch { before = undefined; }
      const removed = (orig as (id: Id) => boolean)(id);
      if (removed) {
        safe(() => rec({
          category: 'agent', action: 'agent.deleted', severity: 'notice', agentId: id,
          summary: `Agent ${before?.name ?? id} was deleted.`, data: { name: before?.name ?? null, role: before?.role ?? null },
        }));
      }
      return removed;
    });
  }

  wrap(agents, 'setSkills', (orig) => (id, slugs) => {
    const before = agents.get(id);
    const after = orig(id, slugs) as Agent;
    safe(() => {
      if (before && before.skills.join('\n') === after.skills.join('\n')) return;
      rec({
        category: 'agent', action: 'agent.skills_changed', severity: 'notice', agentId: id,
        summary: `${after.name} now has ${plural(after.skills.length, 'skill')}${after.skills.length ? `: ${after.skills.join(', ')}` : ''}.`,
        data: { from: before?.skills ?? null, to: after.skills },
      });
    });
    return after;
  });

  // ================================================================ sessions and runs
  const sessions = repos.sessions;
  wrap(sessions, 'create', (orig) => (input) => {
    const s = orig(input) as Session;
    safe(() => rec({
      category: 'session', action: 'session.started', severity: 'info', actor: s.agentId ? agentActor(s.agentId) : SYSTEM_ACTOR,
      ticketId: s.ticketId, agentId: s.agentId, sessionId: s.id,
      summary: `${agentName(s.agentId) ?? 'An agent'} started a new session (${s.reason.replace('_', ' ')}, ${s.runtime}${s.model ? `, ${s.model}` : ''}).`,
      data: { reason: s.reason, runtime: s.runtime, model: s.model },
    }));
    return s;
  });
  wrap(sessions, 'end', (orig) => (id) => {
    let before: Session | undefined;
    try { before = sessions.get(id); } catch { before = undefined; }
    const s = orig(id) as Session;
    if (!before?.endedAt) {
      safe(() => rec({
        category: 'session', action: 'session.ended', severity: 'info', ticketId: s.ticketId, agentId: s.agentId, sessionId: s.id,
        summary: `Session of ${agentName(s.agentId) ?? 'an agent'} ended.`,
        data: { reason: s.reason, runtime: s.runtime, startedAt: s.startedAt, endedAt: s.endedAt },
      }));
    }
    return s;
  });

  const runs = repos.runs;
  wrap(runs, 'create', (orig) => (input) => {
    const r = orig(input) as Run;
    safe(() => {
      const { agentId } = runInfo(r.id);
      rec({
        category: 'session', action: 'session.run_started', severity: 'info', actor: agentId ? agentActor(agentId) : SYSTEM_ACTOR,
        ticketId: r.ticketId, runId: r.id, sessionId: r.sessionId, agentId,
        summary: `${agentName(agentId) ?? 'The agent'} started working (${r.trigger}).`, data: { trigger: r.trigger, jobId: r.jobId },
      });
    });
    return r;
  });
  wrap(runs, 'update', (orig) => (id, patch) => {
    let before: Run | undefined;
    if (patch.status !== undefined) {
      try { before = runs.get(id); } catch { before = undefined; }
    }
    const r = orig(id, patch) as Run;
    if (before && before.status !== r.status && (r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled')) {
      safe(() => {
        const { agentId } = runInfo(r.id);
        rec({
          category: 'session', action: 'session.run_ended', severity: r.status === 'failed' ? 'warning' : r.status === 'cancelled' ? 'notice' : 'info',
          actor: agentId ? agentActor(agentId) : SYSTEM_ACTOR, ticketId: r.ticketId, runId: r.id, sessionId: r.sessionId, agentId,
          summary: `Run ${r.status}: ${r.exitReason ?? 'finished'} ($${r.costUsd.toFixed(4)}, ${r.tokensIn + r.tokensOut} tokens).`,
          data: { status: r.status, exitReason: r.exitReason, costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut, startedAt: r.startedAt, endedAt: r.endedAt },
        });
      });
    }
    return r;
  });
  wrap(runs, 'failOrphans', (orig) => (reason) => {
    const n = orig(reason) as number;
    if (n > 0) safe(() => rec({ category: 'system', action: 'system.orphan_runs_failed', severity: 'warning', summary: `${plural(n, 'run')} left running by an unclean stop were marked failed.`, data: { count: n } }));
    return n;
  });

  // ================================================================ tickets
  const tickets = repos.tickets;
  wrap(tickets, 'create', (orig) => (input) => {
    const t = orig(input);
    safe(() => rec({
      category: 'ticket', action: 'ticket.created', severity: 'info', ticketId: t.id, agentId: t.agentId,
      summary: `Ticket T-${t.number} was created: ${t.title}`,
      data: { number: t.number, title: t.title, agentId: t.agentId, projectId: t.projectId ?? null, tags: t.tags ?? [], costCapUsd: t.costCapUsd, parentId: t.parentId },
    }));
    return t;
  });
  wrap(tickets, 'update', (orig) => (id, patch) => {
    let before: ReturnType<typeof tickets.get>;
    if (patch.agentId !== undefined) {
      try { before = tickets.get(id); } catch { before = undefined; }
    }
    const t = orig(id, patch);
    if (before && before.agentId !== t.agentId) {
      safe(() => rec({
        category: 'ticket', action: 'ticket.reassigned', severity: 'notice', ticketId: t.id, agentId: t.agentId,
        summary: `T-${t.number} moved from ${agentName(before!.agentId) ?? 'nobody'} to ${agentName(t.agentId) ?? 'nobody'}.`,
        data: { from: before!.agentId, to: t.agentId },
      }));
    }
    return t;
  });
  const anyTickets = tickets as unknown as Record<string, unknown>;
  if (typeof anyTickets['delete'] === 'function' || typeof anyTickets['remove'] === 'function') {
    const key = typeof anyTickets['delete'] === 'function' ? 'delete' : 'remove';
    const orig = (anyTickets[key] as (id: Id) => unknown).bind(tickets);
    anyTickets[key] = (id: Id) => {
      let before: ReturnType<typeof tickets.get>;
      try { before = tickets.get(id); } catch { before = undefined; }
      const result = orig(id);
      if (before && result !== false) {
        safe(() => rec({ category: 'ticket', action: 'ticket.deleted', severity: 'notice', ticketId: id, summary: `Ticket T-${before!.number} was deleted: ${before!.title}`, data: { number: before!.number, title: before!.title } }));
      }
      return result;
    };
  }

  // ================================================================ trusted commands
  const trusted = repos.trusted;
  wrap(trusted, 'add', (orig) => (input) => {
    let existed = false;
    try { existed = !!trusted.find({ shell: input.shell, command: input.command }); } catch { existed = false; }
    const t = orig(input);
    if (!existed) {
      safe(() => rec({
        category: 'permission', action: 'permission.trusted_command_added', severity: 'warning', actor: actorNow(USER_ACTOR),
        summary: `Command trusted ("Always allow"): ${t.command.slice(0, 120)}`, data: { trustedCommandId: t.id, shell: t.shell, command: t.command, requestId: t.requestId },
      }));
    }
    return t;
  });
  wrap(trusted, 'remove', (orig) => (id) => {
    const before = trusted.list().find((t) => t.id === id);
    const ok = orig(id) as boolean;
    if (ok) {
      safe(() => rec({
        category: 'permission', action: 'permission.trusted_command_removed', severity: 'notice',
        summary: `Command no longer trusted: ${before?.command.slice(0, 120) ?? id}`, data: { trustedCommandId: id, shell: before?.shell ?? null, command: before?.command ?? null },
      }));
    }
    return ok;
  });

  instrumentStores(ctx, rec, safe);
}

/** Settings, skills, connectors, mail and sign-in stores. */
function instrumentStores(ctx: AppContext, rec: Rec, safe: (fn: () => void) => void): void {
  if (ctx.settings) {
    const store = ctx.settings;
    wrap(store, 'update', (orig) => (patch) => {
      const before = store.get() as unknown as Record<string, unknown>;
      const after = orig(patch);
      safe(() => {
        const a = after as unknown as Record<string, unknown>;
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const k of Object.keys(a)) if (JSON.stringify(before[k]) !== JSON.stringify(a[k])) changes[k] = { from: before[k] ?? null, to: a[k] ?? null };
        if (Object.keys(changes).length) rec({ category: 'config', action: 'config.settings_changed', severity: 'notice', summary: `Settings changed: ${Object.keys(changes).join(', ')}.`, data: { changes } });
      });
      return after;
    });
  }

  if (ctx.skills) {
    const lib = ctx.skills;
    wrap(lib, 'create', (orig) => (body, opts) => {
      const s = orig(body, opts);
      safe(() => rec({ category: 'config', action: 'config.skill_created', severity: 'notice', summary: `Skill "${s.name}" was added.`, data: { slug: s.slug, name: s.name, needs: s.needs, connectors: s.connectors } }));
      return s;
    });
    wrap(lib, 'update', (orig) => (slug, body) => {
      const s = orig(slug, body);
      safe(() => rec({ category: 'config', action: 'config.skill_updated', severity: 'notice', summary: `Skill "${s.name}" was changed (version ${s.version}).`, data: { slug: s.slug, name: s.name, version: s.version, needs: s.needs, connectors: s.connectors, usedBy: s.usedBy } }));
      return s;
    });
    wrap(lib, 'remove', (orig) => (slug) => {
      orig(slug);
      safe(() => rec({ category: 'config', action: 'config.skill_deleted', severity: 'notice', summary: `Skill "${slug}" was deleted.`, data: { slug } }));
    });
  }

  if (ctx.connectors) {
    const hub = ctx.connectors;
    wrap(hub, 'add', (orig) => async (body) => {
      const c = await orig(body);
      safe(() => rec({
        category: 'connector', action: 'connector.added', severity: 'notice', summary: `Connector "${c.name}" was added (${c.catalogId}, ${plural(c.tools.length, 'tool')}).`,
        data: { connectorId: c.id, name: c.name, catalogId: c.catalogId, transport: c.transport?.type ?? null, tools: c.tools.map((t) => ({ name: t.name, level: t.level })), allowedAgents: c.allowedAgents },
      }));
      return c;
    });
    wrap(hub, 'update', (orig) => (id, patch) => {
      const before = hub.get(id);
      const c = orig(id, patch);
      safe(() => {
        if (patch.tools?.length) {
          const changed = patch.tools.map((t) => ({ name: t.name, from: before?.tools.find((x) => x.name === t.name)?.level ?? null, to: t.level }));
          rec({ category: 'connector', action: 'connector.tools_reviewed', severity: 'notice', summary: `Tools of "${c.name}" were reviewed (${plural(changed.length, 'tool')}).`, data: { connectorId: id, tools: changed } });
        }
        if (patch.enabled !== undefined && before?.enabled !== patch.enabled) {
          rec({ category: 'connector', action: patch.enabled ? 'connector.enabled' : 'connector.disabled', severity: 'notice', summary: `Connector "${c.name}" was turned ${patch.enabled ? 'on' : 'off'}.`, data: { connectorId: id } });
        }
        if (patch.allowedAgents !== undefined && JSON.stringify(before?.allowedAgents ?? null) !== JSON.stringify(c.allowedAgents)) {
          rec({ category: 'connector', action: 'connector.access_changed', severity: 'notice', summary: `Who may use "${c.name}" changed.`, data: { connectorId: id, from: before?.allowedAgents ?? null, to: c.allowedAgents } });
        }
        if (patch.name !== undefined && before?.name !== patch.name) {
          rec({ category: 'connector', action: 'connector.renamed', severity: 'info', summary: `Connector "${before?.name ?? id}" was renamed to "${c.name}".`, data: { connectorId: id } });
        }
      });
      return c;
    });
    wrap(hub, 'remove', (orig) => async (id) => {
      const before = hub.get(id);
      await orig(id);
      safe(() => rec({ category: 'connector', action: 'connector.removed', severity: 'notice', summary: `Connector "${before?.name ?? id}" was removed.`, data: { connectorId: id, name: before?.name ?? null, catalogId: before?.catalogId ?? null } }));
    });
  }

  if (ctx.mail) {
    const mail = ctx.mail;
    wrap(mail, 'connect', (orig) => async (body) => {
      try {
        const st = await orig(body);
        safe(() => rec({ category: 'auth', action: 'auth.mail_connected', severity: 'notice', summary: `Mailbox ${body.address} was connected (${body.provider}).`, data: { provider: body.provider, address: body.address } }));
        return st;
      } catch (err) {
        safe(() => rec({ category: 'auth', action: 'auth.mail_connect_failed', severity: 'notice', summary: `Connecting mailbox ${body.address} failed.`, data: { provider: body.provider, address: body.address, error: (err as Error)?.message ?? String(err) } }));
        throw err;
      }
    });
    wrap(mail, 'disconnect', (orig) => async () => {
      const r = await orig();
      safe(() => rec({ category: 'auth', action: 'auth.mail_disconnected', severity: 'notice', summary: `Mailbox signed out${r.provider ? ` (${r.provider})` : ''}.`, data: { provider: r.provider, revokedAtProvider: r.revokedAtProvider } }));
      return r;
    });
    wrap(mail, 'completeSignIn', (orig) => async (provider, email) => {
      const st = await orig(provider, email);
      safe(() => rec({ category: 'auth', action: 'auth.signed_in', severity: 'notice', summary: `Signed in with ${provider}${email ? ` as ${email}` : ''}.`, data: { provider, address: email } }));
      return st;
    });
  }

  if (ctx.oauth) {
    const oauth = ctx.oauth;
    wrap(oauth, 'setCustomApp', (orig) => async (provider, body) => {
      const st = await orig(provider, body);
      safe(() => rec({ category: 'config', action: 'config.oauth_app_changed', severity: 'notice', summary: `The ${provider} sign-in app was changed.`, data: { provider } }));
      return st;
    });
    wrap(oauth, 'signOut', (orig) => async (provider) => {
      const r = await orig(provider);
      safe(() => rec({ category: 'auth', action: 'auth.signed_out', severity: 'notice', summary: `Signed out of ${provider}.`, data: { provider, revokedAtProvider: r.revokedAtProvider } }));
      return r;
    });
  }
}
