# CR-A01 implementation record

Prepared: 2026-09-20, Europe/Istanbul

This record accompanies the issue-specific pull request for GitHub issue [#48](https://github.com/muaz978/sync-your-joy/issues/48). It documents the work performed on `codex/crunchyroll-sync-hardening`, including failed attempts and the boundary between verified local behavior and external acceptance.

## Scope

CR-A01 required a reproducible baseline for the slow-loading adaptive-player path, followed by fixes for the uncovered deterministic failures. The work preserved the state-only boundary. No media bytes, screenshots of protected playback, cookies, credentials, signed stream URLs, license traffic or private provider APIs were used.

The work also implemented the directly dependent deterministic fixes that were uncovered while building the baseline:

- CR-A02, nested player identity and worker-bound authority.
- CR-A03, late native operation attribution and timeout observation.
- CR-A04, asynchronous worker binding revalidation.
- CR-A05, bounded repeated drift correction.
- CR-A07, seek deadline and fixed-quorum enforcement.
- The missing-report portion of CR-B04, plus local and edge timer wiring needed to exercise it.

## Chronological activity

1. The open pull requests were inventoried before issue work. PRs #44, #45, #46 and #47 had green checks. They were reviewed, rebased when required, rechecked after each merge, and merged in dependency order. The final merged main SHA was `bfe0d88ad53f5ed51f960b5a90e5d9253c2616c2`.

2. The open issue queue was inventoried and sorted by creation time. The oldest manual issues, #30, #33, #34 and #35, were identified as requiring real provider accounts, real devices or headed-browser access. The canonical issue map and remediation plan were used to keep the implementation sequence dependency-aware without claiming those manual gates were complete.

3. The candidate baseline was recorded in [CRUNCHYROLL_A01_BASELINE.md](CRUNCHYROLL_A01_BASELINE.md). The base SHA was `762fc585829e4b0cc3443997c049f1d281872b4d`. The environment was Darwin 27.0.0 arm64, Node `v26.7.0`, npm `11.19.0`, and Vitest `5.0.0`.

4. The pre-edit baseline passed `npm run check` with 26 Vitest files and 189 tests, TypeScript and edge typecheck, room-service build and extension build.

5. Red regressions were added and run before the corresponding fixes. The failures covered exact-deadline seek ACK acceptance, failed-member quorum shrinkage, late native completion after a shared timeout, stale asynchronous worker context after navigation, and repeated hard correction during 0.8, 1.2 and 2 second slow seeks. The complete observed failure details are preserved in the baseline document.

6. The first implementation commit, `e5abcec`, fixed the seek barrier deadline and required-member failure path. The first targeted engine suite then passed 3 files and 55 tests, and the full check passed with 26 files and 191 tests.

7. Commit `98e3e07` retained a short-lived attribution window for a native seek after the shared barrier disappeared. A late `seeked` event no longer became a new controller seek, while a genuine different target still propagated.

8. Commit `fa1891c` added the three-way identity decision `match`, `mismatch` or `unknown`, plus focused tests for strong provider IDs, unresolved generic nested frames, matching worker authority and strong mismatches. The content script now uses the worker-bound media for unresolved nested identity.

9. Commit `dfdf06c` was attempted for the worker race fix, but its first typecheck failed because the test fixture used unavailable `chrome.tabs.TabChangeInfo` types and an incomplete `chrome.tabs.Tab` value. The fixture was corrected without weakening the assertion, the worker tests and typecheck passed, and the corrected commit was amended as `ca74ac6`.

10. Commit `023816f` bounded hard correction to one local attempt and then reported an explicit bounded recovery state. A parameterized 30-second fake-provider simulation for 800, 1,200 and 2,000 ms seek delays passed with no more than two native writes per run.

11. The remaining no-status startup gap was then implemented. `RoomCoordinator` now resets health baselines for each new play or resumed seek, exposes `nextHealthDeadlineMs()` and `evaluateHealth()`, pauses at the authoritative current position when a required participant never reports, and pauses when an accepted status stream becomes silent for five seconds. The local cleanup timer and edge Durable Object alarm both invoke the evaluator. The edge path schedules the earliest health deadline alongside existing seek, controller and room deadlines. This change was committed as `74aa151`.

12. An integration regression was added for a generic nested player with only a wrapper URL. It is accepted when the worker-bound outer tab matches the room. The test passes in the real content-script lifecycle harness and was committed as `b19b5e9`.

13. The complete candidate branch was published to `origin/codex/crunchyroll-sync-hardening`. No issue-specific pull request existed before this record was prepared.

## Verification commands and results

The following commands passed after the implementation work:

```text
npm exec vitest run packages/sync-engine/src/room-streaming-regressions.test.ts packages/sync-engine/src/playback-health.test.ts packages/sync-engine/src/room.test.ts
3 files passed, 60 tests passed

npm exec vitest run apps/extension/src/content-script.test.ts apps/extension/src/player-identity.test.ts apps/extension/src/service-worker.test.ts
3 files passed, 33 tests passed

npm run check
27 Vitest files passed, 203 tests passed
TypeScript and edge typecheck passed
room-service build passed
extension build passed

git diff --check
passed
```

The existing content-script test `acknowledges a ready seek after data arrives` dispatches `canplay` without `seeked` and requires exactly one `SEEK_APPLIED` message. The new coordinator tests cover no startup status and post-start report silence. The nested identity integration test exercises the content-script lifecycle rather than only the pure helper.

## Files and artifacts

- [CRUNCHYROLL_A01_BASELINE.md](CRUNCHYROLL_A01_BASELINE.md), red baseline, source hashes, environment and post-fix evidence.
- `packages/sync-engine/src/room.ts`, health deadlines and seek barrier behavior.
- `packages/sync-engine/src/playback-health.ts`, report silence policy.
- `packages/sync-engine/src/room-streaming-regressions.test.ts`, deadline, quorum and health regressions.
- `apps/room-service/src/server.ts`, local health timer integration.
- `apps/edge-service/src/worker.ts`, edge alarm scheduling and evaluation.
- `apps/extension/src/content-script.ts`, operation attribution, identity and bounded correction behavior.
- `apps/extension/src/content-script.test.ts`, late completion, slow seek, delayed readiness and nested identity coverage.
- `apps/extension/src/player-identity.ts` and `player-identity.test.ts`, the three-way identity contract.
- `apps/extension/src/service-worker.ts` and `service-worker.test.ts`, delayed binding revalidation.
- [context-checkpoint.md](../context-checkpoint.md), the append-only chronological session record.

## Known limits and unresolved gates

The green results are source, deterministic, synthetic-provider, typecheck and local build evidence. They do not prove authenticated two-account Crunchyroll behavior, real two-device network chaos, headed cross-platform compatibility, deployment, UYAP or provider acceptance, or release readiness. Issues #30, #33, #34 and #35 remain dependent on those external environments. Edge persistence and rehydration need a Cloudflare-compatible storage and alarm harness before CR-B06 can be accepted.

This record does not claim that every open issue is complete. It documents the first issue tranche and the exact evidence available for review.
