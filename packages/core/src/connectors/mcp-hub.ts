/**
 * McpHub: Sebeto's side of custom MCP servers (docs/25 Connectors & Custom MCP.md).
 *
 * - Stores each connector in <workspace>/connectors/custom/<id>.json (no secrets inside) and its
 *   secret settings in the SecretStore ("conn-<id>-<n>").
 * - Connects lazily (stdio: starts the command; http: Streamable HTTP), discovers tools, and keeps
 *   one client per connector. A crash marks the connector "error"; the next call reconnects.
 * - Tool review: each discovered tool gets a suggested level and stays unusable until the owner
 *   reviews it. A tool whose name/description/inputs change goes back to "not reviewed".
 * - Calls have a timeout and an output cap. The hub never decides permissions: the tool server
 *   gates every call before it reaches here.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  uuidv7,
  type AddConnectorBody, type ConnectorInfo, type ConnectorSetting, type ConnectorStatus, type ConnectorTool,
  type ConnectorTransport, type Id, type ToolLevel, type UpdateConnectorBody, BUILTIN_SERVERS,
} from '@sebeto/shared';
import { createBuiltinServer } from './builtin/index.js';
import type { SecretStore } from './secrets.js';
import { PRESET_EXTRA_SECRETS, catalogEntry, presetConfig } from './catalog.js';

export const CALL_TIMEOUT_MS = 60_000;
export const CONNECT_TIMEOUT_MS = 90_000; // npx may download the server the first time
export const OUTPUT_MAX_CHARS = 100_000;

export class ConnectorError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'not_found' | 'unavailable' = 'invalid') {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** What a remote tool says about itself (subset of MCP Tool). */
export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** The part of an MCP client the hub uses; tests provide a fake. */
export interface RemoteClient {
  listTools(): Promise<RemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}
export type RemoteConnect = (transport: ConnectorTransport, env: Record<string, string>) => Promise<RemoteClient>;

interface Stored {
  id: Id; name: string; catalogId: string; transport: ConnectorTransport;
  settings: Array<{ name: string; secret: boolean; value?: string; secretRef?: string }>;
  enabled: boolean; allowedAgents: Id[] | null; tools: ConnectorTool[]; createdAt: string;
}

const READ_NAME = /^(get|list|read|search|find|query|describe|fetch|show|lookup|count|view|directory_tree|stat)/i;

/** Suggested level: the server's hints first, then the tool name. Exported for tests. */
export function suggestLevel(t: RemoteTool): ToolLevel {
  if (t.annotations?.destructiveHint) return 'change';
  if (t.annotations?.readOnlyHint) return 'read';
  return READ_NAME.test(t.name) ? 'read' : 'change';
}

export function fingerprint(t: RemoteTool): string {
  return createHash('sha256').update(JSON.stringify([t.name, t.description ?? '', t.inputSchema ?? {}])).digest('hex').slice(0, 16);
}

/**
 * Merge a fresh tool list into the stored one: unchanged tools keep their review; new or changed
 * tools are not reviewed (and keep any earlier level only as the starting choice). Exported for tests.
 */
export function mergeTools(previous: ConnectorTool[], remote: RemoteTool[]): ConnectorTool[] {
  const before = new Map(previous.map((t) => [t.name, t]));
  return remote.map((r) => {
    const fp = fingerprint(r);
    const old = before.get(r.name);
    const suggested = suggestLevel(r);
    const same = !!old && old.fingerprint === fp;
    return {
      name: r.name, description: (r.description ?? '').slice(0, 2000), inputSchema: r.inputSchema ?? { type: 'object' },
      fingerprint: fp, suggested,
      level: same ? old!.level : old ? old.level : suggested,
      reviewed: same ? old!.reviewed : false,
    };
  });
}

