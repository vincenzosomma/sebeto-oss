/**
 * The connectors catalog shown in Settings → Connectors. "builtin" connectors have their own
 * screen (Gmail), "preset" ones are known MCP servers with a few fields, "custom" is your own
 * MCP server, and "planned" ones are listed so the owner sees what is coming.
 */
import type { CatalogEntry, ConnectorSetting, ConnectorTransport } from '@sebeto/shared';
import { SLACK_ENV, slackAppToken, slackToken } from './builtin/slack.js';

export const CATALOG: CatalogEntry[] = [
  {
    id: 'microsoft', name: 'Microsoft 365 / Outlook', category: 'Email & calendar', availability: 'builtin', fields: [],
    description: 'Work or school (Microsoft 365) or personal (Outlook.com, Hotmail) account, with "Sign in with Microsoft".',
    capabilities: 'Search and read your email, read your calendar, send email from your address (each email needs your approval).',
  },
  {
    id: 'google', name: 'Google (Gmail & Calendar)', category: 'Email & calendar', availability: 'builtin', fields: [],
    description: 'Google Workspace or personal Google account, with "Sign in with Google".',
    capabilities: 'Search and read your Gmail, read your Google Calendar, send email from your address (each email needs your approval).',
  },
  {
    id: 'gmail', name: 'Gmail (app password)', category: 'Email & calendar', availability: 'builtin', fields: [],
    description: 'Personal Gmail connected with a 16-letter app password, without Google sign-in.',
    capabilities: 'Search and read your email; send email from your address (each email needs your approval).',
  },
  {
    id: 'folder', name: 'Folder', category: 'Files', availability: 'preset',
    description: 'A folder on this computer or a mapped network share (for example runbooks or exports).',
    capabilities: 'List, search and read files in that folder. Writing tools are offered too, and stay off unless you allow them.',
    fields: [{ key: 'path', label: 'Folder', kind: 'path', placeholder: 'D:\\Shares\\Runbooks', help: 'Agents can only reach this folder and what is inside it.' }],
  },
  {
    id: 'atlassian', name: 'Jira & Confluence (Atlassian MCP)', category: 'Tickets & projects', availability: 'preset',
    description: 'Atlassian Cloud through Atlassian\'s official MCP server (mcp.atlassian.com), signed in with a scoped API token or a service account key.',
    capabilities: 'Atlassian\'s own tools: search and read Jira issues and Confluence pages; create and edit issues, comment (Jira Service Management internal notes or public replies), change status, create and edit pages. Each change needs your approval. Agents see only what that account can see.',
    fields: [
      { key: 'site', label: 'Atlassian address', kind: 'url', placeholder: 'https://your-company.atlassian.net', help: 'Tools need it as "cloudId"; Sebeto also uses it for Jira triggers.' },
      { key: 'email', label: 'Account email', kind: 'text', placeholder: 'you@your-company.com', optional: true, help: 'For a personal API token. Leave empty for a service account API key.' },
      { key: 'token', label: 'API token (with scopes) or service account key', kind: 'secret', help: 'id.atlassian.com → Security → API tokens → Create API token with scopes (a classic token without scopes is refused by the MCP server). Your org admin must allow API token authentication for the Rovo MCP server. Stored encrypted.' },
    ],
  },
  {
    id: 'slack', name: 'Slack', category: 'Chat', availability: 'preset',
    description: 'Your Slack workspace, through a Slack app token. Built into Sebeto: nothing is downloaded.',
    capabilities: 'List and read channels and threads, look up people, search messages (user token only); post messages and thread replies (each post needs your approval).',
    fields: [
      { key: 'token', label: 'Slack token', kind: 'secret', placeholder: 'xoxb-…', help: 'Bot token (xoxb-) from your Slack app (scopes: channels:read, channels:history, groups:read, groups:history, users:read, chat:write). Invite the app to the channels it should read. A user token (xoxp-) also allows search. Stored encrypted.' },
      { key: 'appToken', label: 'App-level token (optional)', kind: 'secret', placeholder: 'xapp-…', optional: true, help: 'Only for buttons in Slack DMs (Approve / Deny / Revise): an app-level token with connections:write, and Socket Mode + Interactivity turned on in the Slack app. Stored encrypted.' },
    ],
  },
  {
    id: 'custom', name: 'Your own MCP server', category: 'Custom', availability: 'custom', fields: [],
    description: 'Any Model Context Protocol server: started by a command on this computer, or reached by URL.',
    capabilities: 'Whatever tools the server offers. You review each tool and choose Read, Change, Production or Off.',
  },
  ...([
    ['servicenow', 'ServiceNow', 'Tickets & projects', 'Incidents, changes and the CMDB.', 'Look up incidents and CIs; update records with approval.'],
    ['github', 'GitHub', 'Code', 'Repositories, issues and pull requests.', 'Read code and issues; open issues or PRs with approval.'],
    ['teams', 'Microsoft Teams', 'Chat', 'Teams channels and chats.', 'Read channels; post messages with approval.'],
  ] as const).map(([id, name, category, description, capabilities]): CatalogEntry => ({
    id, name, category, description, capabilities, availability: 'planned', fields: [],
  })),
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id);
}

