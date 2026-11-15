# CR-B03 extension prepare and started acknowledgement report

Issue: [#57](https://github.com/muaz978/sync-your-joy/issues/57)
Dependencies: [#55 / CR-B01](https://github.com/muaz978/sync-your-joy/issues/55), [#56 / CR-B02](https://github.com/muaz978/sync-your-joy/issues/56)
Scope: extension capability advertisement, player-side preparation, current-play-attempt tracking, started evidence, operation acknowledgement transport, and backend wire dispatch
Status when written (historical): implementation and final branch verification complete; PR review, PR metadata, merge and issue-closure gates remain separate. Update 2026-10-16: merged as PR #85 and shipped in v0.2.5, so section 8 is the pre-merge snapshot (historical), including the package still at 0.2.4 and no release claimed. Section 7 was replaced on 2026-11-15 with the verification record on the one base named in that section (`main` at `8d8bf2a` with the CR-A06 change merged, merge commit `c68e81b`) and only its last paragraph is historical; #57 stays open for acceptance evidence.

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
- a paused seek with `resumeWhenReady: false` aligns and remains paused without sending a started acknowledgement. The coordinator treats it as settled at `committed`, clears it when its window closes, and the player stops applying it as a live operation; see [the prepare stall analysis](CRUNCHYROLL_PREPARE_STALL_ANALYSIS.md).

### Started evidence

`requestVideoPlay()` success now marks only that the current play request resolved. It does not acknowledge started. The content script waits for all of the following:

- the operation key is still current;
- the play attempt belongs to that operation;
- the video is not paused or seeking;
- no local seek operation is pending;
- `playerHealth.hasRenderedFrameProgress` is true: a frame counter (the `requestVideoFrameCallback` count where the browser has it, otherwise the playback-quality count while the page is visible) advanced for this source and command.

Update 2026-11-15: this gate originally read `hasRealPlaybackProgress`, which is also true for progress that only the media clock shows. By the owner decision of 2026-10-31 on #53 (the same answer applies to #57), clock-only progress does not send `started`; rendered-frame evidence is required. A player with no frame counter, or in a tab that stays hidden through the deadline, therefore does not send `started`, and the coordinator ends that start at its deadline. A tab that becomes visible before the deadline can send `started` once frames advance. Frames presented during the startup grace still count. This prevents a pending promise, a provider's optimistic play event, a stuck frame, `paused=false` without movement, or a running media clock alone from becoming a false started acknowledgement.

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

## 7. Verification

Section 7 was written before the merge of PR #85 and described a package at 0.2.4. It is replaced by the record below, which was taken on one base, `main` at `8d8bf2a` (extension 0.2.12) with the CR-A06 change (head `6950648` of `issue-53-health-evidence`) merged in, the merge commit `c68e81b33cece5a864705f5b02ac0f7695cfcc86`. The final test run executed on exactly that commit; the commit that adds this revision changes documentation only. The historical pre-merge record is kept at the end of this section in one paragraph.

### Current deterministic evidence (unit level, a fake video element)

All of it is `apps/extension/src/content-script.test.ts` with Vitest fake timers; none of it ran in a browser. The block "a transactional play through the extension (CR-B03, #57)" covers:

| Contract | Test |
| --- | --- |
| No `prepared` while the local media is not the room's; sent once it matches | "sends no prepared acknowledgement while the local media is not the room's, and sends it once the page matches" |
| No acknowledgement without a worker binding | "sends no prepared acknowledgement before the page has a binding from the worker" |
| A refused acknowledgement is asked again on the next evaluation (about once a second, until the deadline), and not once accepted | "asks again on the next evaluation when the worker did not accept the acknowledgement, and stops once it has" |
| A refused `play()` then a native `play` event: no `started` until real progress, then exactly one | "sends started once, only after real progress, when the person then starts the player themselves" |
| While the browser keeps refusing, the extension asks again at most once a second and stops when the room ends the operation | "asks the browser again at most once a second while the operation stays committed, and stops when the room ends it" |
| A `play()` that never settles never produces `started`, including after the ten-second deadline and a late settlement | "a play() that never settles" (two tests) |
| A future `effectiveAtServerMs` is not started early, and is not started at the old time after a pause, a newer operation, a source change to a source with no data, or leaving the room | "a scheduled start that the room cancels before its time" (five tests) |
| The late result of an old `play()` sends nothing after a newer operation, a pause or leaving the room | "the result of a play() that an operation no longer owns" (three tests) |
| `started` rests on frames: frames during the startup grace count; a hidden tab waits until the page is visible and frames advance | "what the started acknowledgement may rest on" (two tests) |

From the pull request for #53, which this change builds on: clock-only progress sends no `started` (owner decision of 2026-10-31); frame-callback progress alone does send it once; a hidden tab sends none. Those tests are in the block "player health evidence in the content script (CR-A06, #53)".

Mutation checks (a production line edited in place, the file run, the file restored): 12 mutations, 9 killed. Killed: acknowledgement without a binding, a page that does not match the room, a refused acknowledgement recorded as accepted, a native play event not taken as the current attempt, `started` without an accepted attempt, the effective time ignored, the play deadline not enforced, frames in the startup grace not kept, and a refused attempt never cleared (after a lower bound was added to its test; with only an upper bound it survived). Survived: a new operation keeping the old keys and a play result attributed to whichever operation is current (every comparison is by key equality, so these sequences cannot tell them apart), and a room exit not retiring the pending play (no acknowledgement is possible without a snapshot, so nothing observable differs).

### Commands run, and their results

Run on 2026-11-15 on one base, `main` at `8d8bf2a` (extension 0.2.12) with the CR-A06 change (head `6950648` of `issue-53-health-evidence`) merged in, the merge commit `c68e81b33cece5a864705f5b02ac0f7695cfcc86`. The runs below executed on exactly that commit, with a clean working tree; the following commit changes documentation only, and the test file has not changed since commit `b1e0e85`.

```text
npm run typecheck                                              clean
npm test                                                       Test Files 51 passed, Tests 1164 passed
npx vitest run apps/extension/src/content-script.test.ts  x3   Tests 182 passed (each run)
```

No browser, `npm run build`, `npm audit` or package smoke was run for this revision.

### Not covered by this revision

- `service-worker.test.ts`: the capabilities on `create_room`, `join_room` and the reconnect `join_room`; and `worker.test.ts`: a wrong-participant or rejected `operation_ack` producing no broadcast. Both files are outside this change.
- `tests/e2e/two-profile-sync.spec.ts` asserting that a Play reaches phase `started`: needs a working browser.
- Real default autoplay in fresh Chrome and Edge profiles, live Crunchyroll, nested frames, two-account, two-device and deployment runs: carried by #30, #33, #34, #35 and #69 (owner decision of 2026-10-31).
- A rejected acknowledgement at the coordinator: it gets no reply; the content script asks again on its next evaluation, which the coordinator accepts or ignores. A reply or retry protocol is a protocol change and has no owner decision.
- A partly started committed operation restored on the edge service takes the pause fallback (owner decision of 2026-10-31, tracked on #60). That is a coordinator behaviour and is not tested here.

### Historical record before the merge of PR #85

At the pre-merge checkpoint the branch passed `npm run check` with 30 test files and 274 tests, `npm run verify:browser-packages` (Chrome, Firefox and Safari package smoke, version 0.2.4) and one local two-profile test (`profile A creates a room`), on a synthetic fixture. A first host-level two-profile run exposed three coordinator timing defects (a shared 1.8 s deadline after commit, the stall watchdog running during startup, and a superseding seek losing its resume intent), which were corrected in `packages/sync-engine/src/room.ts` and covered in `room.test.ts`. No live-provider, deployment or user-acceptance result was claimed then, and none is claimed now.

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
