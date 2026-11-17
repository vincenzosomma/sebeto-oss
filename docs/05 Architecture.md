---
tags: [sebeto, architecture]
created: 2026-11-08
---

# Architecture

## Deployment model
**One headless core, two shells:** a desktop app (Electron, core in a utilityProcess) and a Docker container (the core serves the web UI). Both run on the user's own hardware → [14 Deployment Modes](14%20Deployment%20Modes.md).
Desktop default: **local app, no backend run by us.** Everything (database, orchestrator, Board MCP server on 127.0.0.1) runs on the user's machine; AI calls go directly to the provider the user chose. See [13 Local-first & Privacy](13%20Local-first%20%26%20Privacy.md).

## Stack
- **Core:** `sebeto-core`, a TypeScript/Node service (Fastify + WebSocket + better-sqlite3) holding all logic and exposing an HTTP/WS API.
- **Shells:** desktop = **Electron** running the core in a `utilityProcess` (changed from Tauri after review: one language, no Node-in-Rust sidecar); server = Docker image where the core also serves the UI ([14 Deployment Modes](14%20Deployment%20Modes.md), [15 Architecture Review](15%20Architecture%20Review.md)).
- **Tools:** Sebeto owns every side effect. Agents use Sebeto tools over MCP (files, web, email, scripts, tickets) with permission gate, audit, git snapshots and cost meter; risky native runtime tools are off by default.
- **Storage layer:** Drizzle ORM with migrations from day one (SQLite now, Postgres optional later).
- **UI:** React + TypeScript + Tailwind + shadcn/ui; dnd-kit for the board.
- **Storage:** SQLite in WAL mode, written only by the core (tickets, sessions, runs, messages, events, agents, budgets) + FTS5 for search; embeddings for "By meaning" later.
- **Agent runtimes:** pluggable **runtime adapters**, chosen by the user per agent and per ticket. **Current:** Claude through the `claude` CLI (headless `-p`, `stream-json`, `--resume`). **Planned:** the Claude Agent SDK, Codex CLI, Gemini CLI, Ollama / LM Studio / OpenAI-compatible APIs. Details: [09 Runtimes & Sessions](09%20Runtimes%20%26%20Sessions.md).
- **One ticket = one session:** each ticket stores `runtime` + `session_id` and resumes the same session on every reply and check-in.

## Components
```
┌──────────── UI (React) ─────────────┐
│ Sidebar │ Board │ Ticket │ Team     │
└────┬────────────────────────────────┘
     │ IPC / events
┌────▼────────────────────────────────┐
│ Orchestrator                         │
│  • ticket state machine              │
│  • scheduler (heartbeats)            │
│  • runner pool (N parallel)          │
│  • permission gate (Allow/Ask/Never) │
│  • budget meter (hard stop)          │
│  • snapshot service (undo)           │
└────┬──────────────┬─────────────────┘
  SQLite+FTS     Runtime adapters: claude-cli (now) | claude-sdk | codex | gemini | ollama
                 (each ticket: own sandbox folder / worktree)
```

## Scalability
Three stages from one codebase (desktop → team server → scale-out) with seams built now: repository layer, UUIDv7 IDs, job-queue and event-bus interfaces, API separate from workers, pagination, rate limiting → [16 Scalability](16%20Scalability.md).

## Architecture improvements (added 2026-11-08)
1. **Board MCP server:** agents create, comment on, hand off and report tickets through tools instead of the app parsing their text → [10 Agent Communication](10%20Agent%20Communication.md).
2. **Durable job queue:** every run (new ticket, reply, check-in, agent message) is a row in a `job` table. The scheduler picks jobs up, so nothing is lost if the app closes, and runs resume on restart through the stored `session_id`.
3. **Concurrency control:** a global limit on parallel runs (the "Max 3 in parallel" setting), with per-runtime limits (local models: 1) and priority (Needs-you replies first, then check-ins).
4. **Budget meter before and after each run:** check the remaining budget before starting a run, pass the cap to the runtime (`--max-budget-usd`), and record the actual cost after it.
5. **Snapshot service:** a hidden git repo per ticket folder; commit before and after each run; Undo = restore; a "Changes" tab shows diffs (revised in [15 Architecture Review](15%20Architecture%20Review.md)).
6. **Immutable audit log:** the `event` table is append-only; it powers "What the agent did" and debugging.
7. **Shared team notes:** a per-team knowledge folder that agents can search, which reduces repeated questions.
8. **Handoff summaries:** context moves between agents as a summary plus files, never a full transcript.

## Event → status mapping
| Agent event | Status |
|---|---|
| tool use / streaming output | In progress |
| asks the user a question, finishes a deliverable, permission "Ask" | Needs you |
| error, permission denied, budget hard stop | Blocked |
| final result accepted | Completed |

## Core data model (draft)
- `agent(id, name, role, runtime, model, reports_to, job, heartbeat, budget_limit, perms_json, paused)`
- `ticket(id, title, goal, status, agent_id, runtime, model, current_session_id, folder, cost_cap, depends_on, created_at)`
- `session(id, ticket_id, agent_id, runtime, model, external_session_id, started_at, ended_at, reason[new|compaction|handoff|runtime_change|crash])`
- `run(id, session_id, job_id, trigger[user|heartbeat|message|start], started_at, ended_at, status, tokens_in, tokens_out, cost_usd, exit_reason)`
- `status_transition(id, ticket_id, from, to, cause[agent|rule|user], run_id, ts)`
- `runtime_config(id, enabled, path, auth_state, default_model)`; API keys go in the OS keychain
- `message(id, ticket_id, from, text, ts)`, with an FTS5 index on text
- `event(id, ticket_id, kind, payload_json, ts)`, the activity log
- `permission_request(id, ticket_id, action, state)`
- `snapshot(id, ticket_id, path, ts)`
- `spend(agent_id, ticket_id, tokens, usd, ts)`
- `ticket.parent_id`, used for delegated sub-tickets
- `skill(id, slug, name, description, permissions_json, tools_json, path, version, created_at)` and `agent_skill(agent_id, skill_id)` → [17 Agents & Skills](17%20Agents%20%26%20Skills.md)
- `agent_message(id, ticket_id, from_agent, to_agent, kind[ask|answer|handoff|review|report], text, hop, ts)`
- `job(id, kind[start|reply|heartbeat|message], ticket_id, agent_id, priority, state, run_after, attempts)`
