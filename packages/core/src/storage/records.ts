/**
 * Repositories for the per-ticket history: sessions, runs, messages, audit events,
 * permission requests and status transitions.
 */
import type Database from 'better-sqlite3';
import {
  nowIso, uuidv7,
  type AuditEvent, type CommandSpec, type ConnectorActivation, type Id, type Message, type Page, type PermissionKey, type PermissionRequest,
  type Run, type Session, type StatusTransition, type TrustedCommand,
} from '@sebeto/shared';
import type {
  AuditRepo, MessageRepo, PermissionRepo, RunRepo, SessionRepo, TransitionRepo, TrustedCommandRepo,
} from '../contracts.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

function notFound(what: string, id: Id): never {
  throw new Error(`${what} not found: ${id}`);
}

/**
 * "Latest page, oldest first" pagination over a per-ticket table keyed by UUIDv7 id:
 * the first page holds the newest `limit` rows; `nextCursor` walks towards older rows.
 * Items inside each page are returned oldest first (chat / log order).
 */
function pageLatestFirst<Row extends { id: string }, T>(
  db: Database.Database,
  table: string,
  ticketId: Id,
  opts: { cursor?: string | null; limit?: number } | undefined,
  map: (row: Row) => T,
): Page<T> {
  const limit = clampLimit(opts?.limit);
  const params: unknown[] = [ticketId];
  let cursorSql = '';
  if (opts?.cursor) {
    const [beforeId] = decodeCursor(opts.cursor, 1) as [string];
    cursorSql = 'AND id < ?';
    params.push(beforeId);
  }
  const rows = db
    .prepare<unknown[], Row>(`SELECT * FROM ${table} WHERE ticket_id = ? ${cursorSql} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const oldest = page[page.length - 1];
  return {
    items: page.reverse().map(map),
    nextCursor: hasMore && oldest ? encodeCursor([oldest.id]) : null,
  };
}

// ---------------------------------------------------------------- sessions
interface SessionRow {
  id: string; ticket_id: string; agent_id: string | null; runtime: string; model: string | null;
  external_session_id: string | null; reason: Session['reason']; started_at: string; ended_at: string | null;
}
const toSession = (r: SessionRow): Session => ({
  id: r.id, ticketId: r.ticket_id, agentId: r.agent_id, runtime: r.runtime, model: r.model,
  externalSessionId: r.external_session_id, reason: r.reason, startedAt: r.started_at, endedAt: r.ended_at,
});

export function createSessionRepo(db: Database.Database): SessionRepo {
  const get = db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO sessions (id, ticket_id, agent_id, runtime, model, external_session_id, reason, started_at, ended_at)
    VALUES (@id, @ticketId, @agentId, @runtime, @model, @externalSessionId, @reason, @startedAt, NULL)`);
  const setExt = db.prepare('UPDATE sessions SET external_session_id = ? WHERE id = ?');
  const end = db.prepare('UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE id = ?');
  const forTicket = db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE ticket_id = ? ORDER BY id');
  const load = (id: Id): Session => {
    const row = get.get(id);
    return row ? toSession(row) : notFound('Session', id);
  };
  return {
    create(input) {
      const id = uuidv7();
      insert.run({ ...input, id, externalSessionId: input.externalSessionId ?? null, startedAt: nowIso() });
      return load(id);
    },
    get(id) {
      const row = get.get(id);
      return row ? toSession(row) : undefined;
    },
    setExternalId(id, ext) {
      if (setExt.run(ext, id).changes === 0) notFound('Session', id);
      return load(id);
    },
    end(id) {
      if (end.run(nowIso(), id).changes === 0) notFound('Session', id);
      return load(id);
    },
    listForTicket: (ticketId) => forTicket.all(ticketId).map(toSession),
  };
}

