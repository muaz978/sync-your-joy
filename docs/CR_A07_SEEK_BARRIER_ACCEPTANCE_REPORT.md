# CR-A07 seek-barrier acceptance report

This record accompanies the issue-specific implementation for [issue #54](https://github.com/muaz978/sync-your-joy/issues/54), `CR-A07: Close the existing seek barrier's deadline and quorum holes`.

It records the existing evidence from CR-A01/PR #70, the remaining lease-boundary gap found during this review, the corrective change, deterministic verification and the external gates that remain separate from source correctness.

It was refreshed on 2026-10-31 against the pinned commit `86f9ddfb8fe1fff07f6f606be8652c3d5c81ddfd` (extension and repository version 0.2.12). The refresh adds engine tests and records an accepted limit. It changes no production code, ticks no acceptance row and does not state that any browser, provider, two-account, two-device, deployment or acceptance gate is met. See [What is not evidenced](#what-is-not-evidenced).

## Change identity

| Field | Value |
| --- | --- |
| Issue | #54, CR-A07 |
| Pull request | #81, https://github.com/muaz978/sync-your-joy/pull/81 |
| Implementation commit | `8f8c416` (`fix: cancel seek barriers on lease transfer`) |
| Repository version when PR #81 was verified | 0.2.4 (historical) |
| Repository and extension version at the refresh | 0.2.12, pinned commit `86f9ddfb8fe1fff07f6f606be8652c3d5c81ddfd` |
| Verification owner | muaz978 |
| Test date and timezone | 2026-09-20, Europe/Istanbul (original); refresh 2026-10-31 |

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

## Which barrier a room uses

A room is transactional when every connected participant advertises `CURRENT_CLIENT_CAPABILITIES` (extension 0.2.5 or later). A seek is then an operation in `contract.operation` with a fixed set of required participants, and `snapshot.seek` stays null. A room in which any connected participant does not advertise them is a legacy room: the seek is `snapshot.seek`, and its quorum is recomputed from the connected, ready and matching participants every time an acknowledgement arrives.

The owner has decided that every participant is on the latest release, so the legacy barrier is no longer supported (see [Accepted limit: the legacy barrier](#accepted-limit-the-legacy-barrier)). The statements below about fixed quorum, cancellation and receipt-time expiry are evidenced for the transactional barrier. For the legacy barrier they are evidenced only where a test named in the acceptance mapping covers the case.

## Post-merge implementation change: paused seeks settle (PR #111)

PR #111 (merge commit `5d47400212d51309b5429f788d2f8fb00f818c91`, released in 0.2.6) changed what happens when a transactional paused seek has been prepared by every required participant: its window ending now clears the operation (`operation_seek_settled`) and leaves the room paused at the target, instead of failing it with a start timeout that put every participant into recovery. The existing test `settles a committed paused seek when its window closes instead of failing the room` pins this.

It does not weaken the deadline rule. A seek that is still collecting preparation when its window ends, or when an acknowledgement arrives at or after the deadline, fails with reason `deadline-expired` and the room is paused at the target. Only a seek that every required participant already prepared is settled rather than failed.

## Post-merge implementation change: barrier window (PR #96)

This section was added on 2026-09-24 so the report matches the merged implementation. It does not change any acceptance state. At the pinned commit the window is still 3,000 ms, so all deadline statements in this report are made against that value.

The evidence above was recorded against a seek-barrier window of 1,800 ms. After PR #81 merged, PR #96 (issue #68, CR-D03; merge commit `1d22c5b231ae4f886cc1e92ad7af2a130e5f1a1f`) changed that window in commit `d5ceef784b4ab73050b6f83b7a127f24a0ce541c`:

| Item | Before PR #96 | After PR #96 (still current at the pinned commit, extension 0.2.12) |
| --- | --- | --- |
| `SEEK_BARRIER_MAX_WAIT_MS` in `packages/sync-engine/src/seek-barrier.ts` | `1_800` | `3_000` |
| Bound asserted in `packages/sync-engine/src/seek-barrier.test.ts` | `<= 2_000` | `<= 3_000`, still `> LOCAL_SEEK_MAX_WAIT_MS` (`1_500`) |

- **Stated reason** (code comment and PR #96 body): a room command waits for every ready participant, and three isolated browser profiles can need more than one scheduling turn to acknowledge the same local seek or play preparation. The window stays bounded and above the local player timeout.
- **Scope of the constant.** It sets `deadlineAtServerMs` both for the pending seek barrier (`packages/sync-engine/src/room.ts`, pending-seek creation) and for transactional operations (`room.ts`, operation creation, CR-B02). The change therefore also lengthens the preparation deadline for play and seek operations.
- **Effect on this report's criteria.** The CR-A07 deadline rules are unchanged: an acknowledgement received at or after the deadline does not complete the barrier; the room instead pauses at the fixed target with reason `seek_timeout_paused`. The barrier is still bounded. The exact-deadline regression (`does not accept a seek acknowledgement at the exact barrier deadline`) reads `deadlineAtServerMs` from the room snapshot instead of a literal, so it exercises the new window. What changed is the length of the window: a participant may now hold a seek or operation for up to 3.0 s before the timeout pause.
- **Not the same as the health deadline.** The `1_800` literals that remain in `room-streaming-regressions.test.ts` and `room.test.ts` belong to the separate playback-progress health deadline (`PLAYBACK_PROGRESS_TIMEOUT_MS = 1_800` in `packages/sync-engine/src/playback-health.ts`), which PR #96 did not change.
- **Not re-verified.** No new local test run or headed observation was recorded for CR-A07 after this change. The deterministic results listed above predate PR #96. Hosted CI for PR #96 and later commits ran the engine suites against the 3,000 ms value; that is historical CI evidence, not a new CR-A07 acceptance run.
- **Related stale text.** Some older documents still describe a 1.8 s barrier or server ceiling (for example `docs/GATE_1_3_CLOSEOUT.md`, a historical gate record). Those are historical records and are not rewritten here.

## Acceptance mapping

Test names are the titles in the test files. `room.test.ts` is `packages/sync-engine/src/room.test.ts`, `room-streaming-regressions.test.ts` and `room.fuzz.test.ts` are in the same directory. Each row is source-level evidence only (unit and protocol tests on synthetic fixtures). No row is an acceptance tick.

| Criterion | Evidence |
| --- | --- |
| Enforce expiry at ACK/commit receipt, including exactly at deadline | Legacy: `does not accept a seek acknowledgement at the exact barrier deadline` (`room-streaming-regressions.test.ts`). Transactional: in `room.test.ts`, `still completes the barrier one millisecond before the deadline`, and `fails the operation and pauses at the target for an acknowledgement 0 ms after the deadline, before any timer runs` and the same title with `1 ms`. They call `acknowledgeOperation` at `deadlineAtServerMs - 1`, `deadlineAtServerMs` and `deadlineAtServerMs + 1` with the acknowledgement that would complete the barrier, and assert `operation_committed` before the deadline and `operation_timeout_paused`, phase `failed`, reason `deadline-expired`, paused at the target, from the deadline on. The window is 3,000 ms (PR #96). The fuzz invariant in the last row covers the same rule over random sequences. |
| Never resume after a required member fails or becomes unready | Legacy: `cancels a seek when a required participant explicitly fails instead of shrinking the quorum` (failure at the seek's own revision; see the accepted limit for the case that is not covered). Transactional: `drops the barrier when a required member reports that playback failed, instead of resuming without it` (operation `cancelled`, reason `start-rejected`, paused at the target, late acknowledgements return `null`). Unready and wrong-media members: the `becomes not ready` and `moves to different media` tests for both modes (next row). |
| Cancel on membership, media or lease change instead of shrinking quorum | `a pending seek when the quorum or the authority changes` in `room.test.ts`, run for a legacy and a transactional room: `a required participant disconnects`, `a required participant becomes not ready`, `a required participant moves to different media`, `a participant who was away reconnects`, `the controller approves a new participant` and `the controller shares a new link`. Each asserts the seek is gone (legacy `seek` null, transactional operation `cancelled` with its reason, or dropped by the new link), the revision rose by exactly one, the room is paused, and that every member's late acknowledgement of the old barrier returns `null` and leaves the snapshot unchanged. A new shared link is an unrelated video, so that case is paused at position 0, not at the old target. Lease transfer: legacy `cancels a pending seek when the controller lease changes` (`room-streaming-regressions.test.ts`); transactional `drops the barrier when the controller lease moves to another participant` (operation `cancelled`, reason `superseded`, new controller, lease epoch plus one). |
| Preserve timeout pause at fixed target | `keeps a fixed paused target when a provider never acknowledges a seek` (`room.test.ts`), `keeps a fixed paused target when jitter exceeds the barrier deadline` (`network-chaos.test.ts`), and the transactional receipt-time tests above, which assert the position equals the seek target. |
| Deduplicate acknowledgements | Legacy: `is counted once and does not complete the barrier while a third member is outstanding` (`room.test.ts`): the same participant acknowledges three times, `acknowledgedParticipantIds` keeps one entry, the barrier stays pending while a third member has not acknowledged, and it completes only with the third member's acknowledgement. Transactional: `keeps a paused seek committed at its fixed target and rejects stale or duplicate operation evidence` asserts `operation_prepare_duplicate`. |
| Reject superseded acknowledgements | `uses the latest target when seeks overlap and ignores obsolete acknowledgements` (`room.test.ts`), the stale-evidence test above, and the late-acknowledgement replays in every cancel-cause test, which return `null` for the old revision or operation. |
| Fuzz invariants for the barrier | `holds the seek barrier invariants in transactional rooms across 600 random seeds x 55 operations each` (`room.fuzz.test.ts`). For transactional rooms: a seek that is still collecting preparation implies the room is paused; an acknowledgement received at or after the seek's deadline never leaves the room playing and fails the operation; the room only starts playing out of a pending seek through its commit, and the commit needs a preparation from every participant that was ready, connected and on the same media at that moment. The run counts how often each situation was reached and fails if one is never reached. The legacy fuzz run is unchanged. |

## Accepted limit: the legacy barrier

Decision by the owner: all participants are on the latest release, so the legacy seek barrier (a room in which a participant does not advertise `CURRENT_CLIENT_CAPABILITIES`, that is an extension older than 0.2.5) is no longer supported. The following hole in that barrier is therefore recorded as an accepted limit. It is not fixed, and no test pins it.

- **What happens.** A legacy pending seek is not cancelled when a required member's failure report carries a `basedOnRevision` that no longer equals the seek's own revision. `updatePlayerStatus` only cancels the seek when `pendingSeek.revision === basedOnRevision`, while `acknowledgeSeek` recomputes its quorum from the participants that are connected, ready and on matching media at acknowledgement time.
- **How it was reproduced.** At the pinned commit, with a scratch script that was not committed: a legacy room with three ready members, play, then seek (seek revision 9). A join request from a new id raises the room revision to 10 and leaves the seek in place. A required member reports `playbackStartFailed` at revision 10: the report is accepted, the member is marked not ready, the room is paused, but the seek stays pending. The two remaining members acknowledge the seek and the room ends `playing`, with the failed member excluded from the quorum.
- **Why it is accepted.** The legacy barrier is not supported any more. A transactional room fixes its participant set when the operation starts and cancels the operation on a failure report, so the same sequence does not resume there (`drops the barrier when a required member reports that playback failed, instead of resuming without it`).
- **What the tests cover instead.** The legacy tests in this change are limited to behavior that holds today: the six cancel causes, duplicate acknowledgements, receipt-time expiry and the failure at the seek's own revision. None of them depends on the hole.

If the legacy barrier is ever supported again, this limit must be re-examined first.

## Deterministic verification

Run from the repository root:

```sh
npx vitest run packages/sync-engine/src/room-streaming-regressions.test.ts packages/sync-engine/src/room.test.ts
npx vitest run packages/sync-engine/src/room.fuzz.test.ts
npm run typecheck
npm test
npm run check
npm audit --audit-level=high
git diff --check
```

Results of the refresh (2026-10-31, working tree on `86f9ddfb8fe1fff07f6f606be8652c3d5c81ddfd`, Node 22, no production file changed):

- `room.test.ts`, `room-streaming-regressions.test.ts` and `room.fuzz.test.ts` together: 3 files, 186 tests passed, on two consecutive runs. `room.test.ts` alone (166 tests), `room.fuzz.test.ts` alone (4 tests) and `room-streaming-regressions.test.ts` alone (16 tests) were counted in the same working tree. The new tests use a fixed clock and a seeded generator, with no timers.
- `npm run typecheck`: passed.
- `npm test`: 48 test files, 900 tests passed.
- Mutation checks of the new tests, made on a temporary copy of `room.ts` that was restored afterwards: removing the cancel in `pauseForMembershipChange` fails the six legacy cause tests; removing that cancel for operations fails the transactional cause, lease and play-membership tests; changing the receipt-time check from `>=` to `>` fails the `0 ms after the deadline` test; removing the acknowledgement deduplication fails the duplicate-acknowledgement test; removing the cancel in `transferControl` fails the transactional lease tests; skipping the receipt-time check, committing one preparation early and leaving the room playing during a seek each fail the matching fuzz invariant.
- Further mutation checks on the same terms: disabling the transactional duplicate-preparation short-circuit in `acknowledgeOperation` fails the `a transactional preparation sent twice` test (and one older test); disabling only the phase guard in front of it fails the `after the commit` test of that block; removing the cancel on the dropped-connection path of `disconnect` fails the fuzz invariant that a pending seek never waits on a required participant who is gone (the fuzz file alone now catches it). Removing the `pauseForMembershipChange` call in `openLink` fails the legacy shared-link test only: in a transactional room `openLink` replaces the operation and the playback right afterwards, so that call changes nothing observable there and is an equivalent mutation.
- `npm run check`, `npm audit --audit-level=high` and `git diff --check` were not part of this refresh run and are not claimed here.

Historical verification of the PR #81 candidate (extension 0.2.4, 2026-09-20, not re-run in the refresh):

- `room-streaming-regressions.test.ts` and `room.test.ts`: 2 files, 55 tests passed. `room.fuzz.test.ts`: 1 file, 3 tests passed.
- `npm run check`: 29 test files, 254 tests passed; TypeScript and edge typecheck passed; room-service build passed; extension build passed.
- `npm audit --audit-level=high`: 0 vulnerabilities. `git diff --check`: passed. `npm run release:check-version`: `0.2.4`.
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

## What is not evidenced

Everything in this report is source-level evidence: unit, protocol and fuzz tests that drive `RoomCoordinator` directly with synthetic participants and an injected clock. The following are not evidenced, and nothing above states or implies that any of them is met:

- **Browser.** No browser run of a seek that is pending during a lease transfer, a dropped socket or a late acknowledgement exists. `tests/e2e/three-profile-browser-matrix.spec.ts` exercises seek, transfer and reconnect separately but has no case with a seek pending during a transfer or a drop. Writing that spec is remaining work. It could not be written and verified in the environment of this refresh because Chromium cannot launch there, so it needs a machine where Playwright Chromium launches.
- **Provider.** No authenticated Crunchyroll seek or lease-transfer observation.
- **Two accounts and two devices.** No run with a second authorized account or a second device.
- **Deployment.** `docs/TEST_GUIDE.md` records the coordinator from `main` at `2b96d13` as deployed on 2026-10-21 and smoke-verified with synthetic participants. That is a recorded statement, not re-run here, and it does not cover the pinned commit. This refresh made no production contact and no deployment.
- **Acceptance.** No written user acceptance. No row of any acceptance table is ticked by this report.
- **The legacy hole.** Not fixed. See [Accepted limit: the legacy barrier](#accepted-limit-the-legacy-barrier).

## External acceptance limits

The deterministic engine suites do not prove authenticated Crunchyroll behavior, visible output, two-account or two-profile behavior, two-device network conditions, deployment behavior or user acceptance. The active signed-in Crunchyroll Edge session is available for a later controlled headed observation. Do not copy its cookies or storage state into test artifacts.

## Closure and release decision

Keep issue #54 open until the applicable source, browser, provider, device, deployment and user-acceptance gates are directly evidenced and no unexplained gap remains. Which of those gates stay on #54 and which are carried by other issues is the owner's decision and is not made here. Move the project state to `Verification` only after the corrective PR has merged and deterministic evidence is complete. Use `Blocked` only for a concrete external dependency.

This single issue does not authorize a release bump. The refresh adds tests and documentation only, so it does not change the repository version, which stays at the value recorded in `package.json` (0.2.12 at the pinned commit) unless a later release decision is separately documented. Reserve `1.0.0` for milestone completion.