/** Default way to reach a server: the official MCP client over stdio or Streamable HTTP. */
export const sdkConnect: RemoteConnect = async (transport, env) => {
  let t: Transport;
  let closeServer: (() => Promise<void>) | null = null;
  if (transport.type === 'builtin') {
    // Ships inside Sebeto: run it in-process over a linked in-memory transport (no child process).
    const server = createBuiltinServer(transport.server, env);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    closeServer = () => server.close();
    t = clientSide;
  } else if (transport.type === 'stdio') {
    t = new StdioClientTransport({
      command: transport.command, args: transport.args,
      // Only a minimal environment plus the connector's own settings: no Sebeto secrets.
      env: { ...getDefaultEnvironment(), ...env }, stderr: 'ignore',
    });
  } else {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) headers[k] = v;
    t = new StreamableHTTPClientTransport(new URL(transport.url), { requestInit: { headers } });
  }
  const client = new Client({ name: 'sebeto', version: '0.2' });
  await client.connect(t, { timeout: CONNECT_TIMEOUT_MS });
  return {
    async listTools() {
      const out: RemoteTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: CALL_TIMEOUT_MS });
        out.push(...(page.tools as RemoteTool[]));
        cursor = page.nextCursor;
      } while (cursor && out.length < 500);
      return out;
    },
    async callTool(name, args, signal) {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal });
      const parts = (res.content as Array<{ type: string; text?: string; mimeType?: string }> | undefined) ?? [];
      const text = parts.map((p) => (p.type === 'text' ? p.text ?? '' : `[${p.type}${p.mimeType ? ` ${p.mimeType}` : ''} not shown]`)).join('\n');
      return { text, isError: !!res.isError };
    },
    close: async () => { await client.close(); await closeServer?.().catch(() => undefined); },
  };
};

