import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectorTransport } from '@sebeto/shared';
import { createMcpHub, mergeTools, suggestLevel, type RemoteClient, type RemoteTool } from './mcp-hub.js';
import { createSecretStore, type Protector } from './secrets.js';
import { presetTransport } from './catalog.js';

const xor: Protector = { kind: 'dpapi', protect: async (b) => Buffer.from(b.map((x) => x ^ 0x33)), unprotect: async (b) => Buffer.from(b.map((x) => x ^ 0x33)) };

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-hub-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const TOOLS: RemoteTool[] = [
  { name: 'list_incidents', description: 'List open incidents', inputSchema: { type: 'object', properties: { team: { type: 'string' } } } },
  { name: 'close_incident', description: 'Close an incident', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'wipe', description: 'Delete things', annotations: { destructiveHint: true } },
];

function fakeServer(tools: RemoteTool[] = TOOLS) {
  const seen: Array<{ transport: ConnectorTransport; env: Record<string, string> }> = [];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let current = tools;
  let fail = false;
  const connect = async (transport: ConnectorTransport, env: Record<string, string>): Promise<RemoteClient> => {
    if (fail) throw Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' });
    seen.push({ transport, env });
    return {
      listTools: async () => current,
      callTool: async (name, args) => { calls.push({ name, args }); return { text: `ok ${name}`, isError: false }; },
      close: async () => undefined,
    };
  };
  return { connect, seen, calls, setTools: (t: RemoteTool[]) => { current = t; }, setFail: (f: boolean) => { fail = f; } };
}

describe('tool review helpers', () => {
  it('suggests levels from hints and names', () => {
    expect(TOOLS.map(suggestLevel)).toEqual(['read', 'change', 'change']);
    expect(suggestLevel({ name: 'do_it', annotations: { readOnlyHint: true } })).toBe('read');
  });

  it('keeps reviews for unchanged tools and resets changed ones', () => {
    const first = mergeTools([], TOOLS).map((t) => ({ ...t, reviewed: true, level: t.name === 'wipe' ? 'off' as const : t.level }));
    const changed = mergeTools(first, [TOOLS[0]!, { ...TOOLS[1]!, description: 'Close AND delete an incident' }, TOOLS[2]!, { name: 'new_tool' }]);
    expect(changed.map((t) => [t.name, t.reviewed, t.level])).toEqual([
      ['list_incidents', true, 'read'], ['close_incident', false, 'change'], ['wipe', true, 'off'], ['new_tool', false, 'change'],
    ]);
  });
});

describe('McpHub', () => {
  it('adds a custom server: secrets encrypted, tools unreviewed and not offered until reviewed', async () => {
    const srv = fakeServer();
    const hub = createMcpHub({ workspaceDir: dir, secrets: createSecretStore(dir, xor), connect: srv.connect });
    const c = await hub.add({
      name: 'Service Desk', catalogId: 'custom', transport: { type: 'stdio', command: 'node', args: ['server.js'] },
      settings: [{ name: 'SD_URL', secret: false, value: 'https://sd.example.it' }, { name: 'SD_TOKEN', secret: true, value: 'tok-123' }],
    });
    expect(c.tools.map((t) => [t.name, t.reviewed, t.suggested])).toEqual([['list_incidents', false, 'read'], ['close_incident', false, 'change'], ['wipe', false, 'change']]);
    expect(c.settings).toEqual([{ name: 'SD_URL', secret: false, value: 'https://sd.example.it' }, { name: 'SD_TOKEN', secret: true }]);
    expect(srv.seen[0]!.env).toEqual({ SD_URL: 'https://sd.example.it', SD_TOKEN: 'tok-123' });
    const saved = fs.readFileSync(path.join(dir, 'connectors', 'custom', `${c.id}.json`), 'utf8');
    expect(saved).not.toContain('tok-123');
    expect(hub.toolsFor(null)).toEqual([]);

    hub.update(c.id, { tools: [{ name: 'list_incidents', level: 'read' }, { name: 'close_incident', level: 'change' }, { name: 'wipe', level: 'off' }] });
    expect(hub.toolsFor(null).map((x) => x.exposedName)).toEqual(['service_desk__list_incidents', 'service_desk__close_incident']);

    // Per-agent access and disabling.
    hub.update(c.id, { allowedAgents: ['agent-a'] });
    expect(hub.toolsFor('agent-b')).toEqual([]);
    expect(hub.toolsFor('agent-a')).toHaveLength(2);
    hub.update(c.id, { enabled: false });
    expect(hub.toolsFor('agent-a')).toEqual([]);
    expect(hub.get(c.id)!.status).toBe('disabled');
    await expect(hub.call(c.id, 'list_incidents', {})).rejects.toThrow(/turned off/);
  });

  it('calls tools, survives restarts, re-reviews changed tools, removes secrets', async () => {
    const srv = fakeServer();
    const secrets = createSecretStore(dir, xor);
    const hub = createMcpHub({ workspaceDir: dir, secrets, connect: srv.connect });
    const c = await hub.add({ name: 'SD', catalogId: 'custom', transport: { type: 'http', url: 'https://mcp.example.it/mcp' }, settings: [{ name: 'Authorization', secret: true, value: 'Bearer x' }] });
    hub.update(c.id, { tools: TOOLS.map((t) => ({ name: t.name, level: 'read' as const })) });
    expect(await hub.call(c.id, 'list_incidents', { team: 'net' })).toEqual({ text: 'ok list_incidents', isError: false, truncated: false });
    expect(srv.calls).toEqual([{ name: 'list_incidents', args: { team: 'net' } }]);
    expect(hub.get(c.id)!.status).toBe('connected');

    // Restart: settings and reviews come back from disk.
    const again = createMcpHub({ workspaceDir: dir, secrets: createSecretStore(dir, xor), connect: srv.connect });
    expect(again.toolsFor(null)).toHaveLength(3);
    srv.setTools([TOOLS[0]!, { ...TOOLS[1]!, inputSchema: { type: 'object', properties: { id: { type: 'string' }, force: { type: 'boolean' } } } }]);
    const refreshed = await again.refresh(c.id);
    expect(refreshed.tools.map((t) => [t.name, t.reviewed])).toEqual([['list_incidents', true], ['close_incident', false]]);
    expect(again.toolsFor(null).map((x) => x.tool.name)).toEqual(['list_incidents']);

    await again.remove(c.id);
    expect(again.list()).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'secrets'))).toEqual([]);
  });

  it('reports start failures and validates input', async () => {
    const srv = fakeServer();
    srv.setFail(true);
    const hub = createMcpHub({ workspaceDir: dir, secrets: createSecretStore(dir, xor), connect: srv.connect });
    await expect(hub.add({ name: 'X', catalogId: 'custom', transport: { type: 'stdio', command: 'nope', args: [] } })).rejects.toThrow(/command was not found/);
    expect(hub.list()[0]!.status).toBe('error');
    await expect(hub.add({ name: 'Y', catalogId: 'custom', transport: { type: 'http', url: 'http://evil.example/mcp' } })).rejects.toThrow(/https/);
    await expect(hub.add({ name: 'Z', catalogId: 'jira' })).rejects.toThrow(/cannot be added/);
    await expect(hub.add({ name: 'W', catalogId: 'custom', transport: { type: 'stdio', command: 'x', args: [] }, settings: [{ name: 'BAD NAME', secret: false }] })).rejects.toThrow(/not a valid setting/);
    expect(presetTransport('folder', { path: 'D:\\Runbooks' })).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', 'D:\\Runbooks'] });
  });
});
