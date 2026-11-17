---
tags: [sebeto, connectors, claude, mcp, permissions, v0.9]
created: 2026-11-16
---

# Agents use the owner's Claude connectors (v0.9, 2026-11-16)

**Owner request (2026-11-16):** "I want to use Claude's MCP for this, as it already has all my MCP and at
the end it is using my Claude." The owner's Claude account already has Atlassian, Slack, Gmail,
Google Drive… connected. Asking for separate API tokens per system in Sebeto was rejected.

## What the owner gets
- **Agents page → an agent on Claude Code → "Your Claude connectors"**: *Show my Claude connectors*
  lists what `claude mcp list` reports (claude.ai connectors and local MCP servers); tick the ones this
  agent may use (for example *claude.ai Atlassian – Acme*, *claude.ai Slack*, *claude.ai Notion*).
  Since 2026-11-17 a connector can also be turned on **for a whole team** or **for all agents**, and
  agents can **ask** for one (see below).
- The agent then uses them with the owner's Claude login: no tokens in Sebeto, no extra cost beyond the
  Claude subscription.
- **Every call still goes through Sebeto's permission gate:**
  - connectors not ticked on the agent → refused (e.g. an MDM's erase/lock tools);
  - look-ups → `tool.read`, asked **once per ticket per connector**. Since 2026-11-17 (`isLookupTool`) a tool
    is a look-up when a word of its name (split on `_ - .` and camelCase) is a look-up word (get, list, read,
    search, find, query, fetch, view, download, status, info, guide, self…) and **no** word changes something
    (create, update, send, post, delete, transition, execute, export, scan, generate…). So `notion-get-self`,
    `atlassianUserInfo` and `enrolment_status` are look-ups; `execute_zapier_read_action` is not. A name with no
    verb (`quality_projects`) counts as a change: when unsure, ask every time. Found by the T-15 connector test;
    the owner can list exact tool names that only read under *Tools that only look things up* (agent page,
    workspace setting `claudeLookupTools`) and they are then asked once per ticket like other look-ups;
  - everything else (comment, transition, post, create, update) → `tool.change`, asked **every time**, showing the tool and its arguments;
  - every decision is in the ticket history and the security log.
- What these connectors return reaches the model directly (Sebeto cannot inspect it), so the first
  approved call marks the rest of the run **untrusted**: outbound actions always ask.

## Who may use which connector (2026-11-17)
**Why:** T-10 ran on the Infrastructure Lead, which had no connectors ticked. It told the owner the Claude
connectors "aren't loaded" and went looking for a Jira CLI with stored credentials. The owner wanted
connectors per team, and agents able to ask for them.

An agent on Claude Code may use the union of:
1. **its own ticks** (`agents.claude_connectors`, v13);
2. **its team's connectors**: Teams window → edit a team → *Claude connectors for this team*
   (`teams.claude_connectors`, migration **v15**); on the agent page they show as "on for the team X";
3. **the all-agents list**: the *All agents* switch beside each connector on an agent page
   (`settings.json` → `claudeConnectorsAllAgents`), saved immediately.

`claudeConnectorsFor(agent, settings, team)` (`connectors/claude-access.ts`) computes it for the executor
(runtime arguments), the system prompt and `approve_tool`. Turning a connector on only makes it
available: every call still goes through the gate as described above.

### Agents can ask: `request_claude_connector`
- A Sebeto tool for every agent on Claude Code: `{ connector, reason }`. The connector is matched by
  exact name or a word in it, only among **connected** connectors ("Jira"/"Confluence" find Atlassian,
  "calendar" finds Google Calendar); ambiguous or unknown names return the list to choose from.
  `claude mcp list` is cached for 10 minutes.
- `gate.requestConnector` always asks (whatever the agent's levels), reuses an identical pending request,
  and a denial in the same run is final. The ticket moves to **Needs you**.
- The request (`permission_requests.connector`, v15) shows a card with **Turn on for <agent>**
  (decision `allow`), **Turn on for the team <team>** (decision `team`, only when the agent has a team)
  and **Deny**. "Allow for this task" and "Always allow" don't apply.
- On approval Sebeto adds the connector to the agent or the team, records it in the security log
  (`agent.claude_connector_on` / `team.claude_connector_on`) and resumes the agent; the next run loads it.
- The prompt and the refusal for a connector the agent may not use both point to this tool, and tell the
  agent not to claim connectors can't be loaded or to use CLI tools with stored credentials.

## How it works
- `Agent.claudeConnectors` (server names, migration **v13** `agents.claude_connectors`), plus the team's and the all-agents list (above).
- For such an agent, the Claude Code runtime (`runtimes/claude-cli.ts`):
  - drops `--strict-mcp-config` (so Claude Code loads the owner's connectors);
  - adds `--permission-prompt-tool mcp__sebeto__approve_tool`;
  - keeps `--allowedTools` = Sebeto tools + read-only natives, so **no connector tool is pre-allowed**: Claude Code must ask the prompt tool for each call.
- `approve_tool` (tools/server.ts, registered only for agents with Claude connectors) runs
  `claudeToolDecision()` and the gate, then answers Claude Code with `{behavior:'allow', updatedInput}` or
  `{behavior:'deny', message}`. A pending approval answers "deny: permission requested… end your turn";
  the run resumes after the owner decides, and the retried call is allowed.
- Tool names: `mcp__<slug>__<tool>`, slug = `claudeMcpSlug(serverName)` (`"claude.ai Atlassian – Acme"` → `claude_ai_Atlassian_Acme`).
- The system prompt names the allowed connectors and says they are the exception to "use the Sebeto
  tools" (without that, agents ignored them).
- `GET /api/v1/runtimes/claude-cli/connectors` → `claude mcp list` parsed (`parseClaudeMcpList`).
- The owner's `~/.claude/settings.json` must not pre-allow these tools (checked 2026-11-16: no `mcp__` allow rules).

## What it cannot do
- **Triggers don't run agent sessions.** Slack and Jira rules read through a locked-down, one-tool
  `claude -p` reader (`claudeConnectorRead`), not through an agent's connectors .
- Only for agents on Claude Code (Codex/Ollama/OpenAI-compatible agents don't have the owner's Claude connectors).

## Verified 2026-11-16
- Headless `claude -p` loads ~460 connector tools (Atlassian 41, Slack 27, Gmail 31, an MDM 134…).
- Live run (test agent on Haiku, connector *claude.ai Atlassian – Acme*): Claude Code called
  `approve_tool`, Sebeto created *"Permission needed: look things up in claude.ai Atlassian – Acme"*
  and the ticket waited in Needs you. Approving is the owner's click (an assistant may not approve on
  the owner's behalf).
- Tests: `runtimes/claude-connectors.test.ts` (arguments, decisions, `claude mcp list` parsing, storage,
  prompt, team and all-agents lists) and `tools/connector-request.test.ts` (asking over MCP; allow, team, deny).
