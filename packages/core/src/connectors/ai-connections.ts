/**
 * v0.7 R: the owner's OpenAI-compatible AI connections (packages/shared/src/ai-connections.ts).
 *
 * Stored in <workspace>/ai-connections.json (no DB migration). The API key is NEVER in that file:
 * it goes to the secrets store (`ai-connection-<id>`, DPAPI on Windows) and the file only says
 * `hasApiKey`. Each connection becomes a runtime adapter `openai:<id>` (runtimes/openai-compat.ts),
 * rebuilt when the connection changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AI_CONNECTION_KINDS, AI_CONNECTION_LIMITS, aiConnectionRuntimeId, nowIso, uuidv7,
  type AiConnection, type AiConnectionTestResult, type AiModelPrice, type CreateAiConnectionBody, type Id, type RuntimeAdapter, type UpdateAiConnectionBody,
} from '@sebeto/shared';
import type { SecretStore } from './secrets.js';
import { checkEndpointUrl, createOpenAiCompatAdapter, EndpointError, type OpenAiCompatAdapterOptions } from '../runtimes/openai-compat.js';

export class AiConnectionError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not_found' = 'invalid') {
    super(message);
    this.name = 'AiConnectionError';
  }
}

export interface AiConnectionChange {
  before: AiConnection;
  after: AiConnection;
  /** Names of the fields that changed ('apiKey' when the key was set or removed; never its value). */
  changed: string[];
}

export interface AiConnectionStore {
  list(): AiConnection[];
  get(id: Id): AiConnection | undefined;
  create(body: CreateAiConnectionBody): Promise<AiConnection>;
  update(id: Id, patch: UpdateAiConnectionBody): Promise<AiConnectionChange>;
  remove(id: Id): Promise<AiConnection>;
  test(id: Id): Promise<AiConnectionTestResult>;
  /** One runtime adapter per connection (the runtime registry asks for these on every lookup). */
  adapters(): RuntimeAdapter[];
}

export interface AiConnectionStoreOptions {
  workspaceDir: string;
  secrets: SecretStore;
  /** Tests: a fake endpoint / fake tools. */
  adapterOptions?: Pick<OpenAiCompatAdapterOptions, 'fetchImpl' | 'connectTools' | 'maxTurns'>;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
/** Printable ASCII without spaces: no header injection through the key. */
const KEY_RE = /^[\x21-\x7e]{1,4096}$/;
const ID_RE = /^[0-9a-f-]{36}$/;

export const secretNameOf = (id: Id) => `ai-connection-${id}`;

function validName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 60) throw new AiConnectionError('Give the connection a name (up to 60 characters).');
  return n;
}

function validModel(m: unknown): string | null {
  if (m === null || m === undefined || m === '') return null;
  if (typeof m !== 'string' || !MODEL_RE.test(m.trim())) throw new AiConnectionError('The model name has characters that are not allowed.');
  return m.trim();
}

function validKey(k: unknown): string {
  if (typeof k !== 'string' || !KEY_RE.test(k.trim())) throw new AiConnectionError('The API key must be one line of printable characters, without spaces.');
  return k.trim();
}

function validPrices(p: unknown): Record<string, AiModelPrice> {
  if (p === undefined || p === null) return {};
  if (typeof p !== 'object' || Array.isArray(p)) throw new AiConnectionError('Invalid prices.');
  const entries = Object.entries(p as Record<string, unknown>);
  if (entries.length > AI_CONNECTION_LIMITS.maxPrices) throw new AiConnectionError(`At most ${AI_CONNECTION_LIMITS.maxPrices} model prices.`);
  const out: Record<string, AiModelPrice> = {};
  for (const [model, v] of entries) {
    const m = validModel(model);
    const price = v as Partial<AiModelPrice> | null;
    const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= AI_CONNECTION_LIMITS.maxPricePerM;
    if (!m || !price || !ok(price.inputPerM) || !ok(price.outputPerM)) throw new AiConnectionError(`Invalid price for ${model}: use dollars per 1 million tokens (0 to ${AI_CONNECTION_LIMITS.maxPricePerM}).`);
    out[m] = { inputPerM: price.inputPerM!, outputPerM: price.outputPerM! };
  }
  return out;
}

