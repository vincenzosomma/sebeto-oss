---
tags: [sebeto, architecture, scalability]
created: 2026-11-08
---

# Scalability

**Goal set by the user (2026-11-08):** "the app must scale without problems." This note defines what scaling means for Sebeto and the design rules we commit to **before writing code**, so growth never needs a rewrite.

## What "scale" means here
| Dimension | Target | Where the real limit is |
|---|---|---|
| Tickets & history per workspace | 100k+ tickets, millions of messages and events | Database indexes, pagination, search |
| Agents per workspace | 50+ agents, 200+ skills | Scheduler fairness, UI lists |
| Agents running at the same time | Desktop: 3–10 · container: 10–50+ | **AI provider rate limits and cost**, then CPU/RAM per runtime process |
| Users (container mode) | 1 → a team of 50 | Auth, roles, a multi-writer database |
| Deployments | 1 laptop → 1 server → several app instances | Single scheduler/leader, shared storage |

The first bottleneck is almost never our code: it's **provider rate limits, tokens and money**. So scaling starts with scheduling and budgets, not servers.

## Three stages, one codebase
| Stage | Shape | Storage | Scheduler |
|---|---|---|---|
| **S1 Desktop** | 1 process (Electron + core) | SQLite (WAL) | In-process job queue |
| **S2 Team server** | 1 container, many browsers | SQLite → **Postgres** (config switch) | In-process queue, Postgres-backed |
| **S3 Scale-out** | N API instances + M worker instances behind a load balancer | Postgres + object storage for files/snapshots | **Postgres job queue** (`SELECT … FOR UPDATE SKIP LOCKED`) shared by workers; one leader for timers via advisory lock |

S2 and S3 are not built now. Their **seams** are built now.

## Design rules we commit to now (the seams)
1. **Storage behind a repository layer** (Drizzle ORM). No raw SQLite-only SQL in business logic. SQLite and Postgres both supported by migrations.
2. **IDs are UUIDv7/ULID**, generated in the app (sortable, safe to merge across instances), never auto-increment.
3. **Job queue interface** (`enqueue`, `claim`, `complete`, `retry`) with an in-memory/SQLite implementation now and a Postgres `SKIP LOCKED` implementation later. All work (runs, heartbeats, messages) goes through it, with no ad-hoc `setTimeout`.
4. **API and workers are separable:** the API layer never runs an agent directly; it enqueues jobs. On desktop both live in one process; in S3 they become separate deployments.
5. **Event bus interface** for live updates (in-process emitter now; Postgres `LISTEN/NOTIFY` or Redis later). The UI only listens to the bus through WebSocket.
6. **File/snapshot storage interface:** local disk now (git per ticket); object storage (S3-compatible) later for S3.
7. **Pagination and limits everywhere:** cursor pagination on every list endpoint, capped page sizes, virtualised lists in the UI (board columns, chats, logs).
8. **Search behind an interface:** SQLite FTS5 now → Postgres full-text (`tsvector`) later → optional embeddings.
9. **Backpressure and fairness:** global, per-runtime and per-provider concurrency limits; token-bucket rate limiting per API key; a priority queue (Needs-you replies > user runs > handoffs > heartbeats); retries with exponential backoff on 429/5xx.
10. **Bounded growth:** context compaction for long sessions; archive completed tickets after N days (still searchable); prune old events into compressed archives.
11. **Stateless runs:** everything a run needs (session ID, ticket state, snapshot commit) is in the database, so any worker can pick up any job and a crash loses at most one run, which is retried.
12. **Measure from day one:** queue depth, run duration, tokens and cost per minute, provider 429 rate, and DB query time. These numbers trigger the move from S1 to S2 to S3, not guesses.

## Honest limits
- A **desktop app** scales to one person's workload. That's by design.
- **Real throughput is capped by AI providers** (rate limits, cost). Sebeto's job is to queue, prioritise and budget gracefully, not to bypass them.
- Moving to **S3 needs Postgres and object storage** that the team runs itself (still self-hosted, still no data held by us).
