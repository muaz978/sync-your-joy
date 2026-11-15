# CR-B06 Edge Health and Rehydration Report

Status when written (historical): implementation complete on the issue branch, awaiting pull request review and merge verification. Update 2026-10-16: merged as PR #88 (2026-09-20) and shipped in v0.2.5, so the sections written for the pre-merge branch (1 to 5) are historical where they say the merge was pending or the package was at 0.2.4; section 7 was rewritten on 2026-11-15; #60 stays open.

Update 2026-11-15: the Durable Object tests that this report said did not exist are in `apps/edge-service/src/worker.alarm.test.ts` (section 4A). The numbers and statements in sections 4 to 7 were corrected against `main` at `257afb6` (package version 0.2.12); the sections written for the pre-merge branch keep their original text where it is still true and say so where it is not. The evidence class of everything here is unit tests and a hand-written storage and alarm harness that drives the real `RoomDurableObject` class. It is not the Workers runtime.

Issue: [CR-B06, Make edge alarms and rehydration preserve health semantics](https://github.com/muaz978/sync-your-joy/issues/60)

Scope: Cloudflare Durable Object alarm ordering, durable state ordering, compact health evidence rehydration, and deterministic regression coverage. This slice remains state-only. It does not access provider APIs, protected media, cookies, signed URLs, or DRM data.

## 1. Problem statement and acceptance boundary

The edge Durable Object already persisted the complete `RoomCoordinator` export, including participant health evidence, but its observable ordering was unsafe for a crash or storage failure between an in-memory transition and the next storage write:

- `alarm()` evaluated seek expiry, operation expiry, health failure, and controller recovery in one pass and could broadcast multiple snapshots from one stale pre-alarm state.
- Several state-changing WebSocket paths broadcast a result before `storage.put()` and `storage.setAlarm()` completed.
- The repository had no edge-specific alarm/storage boundary test proving earliest-deadline selection, persistence-before-observation, cold restore, or cancelled-operation behavior.

This report records source and deterministic boundary evidence. It does not claim a deployed staging Durable Object, authenticated Crunchyroll output, two-account acceptance, two-device acceptance, extension installation, or final user acceptance. Those remain separate gates.

## 2. Source review before implementation

The pre-change source review covered:

- `apps/edge-service/src/worker.ts`
- `packages/sync-engine/src/room.ts`
- `packages/sync-engine/src/playback-health.ts`
- `apps/edge-service/tsconfig.json`
- `apps/edge-service/wrangler.jsonc`
- root `package.json` and `package-lock.json`

The stored room record contained:

- full `RoomCoordinator.exportState()` output;
- pending controller recovery state;
- empty-room timestamp;
- room creation timestamp.

The coordinator export already carried `lastSample`, `lastSampleReceivedAtMs`, and `lastProgressAtServerMs`. Therefore the primary defect was ordering and edge-boundary proof, not an omission of health fields from the stored coordinator state.

The existing alarm path used the following sequence before this change:

1. release an expired seek and broadcast it;
2. release an expired operation and broadcast it;
3. evaluate health and broadcast it;
4. attempt controller recovery and broadcast it;
5. persist the final room state and schedule the next alarm.

The state-changing message paths used the same unsafe broad pattern, mutating the coordinator, broadcasting a snapshot, and persisting afterward.

## 3. Implementation

### 3.1 `apps/edge-service/src/alarm.ts`

Added a small policy seam with three responsibilities:

- `applyEarliestDueDeadline()` evaluates deadline families in stable order, seek, operation, then health, and returns at most one transition for one alarm turn.
- `earliestAlarmAtMs()` filters absent and non-finite candidates and returns the minimum deadline, or `null` when no deadline exists.
- `persistThenObserve()` makes the ordering contract explicit and testable: the durable write must resolve before the observation callback is allowed to send or broadcast the state transition.

The seam does not replace Durable Object storage or WebSocket behavior. It only isolates the ordering policy used by the actual Worker.

### 3.2 `apps/edge-service/src/worker.ts`

The Durable Object now:

- evaluates room lifetime and empty-room expiry before applying ordinary deadline transitions;
- applies at most one seek, operation, or health transition in an alarm invocation;
- gives controller recovery the next alarm turn when an ordinary deadline transition was applied;
- persists and schedules before broadcasting alarm snapshots;
- persists before sending the initial `room_joined` response for room creation;
- persists before sending and broadcasting a successful join result;
- persists before broadcasting player status, seek acknowledgement, operation acknowledgement, join approval or denial, control, readiness, controller transfer, and link-open results;
- persists the updated disconnect/controller-recovery metadata before broadcasting a disconnect snapshot;
- continues to include pending controller, empty-room, seek, operation, and health deadlines when scheduling the next alarm (on `main` and deployed to production on 2026-10-16, the six-hour room lifetime limit is part of this list too; see section 6);
- clears pending controller state when an empty room is deleted.

If the durable write or alarm scheduling fails, the observation callback is not executed. That keeps a failed storage boundary from being represented to connected peers as a committed state transition.

## 4. Regression coverage

Added `apps/edge-service/src/alarm.test.ts` with seven tests (the file has ten today; the later ones cover the disconnect-grace and automatic-resume families, the after-write hook and the failed-write case):

1. earliest valid alarm selection ignores absent and non-finite values;
2. only one deadline family is evaluated per alarm turn and later families are not called after a transition;
3. the complete stored room record is written and the earliest of controller, room, seek, operation, and health deadlines is scheduled before broadcast;
4. a successful durable write occurs before broadcast;
5. a failed durable write produces no broadcast;
6. a room restored from stored coordinator state retains the accepted sample and both server health timestamps, and health evaluation still reaches the same deadline without manufacturing progress;
7. a cancelled transactional operation remains cancelled after cold restore and does not get released again at its old deadline.

The last two tests exercise the real `RoomCoordinator` export and `RoomCoordinator.fromState()` contract rather than a reduced mock model.

## 4A. Durable Object tests added on 2026-11-15

`apps/edge-service/src/worker.alarm.test.ts` (new, 22 tests: 12 in the due-alarm describe, four per family, and 10 in the others) drives the real `RoomDurableObject` class over a hand-written storage harness. Its `put` can be held or made to fail, it counts `put` and `setAlarm` calls, and a "restart" is a second object built over the same store with the sockets that are still attached. It is a different file from `worker.test.ts` only so that the three open test branches for #57, #58, #60 and #61 do not edit the same file; the helpers are repeated in each.

| Behaviour | Test (describe: it) |
| --- | --- |
| A due seek, operation and health alarm are written before any member hears them (the write is held; the store is read at the moment each member hears it) | `a due alarm is saved before it is announced`, three tests, one per family |
| A failed write announces nothing for each family | same describe, three tests |
| The first alarm delivered 30 s after its deadline makes one saved and announced transition per family (an exact-deadline-only release fails it) | same describe, three tests |
| The same alarm delivered again, and an hour late, makes one transition: nothing more is announced, the revision and the stored room do not change | same describe, three tests |
| A cancelled operation is cancelled after a restart, no alarm is asked for its old deadline, and the alarm at that deadline releases nothing | `a cancelled operation across a restart` |
| A restart after samples that were never written restores the evidence that was written, not the time of the restore or the later samples | `a restart after a sample that was not saved`, first test |
| Stored evidence older than 1.8 s: the first alarm after the restore pauses a healthy room as `participant_playback_stalled`, although the last real sample was 100 ms earlier. No grace exists (pinned, see section 6) | same describe, second test |
| A member that reports after the restore and before that alarm keeps the room playing | same describe, third test |
| A committed operation with one of two participants started restores paused at the operation target with no operation, one revision on, and that is saved; no operation or health alarm is left; a late `started` acknowledgement for the dropped operation changes nothing (owner decision of 2026-10-31 on #60) | `a restart in the middle of an operation's start`, first two tests |
| That restore tells the attached members nothing (current behaviour, open question, section 6) | same describe, third test |
| A write that failed inside `alarm()` and a retry on the same object: the retry saves and announces nothing; on a new object the retry announces | `an alarm whose write failed and is delivered again`, two tests |
| One `client_metrics` report costs one `put` and one `setAlarm`; a ping costs none | `what a report from a client costs in storage calls` |

"The same alarm delivered again" is tested per family. Two families that are both due and both still pending after the first transition could not be built through the Durable Object: a pause clears the disconnect grace and the other families, so the next turn finds nothing. The order and the one-family-per-turn rule are covered at unit level by `alarm.test.ts`.

Mutation checks, each a one-line scratch edit of a production file followed by `git checkout`, run against `worker.alarm.test.ts` alone (every one fails at least one test; the file was restored each time):

| Scratch edit | Failing tests |
| --- | --- |
| `alarm()` in `worker.ts`: `void this.persistAndSchedule()` instead of awaiting it | 8 (three saved-before-announced, three failed-write, both retry tests) |
| `alarm()`: `.catch(() => {})` on the write | 5 |
| `releaseExpiredSeek`: do not clear `pendingSeek` | 4 |
| `releaseExpiredOperation`: do not set phase `failed` | 2 |
| `evaluateHealth`: keep `status: 'playing'` | 3 |
| `operationDeadlineMs`: drop the cancelled check | 1 |
| `releaseExpiredOperation`: drop the cancelled check | 1 |
| restore in `room.ts`: set `lastProgressAtServerMs` to the restore time | 2 |
| `PLAYBACK_PROGRESS_TIMEOUT_MS` 1_800 to 18_000 | 4 |
| `isRoomOperation`: a committed operation may have started participants | 3 |
| `worker.ts` restore: announce `room_restored` when nothing was repaired | 1 |
| `alarm()`: announce when the alarm found nothing to release | 5 |
| `client_metrics` handler: no write | 1 |
| `ping` handler: write | 1 |
| seek, operation and stall released only when the clock equals the deadline (three edits) | 1, 1 and 2 (the late-first-alarm tests) |

## 5. Verification commands and evidence

Baseline from the clean merge of CR-B05, before this change:

```text
npm run check
30 test files passed
280 tests passed
TypeScript passed
Server and extension build passed
```

Implementation verification:

```text
npx vitest run apps/edge-service/src/alarm.test.ts
1 test file passed
7 tests passed

npm run typecheck
TypeScript passed, including apps/edge-service/tsconfig.json

npm test
31 test files passed
287 tests passed

npm run check
TypeScript passed
31 test files passed
287 tests passed
Server and extension build passed

npx wrangler deploy --config apps/edge-service/wrangler.jsonc --dry-run
Worker bundle produced successfully
Total upload: 81.76 KiB, gzip: 15.82 KiB
ROOMS Durable Object binding recognized
No deployment performed
```

Verification of the 2026-11-15 additions (section 4A), on `main` at `257afb6` plus this change:

```text
npx vitest run apps/edge-service        (three consecutive runs)
3 test files passed, 127 tests passed each time (105 before: 127 - 22 new)

npm run typecheck
TypeScript passed, including apps/edge-service/tsconfig.json

npm test
52 test files passed, 1101 tests passed (after merging main at 8d8bf2a)
```

The 17 mutation checks of section 4A were run against `worker.alarm.test.ts` alone; none of them was left in the tree. No Wrangler dry run, deployment or smoke run was made for this change: it adds tests and a document, no product code.

The Wrangler dry run confirms that the edge Worker bundles with the Durable Object binding. It does not prove a remote staging deployment or live Cloudflare alarm execution.

## 6. Storage, scheduling, and security notes

Corrected 2026-11-15 against `main` at `257afb6`. The text of the first version of this section said that no extra write is added and that `setAlarm()` is called only when a finite deadline exists. Both statements are out of date.

**What is stored.** One key, `room`, holding the coordinator export (which carries each participant's `lastSample`, `lastSampleReceivedAtMs` and `lastProgressAtServerMs`), the pending controller recovery, the empty-room timestamp and the creation time. Every write replaces the whole record.

**When it is written.** Each of these causes one `storage.put('room', ...)` followed by one `setAlarm()` (`persistAndSchedule()` in `worker.ts`):

- every state-changing message that the coordinator accepts (create, join, approval, readiness, control, transfer, link, seek and operation acknowledgements, and a `player_status` report that changes a status or pauses the room);
- every non-terminal alarm turn, whether or not it changed anything. A terminal turn (the six-hour lifetime limit or the empty-room expiry) closes the sockets, deletes the room's storage and returns, with no write and no `setAlarm()` (`alarm()` in `worker.ts`);
- every `client_metrics` report. The extension sends one after each pong, and pings every five seconds, so in the normal case, where the pong arrives and the client reports, each connected client causes one write and one alarm call every five seconds for as long as it is connected, and a room of two is two writes and two alarm calls per five seconds. A missed pong gives no report for that ping, and a client that does not send `client_metrics` (the protocol does not require it) causes none, so the real count can be lower. Pinned by `what a report from a client costs in storage calls`. A ping alone writes nothing;
- every restore, including one that repaired nothing (the alarm that is set belongs to whichever code last wrote the room, so it is derived again);
- a retry of a restore whose save failed, at most once every five seconds, triggered by a frame from any client;
- the reconcile after a socket whose attachment cannot be read closes (PR #133).

A `player_status` report that changes nothing a member can see is accepted in memory and is not written (`updatePlayerStatus` returns null). The saved evidence is therefore the evidence of the last write, which can lag the last report by up to the ping interval (section 6A).

**Which alarm.** On every non-terminal save an alarm is set (a terminal expiry deletes the room and sets none). Candidates are the pending controller recovery, the empty-room expiry, the six-hour lifetime limit (always present while the room exists, so the minimum is always finite), the pending seek, the operation, the next health deadline, the disconnect grace and the automatic-resume deadline. `setAlarm()` is called on every save, not only when a deadline exists; this section previously said the opposite.

**Ordering.** The write completes before the transition is announced, for every path that announces (`persistThenObserve`). For the alarm, `persistAndSchedule()` is awaited before the broadcasts. If the write fails the alarm throws and nothing is announced (tested for the seek, operation and health families).

**Cost is accepted as it is.** The write per `client_metrics` report is recorded here as the present cost. No owner decision on it is recorded on #60 (the 2026-10-16 comment asked whether it is accepted; the 2026-10-31 decisions do not answer it). It is not changed here.

The state-only security boundary is unchanged. The edge service handles synchronization state and does not fetch, proxy, inspect, or expose protected provider media. Health evidence is limited to playback observations already supplied by connected clients and server receipt timestamps.

## 6A. Behaviours pinned on 2026-11-15 that the owner may want to change

These are recorded, not endorsed. Each has a test that fails if the behaviour changes, so a change is a decision.

1. **Restore with stored evidence older than 1.8 s pauses a healthy room.** Saved evidence can be up to one ping interval (5 s) behind the last report, and the progress limit is 1.8 s. After a restart the health alarm is derived from the saved evidence, is already due, and the first alarm pauses the room as `participant_playback_stalled`, unless a client report arrives first. There is no grace. The 2026-10-16 comment asked for "a bounded grace or record the behaviour as accepted"; no owner decision is recorded, so this PR pins the behaviour and adds no grace. A grace would have to live in the coordinator (`packages/sync-engine`), which is outside this change.
2. **A partly started committed operation restores paused.** Starts are recorded one at a time, so between the first and the last the stored operation is `committed` with some participants started, and `isRoomOperation` accepts a committed operation only with none. The coordinator then treats the contract section as invalid and takes the same fallback as a pre-contract record (`migratePreContractState`): paused at the operation target, no operation, revision one higher, saved. No progress is added. This is the owner decision of 2026-10-31 on #60 (the pause fallback is accepted and pinned); the tests are `a restart in the middle of an operation's start`.
3. **That restore is silent.** The repair that restore announces to attached members (`unsavedRestore.reason`) is set only when a request is withdrawn or a member marked disconnected. A restore that pauses the room because the operation was dropped changes the revision but announces nothing, so a member that kept its socket still shows the room as playing and its reports (stamped with the old revision) are rejected until some later broadcast. Pinned as `tells the attached members nothing at the restore`. This was not part of the owner decision, which accepted the pause and not its announcement; it is listed for the owner. A change would be small (set a repair reason when the restored revision differs from the stored one) but adds a value to the `reason` that clients receive, so it is not made here.
4. **A retried `alarm()` on the same object saves and announces nothing.** If the write fails inside `alarm()`, the coordinator has already changed in memory; the platform's retry finds nothing left to release, saves, and the members are not told (the state they hold is the one before the alarm until their next broadcast). On a new object (an eviction between the failure and the retry) the state is restored from before the alarm and the retry announces. The 2026-10-31 verification pass lists a characterization test for this and the owner has not recorded a decision to change `alarm()`; both cases are pinned.

## 7. Remaining gates

Current as of 2026-11-15. The original text, written before the merge, said the issue should stay open until the pull request is merged; that happened (PR #88, 2026-09-20).

Not done, and not claimed:

- Running `RoomDurableObject` under workerd or miniflare (phase R7 on #119). Everything above uses a hand-written harness. It has no real storage, no real alarm delivery, no hibernation and no output gate, so an ordering that depends on those is not shown.
- The staging Durable Object run on a throwaway Worker (a condition of this card; needs Cloudflare access and approval).
- A bounded grace for stale restored evidence, and an announcement for a restore that pauses the room (section 6A, owner decisions needed).
- Provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69 and are not required on this card (owner decision of 2026-10-31).

No release version was changed by this work. #60 stays open.
