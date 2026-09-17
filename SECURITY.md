# Security policy

SyncYourJoy is a controlled private beta with a single rolling release line. Only the latest published version and the `main` branch are supported; there are no long-term-support branches to report against.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability, and never include real room codes, session tokens, or other live secrets in a report.

Instead, use GitHub's private vulnerability reporting for this repository:

1. Go to the [Security tab](https://github.com/muaz978/sync-your-joy/security).
2. Select **Report a vulnerability**.
3. Describe the issue, the affected file(s) or endpoint, and, if you have one, a reproduction.

This opens a private advisory visible only to the maintainer and you, so the issue can be triaged and fixed before any public disclosure.

## Scope

In scope: the browser extension, the room protocol (`packages/protocol`), the synchronization engine (`packages/sync-engine`), and both realtime backends (`apps/room-service`, `apps/edge-service`).

Known, already-tracked limitations that do not need a new report: see [`docs/CODE_AUDIT.md`](docs/CODE_AUDIT.md) for the project's own running security and reliability audit, including items still open by design.

## What to expect

This is a solo-maintained beta project, not a company with a formal SLA. A best-effort acknowledgement and triage should follow within a few days. Fixes for confirmed, in-scope reports are prioritized ahead of new features.