// ---------------------------------------------------------------- runs
interface RunRow {
  id: string; session_id: string; ticket_id: string; job_id: string | null; trigger: Run['trigger'];
  status: Run['status']; started_at: string; ended_at: string | null; tokens_in: number; tokens_out: number;
  cost_usd: number; exit_reason: string | null; snapshot_before: string | null; snapshot_after: string | null;
}
const toRun = (r: RunRow): Run => ({
  id: r.id, sessionId: r.session_id, ticketId: r.ticket_id, jobId: r.job_id, trigger: r.trigger, status: r.status,
  startedAt: r.started_at, endedAt: r.ended_at, tokensIn: r.tokens_in, tokensOut: r.tokens_out, costUsd: r.cost_usd,
  exitReason: r.exit_reason, snapshotBefore: r.snapshot_before, snapshotAfter: r.snapshot_after,
});
const RUN_COLUMNS = {
  status: 'status', endedAt: 'ended_at', tokensIn: 'tokens_in', tokensOut: 'tokens_out', costUsd: 'cost_usd',
  exitReason: 'exit_reason', snapshotBefore: 'snapshot_before', snapshotAfter: 'snapshot_after',
} as const satisfies Partial<Record<keyof Run, keyof RunRow>>;

export function createRunRepo(db: Database.Database): RunRepo {
  const get = db.prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO runs (id, session_id, ticket_id, job_id, trigger, status, started_at)
    VALUES (@id, @sessionId, @ticketId, @jobId, @trigger, 'running', @startedAt)`);
  const forTicket = db.prepare<[string, number], RunRow>('SELECT * FROM runs WHERE ticket_id = ? ORDER BY id DESC LIMIT ?');
  const failOrphans = db.prepare(
    "UPDATE runs SET status = 'failed', ended_at = ?, exit_reason = ? WHERE status = 'running'");
  const load = (id: Id): Run => {
    const row = get.get(id);
    return row ? toRun(row) : notFound('Run', id);
  };
  return {
    create(input) {
      const id = uuidv7();
      insert.run({ ...input, id, startedAt: nowIso() });
      return load(id);
    },
    get(id) {
      const row = get.get(id);
      return row ? toRun(row) : undefined;
    },
    update(id, patch) {
      const sets: string[] = [];
      const values: Record<string, unknown> = { id };
      for (const [key, col] of Object.entries(RUN_COLUMNS)) {
        const v = patch[key as keyof typeof RUN_COLUMNS];
        if (v === undefined) continue;
        sets.push(`${col} = @${col}`);
        values[col] = v;
      }
      if (sets.length > 0) {
        if (db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id`).run(values).changes === 0) notFound('Run', id);
      }
      return load(id);
    },
    listForTicket: (ticketId, limit) => forTicket.all(ticketId, clampLimit(limit)).map(toRun),
    failOrphans: (reason) => failOrphans.run(nowIso(), reason).changes,
  };
}

// ---------------------------------------------------------------- messages
interface MessageRow {
  id: string; ticket_id: string; run_id: string | null; role: Message['role']; author: string; text: string; created_at: string;
}
const toMessage = (r: MessageRow): Message => ({
  id: r.id, ticketId: r.ticket_id, runId: r.run_id, role: r.role, author: r.author, text: r.text, createdAt: r.created_at,
});

export function createMessageRepo(db: Database.Database): MessageRepo {
  const insert = db.prepare(`
    INSERT INTO messages (id, ticket_id, run_id, role, author, text, created_at)
    VALUES (@id, @ticketId, @runId, @role, @author, @text, @createdAt)`);
  const get = db.prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?');
  return {
    create(input) {
      const id = uuidv7();
      insert.run({ ...input, id, runId: input.runId ?? null, createdAt: nowIso() });
      return toMessage(get.get(id)!);
    },
    listForTicket: (ticketId, opts) => pageLatestFirst<MessageRow, Message>(db, 'messages', ticketId, opts, toMessage),
  };
}

// ---------------------------------------------------------------- audit
interface AuditRow {
  id: string; ticket_id: string; run_id: string | null; kind: AuditEvent['kind']; summary: string; data: string | null; created_at: string;
}
const toAudit = (r: AuditRow): AuditEvent => ({
  id: r.id, ticketId: r.ticket_id, runId: r.run_id, kind: r.kind, summary: r.summary,
  data: r.data === null ? null : (JSON.parse(r.data) as Record<string, unknown>), createdAt: r.created_at,
});

