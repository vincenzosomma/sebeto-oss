---
tags: [sebeto, architecture, deployment]
created: 2026-11-08
---

# Deployment modes: desktop app + container

**Question (2026-11-08):** can Sebeto also be deployed as a container, or would that complicate the architecture?
**Answer:** it's cheap **if we design for it now**, and expensive if we add it later. The trick is to make the core of the app a small **headless service** with a web UI, and treat "desktop" and "container" as two thin shells around the same code.

## One core, two shells
```
            ┌───────────────── sebeto-core (headless) ─────────────────┐
            │ orchestrator · scheduler · runtime adapters · Board MCP   │
            │ SQLite · snapshots · budgets · HTTP + WebSocket API       │
            └──────────────▲───────────────────────────▲───────────────┘
                           │                           │
   Desktop app (Electron) ─┘                           └──── Container (Docker)
   • starts core as a local sidecar                     • core serves the same web UI
   • UI in a native window                              • open http://host:7600 in a browser
   • keys in the OS keychain                            • keys from env / Docker secrets
   • files = user's folders                             • files = mounted volumes
```
The **React UI is the same** in both. It talks to the core over HTTP and WebSocket, whether the core runs on the same laptop or on a server.

## What changes in container mode
| Topic | Desktop | Container |
|---|---|---|
| Access | Native window, localhost only | Browser; **login required** (single-user password or token at first; users/roles later) |
| Secrets | OS keychain | Environment variables / Docker secrets, encrypted at rest |
| Agent CLIs (`claude`, `codex`, `gemini`) | The user's installed tools | **Installed in the image**; logins via API keys in env (interactive logins don't fit containers) |
| Local models | Ollama/LM Studio on the same PC | A separate `ollama` service in docker-compose |
| Files | User picks folders | Mounted volumes (`/workspace`); each ticket folder sits under it |
| Data | App-data folder | `/data` volume (SQLite + snapshots) |
| Sandboxing | Folder rules | Stronger: the container is itself a sandbox |
| Updates | Auto-update from GitHub Releases | New image tag (`ghcr.io/vincenzosomma/sebeto-oss`) |

**Privacy is unchanged:** the user or their team runs the container on **their own** machine or server. We still hold no data ([13 Local-first & Privacy](13%20Local-first%20%26%20Privacy.md)).

## Example (target)
```yaml
# docker-compose.yml
services:
  sebeto:
    image: ghcr.io/vincenzosomma/sebeto-oss:latest
    ports: ["7600:7600"]
    environment:
      SEBETO_ADMIN_PASSWORD_FILE: /run/secrets/admin_pw
      ANTHROPIC_API_KEY_FILE: /run/secrets/anthropic
    volumes:
      - sebeto-data:/data
      - ./workspace:/workspace
    secrets: [admin_pw, anthropic]
  ollama:            # optional, fully offline models
    image: ollama/ollama
    volumes: [ollama:/root/.ollama]
volumes: { sebeto-data: {}, ollama: {} }
secrets:
  admin_pw: { file: ./secrets/admin_pw.txt }
  anthropic: { file: ./secrets/anthropic.txt }
```

## Impact on the stack (decision)
- **sebeto-core in TypeScript (Node.js):** Fastify (HTTP) + WebSocket + better-sqlite3. It runs the same way in Docker and on desktop, and the Claude Agent SDK is TypeScript-first. Spawning the `claude` CLI is simple from Node.
- **UI:** React + TypeScript (unchanged), built as static files that the core serves.
- **Desktop shell:** **Electron** runs `sebeto-core` in a `utilityProcess` and opens the UI in a window (chosen over Tauri after [15 Architecture Review](15%20Architecture%20Review.md): one language, simpler packaging; heavier installer accepted).
- **Monorepo layout:** `packages/core`, `packages/ui`, `packages/shared`, `apps/desktop`, `docker/`.

