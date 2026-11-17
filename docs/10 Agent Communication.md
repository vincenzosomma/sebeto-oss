---
tags: [sebeto, architecture, agents]
created: 2026-11-08
---

# Agent communication

**Principle: agents talk through the board, never in hidden chats.** Every message between agents is visible on a ticket, so a non-technical owner can always see who asked whom for what, and what it cost.

## Patterns
| Pattern | Example | On the board |
|---|---|---|
| **Delegate** | The Infrastructure Lead splits "Windows 11 rollout" into sub-tickets for the Sysadmin assistant, Analyst and Comms writer | Child tickets linked to a parent; the parent completes when all its children do |
| **Hand off** | The Analyst passes the top incident causes to the Comms writer | A handoff message appears in both tickets, with outputs attached |
| **Ask a colleague** | The Comms writer asks the Analyst how many users were affected | A question-and-answer pair recorded in both tickets |
| **Review** | The Comms writer sends a draft to the Service Desk Lead before it reaches the owner | A review message; the manager approves or sends it back |
| **Report up** | Each worker reports to its manager on its check-in schedule | A status comment on the ticket |
| **Escalate** | Nobody can solve it → Chief of Staff → owner | Lands in **Needs you** |

## Mechanism: the Board MCP server
The app runs a local **MCP server**, and every agent session is started with it attached (Claude CLI: `--mcp-config board.json`; other runtimes through their own MCP support, or the app's built-in tool loop for local models).

| Tool | What it does |
|---|---|
| `read_ticket(id)` | Reads a ticket's goal, status, outputs, and a summary of its chat |
| `create_ticket(title, goal, assignee_role, parent_id?)` | Delegates work (managers only, or with owner approval) |
| `comment_on_ticket(id, text)` | Leaves a visible note |
| `ask_agent(role, question, ticket_id)` | Asks a colleague a question; the answer arrives on its next run |
| `handoff(ticket_id, to_role, note, outputs[])` | Passes the work on and reassigns the ticket |
| `request_review(ticket_id)` | Sends the work to the agent's manager |
| `report_status(ticket_id, status, note)` | Sets In progress / Needs you / Blocked explicitly, for clean status changes |
| `search_knowledge(query)` | Searches the shared team notes (see below) |

When an agent calls a tool, the app writes the message to the **outbox table**, updates the board, and the **scheduler** wakes the receiving agent by resuming its session with the message, either right away or on its next check-in.

## Wake-ups
Agents are woken by **events** (a user reply, a handoff, a dependency finishing, a permission answered). The heartbeat is a **cheap check in code**, not a model call; the model runs only when there is work ([15 Architecture Review](15%20Architecture%20Review.md) #8).

## Guardrails (mandatory)
- **Who can talk to whom** follows the org chart: an agent can contact its manager, the agents reporting to it, and teammates on the same team. Anything else is routed through the Chief of Staff.
- **Hop limit:** a single request can pass between agents at most 5 times; after that it goes to **Needs you**.
- **Loop detection:** the same pair of agents exchanging more than 3 messages on one ticket without progress triggers an automatic pause.
- **Costs are charged to the sender** (the asking agent's budget). Every delegation shows its estimated cost; delegations above a threshold need owner approval.
- **No secrets cross agents:** API keys and permissions never travel in messages; each agent keeps its own permissions.

## Shared team notes (knowledge)
A small per-team wiki (Markdown in the workspace) that agents can read and propose edits to: brand voice, customer facts, contact lists. This means fewer repeated "ask a colleague" round-trips and fewer tokens. The owner approves the edits agents propose.

## Context passing
Handoffs carry a **short summary + output files**, never a whole chat transcript. This keeps costs down and works across different runtimes (for example from Gemini to Claude).
