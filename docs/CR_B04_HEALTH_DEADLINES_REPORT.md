# CR-B04 health deadline and silent-player evaluation report

Issue: [#58](https://github.com/muaz978/sync-your-joy/issues/58)
Dependency: [CR-B02 / #56](https://github.com/muaz978/sync-your-joy/issues/56)
Scope: deterministic sync-engine health deadlines and failure evaluation
Branch: `codex/issue-58-health-deadlines`
Base: CR-B03 merge `b36d33dcbd9bab22d14351ec5b50fcd24cd6f157`
Current version: `0.2.4`
Status: implementation and final local verification complete; PR review, merge and downstream acceptance remain separate gates

## 1. Problem and acceptance interpretation

CR-A01 added the first timer-driven report-silence evaluator. CR-B02 then added transactional preparation, commit, observed-start acknowledgements and operation deadlines. The remaining CR-B04 gap was that health evaluation did not use the same complete deadline model as the player state machine:

- `nextHealthDeadlineMs()` handled a participant with no sample and a participant whose accepted sample stream had gone silent, but it did not schedule sustained no-progress detection when no later sample arrived;
- a sample explicitly reporting `playbackStarted: false` was treated as ordinary report silence instead of the observed-start deadline;
- a health failure could pause playback while leaving an active transactional operation in a live phase;
- deadline arithmetic was repeated in the coordinator instead of being centralized in pure server-clock helpers;
- duplicate timer callbacks needed explicit proof that they cause no second pause, revision, or failure effect.

The issue criteria are interpreted as follows:

1. Preparation and observed-start deadlines remain represented by the CR-B02 operation deadline and expiry contract. CR-B04 makes the health side deterministic and compatible with those operation phases.
2. Missing startup samples use the startup deadline. An accepted sample with `playbackStarted: false` uses that same observed-start deadline rather than a shorter report-silence deadline.
3. A non-paused, non-buffering sample with no useful progress receives a server-clock no-progress deadline. The evaluator can pause at that deadline without waiting for another inbound player report.
4. A paused or buffering sample uses the report-silence deadline. A live WebSocket ping is not treated as media health evidence because it does not update `lastSampleReceivedAtMs`.
5. Sample ordering and current room revision checks remain before freshness bookkeeping. The room coordinator continues to rely on the authenticated transport boundary for participant, media and binding identity validation, while the room-level method rejects stale revisions and out-of-order local sample timestamps before mutating health state.
6. The first health failure pauses once, cancels a still-active transactional operation with `manual-recovery`, increments the room revision once and marks a state barrier. Later timer callbacks observe paused playback and return no result.

This report separates source inspection, deterministic tests, local browser evidence, live-provider acceptance, deployment and user acceptance. It does not close issue #58 or authorize a release.

## 2. Baseline and affected files

The branch starts from the verified CR-B03 merge on `origin/main`. The relevant pre-change baseline was:

- `packages/sync-engine/src/playback-health.ts` defined startup grace, progress timeout, startup timeout and report-silence timeout constants;
- `RoomCoordinator.nextHealthDeadlineMs()` returned only the earliest missing-sample or report-silence deadline;
- `RoomCoordinator.evaluateHealth()` paused on missing samples or report silence, but did not classify timer-driven no progress or cancel a live operation;
- `updatePlayerStatus()` already rejected stale room revisions and backward local sample timestamps before assigning `lastSample`, `lastSampleReceivedAtMs` or `lastProgressAtServerMs`;
- the local room-service cleanup timer and edge Durable Object alarm already invoked operation expiry and `evaluateHealth()` independently of message handlers;
- the edge scheduler already included operation and health deadlines separately, so this issue does not claim to complete CR-B05 or CR-B06 transport persistence work.

Changed files:

| File | Change | Purpose |
| --- | --- | --- |
| `packages/sync-engine/src/playback-health.ts` | Added pure startup, progress and report-silence deadline helpers and reused the progress/startup helpers in the existing predicates | Centralizes bounded server-clock arithmetic and prevents evaluator and watchdog drift |
| `packages/sync-engine/src/playback-health.test.ts` | Added boundary tests for the pure deadline helpers | Proves client sample timestamps cannot move a server deadline and exact boundaries remain deterministic |
| `packages/sync-engine/src/room.ts` | Added participant health deadline classification, timer-driven no-progress evaluation, explicit never-started handling, and transactional cancellation during health recovery | Completes the coordinator-side CR-B04 behavior without weakening existing identity and ordering guards |
| `packages/sync-engine/src/room-streaming-regressions.test.ts` | Added duplicate timer, buffering silence, explicit never-started, no-progress and client-clock/out-of-order regressions | Covers each CR-B04 acceptance gate at injected-clock boundaries |
| `packages/sync-engine/src/room.test.ts` | Added a started transactional operation regression for timer-driven no-progress recovery | Proves health recovery cancels the active operation and uses the authoritative coordinator position |
| `docs/CR_B04_HEALTH_DEADLINES_REPORT.md` | This report | Records the baseline, implementation, evidence, limits and closure boundary |

No room-service or edge-service source was changed in CR-B04. Their existing timer and alarm paths already call the coordinator methods. The separate service and Durable Object acceptance issues remain responsible for transport scheduling, persistence and rehydration evidence.

## 3. Deadline model

The health helpers use only the coordinator's server clock:

| State | Deadline | Evaluation |
| --- | --- | --- |
| No accepted sample for a required connected ready participant | `effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS` | `participant_playback_silent` |
| Last accepted sample says `playbackStarted: false` | `effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS` | `participant_playback_startup_timeout` |
| Last accepted sample is paused or buffering | `lastSampleReceivedAtMs + PLAYBACK_REPORT_SILENCE_TIMEOUT_MS` | `participant_playback_silent` |
| Last accepted sample is playing and has no useful progress | max of the scheduled-start and last-progress timeout boundaries | `participant_playback_stalled` |

The existing `PLAYBACK_STARTUP_GRACE_MS` remains relevant for a transactional participant that is committed but has not yet sent observed-start evidence. Its no-progress deadline cannot fire before startup grace. This preserves the CR-B03 browser startup window while still allowing timer-driven detection after that window.

The existing CR-B02 operation deadline remains independent. The server and edge paths call operation expiry before health evaluation. At the exact operation deadline, operation expiry pauses and fails the operation, so the following health evaluation sees paused playback and produces no duplicate transition.

## 4. Implementation details

### Pure deadline helpers

`playback-health.ts` now exposes:

- `playbackStartupDeadlineMs(playback)`;
- `playbackProgressDeadlineMs(playback, lastProgressAtServerMs)`;
- `playbackReportSilenceDeadlineMs(playback, lastSampleReceivedAtMs)`.

The helpers clamp receipt baselines to the scheduled server start where appropriate. They never use `sampledAtLocalMs` for elapsed-time decisions. Local sample timestamps remain an ordering signal only.

### Shared coordinator classification

The coordinator now derives `nextHealthDeadlineMs()` from the same participant classification used by `evaluateHealth()`:

- a missing sample or explicit never-started sample receives the startup deadline;
- a paused or buffering sample receives the report-silence deadline;
- an active playing sample receives the earlier of report silence and useful-progress expiry;
- a committed transactional participant still waiting for `started` cannot be classified as stalled before startup grace.

This means the scheduler will wake at the deadline the evaluator actually understands. A ping or unrelated room event does not refresh a media receipt baseline.

### Failure recovery and episode semantics

When a health deadline is reached, the coordinator calculates a safe pause position before changing the playback state:

- a started transactional operation uses the authoritative coordinator projection;
- a committed or preparing operation retains its fixed target;
- legacy steady playback uses the authoritative coordinator projection.

An active transactional operation is cancelled with `manual-recovery` before the pause is committed. The room revision increments once and the state barrier is marked. Since the room is then paused, repeated cleanup or alarm callbacks return `null` and cannot increment the revision again.

### Identity and freshness boundary

CR-B04 does not move player binding or media identity validation into the room snapshot. The extension service worker and authenticated backend continue to establish participant and current-player identity before the coordinator receives a `player_status` message. Inside the coordinator:

- a participant and exact current room revision are required;
- a sample with a lower local sample timestamp than the accepted sample is rejected before any freshness or progress field changes;
- server receipt time updates `lastSampleReceivedAtMs`;
- explicit `progressed: false` does not reset `lastProgressAtServerMs`;
- unrelated revision changes cannot be repaired by an old report because the old revision is rejected, and the previously accepted evidence remains intact.

## 5. Security and privacy review

- All new deadline values are derived from bounded constants and validated numeric state.
- No client timestamp controls a server-side timeout.
- A WebSocket ping cannot manufacture a player sample or clear a health deadline.
- A stale or out-of-order sample cannot reset progress freshness before it is rejected.
- A timer callback cannot resume a cancelled or failed transactional operation. Health recovery pauses and marks a revision barrier.
- The fixed participant and operation identity rules from CR-B01 and CR-B02 remain unchanged.
- No credentials, cookies, account identifiers, provider tokens, private provider APIs, signed stream URLs, DRM data, media bytes, screenshots or arbitrary page execution were added.
- The extension's state-only boundary is preserved. This deterministic engine work does not inspect or extract protected Crunchyroll media.

## 6. Verification performed

### Focused deterministic verification

```text
npm test -- --run packages/sync-engine/src/playback-health.test.ts packages/sync-engine/src/room-streaming-regressions.test.ts packages/sync-engine/src/room.test.ts
PASS, 3 files, 74 tests
```

The focused suite verifies:

- missing startup evidence and exact startup deadline;
- explicit never-started evidence and the observed-start deadline;
- paused or buffering report silence;
- no-progress expiry without another incoming sample;
- duplicate timer execution after a failure;
- server receipt time despite a large or backward-moving client timestamp;
- stale revision and out-of-order sample protection;
- transactional no-progress recovery and cancellation of the active operation;
- existing seek, startup, stall, restart, quorum and operation regressions.

### Final repository and browser verification

The final branch verification completed with:

```text
npm run check
npm run verify:browser-packages
git diff --check
```

Results:

- `npm run check`: passed. Typecheck passed, 30 Vitest files passed with 279 tests, the room-service bundle passed, and the extension build passed.
- `npm run release:check-version`: passed with version `0.2.4`.
- `git diff --check`: passed.
- The restricted `npm run verify:browser-packages` attempt failed only at Apple's Safari converter because the sandbox denied access to its temporary staging path and the converter reported that it could not parse `manifest.json`.
- The approved host-level rerun passed Chrome manifest `0.2.4` with `service-worker.js`, Firefox manifest `0.2.4` with `sidepanel.html`, and Safari macOS package smoke.
- `npm run test:e2e -- --grep "profile A creates a room"`: passed at host level, one two-profile test in 6.2 seconds, including the real unpacked extension and local room service.

The restricted Safari failure and the successful host rerun are recorded as separate evidence classes. The host rerun proves package structure and a generic local browser scenario only. It does not prove authenticated Crunchyroll output.

CR-B04 is a sync-engine contract slice. A generic local browser test is useful regression evidence but is not required to establish the new timer behavior, and it cannot establish authenticated Crunchyroll playback. The signed-in Edge session remains available for the later controlled headed gate. No browser installation, account action or provider API access is requested for this issue.

## 7. External limits and downstream dependencies

This implementation does not claim:

- real visible Crunchyroll frames or provider startup behavior;
- two-account or two-device acceptance;
- local room-service timer socket behavior, which belongs to CR-B05;
- Cloudflare alarm, hibernation, persistence or rehydration behavior, which belongs to CR-B06;
- mixed-version and stored-state migration behavior, which belongs to CR-B07;
- deployment, release packaging or user acceptance.

The user-signed Crunchyroll session is treated as available. No issue label or project field should say that the account is missing. If a later live gate needs an additional account, device, deployment target or explicit installation action, that exact requirement will be reported at that gate.

## 8. Review and closure decision

The implementation is eligible for a detailed PR after final local checks, diff inspection, commit and push. The PR must include this report, the exact source and test evidence, the security boundary, any environment-specific failures and the reason the issue remains open.

After a successful review and merge, issue #58 should move to `Verification`, not `Done` or closed. The implementation can be considered complete for this deterministic slice, but downstream CR-B05, CR-B06 and later provider, device, deployment and user-acceptance gates remain. No release bump is proposed for CR-B04 alone. Version `0.2.4` remains current and `1.0.0` remains reserved for the complete milestone release.
