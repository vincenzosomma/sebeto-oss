---
tags: [sebeto, architecture, review]
created: 2026-11-08
---

# Architecture review (before writing code)

A critical pass over [05 Architecture](05%20Architecture.md), [09 Runtimes & Sessions](09%20Runtimes%20%26%20Sessions.md), [10 Agent Communication](10%20Agent%20Communication.md), [13 Local-first & Privacy](13%20Local-first%20%26%20Privacy.md) and [14 Deployment Modes](14%20Deployment%20Modes.md). Each finding has a severity and a decision. **P0** = fix before the first line of code. **P1** = fix during v0.1–v0.2. **P2** = later.

---

## P0: fix before coding

### 1. Desktop shell: Tauri + Node sidecar is the hardest combination
**Weakness:** the core is now Node/TypeScript, but Tauri is a Rust shell. Shipping Node inside Tauri means bundling a Node binary per OS as a "sidecar", plus native modules (SQLite) compiled per platform, plus a Rust layer nobody needs. That's three toolchains for a solo developer.
**Decision:** use **Electron** for the desktop shell. The core runs in Electron's `utilityProcess`, so it's the same Node code as in Docker, and there's one language end to end. The cost is a bigger installer (~100 MB), which is acceptable for a desktop tool. Tauri can be revisited later because the core stays separate.

### 2. Permissions can't be enforced across different runtimes; Sebeto must own the tools
**Weakness:** Allow/Ask/Never was mapped onto each runtime's built-in tools (`--allowedTools` for Claude, sandbox flags for Codex, approval mode for Gemini, our own loop for Ollama). Every runtime behaves differently, so the guarantees differ by model. Snapshots, audit and budgets would also be bypassed by native tools.
**Decision: "Sebeto owns the side effects."**
- Agents run with their **native dangerous tools off by default** (shell/Bash, web fetch, unrestricted file write).
- Every action that changes something goes through **Sebeto tools served over MCP**: `fs.write` (inside the ticket folder, snapshotted), `fs.read`, `http.get`, `email.draft/send`, `script.run` (sandboxed), `ticket.*`, `agent.*`.
- The **permission gate, audit log, snapshot and cost meter live in those tools**, so every runtime gets the same rules.
- Read-only native tools (read, search) stay allowed for speed.
- One MCP server, two endpoints: **Board tools** (tickets, agents) and **Work tools** (files, web, email, scripts).

### 3. Sandbox is weaker than it looks
**Weakness:** "each ticket in its own folder" doesn't stop an agent that has a shell. On a desktop, a shell command can touch the whole machine. For IT Ops, where agents may run scripts against real systems, this is the biggest risk.
**Decision:**
- Shell is **Never by default** for the runtime's own shell tool. Commands run only through Sebeto's **`run_command`** tool (added in v0.1 after user testing): PowerShell, cmd or bash, in the ticket folder, **each exact command approved by the owner** (allow-once per command), with a timeout, Sebeto secrets stripped from the environment, and output logged to `command-logs/`. `script.run` executes in a **sandbox**: in container mode it's the container (with an optional per-run throwaway container); on desktop it's the runtime's own sandbox where available (Claude Code has sandbox settings; verify per version), otherwise "Ask" every time with the full command shown.
- **Production changes** are a separate permission class ("Change production systems") that is always **Ask**, cannot be set to Allow, and expects a dry-run first.
- Credentials for infrastructure are **never in the prompt**: connectors hold them and tools use them, so the model never sees secrets.

