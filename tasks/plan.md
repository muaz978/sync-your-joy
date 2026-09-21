# Implementation Plan: CR-D01 isolated E2E build and failure artifacts

## Overview

Issue #66 hardens the real two-profile browser test so every run uses an isolated extension build, records enough provenance to identify the exact source and configuration, and preserves sanitized per-profile diagnostics without overwriting a release build. The task is tracked in GitHub issue [#66](https://github.com/muaz978/sync-your-joy/issues/66); this file is the local implementation plan and checkpoint index, not a replacement for the issue tracker.

## Architecture Decisions

- Playwright receives a unique run output directory. The E2E build is placed below that directory, while the normal `apps/extension/dist` release or development output remains untouched.
- The build script accepts an explicit output directory but keeps `apps/extension/dist` as the default for normal commands.
- Global setup writes a provenance manifest containing the source commit, a deterministic tracked-source hash, lockfile hash, E2E/build configuration hash, room-service endpoint identity and extension-output identity. It does not store credentials, cookies, protected provider state or media data.
- Each persistent profile records sanitized lifecycle events and safe panel-state booleans. URLs lose query strings and fragments before being written. Room codes, account data and page content are never recorded.
- Tracing is explicit and opt-in through `SYNCYOURJOY_E2E_TRACE=1`. It is disabled for protected provider runs unless the operator deliberately enables it in a safe environment. The sanitized event/state logs remain available without tracing.
- A small reporter writes a sanitized run summary and classifies failures as browser-launch/setup failures or product-test failures. This keeps a failed browser launch from being mistaken for a product assertion failure.
- Existing test behavior remains the same for the local fixture and opt-in provider paths except for the isolated output and additional diagnostics.

## Task List

### Phase 1: Provenance and isolated build

- [x] Add an explicit extension output-directory override to `scripts/build-extension.mjs`.
- [x] Make Playwright allocate a unique run output directory and make global setup build into an isolated child directory.
- [x] Write source, lockfile and configuration hashes plus endpoint and output provenance.

### Phase 2: Profile diagnostics

- [x] Add sanitized per-profile event and state logging.
- [x] Add explicit opt-in trace start and stop with a per-profile trace path.
- [x] Add launch-failure classification and a sanitized run summary reporter.
- [x] Record state checkpoints in the local fixture and protected provider specs.

### Checkpoint: deterministic artifact behavior

- [x] Existing unit and typecheck suites pass.
- [x] A normal local E2E run uses a unique output directory and produces provenance and profile logs.
- [x] A controlled failure distinguishes browser launch/setup from a product assertion and retains diagnostics.
- [x] `apps/extension/dist` is unchanged by E2E setup.

### Phase 3: Documentation and handoff

- [x] Document artifact locations, trace privacy, provenance fields and failure categories in the test guide and a CR-D01 report.
- [x] Run the complete repository checks and browser package checks.
- [ ] Commit, push, open a metadata-complete PR, review the exact final head, merge only after review, and update issue #66 without closing it until all applicable gates are evidenced.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A stale endpoint or previous run is reused | High | Unique run directory and unconditional isolated build |
| Diagnostic artifacts expose provider data | High | Sanitized URL handling, selector-based state only, opt-in traces, no page content or storage state |
| A launch failure is reported as a product bug | Medium | Explicit browser-launch error marker and run-summary classification |
| E2E build overwrites release output | High | Build override points only at `test-results` run output |
| A failed test leaves profile artifacts unwritten | Medium | `afterAll` closes profiles and close writes logs in a finally-style path |

## Open Questions

- The later protected Crunchyroll gate still requires secure storage-state inputs and is not proven by the deterministic fixture run. This issue only improves its build and diagnostic boundary.
- Video recording remains optional and is not enabled by default because screenshots or recordings may expose protected provider content.
