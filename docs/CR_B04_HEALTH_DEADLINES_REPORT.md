# CR-B04 health deadline and silent-player evaluation report

Issue: [#58](https://github.com/muaz978/sync-your-joy/issues/58)
Dependency: [CR-B02 / #56](https://github.com/muaz978/sync-your-joy/issues/56)
Scope: deterministic sync-engine health deadlines and failure evaluation
Branch: `codex/issue-58-health-deadlines`
Base: CR-B03 merge `b36d33dcbd9bab22d14351ec5b50fcd24cd6f157`
Version when written: `0.2.4`
Status when written (historical): implementation and final local verification complete; PR review, merge and downstream acceptance remain separate gates. Merged as PR #86 and shipped in v0.2.5; #58 stays open. Section 9 is the post-merge update (against `main` at `8d8bf2a`, extension 0.2.12): PR #105 and the Option A changes, and it supersedes the statements in sections 1 to 8 about sample ordering and the exact-revision rule.

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
5. Sample ordering and current room revision checks remain before freshness bookkeeping. The room coordinator continues to rely on the authenticated transport boundary for participant, media and binding identity validation, while the room-level method rejects stale revisions and out-of-order local sample timestamps before mutating health state. (Amended 2026-10-31, Option A, see section 9: the extension checks the media and binding before it sends a report, and the coordinator only orders reports. The rule for out-of-order timestamps and for revisions is the one in section 9, not the one written here.)
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
- a sample with a lower local sample timestamp than the accepted sample is rejected before any freshness or progress field changes (superseded: section 9 narrows this to a late delivery, and also rejects a replayed duplicate);
- server receipt time updates `lastSampleReceivedAtMs`;
- explicit `progressed: false` does not reset `lastProgressAtServerMs`;
- unrelated revision changes cannot be repaired by an old report because the old revision is rejected, and the previously accepted evidence remains intact (superseded: section 9 tolerates a report in flight across revisions that change nothing the players are playing against).

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

## 9. Post-merge update (against `main` at `8d8bf2a`, extension 0.2.12)

Evidence class for everything in this section: unit and injected-clock tests on synthetic fixtures. No browser, Crunchyroll, two-account, two-device, deployment or acceptance evidence is claimed. Per the owner's decision of 2026-10-31 those gates are carried by #30, #33, #34, #35 and #69, not by #58.

### Owner decision that bounds this card (2026-10-31): Option A

The extension checks the media and the binding of the player a report comes from, and the coordinator only orders reports. Criterion 2 ("validate sample sequence, media and binding before freshness") is amended to say that. `PlayerSample` therefore carries no media epoch, binding ID or sequence, and the coordinator does not read the binding evidence of an operation acknowledgement when it takes a report (pinned by a test). A replayed identical report and a 5 second client clock step back must not pause healthy players (pinned, below). The answer on #53 about clock-only progress applies to what the panel and the acknowledgement may claim; the coordinator still counts a report that says it progressed, and this change does not discount clock-only evidence (`progressEvidence` is still not read).

### PR #105 (already merged)

`isSampleRevisionCurrent` accepts a report stamped within the latest unbroken run of revisions produced only by start acknowledgements, as progress evidence; failure classification still needs the exact revision. See its tests in `room.test.ts`.

### Replayed reports

A report the coordinator already holds, delivered again, used to refresh `lastSampleReceivedAtMs` and, when it said `progressed`, `lastProgressAtServerMs`, so a stopped or silent player could be kept looking alive by repeating its last good report. `isDuplicateSample()` (`playback-health.ts`) now drops a report that equals the recorded one in every field. Only a whole-report duplicate is dropped: two different reports can share a millisecond, so the timestamp alone is not the test.

### Three classes of report

`updatePlayerStatus()` puts every report in one of three classes (`room.ts`). The coordinator orders reports; it does not judge which media element or binding one came from (Option A: the extension checks that before it sends).

| Class | A report is in it when | `lastSample` (the stored report) | `lastSampleReceivedAtMs` | `lastProgressAtServerMs` | status, `playbackBlocked` | failure classification (now, or by the timer later) | ordering record |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dropped | it was seen before (same content as one of the last 64 distinct reports it remembers, whether that one was accepted or itself dropped as old), or equals or is older than and not further along than the stored or the latest report, or is older than the stored report with fewer corrections (`correctionCount`) | not changed | not changed | not changed | not changed | none | not changed |
| alive-only | it carries an older revision of a run of events that change nothing the players are playing against, or it is the first report after a possible client clock step (older timestamp than the stored report, but further along) | not changed (and never set by it) | set to now | set to now when the report shows progress | not changed | none: nothing is read from it except, for the timer, that the player is alive and has progressed | set: it becomes the latest report, its content is remembered, and a possible step is recorded |
| stored | any other report | set | set to now | set to now when the report shows progress | set | yes, when it carries the current revision (the failure branch still needs an exact revision) | set: it becomes the latest report and any possible step is forgotten |

"Shows progress" is the same for every class: the report's `progressed` field when it has one, otherwise a position that moved by at least `PLAYBACK_POSITION_ADVANCE_SECONDS` (0.12 s) from the latest report of either class. A report that omits `progressed` therefore counts by its position whether it is stored or alive-only.

The ordering record (`reportOrders`, per participant, in memory only, cleared on every new command and not part of a snapshot or of stored state) holds the latest report of either kind, the possible clock step, whether any report since the last command showed progress, and the content of the last 64 distinct reports it saw. Both reports it accepted (stored or alive-only) and reports it dropped as old enter that list; an exact repeat is already in it and is not added again, and the oldest entry is evicted first when it is full. A restored coordinator starts without one and orders against the stored report.

### Client clock steps and late reports

Reports carry the client's `Date.now()`. A client clock that steps back made every following report look older than the recorded one, so the coordinator dropped a healthy player's reports until its clock caught up and then paused the room as stalled (a 5 second step paused after 1.8 seconds). The rule now:

- A report with an older timestamp whose position is not further along by at least 0.12 s than the stored or the latest report is a late delivery and is dropped, whatever it says (playing, paused or buffering).
- An older timestamp from a player that has made fewer corrections (`correctionCount`) than the stored report shows is dropped too: it was sent before a correction the player made on its own, which moved the position back without changing the room revision.
- Any other older timestamp (further along, no fewer corrections) is a clock step or a late report from before a correction, and one report cannot tell which. It is alive-only. The next report that follows it, with a newer timestamp and further along by at least 0.12 s, confirms the step and is stored; a report that does not is alive-only too. The possible step is forgotten when a stored report arrives or a new command starts.

Consequences, all pinned: a healthy player whose clock steps back by 0.4 s, 1.5 s, 5 s or 60 s keeps its health evidence and the room keeps playing; a stopped player is still paused; a delayed report from before a correction, even one that says the start failed, cannot pause the room or show the participant as blocked.

### Reports in flight across revisions that are not a new command

A join request, a denial, a withdrawal, a change of controller, a dropped connection that is waited for, a return inside that wait and a member becoming ready advance the revision without pausing the room, so a report the player had already stamped with the previous revision was rejected and, with bad timing, the room paused healthy players as stalled (about one snapshot round trip of window each time). These events extend `tolerableRevisionRun` (renamed from `startAcknowledgementRun`), the latest unbroken run of such revisions starting at the revision of the command before it, and `isSampleRevisionCurrent()` accepts a report stamped inside the run, as an alive-only report. Any other revision (a new Play, a pause, a seek, a membership change that pauses the room, media change) ends the run, so a report from before one of those is still rejected. A change of controller in a transactional room pauses the room, so it is not tolerated there. The run is in memory only.

### What the timer reads

The timer (`nextHealthDeadlineMs()` and `evaluateHealth()`) judges a participant by its stored report, except in two cases, and in both it uses a fixed report that says playing and carries no failure field. First, when it has none because every report it sent was alive-only, and at least one showed progress. Second, when an alive-only report has shown progress since the stored report was stored: the player is playing now, so the stored report is out of date, whatever it says. That is one rule for every kind of stored state: not started (`playbackStarted: false`), buffering, paused, or playing without progress. Review round 4 found it for a report that said "not started" (a participant that then sent only progressing reports that missed a start acknowledgement was paused as `participant_playback_startup_timeout` at ten seconds). Round 5 found it for buffering and paused: with a stored buffering report, later alive-only progress did not retire it, so the timer applied no progress deadline, and fresh alive-only reports kept extending the silence deadline, so a player that then stopped was never paused. Both were the same rule applied to one field at a time; it now applies to the report as a whole. A stored report that arrives after the alive-only progress is the newest, and is read as it says (a player that is buffering again is not judged by the progress deadline). In both cases the silence and progress deadlines apply from the times the alive-only reports set. When no report was ever stored and none showed progress, the participant is judged as before: the 10 s startup deadline applies and a silent participant is paused as `participant_playback_silent`, because nothing says whether it has started. The 10 s startup deadline applies only to that case and to a stored report that says `playbackStarted: false`; a stored report that says playing (`playbackStarted: true` or omitted) is judged by the progress deadline (1.8 s without progress, unless the player is buffering or paused). An alive-only report never makes the timer classify `participant_playback_startup_timeout`, `participant_playback_blocked` or a buffering pause.

Limits, stated: the status shown in the panel for a participant whose reports were all alive-only stays at its last stored value (for example `preparing`) until a stored report arrives; the replay memory is the last 64 distinct reports: a replay inside it is dropped by content, and one beyond it only when it is also older and not further along than the latest (a replay of a report that is no longer among the last 64, and whose timestamp is newer than the latest report's, as after a client clock step back, would be accepted); a frozen player is paused by its progress deadline when its stored report says it is playing, or when it sent alive-only reports that showed progress (the fields of an alive-only report are ignored; progress is what counts, and it is read as fixed playing evidence even if the report says paused or buffering); the 10 s startup deadline applies only when there is no stored report or the stored report says `playbackStarted: false`.

Reading of the criterion: the first of the two readings in the 2026-10-31 verification pass (a report in flight across such a revision is tolerated as progress while failure classification stays exact) is the one implemented. The owner's decision comment does not record a choice between it and "stored evidence surviving a revision bump is enough", and the task for this change names the widening explicitly.

How big this is, and the fallback: the tolerant half of this change (older revisions, clock steps) took three review rounds, each finding a new way an older report could stand in for a newer one. What is in place now is one function, one in-memory record and one fixed report, covered by direct tests and a seeded property test over 300 sequences each of a progressing and a frozen player, but it is more than the strict fixes. If the owner would rather not carry it, the strict part (drop a replayed report, order reports exactly by timestamp, positional progress) can ship alone and the tolerance for unrelated revisions and clock steps can be split out for a separate decision; the Option A decision and the criterion's "unrelated revisions" clause are what ask for it.

### Pings

`ping` and `client_metrics` never touch `lastSampleReceivedAtMs`, but no transport test names that. The tests for the room service (`server.test.ts`) and the Durable Object (`worker.test.ts`) are not part of this change.

### Tests

`room-streaming-regressions.test.ts`: describe "player reports: a replayed report, a client clock step and the order of reports" (8 tests), "a report in flight across a revision that is not a new command" (14), "a report that is only evidence the player is alive" (10) and "alive-only reports are ordered, deduplicated and read by the timer" (10). `room-report-order.property.test.ts`: over 3,000 seeded sequences of each direction (6,000 in all; once over 20,000 of each, 40,000 in all, with seeds 1 to 20,000 printed by the test), in legacy and in transactional rooms (prepared, committed, and a start acknowledgement from the host and from the guest at random times, each raising the revision), with and without a guest that first sends reports that say it is not playing for up to three seconds, drawn over every field the timer reads (`playbackStarted` false, true or omitted; `paused`; `buffering`; `progressed` false or omitted), a player that keeps progressing is never paused by anyone, and a player that stops is paused, by that player and nobody else, by its progress deadline, whatever the replays, late and re-ordered deliveries, client clock steps of 0.4 s to 60 s in both directions, omitted `progressed` fields and older revisions after join requests. The first version of the property test used a legacy room and a guest that always said it had started, which is why it did not find the round-4 hole; it now does, with the fix reverted (20 of 2,500 progressing sequences failed). The round-5 version draws the stored report over every field above and, with the round-5 rule reverted to the round-4 one, fails the "stops" direction (the progressing direction cannot see this hole: it pauses nobody); it passed once over seeds 1 to 20,000 of each direction. A report that says "playing" with no progress is deliberately not drawn as a start-up state: held for 1.8 seconds it is a stalled player, and the room rightly pauses it. `room.test.ts`: describe "player reports during a started transactional Play" (8 tests; four are the stored-report cases: buffering, paused and not started retired by later alive-only progress, and a newer stored report that is not).

### Not covered

- A silent-player scenario in `scripts/smoke-room-service.mjs` and the production smoke.
- Transport-level ping tests, a wire-level `participant_playback_silent` test, and the Durable Object runtime.
- Automatic resume interacts with one pause per failure episode (a pause arms up to three resumes in two minutes); that interaction is not part of this change.
- Whether the coordinator should discount clock-only progress.
- Mixed-version rooms on real builds, live Crunchyroll, two accounts, two devices, a deployed coordinator and user acceptance.
