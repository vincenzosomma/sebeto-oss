/** MCP servers that ship inside Sebeto and run in-process (docs/37 Atlassian & Slack Connectors.md). */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BuiltinServerId } from '@sebeto/shared';
import { createSlackServer } from './slack.js';
import type { FetchLike } from './common.js';

export { createSlackServer, slackClient, slackToken, slackMessageText, resolveChannel, SLACK_ENV, type SlackMessage, type SlackCall } from './slack.js';
export { BuiltinError } from './common.js';

export function createBuiltinServer(id: BuiltinServerId, env: Record<string, string>, opts: { fetchImpl?: FetchLike } = {}): McpServer {
  switch (id) {
    case 'slack': return createSlackServer(env, opts);
    default: throw new Error(`Unknown built-in connector "${String(id)}"`);
  }
}
