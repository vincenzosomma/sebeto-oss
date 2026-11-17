# Security policy

Sebeto runs agents that can read and change files, run commands and call other systems, so security
reports matter a lot to us.

## Reporting a vulnerability
Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and the impact you expect. We will acknowledge the report,
keep you updated, and credit you in the release notes if you wish.

## Scope
- The core (`packages/core`): the permission gate, tool sandboxing, the API and its token, connectors and
  secret storage, triggers and webhooks.
- The UI (`packages/ui`) and the desktop app (`apps/desktop`).

Issues in third-party AI providers, MCP servers or connectors are out of scope, unless Sebeto makes them
worse (for example, by passing untrusted content on without marking it).