function validTimeout(t: unknown): number {
  if (t === undefined) return AI_CONNECTION_LIMITS.defaultReplyTimeoutMin;
  if (typeof t !== 'number' || !Number.isInteger(t) || t < AI_CONNECTION_LIMITS.minReplyTimeoutMin || t > AI_CONNECTION_LIMITS.maxReplyTimeoutMin) {
    throw new AiConnectionError(`The reply timeout must be ${AI_CONNECTION_LIMITS.minReplyTimeoutMin}–${AI_CONNECTION_LIMITS.maxReplyTimeoutMin} minutes.`);
  }
  return t;
}

function validContext(c: unknown): number | null {
  if (c === undefined || c === null) return null;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 2048 || c > 2_097_152) throw new AiConnectionError('The context window must be 2048–2097152 tokens, or empty.');
  return c;
}

function validKind(k: unknown): AiConnection['kind'] {
  if (!AI_CONNECTION_KINDS.includes(k as AiConnection['kind'])) throw new AiConnectionError("The kind must be 'local' or 'remote'.");
  return k as AiConnection['kind'];
}

function checkUrl(raw: unknown, kind: AiConnection['kind'], allowPrivateHttp: boolean): string {
  if (typeof raw !== 'string' || raw.length > 500) throw new AiConnectionError('Invalid address.');
  try {
    return checkEndpointUrl(raw, kind, allowPrivateHttp);
  } catch (err) {
    throw new AiConnectionError((err as EndpointError).message);
  }
}

/** Read the settings file; entries that fail validation are skipped (a hand edit cannot break the core). */
function load(file: string): AiConnection[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const list = (raw as { connections?: unknown })?.connections;
  if (!Array.isArray(list)) return [];
  const out: AiConnection[] = [];
  for (const c of list as Array<Partial<AiConnection>>) {
    try {
      if (typeof c.id !== 'string' || !ID_RE.test(c.id)) continue;
      const kind = validKind(c.kind);
      const allowPrivateHttp = c.allowPrivateHttp === true;
      out.push({
        id: c.id, runtimeId: aiConnectionRuntimeId(c.id), name: validName(c.name),
        baseUrl: checkUrl(c.baseUrl, kind, allowPrivateHttp), kind,
        defaultModel: validModel(c.defaultModel), hasApiKey: c.hasApiKey === true, allowPrivateHttp,
        prices: validPrices(c.prices), replyTimeoutMin: validTimeout(c.replyTimeoutMin), contextWindow: validContext(c.contextWindow),
        createdAt: typeof c.createdAt === 'string' ? c.createdAt : nowIso(), updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : nowIso(),
      });
    } catch { /* skip the invalid entry */ }
  }
  return out;
}

