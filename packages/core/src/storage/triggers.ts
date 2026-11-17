/** Triggers and their fires (v0.4 §D; tables from migration v6). */
import type Database from 'better-sqlite3';
import {
  nowIso, uuidv7, type Id, type TicketBlueprint, type Trigger, type TriggerConfig, type TriggerFire, type TriggerFireOutcome, type TriggerKind,
} from '@sebeto/shared';
import type { NewTriggerFire, StoredTrigger, TriggerRepo, TriggerState } from '../contracts.js';

interface TriggerRow {
  id: string; name: string; kind: TriggerKind; enabled: number; config: string; blueprint: string;
  dedupe_window_minutes: number; secret_hash: string | null; state: string | null;
  last_fired_at: string | null; fire_count: number; created_at: string; updated_at: string;
}
interface FireRow {
  id: string; trigger_id: string; at: string; outcome: TriggerFireOutcome; ticket_id: string | null; dedupe_key: string | null; detail: string;
  ticket_number: number | null;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const hookPathOf = (id: Id) => `/api/v1/hooks/${id}`;

function toTrigger(r: TriggerRow): StoredTrigger {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled === 1,
    config: parseJson<TriggerConfig>(r.config, { kind: r.kind } as TriggerConfig),
    blueprint: parseJson<TicketBlueprint>(r.blueprint, {
      title: r.name, goal: '', teamId: null, agentId: null, projectId: null, tags: [], costCapUsd: null, autoStart: false,
    }),
    dedupeWindowMinutes: r.dedupe_window_minutes,
    hookPath: r.kind === 'webhook' ? hookPathOf(r.id) : null,
    hasSecret: !!r.secret_hash,
    lastFiredAt: r.last_fired_at,
    fireCount: r.fire_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    secretHash: r.secret_hash,
    state: parseJson<TriggerState>(r.state, {}),
  };
}

const toFire = (r: FireRow): TriggerFire => ({
  id: r.id, triggerId: r.trigger_id, at: r.at, outcome: r.outcome, ticketId: r.ticket_id, ticketNumber: r.ticket_number, detail: r.detail,
});

/** The public shape (no secret hash, no internal state). */
export function publicTrigger(t: StoredTrigger): Trigger {
  const { secretHash: _h, state: _s, ...rest } = t;
  return rest;
}

const FIRE_SELECT = 'SELECT f.*, t.number AS ticket_number FROM trigger_fires f LEFT JOIN tickets t ON t.id = f.ticket_id';

export function createTriggerRepo(db: Database.Database): TriggerRepo {
  const stmts = {
    get: db.prepare<[string], TriggerRow>('SELECT * FROM triggers WHERE id = ?'),
    list: db.prepare<[], TriggerRow>('SELECT * FROM triggers ORDER BY name COLLATE NOCASE, id'),
    insert: db.prepare(`INSERT INTO triggers (id, name, kind, enabled, config, blueprint, dedupe_window_minutes, secret_hash, state,
      last_fired_at, fire_count, created_at, updated_at)
      VALUES (@id, @name, @kind, @enabled, @config, @blueprint, @dedupe, @secretHash, @state, NULL, 0, @now, @now)`),
    update: db.prepare(`UPDATE triggers SET name = @name, enabled = @enabled, config = @config, blueprint = @blueprint,
      dedupe_window_minutes = @dedupe, secret_hash = @secretHash, updated_at = @now WHERE id = @id`),
    setState: db.prepare('UPDATE triggers SET state = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM triggers WHERE id = ?'),
    disableAll: db.prepare('UPDATE triggers SET enabled = 0, updated_at = ? WHERE enabled = 1'),
    insertFire: db.prepare(`INSERT INTO trigger_fires (id, trigger_id, at, outcome, ticket_id, dedupe_key, detail)
      VALUES (@id, @triggerId, @at, @outcome, @ticketId, @dedupeKey, @detail)`),
    counted: db.prepare('UPDATE triggers SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?'),
    fire: db.prepare<[string], FireRow>(`${FIRE_SELECT} WHERE f.id = ?`),
    fires: db.prepare<[string, number], FireRow>(`${FIRE_SELECT} WHERE f.trigger_id = ? ORDER BY f.at DESC, f.id DESC LIMIT ?`),
    created: db.prepare<[string, string, string], { ticket_id: string }>(
      `SELECT ticket_id FROM trigger_fires WHERE trigger_id = ? AND dedupe_key = ? AND outcome = 'created' AND ticket_id IS NOT NULL AND at >= ?
       ORDER BY at DESC, id DESC LIMIT 5`),
    hasKey: db.prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM trigger_fires WHERE trigger_id = ? AND dedupe_key = ? AND outcome IN ('created','commented','ignored')`),
  };

  const get = (id: Id) => {
    const r = stmts.get.get(id);
    return r ? toTrigger(r) : undefined;
  };

  return {
    get,
    list: () => stmts.list.all().map(toTrigger),
    create(input) {
      const id = input.id ?? uuidv7();
      stmts.insert.run({
        id, name: input.name, kind: input.config.kind, enabled: input.enabled ? 1 : 0, config: JSON.stringify(input.config),
        blueprint: JSON.stringify(input.blueprint), dedupe: input.dedupeWindowMinutes, secretHash: input.secretHash ?? null,
        state: JSON.stringify(input.state ?? {}), now: nowIso(),
      });
      return get(id)!;
    },
    update(id, patch) {
      const cur = get(id);
      if (!cur) throw new Error(`Trigger not found: ${id}`);
      const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as StoredTrigger;
      stmts.update.run({
        id, name: next.name, enabled: next.enabled ? 1 : 0, config: JSON.stringify(next.config), blueprint: JSON.stringify(next.blueprint),
        dedupe: next.dedupeWindowMinutes, secretHash: next.secretHash, now: nowIso(),
      });
      if (patch.state !== undefined) stmts.setState.run(JSON.stringify(patch.state), id);
      return get(id)!;
    },
    setState(id, state) {
      stmts.setState.run(JSON.stringify(state), id);
    },
    remove: (id) => stmts.remove.run(id).changes > 0,
    disableAll: () => stmts.disableAll.run(nowIso()).changes,
    recordFire(input: NewTriggerFire): TriggerFire {
      const id = uuidv7();
      const at = input.at ?? nowIso();
      db.transaction(() => {
        stmts.insertFire.run({
          id, triggerId: input.triggerId, at, outcome: input.outcome, ticketId: input.ticketId ?? null,
          dedupeKey: input.dedupeKey ?? null, detail: input.detail.slice(0, 500),
        });
        if (input.outcome === 'created' || input.outcome === 'commented' || input.outcome === 'ignored') stmts.counted.run(at, input.triggerId);
      }).immediate();
      return toFire(stmts.fire.get(id)!);
    },
    listFires: (triggerId, limit = 50) => stmts.fires.all(triggerId, Math.max(1, Math.min(200, limit))).map(toFire),
    createdTicketsFor: (triggerId, dedupeKey, sinceIso) => stmts.created.all(triggerId, dedupeKey, sinceIso).map((r) => r.ticket_id),
    seenKey: (triggerId, dedupeKey) => stmts.hasKey.get(triggerId, dedupeKey)!.n > 0,
  };
}
