# Crunchyroll investigation and remediation handoff

Prepared: 2026-09-19. Updated: 2026-09-20. Repository: `muaz978/sync-your-joy`.

## 1. Read this first

The latest instruction is to commit and push the existing candidate fixes, tests, and documents to a dedicated branch so remote contributors can inspect them. That publication instruction does not mark the 23 remediation issues complete and does not authorize a production release.

Earlier turns changed executable code and tests before the deeper plan was prepared. They are now preserved as focused commits on `codex/crunchyroll-sync-hardening`. They remain an incomplete investigation candidate and are undeployed.

Three layers of evidence must remain distinct:

1. Earlier implementation and test results, recorded in checkpoints 29-31.
2. Additional source-level risks found during the deeper planning review. These have not been newly reproduced or fixed.
3. The proposed implementation and acceptance work in [the remediation plan](CRUNCHYROLL_REMEDIATION_PLAN.md) and [canonical GitHub issue map](CRUNCHYROLL_ISSUE_MAP.md). Live issue state is maintained on GitHub.

The next owner should read this file, the plan and the latest chronological checkpoint before acting. Older “completed locally” summaries describe the earlier tested cases, not clearance of the new review findings.

## 2. User objective and symptom record

The user requested a deep investigation into why Crunchyroll synchronization fails when YouTube and other platforms appear to work. They reported repeated pauses, jumps/drift, buffering loops, losing sync after backward/forward seeking and between episodes, everyone ready but only one device playing, time advancing while the image freezes, and an indefinitely loading black player.

The investigation interpreted these as potentially different failure classes. It did not assume every black screen had one cause. The user first limited the deeper remediation work to planning and requested this handoff, then separately authorized preserving the existing candidate and documents on a branch.

Maintain the product boundary: each participant uses their own authorized account and streams independently. SyncYourJoy exchanges control, identity, readiness and limited diagnostic state. No protected video/audio transfer, credential access, stream interception, DRM investigation, screen capture or provider HAR collection is part of this work.

## 3. Exact source and publication state

| Item | State |
| --- | --- |
| Repository | `muaz978/sync-your-joy` |
| Preservation branch | `codex/crunchyroll-sync-hardening` |
| Baseline | `1ac5b1c13ba21d93823c43c3b33f354ba5a9ac68`, `chore: prep v0.2.4 (#43)` |
| Package version | `0.2.4` |
| Protocol constant | `PROTOCOL_VERSION = 1` |
| Candidate code commits | `4debb78`, `9ae24a7`, `0c13a28`, `ded3527` |
| Remote branch | `codex/crunchyroll-sync-hardening` exists with code/test tip `ded3527`; documentation update is still local |
| GitHub work tracker | Milestone 1, 23 CR issues, with issue 33 reused for CR-D04 |
| Release/deployment | None for these changes |
| Production deployment | None for these changes; live production state was not rechecked during planning |
| Strengthened local E2E | One exact-candidate run passed on 2026-09-20; broader D03 coverage remains open |
| Authenticated Crunchyroll acceptance | Pending |

The baseline `main` commit alone cannot reconstruct the candidate. Use the preservation branch and verify its remote tip before continuing. The branch records the candidate in focused commits so a contributor no longer needs this workstation's former dirty working tree.

## 4. Actual player observation and source research

Earlier browser inspection used the already-open Edge watch page:

`https://www.crunchyroll.com/watch/GE00365016JAJP/extreme-level-3-situation`

Observed native state:

- Top-document video ID `bitmovinplayer-video-null`.
- Source protocol `blob:`; the full blob URL was not retained.
- Duration `1420.002`, `readyState = 4`, playback rate `1`.
- Seekable range approximately 0 through 1420 seconds; buffered data around seconds 80 through 139/140 at inspection.
- No player iframe on this page; observed iframe was OneTrust.
- Native controls exposed Skip Intro, Next Episode, playback speed and audio/subtitles.