export function createAiConnectionStore(opts: AiConnectionStoreOptions): AiConnectionStore {
  const file = path.join(opts.workspaceDir, 'ai-connections.json');
  let connections = load(file);
  const adapterCache = new Map<Id, RuntimeAdapter>();

  const save = () => {
    fs.mkdirSync(opts.workspaceDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // The key is never part of AiConnection, so it cannot end up in this file.
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, connections }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  };
  const adapterOf = (c: AiConnection): RuntimeAdapter => {
    let a = adapterCache.get(c.id);
    if (!a) {
      a = createOpenAiCompatAdapter({
        ...opts.adapterOptions,
        connection: c,
        apiKey: async () => (c.hasApiKey ? opts.secrets.get(secretNameOf(c.id)) : null),
      });
      adapterCache.set(c.id, a);
    }
    return a;
  };
  const find = (id: Id) => {
    const c = connections.find((x) => x.id === id);
    if (!c) throw new AiConnectionError(`AI connection ${id} not found`, 'not_found');
    return c;
  };

  return {
    list: () => connections.map((c) => ({ ...c, prices: { ...c.prices } })),
    get: (id) => {
      const c = connections.find((x) => x.id === id);
      return c ? { ...c, prices: { ...c.prices } } : undefined;
    },

    async create(body) {
      if (connections.length >= AI_CONNECTION_LIMITS.maxConnections) throw new AiConnectionError(`At most ${AI_CONNECTION_LIMITS.maxConnections} AI connections.`);
      const kind = validKind(body.kind);
      const allowPrivateHttp = body.allowPrivateHttp === true;
      const id = uuidv7();
      const key = body.apiKey === undefined || body.apiKey === '' ? null : validKey(body.apiKey);
      const now = nowIso();
      const c: AiConnection = {
        id, runtimeId: aiConnectionRuntimeId(id), name: validName(body.name),
        baseUrl: checkUrl(body.baseUrl, kind, allowPrivateHttp), kind,
        defaultModel: validModel(body.defaultModel), hasApiKey: key !== null, allowPrivateHttp,
        prices: validPrices(body.prices), replyTimeoutMin: validTimeout(body.replyTimeoutMin), contextWindow: validContext(body.contextWindow),
        createdAt: now, updatedAt: now,
      };
      if (connections.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) throw new AiConnectionError(`An AI connection named "${c.name}" already exists.`);
      if (key) await opts.secrets.set(secretNameOf(id), key);
      connections = [...connections, c];
      save();
      return { ...c };
    },

    async update(id, patch) {
      const before = find(id);
      const kind = patch.kind === undefined ? before.kind : validKind(patch.kind);
      const allowPrivateHttp = patch.allowPrivateHttp === undefined ? before.allowPrivateHttp : patch.allowPrivateHttp === true;
      const next: AiConnection = {
        ...before,
        name: patch.name === undefined ? before.name : validName(patch.name),
        kind, allowPrivateHttp,
        // Re-checked even when only the kind or the http permission changes.
        baseUrl: checkUrl(patch.baseUrl ?? before.baseUrl, kind, allowPrivateHttp),
        defaultModel: patch.defaultModel === undefined ? before.defaultModel : validModel(patch.defaultModel),
        prices: patch.prices === undefined ? before.prices : validPrices(patch.prices),
        replyTimeoutMin: patch.replyTimeoutMin === undefined ? before.replyTimeoutMin : validTimeout(patch.replyTimeoutMin),
        contextWindow: patch.contextWindow === undefined ? before.contextWindow : validContext(patch.contextWindow),
        updatedAt: nowIso(),
      };
      if (next.name !== before.name && connections.some((x) => x.id !== id && x.name.toLowerCase() === next.name.toLowerCase())) {
        throw new AiConnectionError(`An AI connection named "${next.name}" already exists.`);
      }
      const changed: string[] = [];
      if (patch.apiKey !== undefined) {
        if (patch.apiKey === null || patch.apiKey === '') {
          if (before.hasApiKey) changed.push('apiKey');
          await opts.secrets.delete(secretNameOf(id));
          next.hasApiKey = false;
        } else {
          await opts.secrets.set(secretNameOf(id), validKey(patch.apiKey));
          next.hasApiKey = true;
          changed.push('apiKey');
        }
      }
      for (const k of ['name', 'baseUrl', 'kind', 'defaultModel', 'allowPrivateHttp', 'replyTimeoutMin', 'contextWindow'] as const) {
        if (next[k] !== before[k]) changed.push(k);
      }
      if (JSON.stringify(next.prices) !== JSON.stringify(before.prices)) changed.push('prices');
      connections = connections.map((x) => (x.id === id ? next : x));
      adapterCache.delete(id);
      save();
      return { before: { ...before }, after: { ...next }, changed };
    },

    async remove(id) {
      const c = find(id);
      await opts.secrets.delete(secretNameOf(id));
      connections = connections.filter((x) => x.id !== id);
      adapterCache.delete(id);
      save();
      return { ...c };
    },

    async test(id) {
      const c = find(id);
      // A fresh adapter: no cached detection.
      adapterCache.delete(id);
      const a = adapterOf(c);
      const started = Date.now();
      const detection = await a.detect();
      const models = detection.installed ? await a.models() : [];
      return { ok: detection.installed && detection.loggedIn !== false && !detection.problem, models, problem: detection.problem ?? null, latencyMs: Date.now() - started };
    },

    adapters: () => connections.map(adapterOf),
  };
}
