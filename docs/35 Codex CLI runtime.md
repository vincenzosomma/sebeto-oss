---
tags: [sebeto, runtimes, agents, v0.8]
created: 2026-11-15
---

# Codex CLI runtime (v0.8)

Second subscription-login runtime after Claude Code (roadmap v0.3 "more adapters"). Lets an agent run
on the **OpenAI Codex CLI** using the owner's **ChatGPT subscription** (`codex login`) — no API key,
cost **$0** to Sebeto. Built and verified against **Codex CLI 0.169.0** on a feature branch while
`main` stayed stable.

## How it runs
`codex exec --json` headless, one process per run:
- **Prompt** on stdin (`-`); **system prompt** written to `<ticket>/AGENTS.md` (Codex has no
  system-prompt flag; it reads AGENTS.md as project instructions — confirmed it obeys). The ticket's
  existing AGENTS.md, if any, is preserved and restored afterwards.
- **Sebeto tools** via a per-run MCP server injected with `-c mcp_servers.sebeto.url=…`; the token is
  passed through the env var `SEBETO_MCP_TOKEN` (`-c …bearer_token_env_var=…`), so it never appears on
  the command line. Codex sends it as `Authorization: Bearer …` (verified).
- **`--approve-for-me`** lets Codex call the (trusted) Sebeto tools without an interactive prompt;
  Sebeto's own permission gate still governs each tool (email/web/prod/delegate/run_command).
- **Output**: Codex `--json` emits JSONL events — `thread.started` (→ session id), `agent_message`
  (→ text), `mcp_tool_call`/`command_execution` (→ tool), `turn.completed.usage` (→ tokens),
  `turn.failed`/`stream_error` (→ error). Parsed into Sebeto `AgentEvent`s.
- **Resume**: `codex exec resume <thread_id>` continues the session (id captured from `thread.started`).
- **Windows**: the npm shim is unwrapped to `node …/@openai/codex/bin/codex.js` so no shell is needed.

## Safety
`--approve-for-me` forces Codex's **workspace-write** sandbox: its native shell/edits are confined to
the ticket folder (`-C <ticket>`), with **no network** and nothing outside the folder. Those changes
are captured by Sebeto's per-run git snapshot (Undo still works). Real outbound/production actions go
through Sebeto's gated tools, not Codex's sandbox.

**Known limitation (v1):** Codex's native shell can run read/write commands inside the ticket folder
without a per-action Sebeto audit entry (workspace-write is required to auto-approve MCP tools in
non-interactive mode; `-s read-only` cannot be combined with `--approve-for-me`). Bounded to the
sandbox folder, no network. A later version can revisit locking the native shell down further.

## Setup
`npm i -g @openai/codex`, then `codex login` (ChatGPT) once. Enabled by default
(`SEBETO_RUNTIMES` includes `codex-cli`); pick it per agent or per ticket in Settings → Models.
Models: `gpt-5.1-codex-max` is offered; the model is **optional** (unset = the account's Codex
default), so any model the account supports can be set.

## Tested
Unit: version/arg-building/binary-resolution and the JSONL parser (real captured shapes). Real-CLI
end-to-end (gated behind `RUN_CODEX_E2E=1`, skipped in CI): a live turn that calls a Sebeto MCP tool
with the bearer token and reports done — **passed**. 990 tests pass; build clean.

## Next
Gemini is deferred: its CLI is deprecated for the owner's Google tier (replaced by Antigravity CLI,
2026-06-18), so that adapter needs Antigravity instead. See [06 Roadmap](06%20Roadmap.md).