This strongly suggests Bitmovin on that inspected page. It does not identify the exact player version, stream format, DRM configuration, public instance API, regional rollout or all-account behavior. A `blob:` source alone does not prove a specific streaming technology. The existing native media discovery already finds this top-document player.

Native Pause was used during the earlier inspection. No candidate extension was installed into a two-account Crunchyroll room, and no live protected synchronization acceptance was performed. A read-only browser facade query did not expose frame callback/quality methods; that tooling result is not evidence that the actual browser lacks the APIs. The tab later navigated away, so any future live test must reacquire its current state rather than reuse old selectors blindly.

Public research consulted official Crunchyroll help, HTML/MSE contracts, Chrome autoplay/interrupted-play/content-script documentation and Bitmovin API/event/configuration references. A public watch-page fetch hit a Cloudflare challenge, and two historical Vilos player URLs returned 502 in the environment. These attempts did not establish the live architecture, and no challenge was bypassed.

The detailed earlier source record is [crunchyroll-source-notes.md](research/crunchyroll-source-notes.md). New planning research reconfirmed [play-promise interruption](https://developer.chrome.com/blog/play-request-was-interrupted), [playback-quality counter resets](https://w3c.github.io/media-playback-quality/), [frame-callback metadata and timing limits](https://wicg.github.io/video-rvfc/), and [Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). No new Crunchyroll browser session was inspected during planning.

## 5. Work performed before planning

### Extension content script

Modified [content-script.ts](../apps/extension/src/content-script.ts) and added [content-script.test.ts](../apps/extension/src/content-script.test.ts).

- Added in-flight seek ownership so ordinary playing heartbeats do not keep reassigning the target while loading.
- Adopted an existing native seek at the requested target rather than restarting it.
- Deferred assignment when seekable ranges are empty and required current-frame data before room-seek acknowledgement.
- Retained timed-out target ownership, with explicit Sync/new command/source lifecycle boundaries.
- Added a 2.5-second post-correction grace with 0.98/1.02 rate adjustment before another hard seek.
- Scoped asynchronous play callbacks to generation, element and source; separated AbortError from NotAllowedError.
- Invalidated pending play and scheduled playback on immediate local pause and lifecycle changes.
- Added local episode checks to incoming commands and outgoing play/pause/seek/ended/status paths.
- Added visible-video frame-counter progress, clock fallback for hidden/unsupported cases, and improved Ready/Buffering/Catching up status text.
- Added newer-command supersession for a timed-out seek so it does not permanently block later room playback.

**Known incompleteness found during planning:** generic embedded identity can be rejected; grace alone does not prove convergence; a disappearing barrier can erase late-event provenance; timed-out probes can stop observing; never-settling play needs a retry boundary; context-refresh health differs from periodic health. See G01, G05-G08 and tasks A02-A06/C01.

### Worker and tab binding

Modified [service-worker.ts](../apps/extension/src/service-worker.ts), its tests, [player-tab.ts](../apps/extension/src/player-tab.ts) and its tests.

- Actual outer-tab URL takes priority over the old room link, including worker restoration.
- Equivalent localized Crunchyroll URLs reuse the same initialized tab based on complete episode ID, including the observed 14-character form.
- Stale equally sized matching frame replacement remains possible after readiness drops and before joining.
- Missing player delivery clears stale media/diagnostics/sample, reports unready, retains the tab for discovery and records `player_unreachable`.
- A context generation prevents an old outbound delivery failure from clearing a freshly rebound context.
- Detailed reports retain sanitized `progressed`, `playbackStarted` and `playbackStartFailed` fields.

**Known incompleteness:** the generation protection does not yet cover every asynchronous context read or incoming old-document message. Tab/frame equality alone is insufficient after frame ID reuse. See G07/A04.

### Coordinator and playback health

Modified [room.ts](../packages/sync-engine/src/room.ts), [playback-health.ts](../packages/sync-engine/src/playback-health.ts) and related tests. Added [room-streaming-regressions.test.ts](../packages/sync-engine/src/room-streaming-regressions.test.ts).

- Every participant, including the controller, must explicitly acknowledge a seek.
- Play during an active seek barrier returns `seek_in_progress`.
- Wrong-revision samples are rejected before mutating progress/sample state.
- Explicit `progressed: false` is respected rather than replaced by a positional fallback.
- Added a ten-second reported never-started watchdog that pauses without clearing readiness; recent real progress protects transient restarts.
- Updated existing room/network-chaos tests to acknowledge the controller explicitly.

**Known incompleteness:** report silence does not trigger this watchdog; late ACK can beat expiry processing; the required quorum can shrink after an explicit failure; start preparation and distinct operation/media identity are absent; edge health persistence and failure-target policy need work. See G02-G04/G09-G11 and stage B.

### Browser test

Modified [two-profile-sync.spec.ts](../tests/e2e/two-profile-sync.spec.ts).

- Added real `requestVideoFrameCallback` checks after initial play, forward seek and native backward seek.
- Each progress probe requires 0.6 seconds of clock and frame media-time advancement, three more presented frames, and a non-paused/non-seeking player.
- Native backward seek assigns the actual controller video's `currentTime = 3`, exercising browser events rather than injected extension intent.
- Added an EOF guard, polled convergence and corrected pause-wait argument placement.
- The fixture was inspected with ffprobe during the earlier task: 20-second H.264 video, 160x90, 10 fps.

**Known incompleteness:** the latest browser test passed once on the exact candidate, but one run and one convergence window do not prove sustained synchronization, adaptive-loading recovery, three-member quorum, or live-provider behavior. The short progressive MP4 cannot exercise slow adaptive loading thoroughly. See D01-D03.

## 6. Test and attempt ledger

This ledger retains historical execution from the earlier investigation and adds the 2026-09-20 pre-commit verification. Raw console outputs remain in the conversation/tool history where available; this document and checkpoints preserve summarized evidence rather than protected provider data.

| Order | Command or activity | Result actually observed | Meaning and limit |
| --- | --- | --- | --- |
| 1 | Initial `npx vitest run apps/extension/src/content-script.test.ts` | Six tests ran: five failures, one pass | Reproduced repeated seek, aborted-play misclassification, stale rejection, premature ACK and frame-freeze detection failures against the original implementation. |
| 2 | Initial adapter/coordinator regression runs | Failing assertions reproduced before fixes | Synthetic source-level reproduction. No protected provider acceptance. |
| 3 | Adapter milestone suite | 28 focused tests passed | Intermediate result, superseded by the final 30-test focused group. |
| 4 | Coordinator milestone suite | 68 engine tests, later 74, passed | Intermediate results as more fixes/tests were added; not extra tests to add to the final total. |
| 5 | Adapter/worker final focused command below | Five files, 30 tests passed; typecheck passed | Identity/tab/frame/worker behavior in the selected suites. |
| 6 | Root content-script focused reruns | Eventually 21 tests passed | Actual content-script listeners/timers run against fake browser/media objects. |
| 7 | Initial full `npm run check` milestone | 26 files, 187 tests plus typecheck/builds passed | Historical intermediate source state. Later checks supersede the count. |
| 8 | Initial `npm run test:e2e` in sandbox | Chrome failed to launch with SIGABRT/EPERM | Environment failure before scenario execution. |
| 9 | Earlier approved isolated-Chrome `npm run test:e2e` | One local two-profile test passed in 5.0 seconds | Before strengthened assertions and later follow-up code. Exact final-source equivalence is not established. |
| 10 | Stronger E2E rerun request | Automatic approval service rejected isolated Chrome launch escalation after its usage limit was reached | Latest assertions did not execute. No bypass was attempted. |
| 11 | `npm run verify:browser-packages` | Extension variants built; Safari converter rejected staging path access | Error included `safari-web-extension-converter requires access to the supplied path` and inability to parse the staged manifest. No Safari success claim. |
| 12 | Final `npm run check`, repeated in checkpoint 31 | TypeScript and edge typecheck passed; 26 files / 189 tests passed; server and extension built | Last recorded exact local source pass, timestamp around 23:28 Europe/Istanbul on 2026-09-19. Does not include Playwright. |
| 13 | `npm audit --omit=dev --audit-level=high`, repeated | `found 0 vulnerabilities` | Dependency audit for the selected production-dependency scope; not an application security audit. |
| 14 | `git diff --check`, repeated | Passed | Whitespace/diff validation only. |
| 15 | Planning-only review | Read source, checkpoint, docs, tests and primary references; generated plan/checklist/handoff | New findings are source review and proposed tasks, not newly executed regressions. |
| 16 | 2026-09-20 `npm run check` | TypeScript and edge typecheck passed; 26 files / 189 tests passed; server and extension builds passed | Exact candidate source verification before commits. Does not include Playwright. |
| 17 | 2026-09-20 `npm run test:e2e` in sandbox | Chrome launch failed with SIGABRT/EPERM before scenario execution | Environment-only failure, superseded by the permitted rerun. |
| 18 | Same E2E with isolated Chrome process permission | One strengthened two-profile test passed in 6.9 seconds, scenario time 4.4 seconds | Exact candidate generic-fixture browser evidence, including forward and native backward seek, visible-frame progress, and convergence. It is not Crunchyroll acceptance. |
| 19 | 2026-09-20 production dependency audit and diff check | `found 0 vulnerabilities`; `git diff --check` passed | Selected dependency scope and whitespace validation only. |

Recorded adapter-focused command:

```sh
npx vitest run apps/extension/src/player-tab.test.ts apps/extension/src/service-worker.test.ts apps/extension/src/media-fingerprint.test.ts apps/extension/src/site-adapter.test.ts apps/extension/src/video-discovery.test.ts
```

Recorded full source command:

```sh
npm run check
```

It expands to TypeScript checks, `vitest run`, server build and extension build. It does **not** invoke `npm run test:e2e`.

### Covered player regressions in the 21-test suite

1. Moving room clock does not restart an in-flight seek.
2. AbortError is not an autoplay rejection.
3. Stale rejection after a newer pause is ignored.
4. Current NotAllowedError still reports a permission failure.
5. Metadata-only seek is not acknowledged.
6. Frozen counters despite moving media time report a stall.
7. Slow correction starts playback before an immediate second hard seek.
8. Timed-out paused seek is not repeatedly reassigned.
9. Newer room target supersedes the old target.
10. Empty seekability waits for data.
11. Data arrival allows seek acknowledgement.
12. Healthy frame progression reports progress.
13. Hidden-tab clock progression is not mistaken for a frame freeze.
14. Immediate episode change blocks old commands and outgoing events before polling.
15. Leaving Crunchyroll blocks old-room operations.
16. Same-element source reload invalidates old play rejection.
17. Late correction completion in the same room snapshot is not a controller seek.
18. Different-target Skip Intro supersedes an expected correction.
19. Controller's existing native seek is adopted.
20. Immediate local pause invalidates an old play rejection before server reply.
21. New room Play releases a timed-out seek after the native seek has completed.

These tests do not cover all variants of their names. For example, case 17 does not include the coordinator removing the barrier first; case 7 stops before repeated post-grace correction; cases 14/15 use a top-document fixture. The deeper plan explicitly targets those missing permutations.

### Test development errors and corrected assumptions

- The initial fake extension-state harness was incomplete for TypeScript and was corrected before the final full check.
- A first newer-Play supersession test still marked the native element as seeking. It failed because playback correctly waits for seeking to finish; the test was corrected to model completion before the new Play. That correction does not prove recovery while the native seek remains unfinished.
- Account usage limits interrupted agents and the later browser approval attempt. Saved source changes remained intact; unfinished work was not counted as complete.
- Safari staging access was an environment boundary. It was not diagnosed as a product failure or counted as a package pass.

## 7. Additional risks identified during deeper planning

The new plan supersedes any implication from checkpoint 31 that no further source-level work is necessary. No new implementation has been performed for these findings.

| Risk | Evidence category | Plan task |
| --- | --- | --- |
| Generic/nested-frame identity disagrees with outer-tab binding | Direct source contract inconsistency; runtime regression to add | A01/A02 |
| Old document/context callback can overwrite a replacement | Direct asynchronous ownership gap; reorder regression to add | A04 |
| Expired seek ACK can resume before timer callback | Direct missing deadline check | A07 |
| Failed required participant can shrink quorum | Direct transition composition gap | A07/B02 |
| Silent player never triggers message-driven startup watchdog | Direct missing timer path | B04-B06 |
| 2.5 seconds at +2% only recovers 0.05 seconds of drift | Arithmetic/algorithmic limitation; sustained simulation needed | A05 |
| Room timeout erases attribution before late native completion | Source event-order risk | A03 |
| Timed-out seek stays pending when only readiness is later observed | Source completion-path gap | A03 |
| Pending play promise can remain non-retryable | Unbounded state; real-provider occurrence unverified | C01 |
| Context refresh uses a less complete health sample than periodic status | Direct source inconsistency | A06 |
| Healthy edge samples may not survive rehydration | Direct persistence-path gap; edge lifecycle test needed | B06 |
| Room readiness does not prepare/confirm actual startup | Existing architecture limitation | B01-B03 |
| Failure position can rewind/jump the room to a broken player's time | Direct policy gap | B02 |
| E2E output and release build share dist; trace options may not reach manually launched contexts | Direct harness configuration exposure | D01 |

No source review alone proves that a particular one caused the user's exact live failure. The plan orders reproduction, minimal fixes, integrated browser testing and live acceptance accordingly.

## 8. Files to preserve and review

Paths below are relative to the repository root.

| Existing candidate file | Kind | Purpose |
| --- | --- | --- |
| `apps/extension/src/content-script.ts` | Modified | Player lifecycle, seek/play ownership, health and identity guards |
| `apps/extension/src/content-script.test.ts` | Added in `0c13a28` | 21 player regressions |
| `apps/extension/src/player-tab.ts` | Modified | Same-episode reuse and stale-frame replacement |
| `apps/extension/src/player-tab.test.ts` | Modified | Tab/frame regressions |
| `apps/extension/src/service-worker.ts` | Modified | Identity, unreachable player and outbound generation protection |
| `apps/extension/src/service-worker.test.ts` | Modified | Worker/report/binding regressions |
| `packages/sync-engine/src/room.ts` | Modified | Seek barrier and health coordination |
| `packages/sync-engine/src/playback-health.ts` | Modified | Startup watchdog policy |
| `packages/sync-engine/src/room-streaming-regressions.test.ts` | Added in `4debb78` | Eight expanded streaming coordination cases |
| `packages/sync-engine/src/room.test.ts` | Modified | Explicit host ACK expectations |
| `packages/sync-engine/src/network-chaos.test.ts` | Modified | Explicit host ACK in simulation |
| `packages/sync-engine/src/playback-health.test.ts` | Modified | Startup deadline boundaries |
| `tests/e2e/two-profile-sync.spec.ts` | Modified in `ded3527` | Frame progress and native backward seek; one exact-candidate run passed |
| `docs/CRUNCHYROLL_SYNC_ANALYSIS.md` | Added on the preservation branch | Earlier analysis of local fixes and provider limits |
| `docs/research/crunchyroll-source-notes.md` | Added on the preservation branch | Primary sources, live observation and failed fetch attempts |
| `context-checkpoint.md` | Modified | Append-only chronological task record |

Planning deliverables are [CRUNCHYROLL_REMEDIATION_PLAN.md](CRUNCHYROLL_REMEDIATION_PLAN.md), [CRUNCHYROLL_ISSUE_MAP.md](CRUNCHYROLL_ISSUE_MAP.md), and this handoff. The issue map is a static index rather than a second live checklist. The checkpoint records preparation and verification without erasing earlier milestones.

### Candidate source fingerprints captured before planning

SHA-256 values identify the preserved candidate source before it was committed, not a release build. The planning pass compared all 104 non-Markdown tracked/untracked, non-ignored files before and after documentation changes.

Verification at 2026-09-19 20:53 UTC: all 104 file hashes matched, with no added, removed or changed non-Markdown file in that inventory. Local document links resolved, all 23 task IDs were unique, no tasks were marked complete, and `git diff --check` passed. These are documentation/preservation checks, not a new application test run. Ignored generated output is outside this hash inventory; no build or browser test was run during planning.

| File | SHA-256 |
| --- | --- |
| `apps/extension/src/content-script.ts` | `92d63931d31b28a1368b07e22583691a0352a74ac5d2f6032c36ea0d0caaa9ac` |
| `apps/extension/src/content-script.test.ts` | `65efc962c56aba22518dd6d042989a0e4e19ed9543d5b90a872e18e58a937302` |
| `apps/extension/src/player-tab.ts` | `636d612a0f16b22f8a70d31f1a4b93e3dfe781ea84809fd46f70220bc957b295` |
| `apps/extension/src/player-tab.test.ts` | `cd84c901f78c2dc9a7aefe29b324efb6e7681fc84238df0621b95cb52795bb6a` |
| `apps/extension/src/service-worker.ts` | `48388eca686cd0c27dbf93cf80e5facc3d1b8aa24afc16d5fdd4a76f60a4f090` |
| `apps/extension/src/service-worker.test.ts` | `81e8a2be8cbeed15a4824fb605928fd40eedbf1b4c9b09a74d5a0a2bdb680b53` |
| `packages/sync-engine/src/room.ts` | `3ff7bbe6661e1d45ccab13ab82d7357e3e20d363edac0567420fce59fd4b92f3` |
| `packages/sync-engine/src/playback-health.ts` | `1be66561051b1441c01483c9f7fa582d8eb2e4fdf0d0292e48d3cee5c798fb51` |
| `packages/sync-engine/src/room-streaming-regressions.test.ts` | `48946017a1993a80637f4e432cd4e0495b7931ac58d7e602e3ba6109019d9231` |
| `packages/sync-engine/src/room.test.ts` | `f035415554b66e23cb1b5fd711674c5442ce2c21a02b03307bc54686ac24e4da` |
| `packages/sync-engine/src/network-chaos.test.ts` | `65df43aae6d096af084d76c2acacdae5b04d16aa01b4f4d0462d7d5a39a6adb7` |
| `packages/sync-engine/src/playback-health.test.ts` | `bb472c58ba7cbc8483388d45c624c871690818b68432b26dd16085523f1444da` |
| `tests/e2e/two-profile-sync.spec.ts` | `9eea1549a59ba9fc524b4fdc6a41416e252ea71f785c86bcf69475372ae4783c` |
| `package-lock.json` | `d6417e1e40e1dc0289aae96520928e3573bd192d7a5597a138082b060a0a76f3` |

## 9. Build, runtime and release hazards

- `npm run check` does not run Playwright and builds the extension with the default endpoint unless an environment override is supplied.
- `scripts/build-extension.mjs` currently defaults to `ws://127.0.0.1:8787/rooms`. The existence of `apps/extension/dist` does not mean it targets production.
- E2E global setup builds to the same dist using an ephemeral local coordinator URL. Its reuse test checks the endpoint in the manifest rather than source hashes. Do not package leftover E2E output or run overlapping builds until D01 is complete.
- Playwright's configured trace/video defaults are not proof that manually launched persistent contexts recorded artifacts. The profile helper needs explicit collection/attachment.
- Reloading the extension does not update content scripts already in an open provider tab. Record the loaded version and deliberately refresh/rebind acceptance tabs after installing a candidate.
- New coordinator behavior and client behavior must be staged together with tested mixed-version policy. Old clients must not be assumed to implement new preparation/start acknowledgement.
- Production smoke must be updated and checked against the new explicit controller-ACK/transaction contract before relying on it. A historical production smoke proves only the historical deployment.
- Isolated Chrome process permission was granted for the successful 2026-09-20 E2E rerun. Safari staging access remains unresolved. No release action was attempted.

## 10. Decisions already made, proposals not yet executed

Already used in earlier implementation: native media adapter; actual outer-tab identity; complete Crunchyroll episode IDs; distinction between AbortError and permission rejection; safe paused timeout; state-only diagnostics; no release during investigation.

Proposed in the deeper plan: authoritative identity handshake, operation/media/binding identity, fixed preparation quorum, prepare/commit/start confirmation, timer-driven silence detection, bounded coordinated recovery, more complete health evidence, isolated browser fixtures, explicit migration and optional controller-follow navigation.

Proposed timing values in the plan are experiments, not tuned provider guarantees. The 250 ms p95 objectives and 95% no-manual-recovery seek target are acceptance goals to measure, not existing results. Current default native next-episode workflow remains manual sharing plus fresh readiness. Custom synchronized playback speed and private Bitmovin APIs are deferred.

## 11. Exact continuation procedure

The candidate branch and documents are authorized for preservation and review. Do not treat that authorization as permission to implement the remaining CR issues, deploy, or release.

When implementation is separately authorized:

1. Check out `codex/crunchyroll-sync-hardening`, verify its remote tip, and read the latest checkpoint and this handoff.
2. Start CR-A01 in issue 48 by recording the branch candidate and reproducing the uncovered failures. The one successful strengthened E2E is a baseline, not a repetition or soak result.
3. Fix identity, binding and operation ownership before broader player behavior. Close the immediate coordinator quorum/deadline gaps in parallel under separate file ownership.
4. Lock B01's shared contract before client/server transaction work. Implement local and edge deadlines consistently, including restoration and mixed-version tests.
5. Add the recovery/UI/navigation work and controlled adaptive fixtures, then run sustained browser and cross-provider regression gates.
6. Use two authorized Crunchyroll accounts/devices for live acceptance. Record exact extension/backend identity, role, episode/timed edition, last action, native time, aggregate frame evidence, visible movement and error category. Keep protected data out of reports.
7. Only after release authorization, package with the correct endpoint, stage, verify compatibility and rollback, deploy and smoke-test. Verify remote commit/Worker/package identity separately.

## 12. Work record and superseded conclusions

- Checkpoint 29 preserves initial source discovery, optional symptom question/answer, live DOM observation, failed public fetches, original red regressions and interrupted agent work.
- Checkpoint 30 preserves the implemented fixes, intermediate test correction, 189-test result, earlier browser pass, later approval rejection and Safari packaging failure.
- Checkpoint 31 preserves the repeated final source check and audit. Its statement that remaining work was only runtime acceptance is superseded by the additional source gaps identified in this planning review; the recorded successful tests remain valid for their covered scope.
- Checkpoint 32 records the plan-only instruction, handoff request, read-only audits, primary-source refresh, new documents, document verification and unchanged-code comparison. Checkpoint 33 records tracker publication. Checkpoint 34 records the focused commits, remote code-branch push, and pending documentation metadata blocker.

This handoff summarizes the complete Crunchyroll investigation scope. [context-checkpoint.md](../context-checkpoint.md) retains the longer chronological activity log, including older project history that predates this task.
