# CR-A07 seek-barrier acceptance report

This record accompanies the issue-specific implementation for [issue #54](https://github.com/muaz978/sync-your-joy/issues/54), `CR-A07: Close the existing seek barrier's deadline and quorum holes`.

It records the existing evidence from CR-A01/PR #70, the remaining lease-boundary gap found during this review, the corrective change, deterministic verification and the external gates that remain separate from source correctness.

## Change identity

| Field | Value |
| --- | --- |
| Issue | #54, CR-A07 |
| Pull request | #81, https://github.com/muaz978/sync-your-joy/pull/81 |
| Implementation commit | `8f8c416` (`fix: cancel seek barriers on lease transfer`) |
| Repository version | 0.2.4 unless a later release decision is separately documented |
| Verification owner | muaz978 |
| Test date and timezone | 2026-09-20, Europe/Istanbul |

## Prior implementation evidence

CR-A07 was partially implemented in CR-A01, PR #70, merge commit `7451307b86aa2a8ab4bef17a3e8bed6e4c05b4e9`. That PR added and tested:

- acknowledgement expiry checked at receipt, including the exact deadline boundary;
- cancellation when a required member explicitly reports playback failure;
- fixed-target timeout pause;
- stale revision rejection for superseded barriers;
- late native seek attribution after the shared barrier expires.

Those behaviors remain valid. The issue was not closed because the acceptance criteria also require lease changes to cancel the old barrier rather than leaving an old operation alive under a new controller.

## Newly found gap

Before this change, `RoomCoordinator.transferControl()` changed the controller and incremented the lease and room revision, but it did not invalidate `pendingSeek`. A pending seek could therefore survive a controller transfer. Its barrier revision was still accepted by `acknowledgeSeek()`, allowing acknowledgements for the old operation to complete and schedule playback after the control lease had changed.

This was distinct from ordinary stale control rejection. The old acknowledgement path compares the supplied revision with the pending seek revision, not with the current room revision, so changing the room revision alone did not cancel the operation.

## Corrective implementation

When `transferControl()` has an active pending seek, it now invokes the same `pauseForMembershipChange()` boundary used by joins, disconnects, readiness loss and shared-link changes. This clears the pending seek and preserves the fixed target while the lease transition then increments the room revision and marks the new state barrier.

The change is deliberately narrow:

- normal controller transfer without an active seek does not gain an unrelated pause;
- an active seek cannot collect acknowledgements across a lease change;
- late acknowledgements for the old barrier return `null`;
- playback remains paused at the seek target and must be explicitly prepared again under the new lease.

## Post-merge implementation change: barrier window (PR #96)

This section was added on 2026-09-24 so the report matches the merged implementation. It does not change any acceptance state.

The evidence above was recorded against a seek-barrier window of 1,800 ms. After PR #81 merged, PR #96 (issue #68, CR-D03; merge commit `1d22c5b231ae4f886cc1e92ad7af2a130e5f1a1f`) changed that window in commit `d5ceef784b4ab73050b6f83b7a127f24a0ce541c`:

| Item | Before PR #96 | After PR #96 (current `main`, `v0.2.5`) |
| --- | --- | --- |
| `SEEK_BARRIER_MAX_WAIT_MS` in `packages/sync-engine/src/seek-barrier.ts` | `1_800` | `3_000` |
| Bound asserted in `packages/sync-engine/src/seek-barrier.test.ts` | `<= 2_000` | `<= 3_000`, still `> LOCAL_SEEK_MAX_WAIT_MS` (`1_500`) |

- **Stated reason** (code comment and PR #96 body): a room command waits for every ready participant, and three isolated browser profiles can need more than one scheduling turn to acknowledge the same local seek or play preparation. The window stays bounded and above the local player timeout.
- **Scope of the constant.** It sets `deadlineAtServerMs` both for the pending seek barrier (`packages/sync-engine/src/room.ts`, pending-seek creation) and for transactional operations (`room.ts`, operation creation, CR-B02). The change therefore also lengthens the preparation deadline for play and seek operations.
- **Effect on this report's criteria.** The CR-A07 deadline rules are unchanged: acknowledgements are still rejected at or after the deadline, the barrier is still bounded, and a timeout still pauses at the fixed target. The exact-deadline regression (`does not accept a seek acknowledgement at the exact barrier deadline`) reads `deadlineAtServerMs` from the room snapshot instead of a literal, so it exercises the new window. What changed is the length of the window: a participant may now hold a seek or operation for up to 3.0 s before the timeout pause.
- **Not the same as the health deadline.** The `1_800` literals that remain in `room-streaming-regressions.test.ts` and `room.test.ts` belong to the separate playback-progress health deadline (`PLAYBACK_PROGRESS_TIMEOUT_MS = 1_800` in `packages/sync-engine/src/playback-health.ts`), which PR #96 did not change.
- **Not re-verified.** No new local test run or headed observation was recorded for CR-A07 after this change. The deterministic results listed above predate PR #96. Hosted CI for PR #96 and later commits ran the engine suites against the 3,000 ms value; that is historical CI evidence, not a new CR-A07 acceptance run.
- **Related stale text.** Some older documents still describe a 1.8 s barrier or server ceiling (for example `docs/GATE_1_3_CLOSEOUT.md`, a historical gate record). Those are historical records and are not rewritten here.

## Acceptance mapping

| Criterion | Evidence |
| --- | --- |
| Enforce expiry at ACK/commit receipt, including exactly at deadline | Existing CR-A01 regression `does not accept a seek acknowledgement at the exact barrier deadline` in `room-streaming-regressions.test.ts`; retained and passing. |
| Never resume after a required member fails or becomes unready | Existing CR-A01 failure regression and `setReady`/disconnect paths cancel the active barrier; passing focused engine suite. |
| Cancel on membership, media or lease change instead of shrinking quorum | Membership and readiness paths already use `pauseForMembershipChange`; this change adds the missing lease-transfer path and regression `cancels a pending seek when the controller lease changes`. |
| Preserve timeout pause at fixed target | Existing timeout regression and the new lease regression assert paused state and target position `120`. |
| Deduplicate acknowledgements | Existing barrier implementation retains participant IDs and tests repeated/ordered acknowledgements. |
| Reject superseded acknowledgements | Existing overlap and stale-revision tests remain passing; the new lease regression asserts old acknowledgements return `null`. |

## Deterministic verification

Run from the repository root:

```sh
npx vitest run packages/sync-engine/src/room-streaming-regressions.test.ts packages/sync-engine/src/room.test.ts
npx vitest run packages/sync-engine/src/room.fuzz.test.ts
npm run check
npm audit --audit-level=high
git diff --check
```

Current focused results:

- `room-streaming-regressions.test.ts` and `room.test.ts`: 2 files, 55 tests passed.
- `room.fuzz.test.ts`: 1 file, 3 tests passed.

Full candidate verification completed locally:

- `npm run check`: 29 test files, 254 tests passed; TypeScript and edge typecheck passed; room-service build passed; extension build passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.
- `npm run release:check-version`: `0.2.4`.
- Browser package smoke: Chrome passed with manifest `0.2.4` and service worker `service-worker.js`; Firefox passed with manifest `0.2.4` and sidebar `sidepanel.html`; Safari macOS package smoke passed.
- Candidate package: `/private/tmp/syj-release-cr-a07/sync-your-joy-extension.zip`.
- Candidate package SHA-256: `837cfd67ff3eb08245243b0e273ce52aa89dde70a8e34ecd69305c5f64b8300c`.
- `npm run test:e2e`: the authenticated Crunchyroll two-profile test was skipped because isolated provider storage-state files are not configured; the generic two-profile test failed before scenario setup because the isolated Chromium process exited with `SIGABRT` and cleanup reported `EPERM`. This is an environment limitation, not a source-level CR-A07 failure.

Remote PR checks for PR #81 at review commit `7c84be9` all passed, and the same checks were rerun successfully at the final documentation head `21b5308`:

- Analyze (javascript-typescript)
- CodeQL
- DevSkim
- lowercase `devskim`
- Typecheck, test, and build

The complete diff was reviewed. GitHub rejected an approval attempt because the authenticated account owns PR #81, so the detailed review was recorded as a formal `COMMENTED` review. The review found no blocking correctness, security or documentation issue and authorized the merge decision subject to the repository policy. A test or external check that was not run is not a pass.

## Privacy and security boundaries

The change is confined to in-memory room coordination state. It does not access provider accounts, passwords, cookies, browser storage state, media bytes, protected streams, DRM data or private provider APIs. It does not change the extension's state-only provider boundary.

## External acceptance limits

The deterministic engine suites do not prove authenticated Crunchyroll behavior, visible output, two-account or two-profile behavior, two-device network conditions, deployment behavior or user acceptance. The active signed-in Crunchyroll Edge session is available for a later controlled headed observation. Do not copy its cookies or storage state into test artifacts.

## Closure and release decision

Keep issue #54 open until the applicable source, browser, provider, device, deployment and user-acceptance gates are directly evidenced and no unexplained gap remains. Move the project state to `Verification` only after the corrective PR has merged and deterministic evidence is complete. Use `Blocked` only for a concrete external dependency.

This single issue does not authorize a release bump. Keep repository version `0.2.4` unless it is later included in a coherent verified release group. Reserve `1.0.0` for milestone completion.
