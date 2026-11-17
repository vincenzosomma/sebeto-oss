---
tags: [sebeto, architecture, privacy]
created: 2026-11-08
---

# Local-first & privacy

**Decision (2026-11-08): we do not store or process anyone's data.** Sebeto is an app people download and run on their own computer. There is no Sebeto server, account, or cloud.

## What that means
| Topic | How it works |
|---|---|
| **Where it runs** | A desktop app (Windows, macOS, Linux) installed from GitHub Releases. It works fully on the user's machine. |
| **Tickets, chats, agents, settings** | A local SQLite database in the user's app-data folder (e.g. `%APPDATA%\Sebeto` on Windows, `~/Library/Application Support/Sebeto` on macOS). |
| **Files agents work on** | In the user's own folders: each ticket gets a sandbox folder the user chooses. |
| **API keys / logins** | Stored in the OS keychain (Windows Credential Manager / macOS Keychain / libsecret), never in our database and never sent to us. |
| **AI model calls** | Go **directly from the user's computer** to the provider they chose (Anthropic through the Claude CLI, OpenAI, Google), using **their own** account or key and under that provider's terms. With **Ollama or LM Studio, nothing leaves the computer at all**. |
| **Accounts** | None. There is no sign-up. |
| **Telemetry** | Off. Any future crash reporting must be **opt-in** and anonymous. |
| **Updates** | The app checks GitHub Releases for new versions (and can be turned off). |
| **Backups / moving machines** | Export/Import of the workspace (a zip of the database and settings). |

## "Self-hosted" vs "local"
- **Now:** **local desktop app**, even simpler than self-hosting: no server to install, just the app.
- **Container mode (planned v0.3):** the same app as a Docker image that people run on their own server and open in the browser → [14 Deployment Modes](14%20Deployment%20Modes.md).
- **Later (optional):** for teams that want a shared board, a **self-hosted sync server** that the team runs on its own machine or server (Docker). We would still hold no data. This is a v1+ idea, not a commitment.
- **Not planned:** a Sebeto cloud or SaaS run by us.

## What we tell users (README / About)
> Sebeto runs entirely on your computer. Your tickets, chats and files never touch our servers, because we don't have any. When you use a cloud AI model, your requests go directly from your machine to that provider under your own account. For full privacy, use a local model with Ollama or LM Studio.

## Consequences for the architecture
- No backend run by us. All logic lives in `sebeto-core`, which runs on the user's own hardware: as a sidecar inside the desktop app, or in the user's own container ([14 Deployment Modes](14%20Deployment%20Modes.md)).
- The **Board MCP server** ([10 Agent Communication](10%20Agent%20Communication.md)) runs **inside the app on localhost only**, bound to `127.0.0.1` with a per-session token.
- Our costs stay near zero: no hosting, no GDPR data-processor role. Users pay their AI provider directly.
- License: MIT, so anyone can audit what the app does with their data.
