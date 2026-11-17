---
tags: [sebeto, architecture, runtimes]
created: 2026-11-08
---

# Runtimes & sessions

**Rule: one ticket = one agent session.** The ticket stores which **runtime** runs it and that runtime's **session ID**, so every reply or check-in resumes the same conversation.

**Decision (2026-11-08):**
- **For now:** drive Claude by running the `claude` CLI directly (headless).
- **Later:** move to the Claude Agent SDK (documented below).
- **Multi-model from day one:** the user chooses the model/runtime per agent, with an optional override per ticket.

---

> **Revised by [15 Architecture Review](15%20Architecture%20Review.md):** side effects go through **Sebeto tools over MCP** (not native runtime tools), a ticket has **many sessions** (session/run tables), and a **mock adapter** exists for development and tests. Ollama moves to v0.2.

## 1. Runtime adapter interface

The orchestrator never talks to a CLI directly. Every runtime implements the same adapter, so adding a model means adding an adapter, not changing the app.

```ts
interface RuntimeAdapter {
  id: 'claude-cli' | 'claude-sdk' | 'codex' | 'gemini' | 'ollama' | string;
  displayName: string;                       // shown in the runtime picker
  detect(): Promise<{ installed: boolean; version?: string; loggedIn?: boolean }>;
  models(): Promise<string[]>;               // for the model dropdown
  capabilities: { tools: boolean; resume: boolean; costReport: boolean; permissionHook: boolean };

  start(t: TicketRun): AsyncIterable<AgentEvent>;              // new session
  resume(t: TicketRun, message: string): AsyncIterable<AgentEvent>;
  stop(sessionId: string): Promise<void>;
}

type TicketRun = {
  ticketId: string; sessionId?: string; cwd: string;           // ticket sandbox folder
  model?: string; systemPrompt: string;                         // role + job description
  permissions: Record<'read'|'write'|'email'|'web'|'money', 'Allow'|'Ask'|'Never'>;
  budgetUsd: number;                                            // ticket cost cap
  prompt: string;
};

type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }             // → "What the agent did"
  | { kind: 'ask'; question: string }                           // → Needs you
  | { kind: 'permission'; action: string; detail: string }      // → permission card
  | { kind: 'error'; message: string }                          // → Blocked
  | { kind: 'done'; costUsd?: number; tokens?: number };
```

The orchestrator maps `AgentEvent` to ticket status (see [05 Architecture](05%20Architecture.md)). This mapping is the same for every runtime.

---

## 2. Claude via the CLI (current implementation)

Verified on Claude Code **2.1.319** (`claude --help`).

**New ticket**
```bash
claude -p "<ticket goal>" \
  --session-id <uuid-we-generate> \
  --output-format stream-json --verbose \
  --append-system-prompt "<role + job description>" \
  --model <model> \
  --allowedTools "Read,Glob,Grep,Edit,Write" \
  --disallowedTools "<tools set to Never>" \
  --permission-mode default \
  --max-budget-usd 2.00
```
Run it with `cwd` set to the ticket folder. Generating the `--session-id` ourselves means we know the session ID before the first event arrives.

**Reply or check-in on an existing ticket**
```bash
claude -p "<user message or 'Check in: continue your work and report status.'>" \
  --resume <session-id> --output-format stream-json --verbose
```

**Parsing:** `stream-json` emits one JSON object per line: `system/init` (session ID, tools), `assistant` messages (text and `tool_use` blocks), `user` messages (tool results), and a final `result` (cost, usage, error flag). Map these onto `AgentEvent`.

**Permissions:**
- `Allow` → add the tool to `--allowedTools`
- `Never` → add it to `--disallowedTools`
- `Ask`, simple version for the MVP: the tool isn't allowed, so the agent stops and explains what it wanted. We show that as a permission card; on **Allow once** we resume with the tool allowed for that run.
- `Ask`, better version: `--permission-prompt-tool <mcp tool>` points to a small MCP server inside our app that receives the request live and waits for the user's click.

**Pros:** fast to build; it reuses the user's Claude Code installation and login.
**Cons:** Claude Code must be installed; we spawn a process per run and parse text output; CLI flags can change between versions (pin a minimum version in `detect()`).

