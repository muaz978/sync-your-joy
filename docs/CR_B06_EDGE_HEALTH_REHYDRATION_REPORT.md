# CR-B06 Edge Health and Rehydration Report

Status: implementation complete on the issue branch, awaiting pull request review and merge verification.

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
- continues to include pending controller, empty-room, seek, operation, and health deadlines when scheduling the next alarm;
- clears pending controller state when an empty room is deleted.

If the durable write or alarm scheduling fails, the observation callback is not executed. That keeps a failed storage boundary from being represented to connected peers as a committed state transition.

## 4. Regression coverage

Added `apps/edge-service/src/alarm.test.ts` with seven tests:

1. earliest valid alarm selection ignores absent and non-finite values;
2. only one deadline family is evaluated per alarm turn and later families are not called after a transition;
3. the complete stored room record is written and the earliest of controller, room, seek, operation, and health deadlines is scheduled before broadcast;
4. a successful durable write occurs before broadcast;
5. a failed durable write produces no broadcast;
6. a room restored from stored coordinator state retains the accepted sample and both server health timestamps, and health evaluation still reaches the same deadline without manufacturing progress;
7. a cancelled transactional operation remains cancelled after cold restore and does not get released again at its old deadline.

The last two tests exercise the real `RoomCoordinator` export and `RoomCoordinator.fromState()` contract rather than a reduced mock model.

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

The Wrangler dry run confirms that the edge Worker bundles with the Durable Object binding. It does not prove a remote staging deployment or live Cloudflare alarm execution.

## 6. Storage, scheduling, and security notes

The durable room record remains one `storage.put('room', ...)` containing the coordinator export and the three room lifecycle fields. Health evidence is already part of each internal participant record. Each state-changing commit then computes the next alarm as the minimum of the currently applicable controller recovery, empty-room, seek, operation, and health deadlines, and calls `setAlarm()` only when at least one finite deadline exists.

The new ordering adds no extra write for a normal state transition. It changes the point at which the existing write and alarm scheduling complete relative to the send or broadcast. Alarm transitions are coalesced to one coordinator transition per invocation, which reduces duplicate or stale snapshots when Cloudflare delivers an alarm late or repeats a callback.

The state-only security boundary is unchanged. The edge service still handles synchronization state and does not fetch, proxy, inspect, or expose protected provider media. Health evidence is limited to playback observations already supplied by connected clients and server receipt timestamps.

## 7. Remaining gates

This issue should remain open until the pull request is reviewed, merged, and the merged commit is verified on `origin/main`. After merge, issue #60 should move to Verification with the PR link, merge SHA, review result, test evidence, and the explicit staging limitation recorded. It must not be closed solely because local tests and a Wrangler dry run passed.

No release version was changed. The repository remains on `0.2.4`; release `1.0.0` remains reserved for complete milestone acceptance.
