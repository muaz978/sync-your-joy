# CR-B07 mixed-version and stored-state migration report

Status when written (historical): implementation complete on branch `codex/issue-61-mixed-version-migration`; PR and merge are intentionally separate gates. Update 2026-10-16: merged as PR #89 and shipped in v0.2.5; #61 stays open, and "Evidence limits and remaining gates" below still lists what this report does not establish.

Update 2026-11-15: the edge coordinator half of the retained-sample and mixed-version tests, a rollback analysis and the findings that writing them produced are in "Edge coordinator, retained samples and rollback" below; the package is at 0.2.12 and the statements below about it being at 0.2.4 are historical. #61 stays open.

Issue: [#61, CR-B07: Verify mixed versions and stored-state migration](https://github.com/muaz978/sync-your-joy/issues/61)

## Scope

CR-B07 verifies that current transactional operation semantics are activated only when every connected participant advertises the required contract, that old or incomplete persisted room state cannot become new transactional evidence after restart, and that the release smoke exercises the explicit controller and peer acknowledgement contract.

The protocol version remains `1`. This change uses the existing additive capability advertisement rather than silently changing the protocol version or assuming that a new client implies a new server.

## Source findings

Before this change:

- `packages/protocol/src/index.ts` already defined the operation contract version, required transactional capabilities, fail-closed negotiation, optional create/join advertisements, and legacy defaults.
- A missing or incompatible advertisement normalized to legacy mode, and `canAcknowledgeOperation()` rejected transactional acknowledgements in legacy mode.
- `RoomCoordinator.refreshNegotiation()` cancelled an active transactional operation when an incompatible peer appeared.
- `RoomCoordinatorState.contract` was optional for migration, but `pendingSeek` was restored independently. A pre-contract or partially written stored room could therefore retain a legacy seek barrier and its historical acknowledgement list after a cold restore.
- `scripts/smoke-room-service.mjs` omitted capability advertisements and exercised the legacy `seek_applied` path, so it did not prove the current transactional controller acknowledgement path.

## Implementation

### Explicit state version and safe migration

`RoomCoordinatorState` now emits `stateVersion: 2`. Older state remains readable because the field is optional on input.

When a restored state has no complete contract boundary, including a missing or malformed contract section, it is treated as pre-contract state:

1. The stored pending seek is validated but never restored as an active barrier.
2. The acknowledgement list is discarded, so a historical host acknowledgement cannot count as new preparation evidence.
3. Playback is forced to a paused state at the fixed pending-seek target, or at the stored playback position when no valid pending seek exists.
4. The revision and control barrier advance, preventing an old control context from being reused.
5. The normalized legacy contract is then refreshed against the connected participant advertisements.

A complete contract-aware current legacy room retains its valid legacy pending seek. This distinction avoids unnecessarily changing a room that was already written by the current contract-aware state machine while still migrating genuinely pre-contract or partially written state safely.

### Mixed-version policy

| Room composition | Negotiated mode | Transactional acknowledgement | Playback behavior |
| --- | --- | --- | --- |
| All current participants with the complete contract | `transactional` | Accepted only for the authenticated sender, current operation, current binding, current source generation and monotonic sample sequence | Prepare, commit and start barriers are active |
| Current participant plus an old or omitted advertisement | `legacy` | Ignored and never counted | Existing legacy controls remain available; no unsupported operation is created |
| Malformed or incomplete capability advertisement | `legacy` | Ignored and never counted | Fail-closed fallback with no implicit upgrade |
| Pre-contract persisted state | `legacy` after migration | Historical seek acknowledgement is discarded | Paused-safe state at the fixed target |

The coordinator does not shrink a transactional quorum to accommodate an old peer. A room must negotiate the complete capability set before operation acknowledgements can affect state.

### Release smoke

`scripts/smoke-room-service.mjs` now:

- advertises `CURRENT_CLIENT_CAPABILITIES` for both participants;
- proves the room enters transactional mode;
- sends prepared and started acknowledgements from the controller and the peer;
- verifies a transactional seek reaches `started` at the fixed target;
- verifies an incomplete preparation expires into a failed, paused operation;
- verifies rapid pause and transactional play recovery;
- retains diagnostics routing and buffering safeguards.

The smoke remains state-only. It does not download media, access provider credentials, or inspect DRM or signed playback data.

## Tests and verification

Baseline before CR-B07 changes:

- `npm run check`: 31 test files, 287 tests passed, typecheck and builds passed.

Final local evidence:

- `npx vitest run apps/room-service/src/server.test.ts packages/sync-engine/src/room.test.ts packages/protocol/src/index.test.ts`: 3 files, 97 tests passed.
- `node --check scripts/smoke-room-service.mjs`: passed.
- `npm run typecheck`: passed.
- `npm run check`: 31 test files, 292 tests passed, typecheck and builds passed.
- `npm run smoke:edge -- ws://127.0.0.1:8787/rooms` against a local room service: passed with `transactionalContractVerified: true`, both diagnostics participants, fixed seek position `137`, timeout rollback, and buffering safeguards.
- `npx wrangler deploy --config apps/edge-service/wrangler.jsonc --dry-run`: passed, recognized `env.ROOMS (RoomDurableObject)`, 83.93 KiB upload and 16.33 KiB gzip. No remote deployment occurred.
- `git diff --check`: passed.

## Edge coordinator, retained samples and rollback (added 2026-11-15)

Evidence class of this section: unit tests over a hand-written storage harness that drives the real `RoomDurableObject` class, plus one scratch run of the tagged v0.2.4 source. No older edge service was run, no workerd, no real Durable Object storage, no browser. The extension half of #61 (create, join and rejoin carrying the capabilities, no acknowledgement from a legacy or contract-less snapshot) and the room-service and coordinator tests are on other branches and are not part of this change.

### What was added

`apps/edge-service/src/worker.mixed-version.test.ts` (13 tests) and `apps/edge-service/src/pre-contract-records.fixture.ts` (retained samples).

| Case | Test |
| --- | --- |
| A host on the current contract with a guest that advertises nothing: the room is legacy, Play is `control_play` with no operation, an `operation_ack` changes nothing and announces nothing, a seek uses the barrier and `seek_applied` settles it | `a room with a client that advertises nothing stays legacy` (2) |
| A live, genuinely issued Play and a legacy client approved into the room: the operation is cancelled, the room is legacy, the members were told, what they were told was saved, and acknowledgements of that operation's id (prepared by both, started by the host) change nothing | `a legacy client during a live operation` (first test) |
| The same when an existing member comes back on an older client that advertises nothing | same describe (second test) |
| The room stays legacy after the legacy client has left, until a member joins or comes back (current behaviour, see findings) | same describe (third test) |
| A stored record that carries a live operation for a member with no capabilities restores cancelled with reason `legacy-peer` and is saved that way | same describe (fourth test) |
| Four retained v0.2.4 records (playing; seek barrier while paused; seek barrier that was to resume playing; a waiting request) restored through the Durable Object | `stored rooms written before the contract existed (v0.2.4 samples)` (7 tests, with a test that the samples have none of the contract-era fields) |
| Old records and a current client: the friend comes back on a current client and the room stays legacy while the host's record has no capabilities; once the host also comes back on a current client the room is transactional and the change is saved | last test of that describe |
| Rollback round trip: the record the v0.2.4 coordinator wrote after it read a current room with a committed Play restores paused at the Play's target, with no operation, one revision on, transactional again for members that advertise it, and a new Play is a new operation | roll-forward test of that describe |

What is asserted for the four old records: the restored room is paused (a playing room at the position it had, a seek barrier at the seek target, also when the barrier was to resume playback), the old barrier and its acknowledgement list are gone, a late `seek_applied` for the old revision from either member changes nothing and announces nothing, the revision is one higher, the contract is legacy with no operation, the room is saved with `stateVersion: 2`, and the only alarm is the six-hour lifetime limit. For the playing record, health evidence is restored as it was and none is added.

### Retained samples

The v0.2.4 records were produced by extracting the tag with `git archive v0.2.4 packages` and running its `RoomCoordinator` with a fixed clock; they are kept literally in the fixture file and must not be regenerated from current code. Their provenance is written at the top of that file. They are what that release's code exports, not records read from a deployed Durable Object, and the v0.2.4 `StoredRoom` wrapper (`pendingController`, `emptySinceMs`, `createdAtMs`) was taken from the tag's `worker.ts`. The scratch scripts that produced them are not in the repository, because the old source is not kept in it.

### Rollback, analysed by running the old code (v0.2.4 reading a current record)

A record written by the current code (0.2.12, `stateVersion: 2`) was restored and re-exported by the v0.2.4 coordinator, then read again by the current code. The run was done three times, for a transactional room with a preparing Play, a transactional room with a committed Play (playing), and a contract-aware legacy room in the middle of a seek barrier.

- The v0.2.4 coordinator reads a current record without error. It ignores `contract`, `stateVersion` and `disconnectGrace`, restores the playback state as stored, and produces snapshots with no `contract` field.
- What it writes back has none of those three fields and keeps each participant's `capabilities` (an unknown field that its export copies).
- The current code then reads that as a pre-contract record and migrates it (the path tested above): the room comes back paused. The preparing Play is dropped (the room was paused at its target), the committed Play is dropped (a room that was playing is now paused at the Play's target, 20 s in the sample, and not advanced), a legacy seek barrier is dropped (paused at its target, 90 s). The revision rises by one for each step and mode is renegotiated from the retained capabilities (transactional where both members advertise it).
- So a rollback to the last pre-contract release and a roll forward again ends paused with no operation and no stale barrier. It does not resurrect an operation, a barrier or an acknowledgement. What a member sees while the old code is serving is not analysed here (the old server sends no contract section, and how a current extension reads that is the extension half of #61).
- Releases between v0.2.4 and the current one that already write the contract (v0.2.5 onward) were not run: the analysis above is for the last release that did not write it. A rollback target that wrote the contract reads the record as current.
- A rollback does not take effect at once: a room that is active keeps the previous code for about five minutes after a deploy or a rollback (`docs/RELEASING.md` and `DURABLE_OBJECT_RUNTIME_OBSERVATIONS_2026-10-15.md`). That was observed on a throwaway Worker and is not repeated here.

The room-state step that `docs/RELEASING.md` should carry for a rollback across the contract boundary (rooms come back paused with no operation; nothing is lost that was not already transient; confirm that members reconnect and press Play) is not written, because that file is outside this change. It is listed as follow-up.

### Findings from writing these tests

1. **A legacy joiner during a live operation does not cancel it as `legacy-peer`.** The 2026-10-31 verification pass named `legacy-peer` for this. In the coordinator a join (approval, or a return) pauses the room for the membership change first, and that cancels the operation with reason `participant-disconnected`; by the time negotiation runs the operation is already cancelled, so the `legacy-peer` branch of `refreshNegotiation()` does not fire. It fires when a record is restored with a live operation and a member without capabilities (the fourth test above). Both are pinned. The reason string appears in `contract.operation.reason` on the wire; whether a client treats it differently was not checked.
2. **Mode is not renegotiated when a member leaves.** After the legacy client leaves, the room stays `legacy` (and a new Play is `control_play`, not an operation) until a member joins, comes back, or the room is restored. This fails closed. It is pinned as current behaviour; whether a leave should renegotiate is an open question for the owner. The code is `disconnectCore()` in `packages/sync-engine/src/room.ts`, which is outside this change.
3. **The mode check in `acknowledgeOperation()` is not observable at this level.** Removing `this.contract.mode !== 'transactional'` fails no test, because a room that has become legacy has already cancelled its operation, and an acknowledgement for a cancelled operation is refused anyway. A live operation in a legacy room cannot be built: a stored record that says legacy has its operation dropped on restore. The guard is defence in depth.
4. **`stateVersion` is written and never read** (unchanged). The 2026-10-31 verification comment proposed that it stay informational; no owner decision on it is recorded, so it is left as it is.
5. **A restore that migrates a record is announced to nobody** (the same finding as in section 6A of `CR_B06_EDGE_HEALTH_REHYDRATION_REPORT.md`): members that kept their socket are not told the room is now paused until the next broadcast. It is not asserted in this change.

### Mutation checks

Each is a one-line scratch edit of a production file, `worker.mixed-version.test.ts` run, file restored with `git checkout`.

| Scratch edit | Result |
| --- | --- |
| Pre-contract migration keeps the playback status | killed (2 tests) |
| Pre-contract migration ignores the pending-seek target | survived: in every real v0.2.4 record the playback position already equals the seek target, so it does not matter for these samples |
| The old barrier is kept after migration | killed (2) |
| Pre-contract migration does not advance the revision | killed (4) |
| Negotiation does not cancel for a legacy peer | killed (1, the stored-record case) |
| Membership change does not cancel the operation | killed (2, the two join cases) |
| `acknowledgeOperation()` ignores the room mode | survived (finding 3) |
| Negotiation reads only the controller's capabilities | killed (6) |
| `worker.ts` drops the capabilities of a `join_room` | killed (5) |
| `acknowledgeSeek()` accepts a stale revision | survived: the barrier is dropped at restore, so there is nothing to acknowledge |

### Verification of this change

```text
npx vitest run apps/edge-service        (three consecutive runs, each)
3 test files passed, 118 tests passed   (105 before: 118 - 13 new)

npm run typecheck                        clean
npm test                                 51 files, 1050 tests passed
```

No Wrangler dry run, deployment or smoke run was made: this change adds tests, a fixture module and a document, no product code.

## Security and privacy boundary

- Protocol and operation identifiers are coordination data, not credentials.
- Capability negotiation is fail-closed. Missing, old, malformed or incomplete peers cannot be treated as transactional participants.
- Persisted state migration does not recover or expose provider material.
- No media bytes, screen capture, cookies, credentials, signed URLs, DRM keys or private provider APIs were accessed or stored.

## Evidence limits and remaining gates

This report establishes source, deterministic coordinator, local transport, smoke and edge dry-run evidence. It does not establish:

- remote staging execution after deployment;
- authenticated live Crunchyroll playback or visible output;
- two separate user accounts on two physical devices;
- installation and browser acceptance;
- final user acceptance;
- release qualification or version bump.

Updated 2026-11-15:

- Still not established: a staging or throwaway-Worker run, a mixed-version or rollback rehearsal on the real Durable Object runtime, a second-person schema review, installed older and newer builds together, authenticated Crunchyroll, two devices and user acceptance. The provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69 and are not required on this card (owner decision of 2026-10-31); a staging or throwaway-Worker rehearsal is not waived by a recorded decision.
- Not done here: the extension tests (capabilities on create, join and rejoin, no acknowledgement from a legacy or contract-less snapshot), the retained samples at `service-worker`, `content-script`, `room.test.ts` and room-service level, the room-state step in `docs/RELEASING.md`, any change to `stateVersion` handling, a visible legacy signal, and the open questions in the findings above.
- The package version is 0.2.12; this change did not alter it. Release `1.0.0` remains reserved for complete milestone acceptance.
