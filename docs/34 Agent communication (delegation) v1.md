---
tags: [sebeto, architecture, agents, v0.8]
created: 2026-11-15
---

# Agent communication — delegation (v1)

First slice of [10 Agent Communication](10%20Agent%20Communication.md): **delegation** through the board. Built on a feature
branch (`feat/agent-comms`) while `main` stayed frozen for a production trial.

## What an agent can now do
Two new Board MCP tools (every agent session already gets Sebeto's tool server):

- **`read_ticket`** — reads the agent's own ticket (goal, status) and lists the work it delegated
  (child tickets with their status and assignee). No permission needed; read-only, own ticket only.
- **`delegate(title, goal, to_role)`** — creates a **child ticket** for a teammate and starts it.
  The agent's ticket then **waits** for the child and is resumed when it finishes.

## Guardrails (docs/10 "Guardrails")
- **Who can delegate / to whom:** only to the people who **report to** the agent, and — if the agent
  **leads a team** — its teammates. An agent with no reports cannot delegate (told to do the work
  itself or escalate with `report_status "needs_you"`).
- **Owner approval:** a new permission key **`ticket.create`** (default **Ask**). Each delegation
  asks the owner, with an *Allow for this task* option to approve all delegations on that ticket.
  Not a production change, so it is never silently allowed by a trusted-command rule.
- **Hop limit:** a chain of delegations can be at most **5** deep (`MAX_DELEGATION_HOPS`); beyond
  that the agent is told to finish and escalate instead.

## Mechanism (reuses existing machinery — no scheduler rewrite)
1. `delegate` resolves the assignee by role within the allowed set, checks the hop limit, runs the
   permission gate (`ticket.create`), then calls the normal `createTicket(... parentId, start:true)`.
2. The child is assigned to the teammate and worked on its own through the existing job queue.
3. The parent's `dependsOn` gets the child's id. The **scheduler** already wakes a parent when a
   dependency moves to `done` (`hasWork`), so the manager is resumed to wrap up when children finish.
4. A visible comment is posted on the parent ("Delegated to Ann (Analyst): T-5 — …").

New storage method `TicketRepo.childrenOf(parentId)` (indexed on `parent_id`).

## Tested
- Unit (gate fakes): `read_ticket` output; delegate refused with no reports; unknown role lists the
  roles the manager can delegate to.
- Integration (real SQLite): child created and assigned to the report, parent `dependsOn` updated,
  `read_ticket` surfaces it, and the Ask → Allow gate flow. **979 tests pass**, build clean.

## UI delegation view (slice 2, done 2026-11-15)
The ticket panel now shows a **Delegation** section: "Part of T-X — …" (clickable) when the ticket
was delegated, and a **Delegated work** list of child tickets with a status badge, each clickable to
open it. Backed by two new `TicketDetail` fields — `children` and `parent` — filled by
`getTicketDetail` (via `childrenOf`), carried through the API/OpenAPI and the UI mock. i18n en/it.

## Not yet (next slices)
- **Board grouping** of a parent with its children (the panel links exist; the board columns don't
  group yet).
- **More patterns:** `ask_agent`, `handoff`, `request_review` (docs/10), loop detection, and costs
  charged to the delegating agent's budget.