### 4. Prompt injection: agents read untrusted content and can act
**Weakness:** agents read emails, web pages, CVE advisories and ticket exports. A malicious page can instruct an agent to "email this file to X" or "run this command".
**Decision:**
- Mark tool results from outside sources as **untrusted** (wrapped and labelled in the agent's context).
- **Role separation:** agents that read untrusted sources (Researcher) don't hold side-effect permissions; work passes to another agent through a **handoff that the owner can see**.
- Any outbound action (email, HTTP POST, production change) after untrusted input in the same run is **forced to Ask**, whatever the setting.
- Show the **provenance** ("based on: nvd.nist.gov page") in permission cards.

### 5. The local API is open to every process on the machine
**Weakness:** a core listening on `localhost` can be called by any local program or malicious web page (DNS rebinding, CSRF).
**Decision:** a **random per-launch token** is required on every API and WebSocket call even on desktop; check the Host and Origin headers; bind to `127.0.0.1` only. Container mode adds the user login. The MCP endpoints get a **per-session token scoped to one ticket**, so an agent can only touch its own ticket and permitted peers.

### 6. Data model: a ticket is not one session
**Weakness:** `ticket.session_id` assumes one session forever. Compaction, a runtime change, a handoff or a crash all create new sessions, and that history would be lost.
**Decision:** add `session` and `run` tables:
- `session(id, ticket_id, agent_id, runtime, model, external_session_id, started_at, ended_at, reason[new|compaction|handoff|runtime_change|crash])`
- `run(id, session_id, job_id, trigger[user|heartbeat|message|start], started_at, ended_at, status, tokens_in, tokens_out, cost_usd, exit_reason)`
- `ticket.current_session_id` points to the active session. Costs, audit and "What the agent did" hang off `run`.

### 7. Snapshots: copying folders doesn't scale; use git
**Weakness:** copying a ticket folder before every run is slow and wastes disk for big folders, and it can't show *what changed*.
**Decision:** a **hidden git repository per ticket folder** (`.sebeto/` git dir, not the user's own git). Commit before and after each run. Undo = restore a commit. Bonus: a **"Changes" tab with diffs** in the ticket panel. Large binaries are excluded with a size limit and listed instead of versioned.

### 8. Heartbeats shouldn't call the model
**Weakness:** "wake every 10–15 minutes" means an LLM call per agent per interval: tokens burned while nothing is happening, multiplied by the team size.
**Decision:** a heartbeat is a **cheap check in code** (new messages? dependency done? permission answered? schedule due?). The model is called **only when there's work**. Most wake-ups come from **events** (user reply, handoff, dependency completed). The UI wording stays "checks in every X".

### 9. The core decides status; agents only propose
**Weakness:** mapping free-form agent output to statuses is fragile.
**Decision:** a **state machine in the core** with explicit transitions. Agents call `report_status` (proposal). The core applies its own rules (an error means Blocked, a pending permission means Needs you), and the user can always override. Every transition is logged with its cause.

### 10. Scope of v0.1 is too big
**Weakness:** v0.1 had the board, Claude CLI, Ollama, the model picker, sandbox folders and auto-status, which is a lot for 2–4 weeks.
**Decision (v0.1 = "one agent, one ticket, done well"):**
- core + API + UI board + ticket chat
- **`claude-cli` adapter + `mock` adapter** (a fake agent for development and tests, no tokens spent)
- state machine, Sebeto file tools with git snapshots, permission gate (Allow/Ask/Never)
- SQLite with migrations
- Ollama moves to v0.2. The mock adapter already proves the multi-runtime interface.

---

## P1: during v0.1–v0.2

| # | Weakness | Improvement |
|---|---|---|
| 11 | **Context growth:** long tickets make sessions slow and expensive | Track context size per session; at a threshold, **compact** (runtime-native compaction where available, otherwise start a new session from a summary plus key files) and record it as `session.reason = compaction` |
| 12 | **CLI output format can change** between versions | **Contract tests** with recorded `stream-json` fixtures per adapter; `detect()` enforces a minimum version and shows a clear message ("Update Claude Code to ≥ x.y") |
| 13 | **Non-technical setup:** asking users to install CLIs contradicts the target audience | A **guided setup wizard**: detect runtimes, one-click install links, "use an API key instead" path, "fully offline with Ollama" path. Check whether the Agent SDK package bundles the Claude Code runtime, which would remove a manual install (verify) |
| 14 | **Terms of service** for driving CLIs programmatically and for subscription logins | Review the Anthropic, OpenAI and Google terms before release; default to **API keys** for automated use; document it |
| 15 | **No schema migrations / backups** | Migrations from day one (Drizzle ORM + migration files); automatic DB backup before each migration; workspace export |
| 16 | **Observability** | Structured logs (pino), a run trace per ticket, a cost ledger, and **"Export diagnostics"** (redacted) for bug reports |
| 17 | **i18n**: the user is Italian; non-technical users want their own language | All UI strings in message catalogues from day one (en, it) |
| 18 | **Unsigned installers** scare non-technical users (SmartScreen, Gatekeeper) | Budget for code signing (Apple Developer Program; a Windows signing certificate or Azure Trusted Signing) before the public release |
| 19 | **API contract** | A versioned REST API (`/api/v1`) described with **OpenAPI** and generated TypeScript client types; one **event stream** (WebSocket) for live updates. The same API later serves a CLI or mobile app |
| 20 | **Budget preflight** | Estimate the cost of a run before starting (based on context size and model price); block if it would exceed the ticket or agent cap |

## P2: later

| # | Item |
|---|---|
| 21 | Postgres option for multi-user container/team sync. Keep a storage layer (Drizzle supports SQLite and Postgres) so it's a configuration switch, not a rewrite |
| 22 | Per-run throwaway containers for scripts on desktop (via Docker Desktop or Podman if installed) |
| 23 | Connectors marketplace (ITSM like ServiceNow/Jira SM, M365, Google Workspace) as MCP servers with stored credentials |
| 24 | Web push / email notifications in container mode |

---

## Revised component map
```
UI (React)  ──HTTP /api/v1 + WebSocket events (token)──►  sebeto-core (Node/TS)
                                                           ├─ API layer (Fastify, OpenAPI)
                                                           ├─ State machine (tickets, sessions, runs)
                                                           ├─ Scheduler (job queue, events, cheap heartbeats)
                                                           ├─ Runtime adapters: claude-cli · mock · (ollama · codex · gemini · claude-sdk)
                                                           ├─ MCP server (per-session token)
                                                           │    ├─ Board tools: ticket.*, agent.*, report_status
                                                           │    └─ Work tools: fs.*, http.*, email.*, script.run
                                                           │         └─ Permission gate · Audit · Git snapshots · Cost meter · Untrusted-input tagging
                                                           ├─ Storage (Drizzle → SQLite; Postgres later)
                                                           └─ Secrets (OS keychain | env/Docker secrets)
Shells: Electron (desktop, utilityProcess)  |  Docker image (browser UI + login)
```

## Repo layout (target)
```
packages/core      # sebeto-core: API, state machine, scheduler, adapters, MCP, storage
packages/ui        # React app (served by core / loaded by Electron)
packages/shared    # types, API client (generated from OpenAPI), i18n catalogues
apps/desktop       # Electron shell
docker/            # Dockerfile, compose examples
docs/              # this vault
design/            # brand + mockups
```
