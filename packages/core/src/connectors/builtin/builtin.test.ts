import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createSlackServer, slackMessageText } from './slack.js';
import { ATLASSIAN_MCP_URL, normalizeAtlassianSite, presetConfig } from '../catalog.js';
import { createMcpHub, type RemoteClient } from '../mcp-hub.js';
import { createSecretStore, plainFileProtector } from '../secrets.js';

interface Seen { url: string; method: string; headers: Record<string, string>; body: unknown }

/** Fake fetch: routes on "METHOD path" prefixes; records every request. */
function fakeFetch(routes: Record<string, (req: Seen) => { status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const seen: Seen[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const req: Seen = { url, method, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(req);
    const u = new URL(url);
    const key = Object.keys(routes).find((k) => `${method} ${u.pathname}${u.search}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    const r = routes[key]!(req);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { impl, seen };
}

async function connect(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('');
    return { text, isError: !!r.isError, json: () => JSON.parse(text) as Record<string, unknown> };
  };
  return { client, call };
}

describe('Slack server', () => {
  const SLACK_ENV = { SLACK_TOKEN: 'xoxb-1-abc' };
  it('reads a channel by name with sender names, bot attachments included', async () => {
    const f = fakeFetch({
      'GET /api/conversations.list': () => ({ json: { ok: true, channels: [{ id: 'C111111', name: 'help-desk' }] } }),
      'GET /api/conversations.history': () => ({ json: { ok: true, messages: [
        { ts: '1763280000.000100', user: 'U123456', text: 'printer broken' },
        { ts: '1763270000.000100', bot_id: 'B999999', bot_profile: { name: 'Jira' }, text: '', attachments: [{ title: 'HELP-9 VPN', title_link: 'https://x/browse/HELP-9' }] },
      ] } }),
      'GET /api/users.info': () => ({ json: { ok: true, user: { id: 'U123456', real_name: 'Ann Lee', profile: { display_name: '' } } } }),
    });
    const { call } = await connect(createSlackServer(SLACK_ENV, { fetchImpl: f.impl }));
    const r = (await call('slack_read_channel', { channel: '#help-desk' })).json();
    expect(r).toMatchObject({ channel: 'help-desk', channel_id: 'C111111', messages: [{ from: 'Ann Lee', text: 'printer broken' }, { from: 'Jira', text: 'HELP-9 VPN\nhttps://x/browse/HELP-9' }] });
    expect(f.seen[0]!.headers.Authorization).toBe('Bearer xoxb-1-abc');
  });

  it('maps Slack errors to plain words and posts with JSON', async () => {
    const f = fakeFetch({
      'GET /api/search.messages': () => ({ json: { ok: false, error: 'not_allowed_token_type' } }),
      'POST /api/chat.postMessage': () => ({ json: { ok: true, ts: '1.2', channel: 'C111111' } }),
      'GET /api/chat.getPermalink': () => ({ json: { ok: true, permalink: 'https://slack/p1' } }),
    });
    const { call } = await connect(createSlackServer(SLACK_ENV, { fetchImpl: f.impl }));
    const s = await call('slack_search_messages', { query: 'vpn' });
    expect(s.isError).toBe(true);
    expect(s.text).toMatch(/user token/);
    expect((await call('slack_post_message', { channel: 'C111111', text: 'hi', thread_ts: '1.1' })).json()).toEqual({ posted: true, channel: 'C111111', ts: '1.2', link: 'https://slack/p1' });
    expect(f.seen.find((x) => x.url.endsWith('chat.postMessage'))!.body).toEqual({ channel: 'C111111', text: 'hi', thread_ts: '1.1', unfurl_links: false });
  });

  it('rejects a bad token and reads attachment text', () => {
    expect(() => createSlackServer({ SLACK_TOKEN: 'abc' })).toThrow(/xoxb/);
    expect(slackMessageText({ ts: '1', text: 'a', attachments: [{ fallback: 'b' }] })).toBe('a\nb');
  });
});

describe('presets in the hub', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-builtin-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('validates preset fields and the Atlassian address', () => {
    expect(normalizeAtlassianSite('acme.atlassian.net/jira/your-work')).toBe('https://acme.atlassian.net');
    expect(() => normalizeAtlassianSite('http://acme.atlassian.net')).toThrow(/https/);
    expect(() => presetConfig('atlassian', { site: 'acme.atlassian.net', email: 'nope', token: 't' })).toThrow(/email/);
    expect(() => presetConfig('atlassian', { site: 'acme.atlassian.net', email: 'a@b.io', token: ' ' })).toThrow(/token/);
    expect(() => presetConfig('slack', { token: 'nope' })).toThrow(/xoxb/);
    expect(presetConfig('slack', { token: ' xoxb-1-a ' }).settings).toEqual([{ name: 'SLACK_TOKEN', secret: true, value: 'xoxb-1-a' }]);
    // Service account key (no email) → Bearer.
    expect(presetConfig('atlassian', { site: 'acme.atlassian.net', email: '', token: 'svc-key' }).settings[0]).toEqual({ name: 'Authorization', secret: true, value: 'Bearer svc-key' });
  });

  it('adds Atlassian as the official MCP server: Basic header stored encrypted, the site kept for Sebeto only', async () => {
    const seen: Array<{ transport: unknown; env: Record<string, string> }> = [];
    const connect = async (transport: unknown, env: Record<string, string>): Promise<RemoteClient> => {
      seen.push({ transport, env });
      return { listTools: async () => [{ name: 'searchJiraIssuesUsingJql', annotations: { readOnlyHint: true } }, { name: 'addOrEditJiraIssueComment' }], callTool: async () => ({ text: '', isError: false }), close: async () => undefined };
    };
    const secrets = createSecretStore(dir, plainFileProtector());
    const hub = createMcpHub({ workspaceDir: dir, secrets, connect: connect as never });
    const c = await hub.add({ name: 'Atlassian', catalogId: 'atlassian', values: { site: 'https://acme.atlassian.net/', email: 'bot@acme.io', token: 'tok-secret' }, settings: [{ name: 'EXTRA', secret: false, value: 'ignored' }] });
    const basic = `Basic ${Buffer.from('bot@acme.io:tok-secret').toString('base64')}`;
    expect(c.transport).toEqual({ type: 'http', url: ATLASSIAN_MCP_URL });
    expect(c.settings).toEqual([{ name: 'Authorization', secret: true }, { name: 'SEBETO_ATLASSIAN_SITE', secret: false, value: 'acme.atlassian.net' }]);
    // Only the Authorization header goes to Atlassian.
    expect(seen[0]!.env).toEqual({ Authorization: basic });
    expect(fs.readFileSync(path.join(dir, 'connectors', 'custom', `${c.id}.json`), 'utf8')).not.toContain('tok-secret');
    expect(c.tools.map((t) => [t.name, t.suggested, t.reviewed])).toEqual([['searchJiraIssuesUsingJql', 'read', false], ['addOrEditJiraIssueComment', 'change', false]]);
    expect(await hub.settingsFor(c.id)).toEqual({ Authorization: basic, SEBETO_ATLASSIAN_SITE: 'acme.atlassian.net' });
    await expect(hub.add({ name: 'X', catalogId: 'custom', transport: { type: 'builtin', server: 'slack' } })).rejects.toThrow(/command or a URL/);
  });
});

describe('Slack message text', () => {
  it('reads Block Kit text (Jira app posts) and drops repeated lines', () => {
    const m = {
      ts: '1', text: 'New issue HELP-90',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'New issue HELP-90' } },
        { type: 'section', fields: [{ type: 'mrkdwn', text: '*Reporter:* Ann' }] },
        { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Laptop will not boot' }, { type: 'link', url: 'https://x/browse/HELP-90' }] }] },
      ],
    };
    expect(slackMessageText(m as never)).toBe('New issue HELP-90\n*Reporter:* Ann\nLaptop will not boot\nhttps://x/browse/HELP-90');
  });
});