export function createAuditRepo(db: Database.Database): AuditRepo {
  const insert = db.prepare(`
    INSERT INTO audit_events (id, ticket_id, run_id, kind, summary, data, created_at)
    VALUES (@id, @ticketId, @runId, @kind, @summary, @data, @createdAt)`);
  const get = db.prepare<[string], AuditRow>('SELECT * FROM audit_events WHERE id = ?');
  return {
    append(input) {
      const id = uuidv7();
      insert.run({
        id, ticketId: input.ticketId, runId: input.runId ?? null, kind: input.kind, summary: input.summary,
        data: input.data == null ? null : JSON.stringify(input.data), createdAt: nowIso(),
      });
      return toAudit(get.get(id)!);
    },
    listForTicket: (ticketId, opts) => pageLatestFirst<AuditRow, AuditEvent>(db, 'audit_events', ticketId, opts, toAudit),
  };
}

// ---------------------------------------------------------------- permission requests
interface PermissionRow {
  id: string; ticket_id: string; run_id: string | null; agent_id: string | null; key: PermissionKey; title: string;
  detail: string; provenance: string | null; state: PermissionRequest['state']; created_at: string; decided_at: string | null;
  command: string | null; always_allowed: number; consumed_at: string | null; task_scoped: number; connector?: string | null;
}
const toPermission = (r: PermissionRow): PermissionRequest => ({
  id: r.id, ticketId: r.ticket_id, runId: r.run_id, agentId: r.agent_id, key: r.key, title: r.title, detail: r.detail,
  provenance: r.provenance, command: r.command ? (JSON.parse(r.command) as CommandSpec) : null,
  state: r.state, alwaysAllowed: r.always_allowed === 1, taskScoped: r.task_scoped === 1,
  connector: r.connector ? (JSON.parse(r.connector) as ConnectorActivation) : null,
  createdAt: r.created_at, decidedAt: r.decided_at,
});

export function createPermissionRepo(db: Database.Database): PermissionRepo {
  const insert = db.prepare(`
    INSERT INTO permission_requests (id, ticket_id, run_id, agent_id, key, title, detail, provenance, command, connector, state, created_at)
    VALUES (@id, @ticketId, @runId, @agentId, @key, @title, @detail, @provenance, @command, @connector, 'pending', @createdAt)`);
  const get = db.prepare<[string], PermissionRow>('SELECT * FROM permission_requests WHERE id = ?');
  const decide = db.prepare(
    "UPDATE permission_requests SET state = ?, decided_at = ?, always_allowed = ?, task_scoped = ? WHERE id = ? AND state = 'pending'");
  const forTicket = db.prepare<[string], PermissionRow>('SELECT * FROM permission_requests WHERE ticket_id = ? ORDER BY id');
  const pending = db.prepare<[string], PermissionRow>(
    "SELECT * FROM permission_requests WHERE ticket_id = ? AND state = 'pending' ORDER BY id");
  const consume = db.prepare(
    "UPDATE permission_requests SET consumed_at = ? WHERE id = ? AND state = 'allowed' AND consumed_at IS NULL");
  const load = (id: Id): PermissionRequest => {
    const row = get.get(id);
    return row ? toPermission(row) : notFound('Permission request', id);
  };
  return {
    create(input) {
      const id = uuidv7();
      insert.run({
        id, ticketId: input.ticketId, runId: input.runId, agentId: input.agentId, key: input.key, title: input.title,
        detail: input.detail, provenance: input.provenance,
        command: input.command ? JSON.stringify({ shell: input.command.shell, command: input.command.command }) : null,
        connector: input.connector ? JSON.stringify({ name: input.connector.name, teamId: input.connector.teamId, teamName: input.connector.teamName }) : null,
        createdAt: nowIso(),
      });
      return load(id);
    },
    get(id) {
      const row = get.get(id);
      return row ? toPermission(row) : undefined;
    },
    decide(id, state, opts) {
      const allowed = state === 'allowed';
      if (decide.run(state, nowIso(), allowed && opts?.always ? 1 : 0, allowed && opts?.taskScoped ? 1 : 0, id).changes === 0) {
        const cur = load(id); // throws when missing
        throw new Error(`Permission request ${id} was already decided (${cur.state})`);
      }
      return load(id);
    },
    listForTicket: (ticketId) => forTicket.all(ticketId).map(toPermission),
    pendingForTicket: (ticketId) => pending.all(ticketId).map(toPermission),
    consume: (id) => consume.run(nowIso(), id).changes === 1,
    consumedAt(id) {
      const row = get.get(id);
      return row ? row.consumed_at : undefined;
    },
  };
}

