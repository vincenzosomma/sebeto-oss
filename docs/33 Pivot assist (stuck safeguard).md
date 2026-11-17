---
tags: [sebeto, runtimes, ollama, security, safeguard]
created: 2026-11-15
---

# Pivot assist: a safeguard for stuck local models

## Why
During the security assessment the Red Team ran on a small
local model (`qwen3-vl:4b-instruct`). It got stuck: it tried to reach `http://127.0.0.1:7600` with
the agent's web-fetch tool, which **correctly refuses private/loopback addresses** (SSRF guard), and
then kept re-issuing the same blocked request until it used all 25 steps. A small model can't do the
thing a capable one does after a couple of failures — stop, re-plan, and try a different tool.

The finding was: this is a limit of the *driver* model, not of the app. So we added a safeguard that
lets a **stronger "advisor" model re-plan for the driver when it loops**, while keeping the driver
local and cheap.

## How it works (packages/core/src/runtimes/ollama.ts)
The Ollama agent loop now tracks whether each turn made progress. A turn is **unproductive** when
every tool call in it was either a repeat of one already tried (same name + arguments) or returned an
error — exactly the 127.0.0.1 loop.

- After **`OLLAMA_PIVOT_AFTER` (3)** consecutive unproductive turns, the loop makes **one no-tools
  reasoning call** to the advisor model: it sends the task, the list of tools the driver actually has,
  and what the driver kept trying (with the errors). The advisor replies with one concrete pivot.
- The pivot is shown in the ticket timeline (`↪︎ Stuck …`) and fed back to the driver as a user
  message ("a senior security advisor suggests … do not repeat the failed approach").
- Capped at **`OLLAMA_MAX_PIVOTS` (2)** per run, so a hopeless driver can't ping-pong forever.
- The advisor is a local Ollama model, so the run still costs **$0**.

The advisor needs **no tool-calling capability** — it only reasons — so a security-reasoning model is
a good fit even though it can't drive an agent itself.

## Configuration
- **`SEBETO_OLLAMA_PIVOT_MODEL`** — the advisor's Ollama model name. **Unset = off** (the loop behaves
  exactly as before: fully backward-compatible). Set it to enable the safeguard.
