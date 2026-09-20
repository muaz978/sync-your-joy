# CR-B03 extension prepare and started acknowledgement report

Issue: [#57](https://github.com/muaz978/sync-your-joy/issues/57)
Dependencies: [#55 / CR-B01](https://github.com/muaz978/sync-your-joy/issues/55), [#56 / CR-B02](https://github.com/muaz978/sync-your-joy/issues/56)
Scope: extension capability advertisement, player-side preparation, current-play-attempt tracking, started evidence, operation acknowledgement transport, and backend wire dispatch
Current status: implementation and final branch verification complete; PR review, PR metadata, merge and issue-closure gates remain separate

## 1. Problem statement and acceptance interpretation

CR-B01 defined an operation identity and observation contract, and CR-B02 added the coordinator state machine that waits for fixed-participant preparation before committing and then waits for observed-start evidence. Before CR-B03, the extension could not participate in that contract:

- it did not advertise `CURRENT_CLIENT_CAPABILITIES` when creating, joining or reconnecting to a room;
- the protocol had no client message for a prepare or started operation acknowledgement;
- the service worker could not validate the current player binding before forwarding such evidence;
- the content script had no transaction-specific preparation path;
- a `play()` promise resolution or a `paused: false` sample could be mistaken for visible playback start;
- a scheduled play from an old operation could survive a pause, source replacement or superseding operation;
- a direct in-page gesture could recover a browser autoplay rejection without being associated with the current operation attempt.

The issue acceptance criteria were interpreted as follows:

1. A content script may prepare only the current operation and current media/player identity. It must pause while preparing, align to the operation target, require usable native media data, and send `prepared` only when the player is actually aligned.
2. A committed play operation may schedule a local play attempt at the coordinator's effective time. A resolved `HTMLMediaElement.play()` promise is not itself started evidence. A started acknowledgement requires the current operation, current binding and source generation, an accepted play attempt, a non-seeking player at the expected target, and real progress evidence from the player-health observer.
3. A user gesture in the page or the extension's in-page playback control may recover a blocked play attempt. That gesture is still subject to the same real-progress gate.
4. Any pause, source/player replacement, control supersession, room detachment or operation identity change must cancel local scheduled work and prevent stale acknowledgements.
5. The backend must receive the acknowledgement through the same authenticated socket identity and pass it to the existing coordinator validation. Payload participant IDs and operation IDs are never authorization by themselves.

This report distinguishes source, deterministic tests, local browser tests, live-provider tests, deployment and user acceptance. It does not close the issue or authorize a release by itself.

## 2. Baseline and affected files

The branch started from the verified CR-B02 merge on `origin/main`, whose exact base at branch creation was the CR-B02 squash merge. The implementation changed the following files:

| File | Change | Why it is needed |
| --- | --- | --- |
| `packages/protocol/src/index.ts` | Added the `operation_ack` client message and strict parsing through `parseOperationAcknowledgement` | Establishes a bounded wire contract for prepared and started evidence |
| `packages/protocol/src/index.test.ts` | Added valid, invalid-binding and invalid-phase parser cases | Prevents malformed or non-transactional acknowledgements from entering either backend |
| `apps/extension/src/internal.ts` | Added `OPERATION_ACK` to the extension runtime request union | Gives the content script and service worker a typed internal boundary |
| `apps/extension/src/service-worker.ts` | Advertises capabilities for create, join and reconnect; validates the current player binding; forwards operation acknowledgements; records bounded diagnostics | Connects the player document to the authenticated room socket without trusting an arbitrary sender or payload identity |
| `apps/extension/src/content-script.ts` | Added transaction identity tracking, preparation, scheduled commit application, direct gesture recovery, real-progress started gating and acknowledgement emission | Implements the player-side half of CR-B03 |
| `apps/extension/src/content-script.test.ts` | Added a complete preparation-to-commit-to-real-progress scenario | Proves that promise resolution and `paused=false` alone do not produce `started` |
| `apps/extension/src/service-worker.test.ts` | Added current-binding forwarding and stale-binding rejection for `OPERATION_ACK` | Proves document replacement cannot reuse the previous player authority |
| `packages/sync-engine/src/room.ts` | Added a post-commit start-evidence deadline, delayed the transactional stall watchdog until startup grace, and preserved seek resume intent before superseding cancellation pauses the old operation | Aligns coordinator timing with real browser progress and prevents a playing room from turning a superseding seek into a paused seek |
| `packages/sync-engine/src/room.test.ts` | Added deadline, startup-watchdog and superseding-seek regressions | Proves the coordinator timing and resume policy at their exact boundaries |
| `apps/room-service/src/server.ts` | Dispatches `operation_ack` through the authenticated client participant to `RoomCoordinator.acknowledgeOperation` | Makes the local backend use the CR-B02 validation path |
| `apps/room-service/src/server.test.ts` | Added a real WebSocket negotiation and full prepare/commit/start transaction | Proves the wire path from two clients to the coordinator and back |
| `apps/edge-service/src/worker.ts` | Dispatches `operation_ack` through the Durable Object attachment and persists/schedules the resulting state | Keeps the deployed backend aligned with the local room service |
| `docs/CR_B03_EXTENSION_ACK_REPORT.md` | This detailed issue report | Records implementation, evidence, security review, limits and remaining gates |

No provider API, credential, cookie, signed media URL, DRM, media byte, screenshot or arbitrary page-execution capability was added.

## 3. Wire and capability contract

### Capability advertisement

The extension service worker now includes `CURRENT_CLIENT_CAPABILITIES` in:

- `create_room`;
- `join_room`;
- reconnect `join_room`.

This allows the coordinator to negotiate transactional mode only when every connected participant supports the complete contract. Missing or legacy peers remain in the legacy path. The change is intentionally fail-closed: an older extension cannot cause a room to wait for operation acknowledgements that it cannot produce.

### Operation acknowledgement message

The new client message has this shape after validation:

```text
{
  type: 'operation_ack',
  acknowledgement: {
    mediaEpoch,
    operationId,
    bindingId,
    sourceGeneration,
    sampleSequence,
    phase: 'prepared' | 'started',
    participantId,
    observedPositionSeconds,
    observedAtLocalMs
  }
}
```

The protocol parser rejects:

- missing or malformed operation identity;
- an invalid binding ID;
- unsafe or negative source generations and sample sequences;
- an unsupported phase such as `preparing`;
- an invalid participant ID;
- non-finite or negative observed positions and timestamps.

The message contains coordination evidence only. `bindingId` is an opaque worker-issued document/player identity, not a credential.

## 4. Extension player state machine

### Operation identity and stale-work cancellation

The content script keys local transaction state by `mediaEpoch:operationId`. It tracks a separate scheduled-start timer, play-attempt key, play-resolution key, prepared key, started key and acknowledgement-in-flight key. A new operation clears all of these markers. `invalidateRoomOperations()` now also clears both legacy and transactional scheduled play work, retires the current play request and clears transaction attempt state.

This means a timer created for one operation cannot start a superseding operation, and a late promise callback cannot acknowledge a newer media or operation identity.

### Preparation

For `preparing` and `prepared` operation snapshots, the content script:

1. cancels the legacy scheduled play timer;
2. pauses a currently playing local video with an expected programmatic pause marker;
3. checks that the selected player has at least `HAVE_CURRENT_DATA`;
4. rejects a still-seeking, locally-seeking or pending native seek state;
5. uses the existing seek-alignment tolerance to verify the operation target;
6. requests the native position only when alignment is not yet available;
7. sends `prepared` only for the current operation after the player is locally aligned.

The acknowledgement includes the current worker binding, the current `PlayerOperations` source generation, a monotonically increasing content-script sample sequence, the extension participant identity and the observed native position.

### Commit and scheduled play

When the coordinator changes the operation to `committed`, the content script uses `effectiveAtServerMs` plus the worker's estimated server offset. Before the effective time it keeps the player paused, confirms the target position and schedules a bounded timer. The timer is capped to one second so a backgrounded or delayed browser re-evaluates the current room snapshot rather than trusting an old delay.

The coordinator now uses two timing stages rather than one deadline for the entire transaction:

- the original short barrier bounds preparation;
- after commit, a bounded start-evidence window is derived from the player startup grace and progress-stall interval.

The room's progress watchdog also waits until startup grace has elapsed for each participant that is still awaiting a transactional `started` acknowledgement. This prevents a legitimate browser startup from being classified as a stall before CR-B03 can observe real progress. Once a participant has started, ordinary progress watchdog behavior resumes.

After the effective time:

- a pending seek or missing target preparation keeps the player paused and retries the current target;
- a paused player starts through the existing `requestVideoPlay()` operation guard;
- a player that is already in the current play attempt is not re-seeked merely because the playback clock has advanced beyond the original operation target;
- a paused seek with `resumeWhenReady: false` aligns and remains paused without sending a started acknowledgement.

### Started evidence

`requestVideoPlay()` success now marks only that the current play request resolved. It does not acknowledge started. The content script waits for all of the following:

- the operation key is still current;
- the play attempt belongs to that operation;
- the video is not paused or seeking;
- no local seek operation is pending;
- `playerHealth.hasRealPlaybackProgress` is true.

The existing player-health observer requires actual clock or rendered-frame progress after the playback startup grace. This prevents a pending promise, a provider's optimistic play event, a stuck frame, or `paused=false` without movement from becoming a false started acknowledgement.

### Direct gesture recovery

If a browser rejects the extension-initiated `play()` with `NotAllowedError`, the failed transaction attempt is cleared. A later native `play` event for a currently committed operation is treated as the current direct gesture attempt. It still must pass the same real-progress gate before the content script sends `started`. The extension pill uses the same guarded path when its playback button is clicked.

## 5. Backend dispatch and coordinator validation

The room service and Durable Object now handle `operation_ack` immediately after the legacy `seek_applied` path:

1. the backend obtains the participant ID from the authenticated socket or Durable Object attachment;
2. it passes that ID and the parsed acknowledgement to `acknowledgeOperation()`;
3. the coordinator checks the negotiated transactional mode, current operation identity, sender/claimed participant equality, stored capabilities, connection, readiness, media match, fixed quorum membership, binding/source-generation continuity, sample monotonicity, target alignment and effective time;
4. only a successful coordinator result is broadcast as a room snapshot;
5. the Durable Object persists and reschedules its next deadline after a successful result.

The backend never authorizes an acknowledgement from the payload's participant ID alone. A stale or malformed message is ignored by the coordinator path and cannot revive a cancelled, failed, superseded or cross-media operation.

## 6. Security and privacy review

- Sender identity is taken from the authenticated WebSocket client record or Durable Object attachment, not from the JSON payload.
- The content script must possess the current worker-issued binding ID before it can send a valid acknowledgement. A stale same-frame document is rejected by the service worker.
- Source generation and sample sequence are scoped to the current player lifecycle and are checked by the coordinator for continuity and monotonicity.
- The fixed participant set remains a coordinator property. CR-B03 does not shrink it when a participant fails to prepare or start.
- The operation and observation IDs are coordination values only. They are not credentials and are not exposed as secrets.
- No new persistent user data is collected beyond the existing bounded diagnostics event fields for operation ID, phase, source generation and sample sequence. No media bytes or provider credentials are stored.
- Legacy peers cannot acknowledge a transactional operation because capability negotiation remains fail-closed.
- The code does not infer Crunchyroll account state. A signed-in account can be used for the separate headed provider gate, but source and local fixture tests do not claim that gate passed.

## 7. Verification performed so far

### Type and focused deterministic checks

```text
npm run typecheck
PASS
```

```text
npm test -- --run apps/extension/src/content-script.test.ts
PASS, 1 file, 58 tests
```

The new content-script scenario verifies:

- current binding acquisition;
- `prepared` emission for the current operation;
- no `started` acknowledgement immediately after the play promise resolves;
- no `started` acknowledgement while the operation has only `paused=false` and no real progress;
- `started` emission only after post-startup frame progress;
- operation and binding identity on the emitted acknowledgement.

```text
npm test -- --run apps/extension/src/service-worker.test.ts packages/protocol/src/index.test.ts
PASS, 2 files, 39 tests
```

These tests cover strict parser validation, capability compatibility, stale document rejection, current binding forwarding and capability-bearing reconnect messages.

```text
npm test -- --run apps/room-service/src/server.test.ts
PASS, 1 file, 13 tests
```

The new WebSocket test covers two capability-bearing clients, pending join approval, readiness, transactional play creation, both prepared acknowledgements, coordinator commit, both started acknowledgements and the final `started` operation snapshot.

### Intermediate failure found and corrected during host-level verification

The first host-level two-profile run exposed this real failure:

```text
Playback did not advance media time and presented frames:
{"currentTime":11.012,"paused":true,"seeking":false,"readyState":4}
```

The failure was not caused by a missing Crunchyroll account. The clean runtime-state capture showed a transactional seek with `phase: failed`, `reason: start-timeout`, `startedParticipantIds: []`, and both participants prepared. The investigation found three related timing/state bugs:

1. The operation reused the 1.8-second preparation deadline after commit, before the extension's startup grace and real-progress observation could complete.
2. The coordinator's normal 1.8-second progress-stall watchdog ran during transactional startup, before the extension was allowed to report real progress.
3. A superseding seek calculated `resumeWhenReady` after `cancelOperation()` had already paused the previous operation, recording `false` even when the room had been playing.

The fixes are now covered by `room.test.ts` and the clean browser smoke. The exact temporary service-worker state getter and E2E debug wrappers used for diagnosis were removed before final verification.

### Final verification completed on the branch

The final verification was rerun after all three coordinator corrections, with temporary debugging removed:

```text
npm run check
PASS
typecheck: PASS
Vitest: 30 files, 274 tests passed
room-service bundle: PASS
extension build: PASS
```

```text
npm run verify:browser-packages
PASS with approved host filesystem access
Chrome: manifest 0.2.4, serviceWorker service-worker.js
Firefox: manifest 0.2.4, sidebar sidepanel.html
Safari: macOS package smoke PASS
```

The restricted attempt of the browser-package command still fails at the macOS Safari converter because the converter cannot access its temporary staging directory. The approved host rerun passed all three package checks. This is an environment permission limitation, not a package-content failure.

```text
npm run test:e2e -- --grep "profile A creates a room"
PASS, 1 test, 16.7 seconds total, 8.7 seconds test execution
```

The clean local two-profile E2E now passes the transactional play and superseding-seek path. It remains local fixture evidence, not authenticated Crunchyroll provider evidence.

No authenticated Crunchyroll live-provider playback result is claimed for CR-B03. No Edge controlled-browser candidate reload, nested-frame provider matrix, deployment, or user-acceptance result is claimed here. No release claim is made. The package version remains `0.2.4`; `1.0.0` remains reserved for the end-of-milestone release gate.

## 8. Review and closure boundary

Before merging the PR, the remaining work is:

1. inspect the final diff, generated artifacts and security-sensitive boundaries;
2. commit and push the implementation, this report and the checkpoint;
3. open a fully documented PR with labels, assignee, milestone, public project fields and exact evidence links;
4. wait for and verify all remote checks;
5. perform the formal review before any merge decision;
6. merge only after the PR review and checks are complete;
7. keep issue #57 open until the issue acceptance gates, live-provider gates where applicable, deployment and user acceptance are separately evidenced.

The report does not authorize issue closure, release creation or `1.0.0`. It records the CR-B03 implementation and its evidence boundaries so later work does not repeat or silently upgrade an unverified result.
