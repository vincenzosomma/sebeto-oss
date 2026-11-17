---
tags: [sebeto, development]
created: 2026-11-08
---

# Development guide

## Repo layout
```
packages/shared    # domain types, runtime contract, API DTOs + WS events, UUIDv7, i18n
packages/core      # sebeto-core (headless): storage, queue, bus, state machine, gate, snapshots,
                   # tools (MCP), runtimes (mock, claude-cli), executor, scheduler, API, main.ts
packages/ui        # React + Vite app (board, ticket panel), served by the core
apps/desktop       # Electron shell (runs the core in a utilityProcess)
docker/            # Dockerfile + compose (container mode)
docs/              # this vault (product + architecture)
design/            # brand assets + mockups
```

## Module boundaries
Every core module implements an interface from `packages/core/src/contracts.ts`. Business logic never touches SQLite directly; it goes through `Repos`. All agent work goes through the `JobQueue`, and status changes only go through the `StateMachine` (see [15 Architecture Review](15%20Architecture%20Review.md) and [16 Scalability](16%20Scalability.md)).

| Folder | Implements | Factory |
|---|---|---|
| `core/src/storage` | `Repos` | `openDatabase({ file, workspaceDir })` |
| `core/src/queue` | `JobQueue` | `createJobQueue(db)` |
| `core/src/bus` | `EventBus` | `createEventBus()` |
| `core/src/state` | `StateMachine` | `createStateMachine(repos, bus)` |
| `core/src/gate` | `PermissionGate` | `createPermissionGate({ repos, state, queue, bus })` |
| `core/src/snapshots` | `Snapshots` | `createSnapshots()` |
| `core/src/tools` | `ToolServer` (MCP) | `createToolServer(ctx, { baseUrl })` |
| `core/src/runtimes` | `RuntimeAdapter`s, `RuntimeRegistry` | `createMockAdapter()`, `createClaudeCliAdapter()`, `createRuntimeRegistry()` |
| `core/src/executor` | `Executor` | `createExecutor(ctx)` |
| `core/src/scheduler` | `Scheduler` | `createScheduler(ctx)` |
| `core/src/connectors` | `SecretStore`, `MailConnector`, `MailClient` | `createSecretStore(workspaceDir)`, `createMailConnector({ workspaceDir, secrets })` |
| `core/src/api` | HTTP + WS API | `createServer(ctx)` |

## Common commands
```bash
npm install                      # once
npm run build -w @sebeto/shared  # shared types must be built before the rest
npm test                         # all vitest suites
npm run typecheck                # all packages
npm run dev:core                 # core API on http://127.0.0.1:7600 (prints SEBETO_READY with the token)
npm run dev:ui                   # UI on http://localhost:5173 (proxies /api to the core); add ?mock=1 to run without the core
npm run dev:desktop              # Electron app (after building core + ui)
```

## Conventions
- TypeScript ESM (`NodeNext`): relative imports end with `.js`.
- IDs are UUIDv7 (`uuidv7()` from `@sebeto/shared`); timestamps are ISO UTC (`nowIso()`).
- Tests sit next to the code (`*.test.ts`, vitest). Tests never call paid AI APIs; the Claude adapter is tested with recorded `stream-json` fixtures. The live smoke test runs only with `SEBETO_E2E_CLAUDE=1`.
- Native module: `better-sqlite3` v12 has prebuilt binaries for Node 24, so `npm test` works as is. **Installer:** `npm run dist -w @sebeto/desktop` stages a self-contained copy and rebuilds better-sqlite3 for Electron **inside the staging folder only** (`apps/desktop/scripts/stage.mjs`), so nothing needs rebuilding by hand and the Node tests keep working. Only `npm run dev:desktop` from source still needs `npm run rebuild-native -w @sebeto/desktop` (and `npm rebuild better-sqlite3` to go back).
- Icons: `npm run icons` regenerates `apps/desktop/build/icon.ico|png` from `design/brand/sebeto-app-icon.svg`.
- One core per workspace: `<workspace>/sebeto.lock` (pid). A second core on the same workspace exits with code 3 and a clear message.
- Try the core quickly: `SEBETO_TOKEN=<16+ chars> SEBETO_RUNTIMES=mock SEBETO_UI_DIR=$PWD/packages/ui/dist node packages/core/dist/main.js`, then open the printed URL with `?token=<token>`.
- Security defaults: the API needs a bearer token even on localhost; MCP tokens are scoped to one ticket/session/run; shell and native write tools are off for agents.
- Commits end with the co-author line; the CI (GitHub Actions) runs typecheck, tests and the UI build on Ubuntu and Windows.
