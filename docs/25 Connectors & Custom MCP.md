---
tags: [sebeto, connectors, mcp, plan]
created: 2026-11-10
---

# Connectors catalog and custom MCP servers (v1 built 2026-11-10)

**Owner request (2026-11-10):** "add the features to add custom MCPs and connectors, or a list of available connectors."

## Status (2026-11-10)
**v1 is built and verified on the running app**:
- **Settings → Connectors** shows your connectors (Gmail + added ones, with status, "N of M tools on", "needs review", Review tools / Reconnect / Turn off / Remove) and the **catalog**:
  - Gmail (built in)
  - **Folder** preset: the reference filesystem MCP server, pinned to `@modelcontextprotocol/server-filesystem@2026.8.31`
  - **Your own MCP server**, by command or URL, with settings stored as secrets
  - Planned: ServiceNow, GitHub, Teams (Microsoft 365 and Google: [26 Microsoft & Google Connectors](26%20Microsoft%20%26%20Google%20Connectors.md); **Jira & Confluence and Slack: built 2026-11-16, [37 Atlassian & Slack Connectors](37%20Atlassian%20%26%20Slack%20Connectors.md)**)
- Each connector can be limited to **some agents**.
- Microsoft 365 / Outlook and Google sign-in were added on 2026-11-10 → [26 Microsoft & Google Connectors](26%20Microsoft%20%26%20Google%20Connectors.md).
- Not built yet: the per-agent picker on the agent page (the connector form does it), more presets.

## What the owner gets
1. **Settings → Connectors**: a page with a **catalog** of ready connectors, each with a short description, what agents can do with it, and a **Connect** button:
   - **Available now:** Gmail (built: [23 Mail Connector](23%20Mail%20Connector.md)).
   - **First wave (IT Ops):** Microsoft 365 mail + calendar (OAuth), Google Workspace (OAuth), a generic IMAP/SMTP mailbox, Jira / ServiceNow tickets, GitHub / GitLab, Slack / Teams messages, and a read-only file share (SMB folder).
   - **Later:** monitoring (Zabbix, Grafana), Active Directory / Entra ID lookups, password vault, uptime checks.
2. **Add a custom MCP server**: name, how to start it (a command such as `npx some-mcp-server`, or a URL for remote/HTTP servers), and its secrets (API keys). Sebeto starts it, lists its tools, and shows them for review before any agent can use them.
3. **Per-agent access**: on each agent, choose which connectors it may use (for example, only the Service Desk analyst gets Jira).
4. Each connector shows its status (connected / error / disabled), with Test, Disconnect and Remove.

## Design rules (they keep [15 Architecture Review](15%20Architecture%20Review.md) promises)
- **Sebeto stays in the middle (proxy).** Agents never connect to a custom MCP server directly. Sebeto connects to it and re-exposes its tools through Sebeto's own MCP server, so every call goes through the **permission gate**, the audit log and the untrusted-content rules, whatever the model.
- **Every tool gets a permission level.** When a server is added, Sebeto lists its tools and the owner (or a sensible default) marks each one **Read**, **Change** or **Production**:
  - **Read** tools: default *Ask once per ticket*, like reading mail.
  - **Change** tools: default *Ask* every time.
  - **Production** tools: always *Ask*.
  - A tool that is new or has changed after an update is disabled until reviewed (no silent "rug pulls").
- **Results are untrusted content.** After an agent uses an outside tool, outbound actions ask again (same rule as web pages and email).
- **Secrets** (API keys, tokens) go to the secret store (DPAPI on Windows). Sebeto passes them to the server process as environment variables; agents never see them.
- **Local commands are code.** A custom server started by a command runs on this computer with the owner's rights. Adding one shows a clear warning, and the command line must be confirmed by the owner. The catalog lists only known, pinned packages.
- **Limits:** per-call timeout, output size cap, and a server crash never stops a ticket (the agent gets an error and carries on).
- Built-in connectors (Gmail today) move under the same Connectors page, so there is one place to manage everything.

## Technical sketch
- `packages/core/src/connectors/catalog.ts` (catalog + presets) and `mcp-hub.ts` (the `McpHub`):
  - stores connectors in `connectors/custom/<id>.json`, with secrets in the secret store;
  - one MCP client per connector over stdio (official SDK, minimal environment) or Streamable HTTP (https only, http just for localhost);
  - tool review with fingerprints; 60 s call timeout and 100,000-character output cap; a crash marks the connector "error" and the next call reconnects.
- Tool server: proxied tools are registered as `<connector>__<tool>` and advertised with the server's own input schema. New permission keys: `tool.read` ("Use connector tools that look things up", once per ticket per connector) and `tool.change` (every call, outbound). Production tools use `prod.change`.
- Agent access: `allowedAgents` on the connector (null = all), so no DB migration was needed.
- API: `GET /connectors` (catalog + installed), `POST /connectors` (add a preset or your own), `PATCH /connectors/{id}` (rename, on/off, agents, tool review), `POST /connectors/{id}/refresh`, `DELETE /connectors/{id}`. WebSocket event `connectors.changed`.
- UI: Settings → Connectors (catalog grid, installed list, tool review screen), plus a connector picker on the agent.

## Next for connectors
- ~~OAuth connectors (Microsoft 365, Google Workspace)~~ ✅, ~~Jira/Slack~~ ✅ (2026-11-16); next ServiceNow/GitHub presets (pinned servers).
- Agents on Claude Code can also use the owner's own Claude connectors: [38 Claude Connectors for Agents](38%20Claude%20Connectors%20for%20Agents.md).
- A connector picker on the agent page; a "test a tool" button in the review screen.
- Skills will declare the connectors they need ([17 Agents & Skills](17%20Agents%20%26%20Skills.md)).
