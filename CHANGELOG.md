# Changelog

All notable changes to Sebeto. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) (before 1.0, minor versions may change things).

## [0.9.0] - 2026-11-17
First public preview. Early software: expect rough edges, and back up your workspace.

### Added
- **Jira & Confluence connector** through Atlassian's official MCP server (scoped API token or service account key).
- **Slack connector** built into Sebeto (bot or user token), and **Slack approvals**: one DM per ticket with
  Approve, Deny, Revise and Mark done buttons.
- **Triggers:** Slack channels (through a Slack app or your own Claude Slack connector, with "wait for the ticket
  number" for Jira Service Management) and Jira JQL queries.
- **Your Claude connectors for agents:** agents on Claude Code use the connectors you already have in Claude, with
  your login. Turn them on per agent, per team or for all agents; agents can ask for one on the ticket. Every call
  goes through Sebeto's permission gate: look-ups are asked once per ticket, changes every time. You can mark
  tools that only look things up.
- **Help-desk triage and security alert triage** examples: tickets from a Slack channel, automatic category tags,
  repeated alerts grouped into one ticket.
- **Deleted tickets** page (restore or delete forever); sub-tickets by hand; budgets that stop the agent or only warn.
- **Files and screenshots in the ticket chat** (paste, drop or attach).
- `~/.sebeto/sebeto.env` for `npm start` settings.

### Changed
- The ticket panel collapses "What the agent did" and shows a budget card in the chat.
- Team files keep several teams; a whole-workspace export rebuilds every team on import.

### Fixed
- A fresh clone could install `@sebeto/core` from npm instead of the workspace copy and fail.

## [0.8.0] - 2026-11-15
- Pivot assist: a stuck local model gets one concrete hint from an advisor model.
- "Allow for this task" permission alongside Allow once, Always allow and Deny.
- Cleaner ticket chat (grouped messages, collapsible prose, code panes).

## [0.7.0] - 2026-11-14
- Workspace backup and restore (one click, daily, verified restore; secrets stay encrypted).
- OpenAI-compatible AI runtime (LM Studio, vLLM, OpenRouter…).

## [0.6.0] - 2026-11-14
- Light and dark theme; Chief of Staff costs counted; better security routing.

## [0.5.0] - 2026-11-13
- Dependency security fixes; Emergency stop enforced at the API; memory aliases; cost dashboard; Italian team texts.

## [0.4.0] - 2026-11-13
- Session library and agent memory, append-only security log with Emergency stop, teams and routing, triggers
  (webhooks, mail rules, schedules), Obsidian-compatible memory graph, AI per team with a lock.

## [0.3.0] and earlier - 2026-11-08 to 2026-11-12
- The board, ticket sessions, permission gate with snapshots and Undo, Claude Code, Codex CLI and Ollama runtimes,
  skills, the Chief of Staff intake chat, connectors and custom MCP servers, agent delegation.

[0.9.0]: https://github.com/vincenzosomma/sebeto-oss/releases/tag/v0.9.0