- Example (what we run locally): `SEBETO_OLLAMA_PIVOT_MODEL=hf.co/fdtn-ai/Foundation-Sec-8B-Reasoning-Q8_0-GGUF:latest`
- The driver is still chosen per team/agent as usual. The advisor does **not** appear in the model
  picker (it has no `tools` capability, so it's filtered out of drivable models) — it's configured by
  the env var on purpose.

### Why Foundation-Sec is the advisor, not the driver
`hf.co/fdtn-ai/Foundation-Sec-8B-Reasoning` reports capabilities `['thinking','completion']` — **no
`tools`**. It cannot emit tool calls, so it cannot drive Sebeto's agent loop. But a security-tuned
reasoning model is ideal for the pivot step, which is pure reasoning ("why is this failing, what
should it try instead"). So it became the advisor.

## Models installed locally (2026-11-15)
| Model | Size | Caps | Role it can play |
|---|---|---|---|
| `qwen3-vl:4b-instruct` | 3.3 GB | completion, vision, **tools** | driver (fast, weak) |
| `hf.co/bartowski/orcarouter_Qwen3.8-27B-Uncensored-GGUF:Q6_K` | 24 GB | **tools**, thinking, vision | driver (strong, slow) |
| `hf.co/fdtn-ai/Foundation-Sec-8B-Reasoning-Q8_0-GGUF` | 8.5 GB | thinking, completion | **advisor** (security reasoning) |

## Driver/advisor on a separate machine (2026-11-16)
Local models can run on another computer on the network (tested on a Windows 11 laptop, 31 GB RAM, Intel Arc GPU), reached by
Sebeto through an SSH tunnel (`SEBETO_OLLAMA_URL=http://127.0.0.1:11435`, LaunchAgent
`io.sebeto.ollama-tunnel`; Ollama there stays on 127.0.0.1).
- Foundation-Sec 1.1 8B **Instruct** had no chat template (`{{ .Prompt }}`); with a Llama 3.1 tools
  template (`foundation-sec-tools`) it makes correct **single** tool calls (3/3, 2.5–4 s), but after a
  tool result it **stops and answers in text**, so it cannot drive the agent loop.
- **qwen3:14b** (driver): 3/3 single calls and keeps going after tool results (explored in-scope pages,
  wrote findings), but **claimed SQLi/XSS without testing** — the reason a security advisor is useful.
- Chosen: **driver `qwen3:14b`, advisor `foundation-sec-reasoning`** (pivot when stuck). Red Team (locked)
  and Local helper use it. A real ticket ran end to end through the tunnel at $0.

## Safety notes
- The advisor only **reads the driver's own transcript** (tool names, the driver's recent attempts and
  their results) and returns text; it never calls tools or acts. No new exfiltration surface.
- Its advice is re-wrapped as a hint to the same local driver, which is still bound by the same
  permission gate, scope and SSRF rules. The safeguard changes strategy, never permissions.

## Tests
`packages/core/src/runtimes/ollama.test.ts`:
- `ollamaPivotModel` env reader (trims, empty → off).
- Driver loops on a failing tool → advisor consulted once, hint surfaced in the timeline and fed back,
  driver then uses a different working tool. Verifies the advisor was told what kept failing.
- No advisor configured → behaviour unchanged (no advisor call; still stops at the turn limit).

## Two bugs the live runs exposed (both fixed)
Getting the safeguard to actually fire end-to-end on the 27B driver surfaced two real defects:

1. **A malformed tool call aborted the whole run.** Some local models emit a tool call whose JSON
   arguments contain a raw newline; Ollama rejects it (`invalid character '\n' in string literal`) and
   the adapter treated *any* chat error as fatal. Now a malformed reply is **recoverable**: the model
   is told to re-issue valid JSON and the run continues (`OLLAMA_MALFORMED_RETRIES`, 2).
2. **`stripThinking` was deleting the advisor's answer.** Foundation-Sec is a reasoning model that
   emits the answer *first* and then a dangling `</think>`. The old `stripThinking` dropped everything
   before a `</think>`, so the advice became an empty string — the pivot fired but silently injected
   nothing, and the driver kept looping. `stripThinking` now keeps the answer when it precedes a
   dangling tag. **This was the bug that made every earlier pivot a no-op.**

Also added: a startup log line (`ollama stuck-pivot advisor`) so the configured advisor is visible,
and a refinement so a tool used past a **soft cap** (`OLLAMA_TOOL_SOFT_CAP`, 6) stops counting as
progress (catches varied-but-off-task spinning, not just exact repeats).

## Live result (T-22, 27B driver + Foundation-Sec advisor) — verified 2026-11-15
After the fixes, **the safeguard worked end to end** (run #6):
- The 27B kept calling `list_files` on the **absolute** path `C:/Users/<you>/Projects/sebeto`, which
  errored every time — the agent's file tools are **scoped to the ticket folder**, not the project.
- After 3 stuck turns the pivot fired and **Foundation-Sec diagnosed it correctly**: *"absolute paths
  aren't allowed… the source is at an external path `list_files` can't reach… use a tool that can
  access remote resources — `fetch_url`."*
- The driver followed the advice, tried a relative path, then `fetch_url` to `http://127.0.0.1:7600`,
  which correctly hit the **permission gate** → the ticket moved to **Needs you** awaiting the owner.

### What this proves — and the real limit it surfaced
- The pivot-assist safeguard **works**: stuck detected → advisor consulted → driver changed tack.
- It cannot manufacture a capability the agent doesn't have. The honest blocker for an agent-run
  assessment is structural: the Red Team's `list_files`/`read_file` only see the **ticket sandbox**,
  and the only route to the app (`fetch_url` to loopback) is **permission-gated**. So a local agent
  still cannot audit the app's source on its own — exactly the conclusion of the security assessment.
  To let it try for real, the owner either approves the loopback fetch, or the Red Team is given a
  tool that can read the project source under scope.

Run tally: #1 (4B) looped on HTTP; #2–#3 (27B) crashed on malformed-JSON (fixed); #4–#5 spun on
`list_files` with the advice silently empty (`stripThinking` bug, fixed); **#6 pivoted correctly**.
