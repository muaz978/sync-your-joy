# CR-A01 reproducibility baseline

Prepared: 2026-09-20, Europe/Istanbul

This document records the first implementation baseline for GitHub issue [#48](https://github.com/muaz978/sync-your-joy/issues/48). It is an evidence record, not a release claim. The test additions below were intentionally run before the coordinator fix so the two targeted failures remain traceable.

## Source and environment

- Candidate branch: `codex/crunchyroll-sync-hardening`
- Candidate base SHA: `762fc585829e4b0cc3443997c049f1d281872b4d`
- Remote `main` at inventory time: `bfe0d88ad53f5ed51f960b5a90e5d9253c2616c2`
- Platform: Darwin 27.0.0, arm64, Apple Silicon
- Node: `v26.7.0`
- npm: `11.19.0`
- Vitest: `5.0.0`, darwin-arm64
- Existing dirty file before the red regression edit: `context-checkpoint.md`
- Additional dirty file for the red regression edit: `packages/sync-engine/src/room-streaming-regressions.test.ts`

Relevant source hashes captured after adding only the red regression tests:

| File | SHA-256 |
| --- | --- |
| `apps/extension/src/content-script.ts` | `92d63931d31b28a1368b07e22583691a0352a74ac5d2f6032c36ea0d0caaa9ac` |
| `apps/extension/src/service-worker.ts` | `48388eca686cd0c27dbf93cf80e5facc3d1b8aa24afc16d5fdd4a76f60a4f090` |
| `apps/extension/src/player-tab.ts` | `636d612a0f16b22f8a70d31f1a4b93e3dfe781ea84809fd46f70220bc957b295` |
| `packages/sync-engine/src/room.ts` | `3ff7bbe6661e1d45ccab13ab82d7357e3e20d363edac0567420fce59fd4b92f3` |
| `packages/sync-engine/src/playback-health.ts` | `1be66561051b1441c01483c9f7fa582d8eb2e4fdf0d0292e48d3cee5c798fb51` |
| `packages/sync-engine/src/room-streaming-regressions.test.ts` | `b51a09e29110d183669d101ff9a4e65f375c40d2426d38056e04ec49a3f18a9e` |
| `tests/e2e/two-profile-sync.spec.ts` | `9eea1549a59ba9fc524b4fdc6a41416e252ea71f785c86bcf69475372ae4783c` |

The existing candidate source was otherwise unchanged. No provider account, cookie, credential, stream URL or protected media data was used.

## Green pre-edit baseline

Before adding the new red regressions:

```text
npm run check
TypeScript and edge typecheck passed
26 Vitest files passed
189 tests passed
room-service build passed
extension build passed
```

`git diff --check` also passed. This command does not execute Playwright.

## Red regressions reproduced before the fix

Command:

```text
npx vitest run packages/sync-engine/src/room-streaming-regressions.test.ts
```

Observed result:

```text
Test Files  1 failed (1)
Tests       2 failed | 8 passed (10)
```

Failure 1, exact deadline ACK:

- New regression: `does not accept a seek acknowledgement at the exact barrier deadline`.
- Expected: `seek_timeout_paused`, with `seek: null` and the fixed target retained at 120 seconds.
- Actual: `seek_participant_aligned`, with the host ACK recorded while the seek deadline was exactly 11,800 ms.
- Source gap: `acknowledgeSeek()` checked revision, readiness, media and target alignment, but did not enforce `deadlineAtServerMs` before accepting the ACK.

Failure 2, required-member failure:

- New regression: `cancels a seek when a required participant explicitly fails instead of shrinking the quorum`.
- Expected: the pending barrier is cancelled, the room remains paused at 120 seconds, and late ACKs from the old barrier are ignored.
- Actual: the room remained paused at 120 seconds but retained a pending seek with an empty ACK list after the failed participant was marked unready. The existing `acknowledgeSeek()` implementation recomputed required members from current ready participants, so the failed participant could be omitted from the quorum.
- Source gap: explicit `playbackStartFailed` handling paused the room and cleared readiness but did not cancel the pending seek operation.

Failure 3, late native completion after shared timeout:

- New regression: `does not turn a late native completion into a new seek after the room barrier expires`.
- Expected: after the coordinator releases the shared barrier, a late `seeked` event remains attributed to the old native operation and produces no new controller `PLAYER_INTENT` seek.
- Actual: clearing the room barrier cleared the pending operation attribution. The late `seeked` event was treated as a fresh controller scrub and emitted a new seek intent.
- Source gap: the content script retained no bounded attribution record after the shared barrier disappeared.

Failure 4, stale worker context after navigation:

- New regression: `does not restore a delayed context after the bound tab starts a new navigation`.
- Expected: after `tabs.onUpdated(..., { status: 'loading' })` clears the binding, an older asynchronous `GET_PLAYER_CONTEXT` result is ignored and both `playerFrameId` and `currentMedia` remain empty.
- Actual: the old refresh committed media from the new URL after the navigation handler had cleared the binding. The test observed `currentMedia` for `GE00365017JAJP` while `playerFrameId` was already null.
- Source gap: `refreshBoundPlayerTab()` did not capture and revalidate the tab, frame and context generation around its awaited browser calls.

Failure 5, repeated slow-seek correction:

- New parameterized regressions: `bounds hard corrections during a 800ms seek and 30 seconds of stalled playback`, and the equivalent 1,200 ms and 2,000 ms cases.
- Command result: 25 content-script tests, 3 failed and 22 passed.
- Expected: no more than two native position writes, with a buffering or recovery report after the player repeatedly completes corrections without making forward progress.
- Actual: each delay produced 10 native position writes during the 30-second simulation.
- Source gap: the recovery grace can expire and re-enter the hard-seek path repeatedly when a provider accepts each correction but does not converge.

These failures are deterministic and use injected time. They do not claim that a protected Crunchyroll player caused the same sequence.

## Post-fix verification

The following candidate fixes were then applied on the same branch:

- `e5abcec` checks the seek deadline on receipt and cancels a pending seek when a required participant explicitly fails.
- `98e3e07` retains late native seek attribution after the shared barrier disappears.
- `fa1891c` gives strong provider identities and current worker bindings an authoritative three-way identity decision for nested players.
- `ca74ac6` rejects delayed worker context results after tab, frame or binding-generation changes.
- `023816f` bounds repeated hard seek corrections and reports bounded recovery for persistent slow-player drift.
- The current uncommitted health increment adds `nextHealthDeadlineMs()` and `evaluateHealth()` to terminate silent startup and post-start report silence, and wires both backend timer paths to that deadline.

Focused verification after those fixes:

```text
npm exec vitest run packages/sync-engine/src/room-streaming-regressions.test.ts packages/sync-engine/src/playback-health.test.ts packages/sync-engine/src/room.test.ts
3 files passed, 60 tests passed

npm exec vitest run apps/extension/src/content-script.test.ts apps/extension/src/player-identity.test.ts apps/extension/src/service-worker.test.ts
3 files passed, 33 tests passed

npm run check
27 Vitest files passed, 204 tests passed
TypeScript and edge typecheck passed
room-service build passed
extension build passed
```

The delayed-readiness case is covered by the existing content-script test `acknowledges a ready seek after data arrives`, which deliberately dispatches `canplay` without `seeked` and requires exactly one `SEEK_APPLIED` message. The new coordinator tests cover a participant that sends no startup status and a participant whose accepted status stream becomes silent. `git diff --check` passed.

This is local deterministic and synthetic-provider evidence. It does not establish authenticated Crunchyroll acceptance, two-device behavior, headed-browser compatibility, deployment, or release readiness.

## Reproduction coverage still to add

The remaining CR-A01 cases are tracked separately and are not represented as passes here:

- authenticated two-account Crunchyroll acceptance and cross-provider behavior;
- headed-browser and two-device network-chaos validation;
- integrated edge alarm and local cleanup-timer runtime traces, beyond the coordinator and build tests already run;
- independent live-provider visible-progress evidence after every recovery and seek case.

The implementation sequence remains evidence-first: preserve this red record, keep the focused fixes and tests, then complete the external runtime gates before treating the broader manual issues as resolved. A passing local fixture remains separate from authenticated Crunchyroll acceptance.