---

## 3. Claude via the Agent SDK (planned migration)

The **Claude Agent SDK** (TypeScript `@anthropic-ai/claude-agent-sdk`, Python `claude-agent-sdk`) is the engine behind Claude Code, exposed as a library.

**Why migrate**
- Typed message objects instead of parsing CLI output
- A `canUseTool` callback gives a native, live **Ask** flow: no MCP workaround, and the session waits for the user's click
- In-process custom tools (for example `create_ticket`, `report_status` for the Chief of Staff)
- Resume through a `resume: sessionId` option; cost and usage arrive on the result message
- No dependency on a separately installed CLI

**Sketch (TypeScript)**
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const msg of query({
  prompt: ticket.prompt,
  options: {
    cwd: ticket.cwd,
    resume: ticket.sessionId,          // omit for a new ticket
    model: ticket.model,
    appendSystemPrompt: role.job,
    allowedTools: allowed, disallowedTools: never,
    canUseTool: async (tool, input) => askUserOnTicket(ticket.id, tool, input), // → permission card
  },
})) {
  emit(mapSdkMessageToAgentEvent(msg));
}
```
> Check the option names against the SDK docs when implementing; the SDK evolves quickly.

**Auth and cost:** the SDK runs on an **Anthropic API key**, so users bring their own key (stored in the OS keychain). We never proxy or resell model access; calls go directly from the user's machine to the provider ([13 Local-first & Privacy](13%20Local-first%20%26%20Privacy.md)). Check Anthropic's current terms before offering claude.ai subscription login inside a third-party app.

**Migration path:** add `claude-sdk` as a second adapter next to `claude-cli`, make it the default once it's stable, and keep the CLI adapter for users who prefer their Claude Code login.

---

## 4. Other runtimes (user-selectable)

> Not installed on the dev machine yet. Verify these flags against each tool's `--help` when building the adapter.

| Runtime | Headless run | Resume | Machine-readable output | Notes |
|---|---|---|---|---|
| **OpenAI Codex CLI** | `codex exec "<prompt>"` | `codex exec resume <session-id>` | `--json` (JSONL events) | `--sandbox workspace-write`, `-C <dir>`; OpenAI key or ChatGPT login |
| **Google Gemini CLI** | `gemini -p "<prompt>"` | `--resume <id>` | `--output-format json` / `stream-json` | `--approval-mode`; Google login or API key |
| **Ollama (local)** | HTTP `POST localhost:11434/api/chat` | the app stores history and resends it | JSON | Free and private. Tool calling only on supported models; our app runs the tools. **Installed** on the dev machine |
| **LM Studio (local)** | OpenAI-compatible server `localhost:1234/v1` | the app stores history | JSON | **Installed** on the dev machine; same adapter shape as Ollama |
| **Any OpenAI-compatible API** | HTTP | the app stores history | JSON | Covers OpenRouter, Azure, Mistral, etc. with one adapter |

For runtimes without built-in sessions (Ollama, LM Studio, plain APIs), `sessionId` is **our own** ID and the conversation lives in our `message` table. The app also provides the tools (read/write in the ticket folder) through a small built-in tool loop.

---

## 4b. Ollama: built (2026-11-10)
- **Adapter:** `packages/core/src/runtimes/ollama.ts`, enabled by default (`SEBETO_RUNTIMES=mock,claude-cli,ollama`; `OLLAMA_HOST` to point elsewhere).
- **Detection:**
  - `/api/version` tells whether Ollama is running.
  - **Models** are the installed ones whose `/api/show` capabilities include **`tools`** (agents need tools); the others are hidden.
  - With no such model, the runtime shows "Download one, for example: ollama pull qwen3".
- **Tool loop (the adapter runs it, Ollama only generates):**
  - It connects to **Sebeto's own MCP tool server** with the run's token.
  - It offers those tools through `/api/chat` `tools`, runs each tool call, and sends results back as `role: "tool"`.
  - Every call goes through the same gate, audit and untrusted-content rules as Claude.
- **Permissions:** when a tool answers "Permission requested…", the turn ends at once. After the owner decides, the next run resumes.
- **Sessions:** history is saved in `<ticket>/.sebeto/ollama-<session>.json` (reserved for Sebeto, not snapshotted), last 60 messages.
- **Limits:**
  - 25 model calls per run;
  - 12,000 characters of tool output per call;
  - `num_ctx` 16k;
  - `<think>` blocks are removed from replies.
- **Cost:** 0 (local), so the cost cap never stops a local agent.
- **Verified 2026-11-10** with `qwen3-vl:4b-instruct` on an RTX 2070 (8 GB), fully offline:
  - T-12: wrote `checklist.md` and reported its status through Sebeto tools;
  - T-13: asked permission for a PowerShell command, waited, resumed after **Allow once**, ran it and answered ("last booted on 10 November 2026 at 08:41").
- **Context compaction (2026-11-11):** Ollama declares its context window (`SEBETO_OLLAMA_NUM_CTX`, default 16k) and has no compaction of its own.
  - At ≥ 70% use, the session is closed. The next run starts a `compaction` session from a Sebeto-written brief of the ticket.
  - Claude Code compacts natively and is left alone.
  - Code: `packages/core/src/executor/compaction.ts`.
- **Tip:** small models follow clear, explicit goals best. Prefer a model with "tools" in `ollama show <model>`.

## 4c. Contract fixtures: how to re-record when Claude Code or Ollama updates
CLI and API output can change between versions ([15 Architecture Review](15%20Architecture%20Review.md) #12). The contract tests replay **real recorded output** through the real adapters.
- **Where:**
  - `packages/core/src/runtimes/__fixtures__/claude/<scenario>.<version>.jsonl` plus `version.<version>.txt` (raw `claude --version`);
  - `packages/core/src/runtimes/__fixtures__/ollama/tool-call.<version>.json`.
- **Tests:** `claude-contract.test.ts` and `ollama-contract.test.ts` find every version automatically. They check the events Sebeto relies on: session id, text, tool (name + summary), usage/done (cost, tokens), errors.
- **Claude scenarios:** plain answer, `--resume` (two runs, same session), one Sebeto MCP tool call, unknown model, cost cap reached. A new version must have all of them.
- **Re-record after a Claude Code update** (costs about $0.02 with haiku; the script stops before $0.30):
  ```powershell
  npm run build -w @sebeto/shared; npm run build -w @sebeto/core
  node packages/core/scripts/record-claude-fixtures.mjs
  npm test
  ```
  It runs `claude` exactly like the adapter (same arguments, prompt on stdin, a tiny local MCP server with an `echo` tool) in a temp folder, and prints the cost of each run.
- **Re-record after an Ollama update** (free, offline; needs `qwen3-vl:4b-instruct` or `--model <a model with tools>`):
  ```powershell
  node packages/core/scripts/record-ollama-fixtures.mjs
  ```
- **Privacy:** both scripts redact the home folder, user name, e-mail addresses and anything that looks like a key, and refuse to save if something is left. Look at the diff before committing.
- **If a new version fails:** keep the new fixtures, fix the parser (`claude-stream.ts` / `ollama.ts`) and keep the old fixtures, so older versions stay covered. If a version is no longer supported, raise `MIN_CLAUDE_VERSION` and delete its fixtures.

## 5. How the user chooses

- **Settings → Models:** the app runs `detect()` for each adapter and shows each one as *Ready*, *Needs login*, or *Not installed* (with an install link). The user adds API keys here.
- **Agents team → agent → Runtime & model:** each agent has a default runtime and model (for example Writer = Claude Sonnet, Researcher = Gemini, Ops assistant = local Llama via Ollama).
- **New ticket / ticket panel:** an optional override ("Run this ticket with…"). It's locked once the session starts, because sessions can't move between runtimes. Changing it later creates a **new session** seeded with a summary of the old one.
- **Fallback rule (optional):** if a runtime is down or out of budget, offer a switch to the next allowed runtime.

## 6. Data model additions
- `agent.runtime`, `agent.model`
- `ticket.runtime`, `ticket.model` (override), `ticket.session_id`
- `runtime_config(id, enabled, path, auth_state, default_model)`; keys live in the OS keychain, never in SQLite
