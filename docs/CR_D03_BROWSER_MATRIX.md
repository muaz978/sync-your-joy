# CR-D03 Local Browser Matrix

Issue: [#68](https://github.com/muaz978/sync-your-joy/issues/68)

This record defines the deterministic local browser evidence for the CR-D03 matrix. It is deliberately separate from authenticated Crunchyroll acceptance, physical-device acceptance, deployment verification and visible-motion user acceptance.

## Scope

The matrix is implemented by [`tests/e2e/three-profile-browser-matrix.spec.ts`](../tests/e2e/three-profile-browser-matrix.spec.ts). It launches three isolated Chromium persistent profiles, loads the real unpacked extension into each profile, starts the real in-process room service, opens the repository-owned test player in each profile and loads the same user-selected local adaptive fixture into all three players.

The scenario covers:

1. Host creation, two join requests, host approval and a fixed three-member quorum.
2. Controller play and native progress evidence from every participant.
3. A 30-second sustained window sampled every 500 ms.
4. Paired drift, presented-frame progress and hard current-time write limits.
5. Exact forward seek destination acknowledgement, followed by convergence.
6. Source replacement and readiness re-detection on participant C.
7. One-shot local `NotAllowedError`, visible playback-blocked state, local gesture, in-panel Sync and explicit readiness recovery.
8. Controller transfer from A to B, B playback, and transfer back to A.
9. A real server-side disconnect of C, service-worker reconnect, room-code preservation, readiness preservation and explicit post-reconnect resume.
10. Native controller scrubbing at a paused room boundary and remote convergence.

Navigation scenarios are not claimed by CR-D03 because CR-C04, issue [#65](https://github.com/muaz978/sync-your-joy/issues/65), remains an explicit dependency.

## Commands

Run the focused matrix during implementation:

```bash
npm run test:e2e -- --grep "three-profile local browser matrix"
```

Run the complete E2E suite:

```bash
npm run test:e2e
```

Run the complete suite in a visible headed Chromium window:

```bash
SYNCYOURJOY_E2E_HEADED=1 npm run test:e2e
```

The E2E global setup starts the room service on an ephemeral localhost port, builds an isolated extension into the run output directory and writes sanitized provenance and profile artifacts. Host browser permission may be required on macOS for local Chromium launches.

## Acceptance metrics

The matrix treats the following as separate assertions:

| Metric | Local assertion | Meaning |
| --- | --- | --- |
| Quorum | Three connected, approved and matching participants | The operation is not accepted from a two-member shortcut |
| Sustained samples | At least 50 samples during 30 seconds | The room remains observable for the full recovery window |
| Drift | Maximum paired drift at or below 0.75 seconds | Native local timelines remain bounded |
| Hard corrections | At most 8 additional current-time writes per player in the sustained window | Stable playback does not repeatedly seek to hide drift |
| Progress | Presented-frame count increases for every player | The test observes real native frame progress, not only a room clock |
| Exact seek | Every player reports the requested destination within 0.75 seconds | The assertion checks the requested target, not only forward movement |
| Reconnect | C enters `reconnecting`, then returns to `connected` with the same room code and readiness | The real extension connection lifecycle is exercised |
| Post-reconnect play | Controller A explicitly resumes after reconnect and all three players progress | The coordinator safety pause on participant disconnect is respected |
| Native scrub | Controller page changes native `currentTime` while paused and every player converges | The native media event path is covered |

The local fixture reports bounded event history, `currentTimeWrites`, source generation, presented-frame count, quality-frame count, last seek destination and controlled play-rejection count. It does not expose media bytes or credentials.

## Why reconnect uses a local control route

Browser-context offline emulation does not reliably terminate a WebSocket owned by an MV3 service worker. In that situation the production heartbeat can report `Connected · Offline` without producing the close event required to enter the reconnect state.

The local room service therefore exposes `POST /__test/disconnect` only when the E2E global setup supplies an unpredictable, process-local `testControlToken`. The test sends the room code and C's participant identity, and the route closes exactly that server-side socket. Normal server construction and deployed instances do not pass the option, so the route is absent outside this local harness.

The route is covered directly by `apps/room-service/src/server.test.ts` for wrong-token rejection, exact participant selection and participant-disconnected state publication. The E2E test then verifies the extension's real reconnect path. No endpoint is added to the edge service or production room service configuration.

When a participant disconnects, the coordinator pauses the room as a safety invariant. Reconnect therefore restores membership and readiness but does not silently resume playback. The matrix explicitly resumes from controller A before asserting native progress again.

## Reconnect single-flight protection

The MV3 service worker uses both a `setTimeout` retry and a Chrome alarm fallback. These can wake close together. `apps/extension/src/service-worker.ts` now uses a single-flight `reconnectPromise` so overlapping callbacks share one connection and `join_room` handshake instead of sending duplicate joins on one socket.

This is a production lifecycle correction exposed by the controlled local disconnect, not a test-only bypass.

## Security finding remediation

The first hosted evaluation of PR #96 was not accepted as merge-ready. GitHub Advanced Security reported one high-severity CodeQL alert and three DevSkim review findings, and each was treated as an actionable correction:

1. CodeQL identified the local fixture's `video.src = activeUrl` assignment as a DOM text-to-HTML interpretation sink. The fixture now parses the URL returned by `URL.createObjectURL(file)`, requires the parsed protocol to be exactly `blob:`, revokes and rejects any unexpected result, then assigns the allowlisted URL to the media element. The source remains a user-selected local file and no remote media is introduced.
2. DevSkim identified the literal `http://localhost` URL used only as a `new URL()` parsing base in the test-control route. The base is now the non-routable `syncyourjoy.invalid` sentinel, with no change to the server's actual bind address or request behavior.
3. DevSkim identified the literal loopback hostname used by the test-only playback rejection hook. Production builds now replace two explicit build constants with disabled values. E2E setup enables the hook only for the generated test-player origin, so the production content script has no provider-page localhost branch.
4. DevSkim identified the suite-level `test.setTimeout(180_000)` call as an untrusted-duration pattern. The unnecessary override was removed. The suite now uses the repository's bounded Playwright timeout and the observed matrix remains below one minute.

A direct Chromium probe also confirmed that `HTMLMediaElement.srcObject` cannot accept a `File` in the supported browser, so that alternative was rejected after it caused the matrix to wait indefinitely for metadata. The final implementation preserves the proven blob-backed playback flow while adding the explicit scheme boundary. No scanner alert was dismissed as a substitute for a code change. Fresh hosted checks and final-head review remain required before merge.

## Evidence boundary

A passing local matrix proves the behavior of this source tree, the built unpacked extension, Chromium, the in-process room service and the owned local fixture for that run. It does not prove:

- Authenticated Crunchyroll playback or entitlement.
- Any protected media, DRM path, signed URL, private player API or provider-specific source behavior.
- Every title, locale, timed edition, browser graphics path or future provider deployment.
- Physical two-device Wi-Fi, sleep/wake, OS-level offline behavior or real user latency.
- Navigation coverage while issue #65 remains open.
- Production deployment or release readiness.

For authenticated provider work, use the opt-in state-only procedures in [`TEST_GUIDE.md`](TEST_GUIDE.md) and the dedicated acceptance reports. Do not copy daily-browser cookies into the deterministic fixture profiles.

## Current implementation evidence

The focused green run after the security remediation reported:

```text
1 passed
test duration: 38.4 seconds
```

That run covered the complete local scenario listed above. The full repository checks and both complete E2E modes are recorded below. Hosted PR checks and the remaining issue #68 acceptance gates are still separate requirements.

The final local verification completed after the implementation and documentation changes:

- `npm run check`: passed, 36 Vitest files and 319 tests, followed by successful server and extension builds.
- `npm run test:e2e`: 5 passed, 1 skipped. The skipped test was the opt-in authenticated Crunchyroll test because protected storage-state inputs were not supplied. The three-profile matrix passed in 38.8 seconds.
- `SYNCYOURJOY_E2E_HEADED=1 npm run test:e2e`: 5 passed, 1 skipped. The three-profile matrix passed in the visible headed runtime in 38.3 seconds.

These results establish source, unit, build and local Chromium evidence for CR-D03. They do not close issue #68 because navigation depends on #65 and live-provider, deployment, physical-device and user-acceptance gates remain separate.

## Intermittent failure investigation (2026-09-24)

### Reported symptoms

On 2026-09-24 the matrix failed intermittently on macOS 27.0 arm64 with Playwright 1.63.0 and Chromium 1243, run as `npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/three-profile-browser-matrix.spec.ts` (`workers: 1`, `fullyParallel: false`):

- Unmodified `origin/main` `ec60ada2a57cab1a50795b710813551fbf4b4fca`: 1 failure in 15 runs. After a later message-only history rewrite, the same file tree is commit `275d197c05acf142d17de276ae3fd46202276df3`; references to `ec60ada` below mean that tree.
- `codex/issue-30-storage-state-harness`, whose launch path for this spec is identical: 5 failures in 20 runs.

Two messages were reported: `A player paused during the sustained window` and `expect(locator).toBeVisible() failed`.

### Method

The spec was repeated with a temporary room-service trace. It was gated by an environment variable, left uncommitted and removed before the verification below. It recorded one JSON line for every player report (revision, current revision, paused, buffering, progress and start-failure flags), operation acknowledgement, controller command and broadcast reason.

Traced reproduction on `ec60ada`: 20 runs, **12 passed and 8 failed**. Seven failures were sustained-window pauses. One was an exact-seek destination miss.

### Finding 1: the coordinator discarded a racing progress report (product, fixed)

Every sustained-window pause was a room-wide pause issued by the coordinator itself: `participant_playback_stalled`, operation `cancelled` with reason `manual-recovery`. All three players paused within about 10 ms of each other, about 2.0–2.4 seconds after the synchronized start.

The sequence:

1. The three test-player pages open at the same instant, so each content script's one-second status timer fires within about 10 ms of the others.
2. During the transactional start, one participant can prove frame progress on its first tick (about +0.5 s), while another needs a second tick (about +1.5 s).
3. The late participant's `started` acknowledgement advances the room revision. On that same tick, the early participant's progress report was stamped with the revision its content script last received, so it arrives stale.
4. `RoomCoordinator.updatePlayerStatus` rejected any report whose `basedOnRevision` differed from the current revision, including its progress evidence.
5. The early participant's last accepted progress was therefore its first-tick acknowledgement. Its next report is a full second away, but `PLAYBACK_PROGRESS_TIMEOUT_MS` is 1,800 ms. The health timer declared it stalled and paused the room.

Evidence: all 5 traced pauses with distinguishable participants (`base-08`, `-12`, `-13`, `-15`, `-16`) show the flagged participant's last accepted progress at +415 to +510 ms, a dropped report at +1,418 to +1,514 ms with revision 14 or 15 against current revision 16, and the stall 1,811–1,894 ms after the last accepted progress. The 2 earlier pauses were recorded before participant labels were distinguishable in the trace. Their revision sequence shows the same stale report immediately before the stall.

PR #96 already rebased the *acknowledging* participant's progress clock on its own `started` acknowledgement. The remaining gap was the *other* participants' reports that race that acknowledgement. A single lost report was enough to pause the room, because the report cadence (1 s) leaves only 0.8 s of slack under the 1.8 s deadline.

The fix is in `packages/sync-engine/src/room.ts`:

- The coordinator records the latest unbroken run of revisions that were produced only by `started` acknowledgements (`startAcknowledgementRun`).
- `isSampleRevisionCurrent` accepts a report stamped at the current revision, or at a revision inside that run, but only while the run still ends at the current revision.
- Any later command, pause, seek, readiness or media change makes the check exact again, so reports from a superseded command stay rejected.
- Failure classification (stall, buffering, start rejection) still requires an exact revision match, so a stale report can prove progress but can never pause the room.
- The run is not persisted in exported coordinator state, so a restored room starts with the previous exact check.

### Finding 2: the +10 seek destination was read before the click (test, fixed)

In one traced run every player seeked to 41.355 s while the test expected 40.353 s, a difference of exactly 1.002 s. The panel renders the forward button's `data-seek` as the current position plus 10 seconds and re-renders about once a second while playing. The test read the attribute and then clicked, so the clicked button could carry a newer target. The product seeks to exactly the value of the button that was clicked.

The spec now records the destination from the exact button element that receives the trusted click, through a one-shot capturing listener. A missed capture produces `NaN`, which fails the existing finiteness check.

### Finding 3: "Playback blocked" erases itself (product, not fixed here)

The rarer `toBeVisible()` failure is the `Playback blocked` assertion on profile C. The coordinator does classify the rejected start (`participant_playback_blocked`, C marked `blocked`), but:

1. The room's own blocked-pause reaches C as a command change.
2. The content script's command-change path (`invalidatePlayRequest` and `resetPlaybackHealthBaseline`) clears the local `playbackStartFailed` flag.
3. C's next routine report therefore carries `playbackStartFailed: false`, and `participantPlaybackStatus` recomputes C from `blocked` to `preparing`.

Across 42 traced runs that reached this step, the `blocked` status lasted 16–155 ms (median 85 ms) before it was overwritten. Passing runs won a race between Playwright polling and that window. The window was similar with and without the fix: 44–155 ms (median 94 ms, 12 traced baseline runs) against 16–131 ms (median 84 ms, 30 traced runs with the fix). In all 30 runs with the fix, the report that erased the state was accepted at the exact current revision, so the fix's stale-report path is not involved. The failure appears more often with the fix mainly because more runs now reach this step instead of failing earlier in the sustained window. The samples are small, so a timing difference cannot be ruled out entirely. A real participant would see the state flash and disappear while the room stays paused and they are no longer ready.

Deciding what should end the blocked state (the local gesture, **Sync me now** or re-readiness) is a product decision. It is recorded as a separate follow-up and is not changed here.

### Observations

- `Connected · Offline` appeared in all 44 failure panels on disk, whatever the failure mode. It is a constant of this harness, not a signal of any of the failures above, and it was not root-caused here.
- A git worktree without its own `node_modules` resolves `@syncyourjoy/*` through the parent checkout's `node_modules`, which points at the *main checkout's* `apps/` and `packages/`. For this investigation the main checkout (`a1533c1`) had byte-identical `apps`, `packages`, `scripts`, `tests` and `fixtures` to `ec60ada`, so the baseline was not affected. Verification of the fix used worktree-local `node_modules/@syncyourjoy` links so the fixed coordinator was actually bundled. The E2E provenance hashes the worktree's sources and would not reveal this substitution.
- The fix is scoped to start acknowledgements. Other revision bumps that do not change the play command, for example a join request or readiness change during playback, can still discard an in-flight report. That was not observed in the matrix and is not changed here.

### Verification of the fix

- Unit tests: two new coordinator regressions. One is the exact traced race (red before the fix, green after). The other shows that a report from a start-acknowledgement run is rejected once a newer command supersedes it; a mutation that removed the run-currency check made it fail. The existing superseded-command, stale-buffering and out-of-order-sample regressions pass unchanged.
- Traced E2E with the fix: 30 runs, **27 passed and 3 failed**. All 3 failures are Finding 3 (`Playback blocked` windows of 43, 17 and 16 ms). There were 0 sustained-window pauses and 0 seek-destination misses, although racing stale-revision progress reports occurred in 20 of the 30 runs (35 reports).
- Untraced E2E with the fix, on exactly the committed change: 20 runs, **18 passed and 2 failed**. Both failures are the `Playback blocked` assertion from Finding 3. There were 0 sustained-window pauses and 0 seek-destination misses.
- Untraced E2E on unmodified `ec60ada` in the same session and on the same host, for comparison: 20 runs, **16 passed and 4 failed**. Three failures are sustained-window pauses (Finding 1) and one is `Playback blocked` (Finding 3), which shows that Finding 3 predates this change. The untraced counts alone are small (3 of 20 against 0 of 20 sustained-window pauses). The case for the fix rests on the traced mechanism, the two unit regressions and the combined 0 of 61 matrix runs with the fix.
- Repository checks on the branch rebased onto `2f92f852d337fb7d5e3f2efd34c512ae770cb73f`: `npm run check` passed (both typechecks, 37 Vitest files and 352 tests, server and extension builds). The full `npm run test:e2e` suite on commit `1ecf89264ce18f2c36094415883c2935208d75e8` gave 11 passed and 1 skipped (the opt-in authenticated Crunchyroll test, because no protected state was supplied). The matrix passed within that run. A further 10 matrix runs on that commit gave **7 passed and 3 failed**, all 3 the `Playback blocked` assertion from Finding 3, with 0 sustained-window pauses and 0 seek-destination misses. This covers the changed E2E launch helper that the rebase brought in.

A failed run is counted as a failure in every figure above. None of these runs is Crunchyroll, protected-media, two-device, deployment or user-acceptance evidence, and issue #68 remains open for the gates listed earlier in this record.
