---
tags: [sebeto, roadmap]
created: 2026-11-08
---

# Roadmap

## v0.1: MVP: built 2026-11-08
- [x] Monorepo: `packages/core` (headless, HTTP/WS API), `packages/ui`, `apps/desktop`; the core runs standalone with `npm start`
- [x] Monorepo scaffold (Electron + React + core), SQLite schema via Drizzle migrations, UUIDv7 IDs, job-queue + event-bus interfaces ([16 Scalability](16%20Scalability.md))
- [x] Board with 5 columns, manual ticket creation, drag and drop
- [x] **Scope cut after review ([15 Architecture Review](15%20Architecture%20Review.md)):** one agent, one ticket, done well
- [x] Security baseline: per-launch API token, Host/Origin checks, MCP tokens scoped per session
- [x] Core state machine (agents propose a status, the core decides) + sessions/runs tables + Drizzle migrations
- [x] Sebeto Work tools over MCP (fs.read/write with **git snapshots**, permission gate Allow/Ask/Never); native shell off
- [x] **`mock` adapter** (fake agent for development and tests, no tokens)
- [x] `RuntimeAdapter` interface + the first real adapter: **`claude` CLI** (headless, stream-json, `--session-id` / `--resume`), with chat per ticket ([09 Runtimes & Sessions](09%20Runtimes%20%26%20Sessions.md))
- [x] Settings → Models: detect installed runtimes; pick a runtime and model per agent and per ticket
- [x] Ollama adapter (moved to v0.2)
- [x] Automatic status from agent events
- [x] Per-ticket sandbox folder