export interface McpHub {
  list(): ConnectorInfo[];
  get(id: Id): ConnectorInfo | undefined;
  /** Adds, starts and discovers tools (all tools start unreviewed). Throws ConnectorError. */
  add(body: AddConnectorBody): Promise<ConnectorInfo>;
  update(id: Id, patch: UpdateConnectorBody): ConnectorInfo;
  /**
   * Set one secret setting of a preset connector, among the names its preset allows
   * (PRESET_EXTRA_SECRETS, e.g. Slack's app-level token). Empty value removes it.
   */
  setSecretSetting(id: Id, name: string, value: string): Promise<void>;
  /** Reconnects and rediscovers tools. */
  refresh(id: Id): Promise<ConnectorInfo>;
  remove(id: Id): Promise<void>;
  /** Tools an agent may be offered: enabled connector, agent allowed, tool reviewed and not off. */
  toolsFor(agentId: Id | null): Array<{ connector: ConnectorInfo; tool: ConnectorTool; exposedName: string }>;
  call(id: Id, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean; truncated: boolean }>;
  /**
   * The connector's settings with secrets decrypted, for Sebeto's own code only (Slack channel
   * triggers). Never returned by the API or offered to agents. Throws when not found or turned off.
   */
  settingsFor(id: Id): Promise<Record<string, string>>;
  closeAll(): Promise<void>;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'tools';

export function createMcpHub(opts: { workspaceDir: string; secrets: SecretStore; connect?: RemoteConnect; onChange?: () => void }): McpHub {
  const connect = opts.connect ?? sdkConnect;
  const dir = path.join(opts.workspaceDir, 'connectors', 'custom');
  const stored = new Map<Id, Stored>();
  const live = new Map<Id, Promise<RemoteClient>>();
  const status = new Map<Id, { status: ConnectorStatus; error: string | null }>();

  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Stored;
        stored.set(s.id, s);
      } catch { /* skip a damaged file */ }
    }
  } catch { /* no connectors yet */ }

  const persist = (s: Stored) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s, null, 2), 'utf8');
  };
  const changed = () => opts.onChange?.();

  const info = (s: Stored): ConnectorInfo => {
    const st = status.get(s.id) ?? { status: s.enabled ? 'not_started' as const : 'disabled' as const, error: null };
    return {
      id: s.id, name: s.name, catalogId: s.catalogId, transport: s.transport,
      settings: s.settings.map((x): ConnectorSetting => (x.secret ? { name: x.name, secret: true } : { name: x.name, secret: false, value: x.value ?? '' })),
      enabled: s.enabled, allowedAgents: s.allowedAgents, tools: s.tools,
      status: s.enabled ? st.status : 'disabled', error: s.enabled ? st.error : null, createdAt: s.createdAt,
    };
  };

  const must = (id: Id): Stored => {
    const s = stored.get(id);
    if (!s) throw new ConnectorError('Connector not found', 'not_found');
    return s;
  };

  /** Settings named SEBETO_* are for Sebeto itself (e.g. the Atlassian site) and are not sent to the server. */
  async function envOf(s: Stored, forServer = true): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const x of s.settings) {
      if (forServer && x.name.startsWith('SEBETO_')) continue;
      const v = x.secret && x.secretRef ? await opts.secrets.get(x.secretRef) : x.value;
      if (v != null) env[x.name] = v;
    }
    return env;
  }

  async function drop(id: Id): Promise<void> {
    const p = live.get(id);
    live.delete(id);
    if (p) await p.then((c) => c.close()).catch(() => undefined);
  }

  function clientOf(s: Stored): Promise<RemoteClient> {
    let p = live.get(s.id);
    if (!p) {
      p = envOf(s).then((env) => connect(s.transport, env)).then(
        (c) => { status.set(s.id, { status: 'connected', error: null }); return c; },
        (err: unknown) => {
          live.delete(s.id);
          status.set(s.id, { status: 'error', error: friendly(err) });
          throw new ConnectorError(`Could not start "${s.name}": ${friendly(err)}`, 'unavailable');
        },
      );
      live.set(s.id, p);
    }
    return p;
  }

  async function discover(s: Stored): Promise<void> {
    const client = await clientOf(s);
    try {
      s.tools = mergeTools(s.tools, await client.listTools());
    } catch (err) {
      status.set(s.id, { status: 'error', error: friendly(err) });
      await drop(s.id);
      throw new ConnectorError(`"${s.name}" did not list its tools: ${friendly(err)}`, 'unavailable');
    }
    persist(s);
  }

  function validate(t: ConnectorTransport): ConnectorTransport {
    if (t.type === 'builtin') {
      if (!BUILTIN_SERVERS.includes(t.server)) throw new ConnectorError('Unknown built-in connector.');
      return { type: 'builtin', server: t.server };
    }
    if (t.type === 'stdio') {
      const command = t.command.trim();
      if (!command || /[\r\n]/.test(command)) throw new ConnectorError('Enter the command that starts the server.');
      return { type: 'stdio', command, args: t.args.map((a) => String(a)).slice(0, 50) };
    }
    let u: URL;
    try { u = new URL(t.url); } catch { throw new ConnectorError('Enter a valid URL.'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) {
      throw new ConnectorError('Use an https:// URL (http:// only for servers on this computer).');
    }
    return { type: 'http', url: u.toString() };
  }

  return {
    list: () => [...stored.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(info),
    get: (id) => (stored.has(id) ? info(stored.get(id)!) : undefined),

    async add(body) {
      const entry = catalogEntry(body.catalogId);
      if (!entry || (entry.availability !== 'preset' && entry.availability !== 'custom')) throw new ConnectorError('This connector cannot be added here.');
      const name = body.name.trim().slice(0, 60);
      if (!name) throw new ConnectorError('Give the connector a name.');
      let transport: ConnectorTransport;
      let presetSettings: ConnectorSetting[] = [];
      try {
        if (entry.availability === 'custom') {
          if (!body.transport) throw new ConnectorError('Choose a command or a URL.');
          if (body.transport.type === 'builtin') throw new ConnectorError('Choose a command or a URL.');
          transport = validate(body.transport);
        } else {
          const cfg = presetConfig(entry.id, body.values ?? {});
          transport = validate(cfg.transport);
          presetSettings = cfg.settings;
        }
      } catch (err) {
        throw err instanceof ConnectorError ? err : new ConnectorError((err as Error).message);
      }
      const id = uuidv7();
      const settings: Stored['settings'] = [];
      // Presets build their own settings from the form; extra settings are only for your own server.
      const requested = entry.availability === 'custom' ? body.settings ?? [] : presetSettings;
      for (const [i, x] of requested.entries()) {
        const n = x.name.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(n)) throw new ConnectorError(`"${x.name}" is not a valid setting name.`);
        if (x.secret) {
          const ref = `conn-${id.slice(-12).toLowerCase()}-${i}`;
          await opts.secrets.set(ref, x.value ?? '');
          settings.push({ name: n, secret: true, secretRef: ref });
        } else settings.push({ name: n, secret: false, value: x.value ?? '' });
      }
      const s: Stored = {
        id, name, catalogId: entry.id, transport, settings, enabled: true,
        allowedAgents: body.allowedAgents ?? null, tools: [], createdAt: new Date().toISOString(),
      };
      stored.set(id, s);
      persist(s);
      try {
        await discover(s);
      } finally {
        changed();
      }
      return info(s);
    },

    update(id, patch) {
      const s = must(id);
      if (patch.name !== undefined) {
        const n = patch.name.trim().slice(0, 60);
        if (!n) throw new ConnectorError('Give the connector a name.');
        s.name = n;
      }
      if (patch.allowedAgents !== undefined) s.allowedAgents = patch.allowedAgents;
      if (patch.tools) {
        for (const p of patch.tools) {
          const t = s.tools.find((x) => x.name === p.name);
          if (t) { t.level = p.level; t.reviewed = true; }
        }
      }
      if (patch.enabled !== undefined && patch.enabled !== s.enabled) {
        s.enabled = patch.enabled;
        if (!s.enabled) void drop(id);
      }
      persist(s);
      changed();
      return info(s);
    },

    async setSecretSetting(id, name, value) {
      const s = must(id);
      if (!(PRESET_EXTRA_SECRETS[s.catalogId] ?? []).includes(name)) throw new ConnectorError(`"${name}" cannot be set on this connector.`);
      const i = s.settings.findIndex((x) => x.name === name);
      const old = i >= 0 ? s.settings[i] : undefined;
      if (!value) {
        if (old?.secretRef) await opts.secrets.delete(old.secretRef);
        if (i >= 0) s.settings.splice(i, 1);
      } else {
        const ref = old?.secretRef ?? `conn-${id.slice(-12).toLowerCase()}-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        await opts.secrets.set(ref, value);
        if (i < 0) s.settings.push({ name, secret: true, secretRef: ref });
      }
      persist(s);
      changed();
    },

    async refresh(id) {
      const s = must(id);
      await drop(id);
      try {
        await discover(s);
      } finally {
        changed();
      }
      return info(s);
    },

    async remove(id) {
      const s = must(id);
      await drop(id);
      for (const x of s.settings) if (x.secretRef) await opts.secrets.delete(x.secretRef);
      stored.delete(id);
      status.delete(id);
      fs.rmSync(path.join(dir, `${id}.json`), { force: true });
      changed();
    },

    toolsFor(agentId) {
      const out: Array<{ connector: ConnectorInfo; tool: ConnectorTool; exposedName: string }> = [];
      const used = new Set<string>();
      for (const s of [...stored.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!s.enabled) continue;
        if (s.allowedAgents && (!agentId || !s.allowedAgents.includes(agentId))) continue;
        const c = info(s);
        let prefix = slug(s.name);
        while ([...used].some((u) => u.startsWith(`${prefix}__`))) prefix = `${prefix}_${s.id.slice(-3)}`.slice(0, 24);
        for (const t of s.tools) {
          if (!t.reviewed || t.level === 'off') continue;
          const exposedName = `${prefix}__${t.name.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);
          if (used.has(exposedName)) continue;
          used.add(exposedName);
          out.push({ connector: c, tool: t, exposedName });
        }
      }
      return out;
    },

    async call(id, tool, args, signal) {
      const s = must(id);
      if (!s.enabled) throw new ConnectorError(`"${s.name}" is turned off.`, 'unavailable');
      const client = await clientOf(s);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      signal?.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        const res = await client.callTool(tool, args, controller.signal);
        const truncated = res.text.length > OUTPUT_MAX_CHARS;
        return { text: truncated ? res.text.slice(0, OUTPUT_MAX_CHARS) : res.text, isError: res.isError, truncated };
      } catch (err) {
        // A broken connection is dropped so the next call reconnects.
        status.set(s.id, { status: 'error', error: friendly(err) });
        await drop(id);
        throw new ConnectorError(`"${s.name}" failed: ${friendly(err)}`, 'unavailable');
      } finally {
        clearTimeout(timer);
      }
    },

    async settingsFor(id) {
      const s = must(id);
      if (!s.enabled) throw new ConnectorError(`"${s.name}" is turned off.`, 'unavailable');
      return envOf(s, false);
    },

    async closeAll() {
      await Promise.all([...live.keys()].map(drop));
    },
  };
}

function friendly(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e.code === 'ENOENT') return 'the command was not found on this computer';
  return (e.message ?? String(err)).split('\n')[0]!.slice(0, 300);
}
