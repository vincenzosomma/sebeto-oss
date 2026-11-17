import { describe, expect, it } from 'vitest';
import { claudeMcpSlug, DEFAULT_PERMISSIONS } from '@sebeto/shared';
import { buildClaudeArgs, parseClaudeMcpList, SEBETO_APPROVE_TOOL } from './claude-cli.js';
import { claudeToolDecision } from '../tools/server.js';
import { openDatabase } from '../storage/index.js';
import { claudeConnectorsFor } from '../connectors/claude-access.js';
import { createSettingsStore } from '../settings.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = { model: 'sonnet', budgetUsd: 1, permissions: DEFAULT_PERMISSIONS, mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' } };
const files = { systemPromptFile: '/tmp/sp.md', mcpConfigFile: '/tmp/mcp.json' };

describe("the owner's Claude connectors", () => {
  it('slugs match the tool prefixes Claude Code uses', () => {
    expect(claudeMcpSlug('claude.ai Atlassian – Acme')).toBe('claude_ai_Atlassian_Acme');
    expect(claudeMcpSlug('claude.ai Slack')).toBe('claude_ai_Slack');
    expect(claudeMcpSlug('mdm')).toBe('mdm');
  });

  it('without connectors: strict MCP config, no prompt tool', () => {
    const args = buildClaudeArgs(run, files);
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--permission-prompt-tool');
  });

  it('with connectors: their servers load, every call is routed to approve_tool, nothing pre-allowed', () => {
    const args = buildClaudeArgs({ ...run, claudeConnectors: ['claude.ai Slack'] }, files);
    expect(args).not.toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe(SEBETO_APPROVE_TOOL);
    const allowed = args[args.indexOf('--allowedTools') + 1]!;
    expect(allowed).not.toMatch(/claude_ai/);
    // Without Sebeto's MCP server there is nobody to ask: stay strict.
    expect(buildClaudeArgs({ ...run, claudeConnectors: ['claude.ai Slack'] }, { systemPromptFile: '/tmp/sp.md' })).toContain('--strict-mcp-config');
  });

  it('decides each call: other connectors refused, look-ups read, the rest change', () => {
    const allowed = ['claude.ai Atlassian – Acme', 'claude.ai Slack'];
    expect(claudeToolDecision('mcp__claude_ai_Atlassian_Acme__getJiraIssue', allowed)).toEqual({ kind: 'gate', level: 'read', server: 'claude.ai Atlassian – Acme', tool: 'getJiraIssue' });
    expect(claudeToolDecision('mcp__claude_ai_Atlassian_Acme__searchJiraIssuesUsingJql', allowed)).toMatchObject({ level: 'read' });
    expect(claudeToolDecision('mcp__claude_ai_Slack__slack_read_thread', allowed)).toMatchObject({ level: 'read' });
    expect(claudeToolDecision('mcp__claude_ai_Atlassian_Acme__addCommentToJiraIssue', allowed)).toMatchObject({ level: 'change' });
    expect(claudeToolDecision('mcp__claude_ai_Atlassian_Acme__transitionJiraIssue', allowed)).toMatchObject({ level: 'change' });
    expect(claudeToolDecision('mcp__claude_ai_Slack__slack_send_message', allowed)).toMatchObject({ level: 'change' });
    expect(claudeToolDecision('mcp__mdm__erase-device', allowed)).toMatchObject({ kind: 'deny' });
    expect(claudeToolDecision('mcp__claude_ai_Gmail__send_message', allowed)).toMatchObject({ kind: 'deny' });
    expect(claudeToolDecision('Bash', allowed)).toMatchObject({ kind: 'deny' });
    expect(claudeToolDecision('mcp__claude_ai_Slack__slack_read_channel', [])).toMatchObject({ kind: 'deny' });
  });

  it('tells look-ups from changes by the words of the tool name, and asks every time when unsure', async () => {
    const { isLookupTool } = await import('../tools/server.js');
    // Look-ups, including prefixed and verb-less status/info names (T-15).
    for (const t of ['notion-get-self', 'getJiraIssue', 'atlassianUserInfo', 'getAccessibleAtlassianResources', 'slack_read_thread',
      'slack_search_channels', 'connection_status', 'guide', 'list_labels', 'get-tags', 'download_gmail_attachment', 'query-data-sources',
      'list_certified_queries', 'get_resource_guide']) expect([t, isLookupTool(t)]).toEqual([t, true]);
    // Changes, or unsure (no verb): asked every time.
    for (const t of ['notion-create-pages', 'addCommentToJiraIssue', 'transitionJiraIssue', 'slack_send_message', 'send_message',
      'erase-device', 'execute_zapier_read_action', 'tracker_projects', 'tracker_issue_transition', 'export-device-data',
      'update_values', 'create_draft', 'scan_package', 'docs_draft_create', 'memory-store', 'mark_invoice_paid', 'generate_summary',
      'list_and_delete', 'get-device-export', 'resolveIssue', 'check_and_fix']) expect([t, isLookupTool(t)]).toEqual([t, false]);
  });

  it("the owner's look-up list turns a verb-less tool into a look-up, exact names only", () => {
    const allowed = ['claude.ai Tracker MCP'];
    expect(claudeToolDecision('mcp__claude_ai_Tracker_MCP__tracker_projects', allowed)).toMatchObject({ level: 'change' });
    expect(claudeToolDecision('mcp__claude_ai_Tracker_MCP__tracker_projects', allowed, ['tracker_projects'])).toMatchObject({ level: 'read' });
    expect(claudeToolDecision('mcp__claude_ai_Tracker_MCP__tracker_issue_transition', allowed, ['tracker_projects'])).toMatchObject({ level: 'change' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-lk-'));
    const store = createSettingsStore(dir);
    expect(store.update({ claudeLookupTools: [' tracker_projects ', 'tracker_projects', 'tracker_measures'] }).claudeLookupTools).toEqual(['tracker_projects', 'tracker_measures']);
    expect(() => store.update({ claudeLookupTools: ['bad name!'] })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses claude mcp list', () => {
    const out = `Checking MCP server health…

claude.ai Atlassian – Acme: https://mcp.atlassian.com/v1/mcp - ✔ Connected
claude.ai Linear: https://mcp.linear.app/mcp - ! Needs authentication
mdm: npx -y mdm-mcp - ✔ Connected`;
    expect(parseClaudeMcpList(out)).toEqual([
      { name: 'claude.ai Atlassian – Acme', slug: 'claude_ai_Atlassian_Acme', connected: true, status: 'Connected' },
      { name: 'claude.ai Linear', slug: 'claude_ai_Linear', connected: false, status: 'Needs authentication' },
      { name: 'mdm', slug: 'mdm', connected: true, status: 'Connected' },
    ]);
  });

  it('agents keep their chosen connectors', () => {
    const { repos } = openDatabase({ file: ':memory:', workspaceDir: '/tmp' });
    const a = repos.agents.create({ name: 'Help Desk', claudeConnectors: ['claude.ai Slack', 'claude.ai Slack', ' claude.ai Atlassian – Acme '] });
    expect(a.claudeConnectors).toEqual(['claude.ai Slack', 'claude.ai Atlassian – Acme']);
    expect(repos.agents.update(a.id, { claudeConnectors: [] }).claudeConnectors).toEqual([]);
    expect(repos.agents.update(a.id, { name: 'Renamed' }).claudeConnectors).toEqual([]);
    repos.close();
  });
});

describe('system prompt', () => {
  it("names the agent's Claude connectors only for Claude Code agents that have some", async () => {
    const { buildSystemPrompt } = await import('../executor/prompts.js');
    const ticket = { number: 7, title: 'Return laptop', tags: [], origin: null } as never;
    const base = { name: 'Help Desk', role: 'IT support', job: '', runtime: 'claude-cli', claudeConnectors: ['claude.ai Atlassian – Acme', 'claude.ai Notion'] } as never;
    const p = buildSystemPrompt(base, ticket);
    expect(p).toContain("connectors from the owner's Claude account: claude.ai Atlassian – Acme, claude.ai Notion");
    expect(p).toContain('mcp__claude_ai_Atlassian_Acme__');
    expect(buildSystemPrompt({ ...(base as object), claudeConnectors: [] } as never, ticket)).not.toContain("owner's Claude account");
    expect(buildSystemPrompt({ ...(base as object), runtime: 'ollama' } as never, ticket)).not.toContain("owner's Claude account");
  });

  it('tells a Claude Code agent without connectors to ask for one, instead of "not loaded"', async () => {
    const { buildSystemPrompt } = await import('../executor/prompts.js');
    const ticket = { number: 10, title: 'Record in Jira', tags: [], origin: null } as never;
    const p = buildSystemPrompt({ name: 'Infra', role: '', job: '', runtime: 'claude-cli', claudeConnectors: [] } as never, ticket);
    expect(p).toContain('request_claude_connector');
    expect(p).toContain('Do not say they do not exist');
    expect(buildSystemPrompt({ name: 'Local', role: '', job: '', runtime: 'ollama' } as never, ticket)).not.toContain('request_claude_connector');
  });
});

describe('Claude connectors for all agents', () => {
  it("adds the workspace's all-agents list to the agent's own ticks, without duplicates", () => {
    expect(claudeConnectorsFor({ claudeConnectors: ['claude.ai Slack'] }, { claudeConnectorsAllAgents: ['claude.ai Atlassian – Acme', 'claude.ai Slack'] }))
      .toEqual(['claude.ai Slack', 'claude.ai Atlassian – Acme']);
    expect(claudeConnectorsFor({ claudeConnectors: [] }, { claudeConnectorsAllAgents: ['claude.ai Gmail'] })).toEqual(['claude.ai Gmail']);
    expect(claudeConnectorsFor({}, undefined)).toEqual([]);
    expect(claudeConnectorsFor(null, { claudeConnectorsAllAgents: ['claude.ai Gmail'] })).toEqual([]);
  });

  it('an agent with no ticks may call an all-agents connector, still through the gate', () => {
    const allowed = claudeConnectorsFor({ claudeConnectors: [] }, { claudeConnectorsAllAgents: ['claude.ai Atlassian – Acme'] });
    expect(claudeToolDecision('mcp__claude_ai_Atlassian_Acme__createJiraIssue', allowed)).toMatchObject({ kind: 'gate', level: 'change' });
    const denied = claudeToolDecision('mcp__claude_ai_Slack__slack_send_message', allowed);
    expect(denied.kind).toBe('deny');
    expect(denied.kind === 'deny' && denied.reason).toContain('request_claude_connector');
  });

  it("adds the team's connectors for its members", () => {
    expect(claudeConnectorsFor({ claudeConnectors: ['claude.ai Slack'] }, { claudeConnectorsAllAgents: ['claude.ai Gmail'] }, { claudeConnectors: ['claude.ai Atlassian – Acme', 'claude.ai Slack'] }))
      .toEqual(['claude.ai Slack', 'claude.ai Atlassian – Acme', 'claude.ai Gmail']);
    expect(claudeConnectorsFor({ claudeConnectors: [] }, undefined, null)).toEqual([]);
  });

  it('teams keep their connectors (create, update, clear)', () => {
    const { repos } = openDatabase({ file: ':memory:', workspaceDir: '/tmp' });
    const t = repos.teams!.create({ slug: 'infra', name: 'Infrastructure', description: '', color: '#0E5A8A', leadAgentId: null, routingHints: '', claudeConnectors: ['claude.ai Atlassian – Acme', ' claude.ai Atlassian – Acme '] });
    expect(t.claudeConnectors).toEqual(['claude.ai Atlassian – Acme']);
    expect(repos.teams!.update(t.id, { name: 'Infra' }).claudeConnectors).toEqual(['claude.ai Atlassian – Acme']);
    expect(repos.teams!.update(t.id, { claudeConnectors: [] }).claudeConnectors).toEqual([]);
    expect(repos.teams!.create({ slug: 'sd', name: 'Service Desk', description: '', color: '#0E5A8A', leadAgentId: null, routingHints: '' }).claudeConnectors).toEqual([]);
    repos.close();
  });

  it('is saved in settings.json, cleaned, and invalid values are refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebeto-cc-'));
    const store = createSettingsStore(dir);
    expect(store.get().claudeConnectorsAllAgents).toBeUndefined();
    expect(store.update({ claudeConnectorsAllAgents: [' claude.ai Slack ', 'claude.ai Slack', 'claude.ai Gmail'] }).claudeConnectorsAllAgents).toEqual(['claude.ai Slack', 'claude.ai Gmail']);
    expect(createSettingsStore(dir).get().claudeConnectorsAllAgents).toEqual(['claude.ai Slack', 'claude.ai Gmail']);
    expect(() => store.update({ claudeConnectorsAllAgents: [''] })).toThrow();
    expect(() => store.update({ claudeConnectorsAllAgents: 'x' as never })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