## v0.2
- [x] Skills v1: `SKILL.md` folders, assign skills to agents, permissions derived from skills (2026-11-10, migration v3) ([17 Agents & Skills](17%20Agents%20%26%20Skills.md))
- [x] Ollama adapter (local, offline) (2026-11-10)
- [x] Context compaction (`executor/compaction.ts`). Still open: adapter contract tests with recorded fixtures; minimum-version checks
- [x] Setup wizard for non-technical users; i18n (en, it) (2026-11-10). Still open: diagnostics export
- [x] Prompt-injection defences: untrusted-input tagging, forced Ask after untrusted input, provenance on permission cards
- [x] Chief of Staff intake agent → proposed tickets (2026-11-10, [24 Intake Chat](24%20Intake%20Chat.md))
- [x] Connectors catalog + custom MCP servers via the Sebeto proxy (v1, 2026-11-10) ([25 Connectors & Custom MCP](25%20Connectors%20%26%20Custom%20MCP.md))
- [x] Full-text search (FTS5): ticket titles/goals + chat messages, `#tag` filters (`search_fts`)
- [x] Permission gate (Allow / Ask / Never) + permission request cards
- [x] Notifications for "Needs you" (desktop notifications on Needs you / Blocked / permission when the app isn't focused) (2026-11-15)
- [x] Snapshots + Undo

## v0.3
- [x] **Agents & skills page:** hierarchy editor, create agents, skill editor and library, team templates
- [x] **Container mode:** Dockerfile (core + UI + agent CLIs), login, secrets from env, `/data` and `/workspace` volumes, docker-compose with optional Ollama; built by CI (publishing the image on GHCR is still to do) ([14 Deployment Modes](14%20Deployment%20Modes.md))
- [x] Agents team: org chart, roles, budgets that stop or only warn (heartbeats still to do)
- [~] More adapters: **Codex CLI done** (2026-11-15, subscription login, MCP-wired, verified — [35 Codex CLI runtime](35%20Codex%20CLI%20runtime.md)); Gemini CLI deferred (deprecated for the owner's tier, replaced by Antigravity CLI 2026-06-18 — revisit via Antigravity). OpenAI-compatible APIs done in v0.7 R
- (moved to Next) Migrate Claude to the **Agent SDK** adapter (native Ask flow via `canUseTool`); keep the CLI adapter as an option
- [x] Ticket templates and cost caps (ticket dependencies still to do)
- [~] **Agent communication:** Board MCP server (delegate, handoff, ask, review, report), sub-tickets, guardrails (hop limit, loop detection, org-chart routing) → [10 Agent Communication](10%20Agent%20Communication.md). **v1 delegation + UI view done** (2026-11-15, `feat/agent-comms`): `read_ticket` + `delegate` tools, `ticket.create` permission, org-chart + hop-limit guardrails, parent waits for children, and a Delegation section on the ticket panel (parent link + delegated children with status) ([34 Agent communication (delegation) v1](34%20Agent%20communication%20(delegation)%20v1.md)). Next: board grouping; ask/handoff/review; loop detection; cost-to-sender
- (moved to Next) Durable job queue + crash-safe resume; shared team notes

## v0.4: security-first operations (planned 2026-11-12)
- [x] **A. Session library + agent memory:** every session (Sebeto tickets and Claude Code sessions found on this computer) listed, sorted by category, openable as a ticket; agents search it with `search_memory` / `read_memory` (permission `memory.read`)
- [x] **B. Security log:** one append-only, hash-chained log of agents, sessions, tools, permissions, tickets, settings and triggers; Security page with filters, verify, JSONL/CSV export; **Emergency stop**; retention
- [x] **C. Teams + routing:** teams with a lead and routing hints; pick the team on a ticket by hand or **Automatic**; new DevOps and Red Team templates
- [x] **D. Triggers:** webhook/alert (Alertmanager, Grafana, Uptime Kuma, Zabbix), mail rules, scheduled tasks; dedupe; untrusted origin (A–D done 2026-11-13)
- [x] **E. Memory graph:** Obsidian-compatible memory vault with `[[links]]`, automatic notes, `memory_related`, graph view (done 2026-11-13)
- [x] **F. AI per team + lock** (Red Team only on local Ollama) and **G. written scope before starting** (done 2026-11-13)

## v0.5: hardening and insight (planned 2026-11-13)
- [x] **H. Dependency security:** clear the open Dependabot alerts (Electron, zod, @fastify/static, vitest, …)
- [x] **I. Emergency stop at the API:** Start and replies refused while the lockdown is on
- [x] **J. Memory aliases:** host names link to system notes
- [x] **K. Library auto-categorise** with the Chief of Staff
- [x] **L. Cost dashboard** per project, team, agent and day
- [x] **M. Italian texts** for the built-in teams

## v0.6: light and dark theme, finishing touches (planned 2026-11-14)
- [x] **N. Light and dark theme** (Light / Dark / Same as the system), desktop window included
- [x] **O. Chief of Staff costs stored** (migration v10), counted on the Costs page
- [x] **P. Routing:** security words ("phishing", "malware"…) weigh more than generic ones

## v0.7: backup and more AI choices (planned 2026-11-14)
- [x] **Q. Workspace backup and restore** (one click, daily automatic, verified restore into a new folder; secrets only encrypted)
- [x] **R. OpenAI-compatible AI runtime** (LM Studio, vLLM, OpenRouter…; same tools and permission gate; works with the team lock)

## v0.8: resilient local agents and clearer approvals (2026-11-15)
- [x] **S. Pivot assist** (stuck safeguard): a local driver model that loops on refused/repeated/off-task tool calls gets one concrete pivot from an advisor reasoning model (e.g. Foundation-Sec), fed back into the loop; `SEBETO_OLLAMA_PIVOT_MODEL`, ≤2 pivots/run, local → $0. Includes malformed-JSON recovery and the `stripThinking` fix. ([33 Pivot assist (stuck safeguard)](33%20Pivot%20assist%20(stuck%20safeguard).md))
- [x] **T. "Allow for this task" permission** (DB v11): a whole-ticket grant alongside Allow once / Always allow (→ trusted commands) / Deny; excluded for production changes (approved each time).
- [x] **U. Cleaner ticket chat**: grouped messages with avatars, collapsible long prose, code rendered in code panes.

## v0.9: work systems and real-use fixes (2026-11-16)
- [x] **V. Install fix:** internal workspace dependencies use `"*"` (a fresh clone installed `@sebeto/core@0.1.0` from npm and failed)
- [x] **W. Jira & Confluence connector** through Atlassian's official MCP server (scoped API token / service account key) ([37 Atlassian & Slack Connectors](37%20Atlassian%20%26%20Slack%20Connectors.md))
- [x] **X. Slack connector** built into Sebeto (bot or user token)
- [x] **Y. Triggers: Slack channel** (with "wait for the ticket number" for Jira Service Management Assist) **and Jira JQL** (DB v12)
- [x] **Z. Agents use the owner's Claude connectors**, gated per call through `--permission-prompt-tool` (DB v13) ([38 Claude Connectors for Agents](38%20Claude%20Connectors%20for%20Agents.md))
- [x] **AA. Ticket panel:** collapsed "What the agent did", in-chat **budget card** (add budget, resume)
- [x] **AB. Delete tickets** → **Deleted tickets** page (restore / delete forever; DB v14)
- [x] Slack triggers live on a help-desk channel and a security-alerts channel (Jira relay still to do)
- [x] **AE. Help Desk triage flow:** skill, one Slack DM per ticket with buttons (Socket Mode), automatic tags, agent hand-offs
- [x] **AF. EDR alerts → Security Lead** (read-only lookup, repeats grouped with `dedupeOn`)
- [x] **AG. Slack rules through the owner's Claude Slack connector** (no Slack app)
- [x] **AH. Budgets stop or only warn** (`budgetBlocks`), **sub-tickets by hand**
- [x] **AJ. Claude connectors per team and for all agents** (DB v15 `teams.claude_connectors`, `settings.claudeConnectorsAllAgents`); **agents can ask** for one with `request_claude_connector` → card *Turn on for the agent / for the team / Deny* ([38 Claude Connectors for Agents](38%20Claude%20Connectors%20for%20Agents.md), 2026-11-17)
- (moved to Next) Forwarding DMs to a triage bot (Slack refuses it); Jira Automation relay for tickets raised outside Slack
- [x] **AC. Team files keep several teams** (whole-workspace export → import rebuilds every team)
- [x] **AD. `~/.sebeto/sebeto.env`** for `npm start` settings (fixed token, pivot advisor)

## Next (after v0.9.0)
- [ ] Publish the Docker image on GHCR
- [ ] Migrate Claude to the **Agent SDK** adapter (native Ask flow via `canUseTool`); keep the CLI adapter as an option
- [ ] Agent communication: board grouping; ask, handoff and review; loop detection; cost to the sender
- [ ] Ticket dependencies; agent heartbeats
- [ ] Durable job queue with crash-safe resume; shared team notes
- [ ] Gemini through the Antigravity CLI
- [ ] Forwarding Slack DMs to a triage bot; Jira Automation relay for tickets raised outside Slack

## v1.0
- [ ] Semantic search
- [ ] Output previews
- [x] Team templates (import/export org charts): v0.9 AC
- [ ] Optional **self-hosted** sync server for teams (run by the team, never by us); mobile companion for approvals over the local network
- [x] Workspace export/import (backup, moving machines): v0.7 Q
- [ ] Code signing (macOS notarisation, Windows signing)
- [ ] Public open-source release (first public preview: v0.9.0)