/** Atlassian's official remote MCP server (Streamable HTTP; /v1 is being retired). */
export const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v2/mcp';
/** Kept with the connector for Sebeto's own use (tools' cloudId, Jira triggers); never sent to the server. */
export const ATLASSIAN_SITE_SETTING = 'SEBETO_ATLASSIAN_SITE';

/** "your-company.atlassian.net", "https://…/jira/…" → "https://your-company.atlassian.net". */
export function normalizeAtlassianSite(raw: string): string {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`); } catch {
    throw new Error('Enter your Atlassian address, for example https://your-company.atlassian.net');
  }
  if (u.protocol !== 'https:') throw new Error('Use an https:// address for Atlassian.');
  if (!u.hostname.includes('.')) throw new Error('Enter your Atlassian address, for example https://your-company.atlassian.net');
  return `https://${u.host}`;
}

/** Transport for a preset, from its field values. Throws with a friendly message on bad input. */
export function presetTransport(id: string, values: Record<string, string>): ConnectorTransport {
  return presetConfig(id, values).transport;
}

/** Transport plus settings (environment for the server; secret ones are stored encrypted) for a preset. */
export function presetConfig(id: string, values: Record<string, string>): { transport: ConnectorTransport; settings: ConnectorSetting[] } {
  const v = (k: string) => (values[k] ?? '').trim();
  switch (id) {
    case 'atlassian': {
      const site = normalizeAtlassianSite(v('site'));
      const email = v('email');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter the email of the Atlassian account, or leave it empty for a service account key.');
      if (!v('token')) throw new Error('Paste the Atlassian API token or service account key.');
      return {
        transport: { type: 'http', url: ATLASSIAN_MCP_URL },
        settings: [
          // Personal API token → Basic email:token; service account API key → Bearer.
          { name: 'Authorization', secret: true, value: email ? `Basic ${Buffer.from(`${email}:${v('token')}`).toString('base64')}` : `Bearer ${v('token')}` },
          { name: ATLASSIAN_SITE_SETTING, secret: false, value: new URL(site).host },
        ],
      };
    }
    case 'slack':
      return {
        transport: { type: 'builtin', server: 'slack' },
        settings: [
          { name: SLACK_ENV.token, secret: true, value: slackToken({ [SLACK_ENV.token]: v('token') }) },
          ...((values.appToken ?? '').trim() ? [{ name: SLACK_ENV.appToken, secret: true, value: slackAppToken({ [SLACK_ENV.appToken]: values.appToken! }) }] : []),
        ],
      };
    case 'folder': {
      const p = (values.path ?? '').trim();
      if (!p) throw new Error('Choose a folder.');
      // Exact pinned version of the reference filesystem server (supply chain: no floating tags).
      return { transport: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', p] }, settings: [] };
    }
    default:
      throw new Error('This connector cannot be added this way.');
  }
}

/** Secret settings that can be set later on an existing preset connector (PUT /connectors/:id/secrets/:name). */
export const PRESET_EXTRA_SECRETS: Record<string, string[]> = {
  slack: [SLACK_ENV.appToken],
};