// ---------------------------------------------------------------- trusted commands
interface TrustedRow { id: string; shell: string; command: string; request_id: string | null; created_at: string }
const toTrusted = (r: TrustedRow): TrustedCommand => ({
  id: r.id, shell: r.shell, command: r.command, requestId: r.request_id, createdAt: r.created_at,
});

/** Trusted commands match on the exact text, ignoring only leading/trailing whitespace. */
export const normalizeCommand = (command: string): string => command.trim();

export function createTrustedCommandRepo(db: Database.Database): TrustedCommandRepo {
  const insert = db.prepare(`
    INSERT INTO trusted_commands (id, shell, command, request_id, created_at) VALUES (@id, @shell, @command, @requestId, @createdAt)
    ON CONFLICT (shell, command) DO NOTHING`);
  const find = db.prepare<[string, string], TrustedRow>('SELECT * FROM trusted_commands WHERE shell = ? AND command = ?');
  const all = db.prepare<[], TrustedRow>('SELECT * FROM trusted_commands ORDER BY id');
  const del = db.prepare('DELETE FROM trusted_commands WHERE id = ?');
  return {
    add(input) {
      const command = normalizeCommand(input.command);
      if (!command) throw new Error('A trusted command cannot be empty');
      insert.run({ id: uuidv7(), shell: input.shell, command, requestId: input.requestId ?? null, createdAt: nowIso() });
      return toTrusted(find.get(input.shell, command)!);
    },
    find(spec) {
      const row = find.get(spec.shell, normalizeCommand(spec.command));
      return row ? toTrusted(row) : undefined;
    },
    list: () => all.all().map(toTrusted),
    remove: (id) => del.run(id).changes > 0,
  };
}

// ---------------------------------------------------------------- status transitions
interface TransitionRow {
  id: string; ticket_id: string; from_status: StatusTransition['from']; to_status: StatusTransition['to'];
  cause: StatusTransition['cause']; run_id: string | null; note: string | null; created_at: string;
}
const toTransition = (r: TransitionRow): StatusTransition => ({
  id: r.id, ticketId: r.ticket_id, from: r.from_status, to: r.to_status, cause: r.cause, runId: r.run_id,
  note: r.note, createdAt: r.created_at,
});

export function createTransitionRepo(db: Database.Database): TransitionRepo {
  const insert = db.prepare(`
    INSERT INTO status_transitions (id, ticket_id, from_status, to_status, cause, run_id, note, created_at)
    VALUES (@id, @ticketId, @from, @to, @cause, @runId, @note, @createdAt)`);
  const get = db.prepare<[string], TransitionRow>('SELECT * FROM status_transitions WHERE id = ?');
  const forTicket = db.prepare<[string], TransitionRow>('SELECT * FROM status_transitions WHERE ticket_id = ? ORDER BY id');
  return {
    append(t) {
      const id = uuidv7();
      insert.run({ id, ticketId: t.ticketId, from: t.from, to: t.to, cause: t.cause, runId: t.runId, note: t.note, createdAt: nowIso() });
      return toTransition(get.get(id)!);
    },
    listForTicket: (ticketId) => forTicket.all(ticketId).map(toTransition),
  };
}
