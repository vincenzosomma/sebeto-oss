# Contributing

Thanks for your interest! Sebeto is an early public preview, so the most useful contributions right now are:

- **Feedback on the UX** for non-technical users (open an issue with the `ux` label)
- **Team templates:** org charts of agents for a use case (marketing, ops, research…)
- **Runtime adapters and connectors:** new AI runtimes or MCP connectors, always behind the permission gate
- **Bug reports** from real use (use the issue templates; attach **Export diagnostics**, never raw logs)

## Workflow
1. Open an issue describing the change before large work.
2. Fork, create a branch (`feat/…`, `fix/…`, `docs/…`).
3. Keep PRs focused; describe what and why.

## Principles
- A user who has never seen a terminal must be able to use every feature.
- Never let an agent lose a user's file: snapshot before writing.
- Every cost must be visible, and every budget must have a hard stop.

## Community
- Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
- Security problems: report them privately, see [SECURITY.md](SECURITY.md).
- Add your change to `CHANGELOG.md` under an *Unreleased* heading.
