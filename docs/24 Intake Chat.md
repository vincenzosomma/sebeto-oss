---
tags: [sebeto, intake, chief-of-staff]
created: 2026-11-10
---

# Intake chat with the Chief of Staff

The main way to create work: describe what you need in your own words, and the **Chief of Staff** turns it into ticket(s) for the right agents. Nothing is created until you confirm. Built on 2026-11-10.

## How it works for the owner
1. Sidebar → **Describe what you need** (the old form is still there under *Or write the ticket yourself*).
2. Write the need, or click one of the examples. Enter sends; Shift+Enter makes a new line.
3. The Chief of Staff:
   - **asks at most one question**, and only when the work cannot be described at all without the answer;
   - otherwise **proposes** right away and states its assumptions. Details the agent can ask later (an email address, a host list) go into the goal as "ask the owner for …".
4. Each proposal is an editable card: **title**, **goal and expected result**, **agent** (or Automatic), **cost cap**, "**Starts after** …" (dependencies), and one line on **why**. Untick a card to leave it out.
5. **Create and start** or **Create only**. Tickets that depend on another one start automatically when that one is completed. Each new ticket's log says "Proposed by the Chief of Staff and accepted by you".
6. The planning cost is shown under the box. The conversation stays while the app is open (closing the dialog keeps it). **Start over** clears it.

## Design
- **No ticket, no tools:** a planning turn uses the default agent's runtime and model as a plain conversation:
  - every permission is *Never* and there are no Sebeto tools, so it cannot touch files, web, mail or commands;
  - it runs in an empty `intake/` folder, with a $0.25 cap per turn, a 2-minute timeout and a fresh session per turn.
- **Stateless:** the app sends the whole conversation each turn. Nothing is stored until tickets are created.
- **Strict answer format:** the Chief of Staff answers with one JSON object (`reply` + `proposals`), and Sebeto checks it:
  - invalid proposals are dropped; an unknown agent becomes Automatic; a bad cost cap becomes $2;
  - dependencies on unknown tickets are removed; at most 8 tickets;
  - an answer that isn't JSON is shown as a normal reply.
- The free test agent is marked in the team list so real work is never assigned to it.
- API:
  - `POST /intake` `{messages, model?}` → `{reply, proposals, costUsd}`
  - `POST /intake/accept` `{proposals, start?}` creates the tickets in order and maps dependency keys to the new ticket ids.
- Code: `packages/core/src/services/intake.ts`, `packages/ui/src/components/IntakeChat.tsx`.

## Measured cost per planning turn (2026-11-10)
| Model | Cost | Time | Behaviour |
|---|---|---|---|
| Haiku | $0.003–0.004 | ~7 s | Good proposals; tends to merge steps into one ticket |
| The Assistant's default model (Claude CLI default) | $0.07–0.09 | ~5–9 s | Good questions and assumptions |

**Decided (owner, 2026-11-10): a "Planning model" setting, Haiku by default.** It is in the chat footer next to the cost: Haiku, Sonnet, Opus, or the agent's default. It is stored in `<workspace>/settings.json` (API `GET/PATCH /settings`). If the runtime doesn't offer the chosen model, the agent's model is used. Verified: a planning turn on Haiku cost **$0.002**.

## Later
- A name for the Chief of Staff (**Munaciello**?) and team templates (**Presepi**?).
- Attach files to the request; propose new agents when nobody fits; voice input.
