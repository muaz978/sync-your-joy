# CR-B02 coordinator prepare and commit transaction report

Issue: [#56](https://github.com/muaz978/sync-your-joy/issues/56)
Depends on: [CR-B01 / #55](https://github.com/muaz978/sync-your-joy/issues/55)
Scope: coordinator and backend persistence/scheduling only
Status when written (historical): implementation and repository verification complete locally; review, merge, release and issue-closure decisions remain separate gates. Merged as PR #84 and shipped in v0.2.5; #56 stays open. The statements in sections 1 to 6 that the extension service worker does not advertise `CURRENT_CLIENT_CAPABILITIES` and that no wire message for operation acknowledgements exists describe the original change only: CR-B03 (PR #85) added the `operation_ack` message, and the service worker now sends the capabilities on create, join and reconnect (`service-worker.ts`, three call sites). Section 8 is the post-merge update (against `main` at `257afb6`, extension 0.2.12) and supersedes section 7.

## 1. Problem and acceptance interpretation

The previous coordinator treated a ready participant as sufficient evidence for play and treated a seek acknowledgement as sufficient evidence that the player had reached the requested position. That left a gap between room intent and player state:

- a browser could be ready while its player was still seeking, loading, or unable to satisfy `play()`;
- play could be committed for one participant while another participant had not prepared the same position;
- a late acknowledgement from an old operation could be accepted after a newer room revision;
- a failed guest report could make the coordinator copy an arbitrary guest position into the authoritative room clock.

CR-B02 therefore implements the coordinator half of the CR-B01 contract:

1. Play and seek use a fixed required participant set in transactional mode.
2. Playback remains paused at the target while preparation is incomplete.
3. The coordinator commits once after all fixed participants prepare, schedules a start, and waits for observed-start acknowledgements for playing operations.
4. Failed startup, binding changes, deadlines, membership changes, control transfer and superseding controls cancel the old operation deterministically.
5. Recovery keeps a prepare/seek target, while steady-play recovery uses the coordinator's expected position instead of an arbitrary failed participant sample.
6. Missing or legacy capability advertisements continue to use the existing legacy path and cannot acknowledge a transactional operation.

This report does not claim CR-B03 extension application, live provider playback, deployment, or user acceptance. Those are downstream gates.

## 2. Baseline and affected files

The branch started from the verified `origin/main` merge for the CR-A02 acceptance documentation. The implementation changed:

| File | Change | Reason |
| --- | --- | --- |
| `packages/protocol/src/index.ts` | Permit partial preparation evidence during `preparing`; add optional `resumeWhenReady` operation semantics | The coordinator needs to represent an operation while one fixed participant is prepared and another is still pending, and must distinguish paused seeks from seeks that resume playback |
| `packages/protocol/src/index.test.ts` | Validate partial preparation and `resumeWhenReady` type safety | Prevents the protocol validator from rejecting valid intermediate coordinator state or accepting malformed state |
| `packages/sync-engine/src/room.ts` | Capability negotiation, persisted contract state, operation creation, preparation/start acknowledgements, fixed quorum, cancellation, deadlines, and clock-based recovery | Implements CR-B02 in the authoritative coordinator |
| `packages/sync-engine/src/room.test.ts` | Five focused CR-B02 scenarios and helper fixtures (22 tests in the CR-B02 describe at the time of the 2026-10-31 verification pass; 37 after the post-merge update in section 8) | Covers the coordinator state machine and persistence behavior |
| `apps/room-service/src/server.ts` | Forward create/join capabilities and expire transactional operations in the cleanup loop | Makes the in-memory backend preserve the negotiated contract and enforce deadlines |
| `apps/edge-service/src/worker.ts` | Forward create/join capabilities, persist/schedule transactional deadlines, and expire operations from the Durable Object alarm | Keeps the deployed backend behavior aligned with the in-memory backend |

The extension service worker did not advertise `CURRENT_CLIENT_CAPABILITIES` in this change. That was deliberate: until CR-B03 added the wire message and player-side prepare/start application, advertising support would have caused a room to wait for acknowledgements that the extension could not yet send. CR-B03 (PR #85) has since done both, and the service worker now advertises the capabilities on create, join and reconnect.

## 3. Coordinator state machine

### Capability admission

The coordinator stores each participant's normalized capability advertisement privately. The public participant snapshot excludes the advertisement and all player observation bookkeeping. Negotiation is fail-closed:

- all connected participants must advertise the current contract version and every transactional capability;
- one omitted, legacy, malformed or incomplete peer keeps the room in `legacy` mode;
- an operation cannot be acknowledged unless the authenticated participant's stored capabilities support the whole transactional contract.

### Operation creation

For transactional play and seek, the coordinator freezes the connected, ready, media-matching participant IDs at command time. It does not recompute the quorum from later readiness changes. A new operation contains:

- `mediaEpoch` and an opaque `operationId`;
- operation kind and `preparing` phase;
- fixed required, prepared and started participant lists;
- a fixed target position;
- optional `resumeWhenReady` for seek;
- no effective start time until the fixed set is prepared;
- a bounded deadline.

The playback snapshot is paused at the fixed target during preparation. A controller pause cancels the active operation and applies the requested paused position.

### Prepare and commit

`acknowledgeOperation()` authenticates the caller-supplied participant ID against the room sender identity supplied by the backend, then verifies operation identity, membership, readiness, media match, capability support, fixed quorum membership, binding identity, source generation and monotonic sample sequence.

Each valid prepare acknowledgement is idempotent. Duplicate evidence does not add a second participant. A lower source/sample sequence is rejected, and a binding/source-generation change cancels the operation with `binding-changed`.

When every fixed participant is prepared:

- the operation records a single scheduled effective time;
- play and resumed seek transition playback to scheduled `playing` state;
- paused seek remains at its fixed target and reaches a committed state without pretending that a player started;
- the coordinator waits for observed-start acknowledgements for operations that schedule playback.

When every required participant confirms its observed start, the operation reaches `started`. A start acknowledgement arriving before the scheduled time or outside the expected position is rejected.

### Cancellation and recovery matrix

| Event | Result | Target/clock policy |
| --- | --- | --- |
| superseding play/seek | old operation `cancelled`, reason `superseded` | new operation owns its own fixed target |
| controller pause | old operation `cancelled`, reason `controller-request` | explicit paused controller position wins |
| control transfer | old operation `cancelled`, reason `superseded` | old target is retained in paused playback |
| participant disconnect or membership change | old operation `cancelled`, reason `participant-disconnected` | fixed target is retained |
| participant becomes unready or mismatched | old operation `cancelled`, reason `participant-not-ready` | fixed target is retained |
| link navigation | old operation is cancelled, media epoch increments, active operation is cleared | new media starts paused at zero |
| binding/source change | old operation `cancelled`, reason `binding-changed` | fixed target is retained |
| deadline before commit | operation `failed`, reason `deadline-expired` | fixed target is retained and paused |
| deadline after commit/start | operation `failed`, reason `start-timeout` | fixed target is retained and paused |
| explicit `play()` rejection | operation `cancelled`, reason `start-rejected` | prepare/start target is retained; failing participant becomes unready |
| steady-play stall or silence | operation `cancelled`, reason `manual-recovery` | coordinator expected position is used, never the failed guest sample |

Late acknowledgements cannot revive a cancelled, failed, superseded, or cross-epoch operation.

## 4. Persistence and compatibility

`RoomCoordinatorState.contract` persists the normalized room contract and active operation. Existing state without this field is restored as paused-safe legacy state. Participant capability and observation fields are optional for migration, and are never broadcast in `RoomSnapshot.participants`.

The room service and Durable Object both forward optional create/join capability advertisements. The room service cleanup loop and Durable Object alarm both call the coordinator deadline method. This makes deadline enforcement independent of whether a scheduler callback is early or late, because the coordinator also checks the deadline at acknowledgement time.

No protocol wire message for operation acknowledgements is added in CR-B02. The coordinator API is ready for the CR-B03 server and extension message wiring. The existing `seek_applied` path and legacy behavior remain unchanged for clients without the new capability advertisement.

## 5. Security and privacy review

- Participant IDs in an acknowledgement are checked against the authenticated sender ID passed by the backend. A payload cannot authorize itself by naming another participant.
- Operation and observation IDs are coordination values, not credentials.
- The fixed quorum prevents a failed participant from being silently removed so that an old operation can resume with a smaller set.
- Media, session tokens, capabilities and player observation bookkeeping remain outside public participant snapshots.
- The state-only boundary is preserved. This change adds no provider API access, cookies, credentials, signed media URLs, DRM handling, screenshots, media bytes, or arbitrary page execution.
- A `paused: false` report, pending browser promise, mocked clock, or arbitrary player sample is not treated as proof of visible playback. Start evidence must match the current operation identity, accepted binding/source sequence and expected position.

## 6. Verification performed

### Focused checks

```text
npm test -- --run packages/protocol/src/index.test.ts packages/sync-engine/src/room.test.ts packages/sync-engine/src/room-streaming-regressions.test.ts
3 files passed, 86 tests passed
```

```text
npm test -- --run packages/protocol/src/index.test.ts packages/sync-engine/src/room.test.ts packages/sync-engine/src/room-streaming-regressions.test.ts packages/sync-engine/src/room.fuzz.test.ts apps/room-service/src/server.test.ts
5 files passed, 101 tests passed
```

### Repository checks

```text
npm run typecheck
passed, including the root TypeScript project and apps/edge-service/tsconfig.json
```

```text
npm test
30 files passed, 268 tests passed
```

The repository fuzz suite passed after the coordinator changes. Existing legacy room tests and streaming regressions remained green, which is the compatibility evidence for the fail-closed legacy path.

```text
npm run build
passed, including the room-service bundle and Chrome extension build at version 0.2.4
```

```text
npm run verify:browser-packages
host-level rerun passed:
  Chrome MV3 manifestVersion 0.2.4, service worker service-worker.js
  Firefox manifestVersion 0.2.4, sidebar sidepanel.html
  Safari macOS package smoke passed
```

The first browser-package attempt was run in the restricted runtime and failed inside Apple's Safari converter with `Unable to parse manifest.json` while it was denied access to its temporary input path. The exact command was rerun with host-level macOS access and passed. This is recorded as an environment limitation, not a source or package failure.

```text
npm run test:e2e -- --grep "profile A creates a room"
host-level rerun passed:
  1 test passed in 7.0s
  two isolated profiles, real unpacked extension, room service, local HTMLVideoElement playback, play/pause/seek/progress/convergence
```

The first E2E attempt in the restricted runtime aborted Playwright Chromium with `SIGABRT` and reported `EPERM` while cleaning up the process. The host-level rerun passed the same scenario. This smoke test exercises the current legacy extension path; it does not claim transactional CR-B03 browser acknowledgement behavior or authenticated Crunchyroll playback.

### Checks not claimed by this issue

- No live Crunchyroll/provider playback claim is made. The user account is available in the controlled browser, but this issue changes coordinator behavior and does not yet wire the extension acknowledgement path.
- No browser extension package or authenticated two-account test is claimed for CR-B02. That belongs to the downstream CR-B03 application slice and the separate CR-A02 headed acceptance gate.
- No deployment or user-acceptance claim is made.

## 7. Review and closure decision (historical, as written for PR #84)

The implementation is ready for source review if the branch remains clean after the final build/package checks and the PR metadata is applied. The PR must document this report, exact commands, evidence boundaries and unresolved downstream gates.

The issue must remain open until CR-B03 consumes the acknowledgement contract and the applicable browser, live-provider, deployment and user-acceptance gates are evidenced. This report is not authorization to close CR-B02 or to bump the release.

Superseded: PR #84 and CR-B03 (PR #85) are merged. The remaining closure conditions are in section 8.

## 8. Post-merge update (against `main` at `257afb6`, extension 0.2.12)

Evidence class for everything in this section: unit and protocol tests on synthetic fixtures. No browser, Crunchyroll, two-account, two-device, deployment or acceptance evidence is claimed. Per the owner's decision of 2026-10-31 those gates are carried by #30, #33, #34, #35 and #69, not by #56.

### Owner decisions that bound this card (2026-10-31)

- Criterion 3 (explicit recovery targets) applies to transactional rooms only. Legacy rooms are out of this card, so the legacy report path (a failing guest's sample) is neither tested nor changed here.
- A seek issued while a Play is still preparing resumes playback only if the room was playing when the seek was pressed. That is the current behavior and it is pinned (below).
- A partly started committed operation that is restored takes the pause fallback. It is pinned by a test; the repair is tracked on #60, and this change deliberately does not relax the validator that causes it (see "Partly started restore").

### Behavior pinned by committed tests

All in `packages/sync-engine/src/room.test.ts`, describe "CR-B02 coordinator prepare and commit transactions" > "what cancels, and what is ignored by, a transactional operation", unless noted:

| Behavior | Test |
| --- | --- |
| A controller pause cancels a `preparing`, a `committed` and a `started` operation with `controller-request`, applies the controller's position, clears the start time, and every later prepare or start acknowledgement is ignored without changing the room | "cancels a preparing / committed / started operation when the controller pauses ..." (3) |
| A required participant that is no longer ready cancels with `participant-not-ready` in the same three phases, and later acknowledgements are ignored | "cancels a preparing / committed / started operation with participant-not-ready ..." (3) |
| Moving to different media is the same cancel, with the same reason | "cancels with participant-not-ready, not another reason, when a required participant moves to different media" |
| An acknowledgement for the old media after a shared link is ignored (the link advances the epoch and clears the operation); a new Play on the new media is untouched by the old acknowledgements | "ignores an acknowledgement for the old media after a shared link opened ..." |
| An acknowledgement whose media epoch alone is wrong (right operation ID, valid binding, epoch lower or higher) is ignored and changes nothing; the right one is then accepted | "ignores an acknowledgement whose media epoch alone is wrong ..." |
| Preparation and start evidence from a connected, ready participant that is not in the frozen set is ignored, and it does not count towards the commit or the start | "ignores preparation and start evidence from a connected, ready participant that is not in the frozen set" |
| A seek during a Play that is still `preparing` leaves the room paused (`resumeWhenReady: false`); a seek during a committed Play resumes (`resumeWhenReady: true`) | describe "a seek issued while a Play is still preparing" (2) |
| A pre-contract pending seek restored in a room of capable peers becomes a clean transactional room (no seek, no operation, paused at the seek target) that accepts a new seek; the late acknowledgement of the old barrier is ignored | "migrates a pre-contract pending seek in a room of capable peers ..." |
| A binding or source-generation change, a lower sample sequence, a legacy peer approved mid-Play, and an acknowledgement for an already cancelled operation | PR #173 (the CR-B01 live-operation tests), not repeated here |

The two existing tests "migrates a pre-contract pending seek to a paused-safe state without reusing historical ACKs" and "migrates a partially written contract with a pending seek to the same paused-safe state" already covered the old restored pending seek in a legacy room (`migratePreContractState`), so no test was added for that case beyond the capable-peers variant above.

Note on the frozen set: no live flow puts a connected, ready participant outside the frozen set. A Play or seek is refused while anyone connected is not ready, and a join, a reconnect or an un-ready cancels the operation. The set check in `acknowledgeOperation()` is therefore reachable only from restored state, which is how its test builds the room.

### Partly started restore

A committed operation with some but not all start acknowledgements is a normal in-flight state, but `isRoomOperation()` accepts a `committed` operation only with an empty started list (a started list must be complete for `started`). A stored room in that state therefore fails `isRoomContractSnapshot()`, the operation is dropped, and the coordinator restores through `migratePreContractState()`: paused at the position the Play began from, with the operation gone and a late start acknowledgement ignored. Tests: "takes the pause fallback ..." (room) and "keeps the committed phase strict ..." (protocol). A fully prepared committed operation and a started one restore unchanged.

The agent task list for this card also proposed allowing a partial started list in `committed`. It was not done: the owner's decision above keeps the pause fallback for a restored partly started operation, and the validator is what produces it (relaxing it makes the restored room keep playing instead). If the owner later wants the operation restored, the change is one condition in `isRoomOperation()` and is additive for wire compatibility (the validator runs only on restore, never on a message). The mixed-version effect would be: a newer coordinator restores its own state with the operation intact; an older coordinator (the deployed one) restoring the same state still takes the pause fallback; `normalizeStoredContractState()` in the extension would have to change in step. That remains #60's decision.

### What this section does not cover

- The legacy path (a failing guest's sample for steady-play recovery) is out of this card by the owner's decision.
- Transport-level tests (a socket-level deadline test, a transactional variant of the fuzz harness) are recommended but not required by the card, and overlap #59 and #60.
- Mixed-version rooms on real builds, live Crunchyroll, two accounts, two devices, a deployed coordinator and user acceptance.

### Verification

```text
npm run typecheck                        clean (tsc --noEmit and the edge-service tsconfig)
npm test                                 50 files, 1053 tests passed (16 added by this update: 15 in room.test.ts, 1 in the protocol tests)
npx vitest run packages/protocol packages/sync-engine   3 runs: 11 files, 291 tests passed each time
```

Each new test was checked against a one-line scratch mutation of the production file and failed under it; the list is in the pull request.

### Closure decision

#56 stays open. What remains on the card itself: the repair of the partly started restore, which is #60's, and the owner's acceptance of the criteria as amended on 2026-10-31.