## Windows installer
Built 2026-11-11. One command builds everything and writes `apps/desktop/release/Sebeto-Setup-<version>.exe` (about 100 MB):
```powershell
npm run dist -w @sebeto/desktop
```
- **What it does:** builds the workspace, stages a self-contained app in `apps/desktop/stage/` (`scripts/stage.mjs`: the Electron main, the built core and shared packages, the core's production dependencies), rebuilds `better-sqlite3` for Electron **inside that folder only**, then runs electron-builder. Your own `node_modules` stay on Node's ABI, so `npm test` keeps working; no manual rebuild commands.
- **Installer:** NSIS, one click, **per-user** (`%LOCALAPPDATA%\Programs\Sebeto`, no admin rights), desktop and Start-menu shortcuts, uninstaller in Settings → Apps. Silent install: `Sebeto-Setup-0.1.0.exe /S` (optionally `/D=<folder>`); silent uninstall: `"Uninstall Sebeto.exe" /S`.
- **Data:** the app uses the same workspace as `npm start`, `~/.sebeto/workspace` (override with the `SEBETO_WORKSPACE` environment variable). Uninstalling never deletes it. The core listens on a random free port on 127.0.0.1, never a fixed one.
- **Icons:** `apps/desktop/build/icon.png` (1024 px) and `icon.ico` are generated from `design/brand/sebeto-app-icon.svg` with `npm run icons` (renders with the Electron already installed; no extra dependency). electron-builder turns the 1024 px PNG into the macOS `.icns` and the Linux icon sizes itself.
- **CI:** the `Windows installer` job in `.github/workflows/ci.yml` builds the installer on `windows-latest` and uploads it as the workflow artifact `sebeto-windows-installer` (kept 14 days). No release is published.
- **Not signed yet:** Windows SmartScreen shows "Windows protected your PC" on first run (More info → Run anyway). Code signing comes before the public release.

## macOS and Linux packages
Built 2026-11-11. The same command, run on a Mac or a Linux machine, builds that platform's packages (electron-builder can't build them from Windows; CI builds all three):
```bash
npm run dist -w @sebeto/desktop
```
| Platform | Output in `apps/desktop/release/` | Notes |
|---|---|---|
| macOS | `Sebeto-<version>-arm64.dmg` (Apple silicon), `Sebeto-<version>-x64.dmg` (Intel) | Two separate disk images, about 120 MB each. `scripts/stage.mjs` rebuilds `better-sqlite3` for Electron for both arm64 and x64 and merges them with `lipo` into one fat binary, so both apps load it. |
| Linux (x64) | `Sebeto-<version>-x86_64.AppImage`, `sebeto_<version>_amd64.deb` | The `.deb` installs to `/opt/Sebeto` (command `sebeto`) with an AppArmor profile for Ubuntu 24.04+. |

- **Same staging as Windows:** the workspace's own `node_modules` stay on Node's ABI, so `npm test` keeps working after a build.
- **macOS is not signed with a Developer ID and not notarized.** The app has only an ad-hoc signature (needed to run on Apple silicon at all). Gatekeeper blocks the first launch ("Apple could not verify Sebeto is free of malware"): open **System Settings → Privacy & Security** and click **Open Anyway**, or remove the quarantine flag with `xattr -dr com.apple.quarantine /Applications/Sebeto.app`. Signing and notarization come before the public release.
- **Linux is not signed either.** AppImage: `chmod +x Sebeto-*.AppImage`, then run it. It needs FUSE 2 (`sudo apt install libfuse2t64` on Ubuntu 24.04), or run it with `--appimage-extract-and-run`. Ubuntu 24.04+ blocks the Chromium sandbox for AppImages (there is no AppArmor profile for them), so it may only start with `--no-sandbox`; the `.deb` doesn't have this problem. `.deb`: `sudo apt install ./sebeto_0.1.0_amd64.deb`.
- **Data:** the same workspace as everywhere else, `~/.sebeto/workspace` (`SEBETO_WORKSPACE` overrides it).
- **CI:** the `Linux packages` job (`ubuntu-latest`) and the `macOS package` job (`macos-latest`) in `.github/workflows/ci.yml` build the packages and upload them as the workflow artifacts `sebeto-linux-packages` (AppImage + .deb) and `sebeto-macos-dmg` (both .dmg files), kept 14 days. Download them from the run's summary page in GitHub Actions. No release is published. Both jobs also smoke-test the packaged app with `apps/desktop/scripts/smoke-health.sh` (a temporary workspace, the mock runtime, then `GET /api/v1/health` and the UI at `/`):
  - Linux: the packaged core run by the packaged Electron as Node (proves the Electron-ABI `better-sqlite3` loads), the whole AppImage under Xvfb, and the installed `.deb` under Xvfb.
  - macOS: the packaged core and the whole arm64 app, plus the x64 app's packaged core under Rosetta; the job also checks the architectures (`lipo`), the `.icns` and the ad-hoc signature (`codesign --verify`). The whole x64 app is not launched (the runner is Apple silicon).

## Cost and risk
- **Extra work now:** small. We already planned the UI ↔ core boundary, so it only has to be a real HTTP/WebSocket API instead of in-process calls.
- **Extra work later for container mode:** login screen, secrets from env, Dockerfile with the CLIs, compose file, CI to publish the image. This is about one milestone.
- **Main risk:** exposing an agent that can run tools on a network. Mitigations: auth is mandatory, the default bind is localhost unless configured, HTTPS goes through the user's reverse proxy, and permissions default to "Ask".
