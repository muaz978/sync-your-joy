# CR-B01 operation identity and compatibility contract

Issue: [#55](https://github.com/muaz978/sync-your-joy/issues/55)
Purpose: define the shared contract required by CR-B02 coordinator transactions and CR-B03 extension application.
Status: the contract (PR #82), the coordinator that consumes it (CR-B02, PR #84) and the extension that applies it (CR-B03, PR #85) are merged and shipped in the 0.2.5 and later releases. This document was refreshed against `main` at `257afb6` (extension 0.2.12) for the media-epoch bound, the live-operation tests and the reason-code table below. The evidence in this document is unit and protocol tests only. No browser, Crunchyroll, two-account, two-device, deployment or user-acceptance run is claimed; per the owner's decision of 2026-10-31 those gates are carried by #30, #33, #34, #35 and #69 and not by #55. #55 stays open.

## Scope and decision

CR-B01 defines the data and admission rules for prepare/commit/start transactions. The transactions themselves are CR-B02 (the coordinator, `packages/sync-engine/src/room.ts`) and CR-B03 (the extension); both depend on this schema and are described in their own reports. This document covers the shared contract and the places where the coordinator enforces it.

The contract keeps four identities separate:

| Identity | Meaning | What it does not mean |
| --- | --- | --- |
| `roomRevision` | Monotonic ordering of room snapshots, including membership and status changes | Proof that a player operation is still current |
| `mediaEpoch` | Room-wide content/timed-edition generation; increments when selected media changes | A source-node or browser-document identity |
| `operationId` | Opaque identity of one play, seek, navigation or recovery operation | Authorization or a substitute for controller/lease validation |
| `bindingId` plus `sourceGeneration` and `sampleSequence` | Evidence from the worker's accepted document/player binding and its local source incarnation | Proof that an arbitrary page sender is trusted |

An operation is current only when its `mediaEpoch` and `operationId` match the coordinator's active operation. A newer snapshot revision alone does not cancel a valid operation, and an old operation cannot become valid merely because its acknowledgement arrives in a newer snapshot.

## Contract fields and bounds

The shared definitions live in `packages/protocol/src/index.ts`.

- `OPERATION_CONTRACT_VERSION` is separate from `PROTOCOL_VERSION`.
- A room may require no more than `MAX_OPERATION_PARTICIPANTS` (10) fixed participants.
- Capabilities are a de-duplicated list bounded by `MAX_CAPABILITIES` (16).
- Operation, participant and binding identifiers use the existing bounded opaque-ID grammar, 6 to 80 ASCII letters, digits, `_` or `-`.
- Media epochs, source generations and sample sequences are non-negative safe integers. The media epoch is bounded by `MAX_MEDIA_EPOCH` (`Number.MAX_SAFE_INTEGER`) in operation identity, acknowledgements, stored contract state and diagnostic reports. Before this refresh it was checked only as an integer, so `1e300` parsed and a stored `2 ** 53` was accepted although it could never advance.
- Positions and timestamps must be finite and non-negative.
- Operation phases are `preparing`, `prepared`, `committed`, `started`, `cancelled` and `failed`.
- Terminal phases require one bounded reason code. The reason vocabulary distinguishes supersession, deadline expiry, membership/media/binding invalidation, startup failures, unsupported peers, stale operations and explicit recovery. The table "Reason codes" below says where the coordinator assigns each one.
- `requiredParticipantIds` is fixed for the operation. Prepared and started sets must contain unique members of that fixed set and cannot be silently recomputed from current readiness.

`OperationAcknowledgement` carries the operation identity, participant identity, binding identity, source generation, sample sequence, observed position and local observation time. The participant identity is still taken from the authenticated room socket by the eventual coordinator implementation; the payload field is evidence, not authorization.

## Capability and room-mode policy

The transactional mode requires all of these capabilities:

- `media-epoch`
- `operation-identity`
- `prepare-start`
- `binding-sequence`

`negotiateRoomMode()` is fail-closed. If any peer is absent, advertises contract version `0`, advertises an unknown capability, duplicates capability data, or lacks any required capability, the negotiation result is `legacy` with the peer listed as incompatible. `canAcknowledgeOperation()` returns false in legacy mode. This prevents a legacy or unsupported peer from being counted as an implicit prepare/start acknowledgement and prevents a room from silently downgrading an active operation.

The existing create/join messages accept an optional capabilities advertisement so old clients remain parseable. Omission is not treated as support: `normalizeClientCapabilities()` turns an omitted or unknown advertisement into `LEGACY_CLIENT_CAPABILITIES`, and the coordinator (`refreshNegotiation()` in `room.ts`) keeps the room in legacy mode while any connected peer lacks a capability.

### A peer without the capabilities while an operation is live

A room that is `transactional` falls back to `legacy` the moment a connected peer lacks a capability. An operation that is still live at that point is cancelled, never carried over. Three paths reach this, and the recorded reason differs:

| Path | Reason on the cancelled operation | Position the room pauses at |
| --- | --- | --- |
| The controller approves a join request from a peer without the capabilities | `participant-disconnected` (the approval first runs the membership-change cancel, which uses its default reason) | the target while the operation had not started; where the room has got to once a start was confirmed |
| A connected participant returns inside the disconnect grace with fewer capabilities (an older extension, for example) while the Play is running | `legacy-peer` | where the room has got to (a started Play) |
| A stored room is restored with an operation in flight and a connected participant without capabilities | `legacy-peer` | the target before a start was confirmed, where the room has got to after one |

After any of the three the room is `legacy`, `sharedCapabilities` is empty, and `acknowledgeOperation()` ignores every acknowledgement (it returns `null` and changes nothing). `legacy-peer` is therefore only recorded when the operation is still live when negotiation runs; a join approval cancels first and so records the membership reason. The mismatch in the first row is recorded here and pinned by a test; it is not changed by this issue.

## Media epoch limit

The media epoch advances by one whenever a shared link changes the selected media. At `MAX_MEDIA_EPOCH` it cannot advance, and reusing it would let an acknowledgement for the old media pass for the new one. `openLink()` therefore refuses a link that would change the media with the failure code `media_epoch_exhausted` before anything changes: the room, its revision, its media and everyone's readiness stay as they were, and the action is not remembered, so a repeat is refused in the same way. A link to the page the room is already on is still `navigation_unchanged`. `media_epoch_exhausted` is a plain string code in `command_rejected`; an older extension shows the message and takes no other action, so the response needs no new capability, contract version or enum value. The limit is unreachable by counting (2^53 - 1 links); it is reachable only from stored state, and a stored epoch beyond the safe range is restored as epoch `0`, paused, like any other malformed contract section.

## Reason codes

| Reason | Assigned by the coordinator when | Notes |
| --- | --- | --- |
| `controller-request` | the controller pauses | |
| `superseded` | a new Play or seek replaces the operation, or control moves to another participant | |
| `deadline-expired` | the preparation window closes before everyone prepared | |
| `start-timeout` | the start window closes after the commit, or a player never starts | |
| `participant-not-ready` | a required participant becomes not ready or moves to other media | |
| `participant-disconnected` | a participant leaves or is not back inside the grace, the controller is recovered, or a join is approved | also the reason recorded for a join approval (see above) |
| `media-changed` | a shared link changes the media | the operation is cleared in the same step, so this reason is never visible in a snapshot |
| `binding-changed` | an acknowledgement for the live operation arrives from a different binding ID or source generation than the participant's earlier one | a lower source generation counts as a change, so the coordinator's later "older generation" comparison cannot fire |
| `start-rejected` | a required player reports that the browser rejected `play()` | |
| `manual-recovery` | a health check pauses a stalled or silent room | the name is historical; it is not a person's action |
| `legacy-peer` | negotiation falls back to legacy while the operation is live | see the table above |
| `unsupported-peer` | never | reserved, documented as unassigned |
| `stale-operation` | never | reserved, documented as unassigned |

Whether the two unassigned codes stay reserved, and whether unknown extra fields on operation messages are rejected or tolerated, are owner decisions that are not recorded; this document does not decide them. Today `parseOperationAcknowledgement()` returns the object it was given, so unknown extra fields on an acknowledgement are carried through to the coordinator, which ignores them. Diagnostic reports are the opposite by design: their unknown fields are relayed untouched so older coordinators stay compatible.

## Stored-state migration defaults

`normalizeRoomContractSnapshot()` and `normalizeStoredContractState()` provide the migration boundary for old state:

- missing or malformed contract state becomes `mode: legacy`;
- `mediaEpoch` defaults to `0`;
- there is no active operation;
- capabilities default to contract version `0` with an empty list;
- binding identity defaults to `null`;
- source generation and sample sequence default to `0`.

An invalid operation inside an otherwise transactional-looking record is discarded. A structurally valid operation is retained only when the normalized contract still has all transactional capabilities and the operation's `mediaEpoch` matches the room's `mediaEpoch`. This means an old pending seek, a cross-epoch operation or a partially written record cannot satisfy a new prepare/start transaction after restart. CR-B07 (PR #89) later added `stateVersion: 2` with the migration of pre-contract stored state and a release smoke that exercises the transactional contract, and records the mixed-version policy; see [the CR-B07 report](CR_B07_MIXED_VERSION_MIGRATION_REPORT.md).

## Verification performed for this issue

The focused protocol tests (`packages/protocol/src/index.test.ts`) cover:

1. operation identity remaining independent of snapshot revision;
2. fixed participant bounds, subset rules and required terminal reasons;
3. valid binding/source/sample acknowledgements and malformed or unsafe values;
4. all-new negotiation versus a mixed new/legacy room;
5. optional legacy create/join messages and rejection of unknown capabilities;
6. old, malformed and transactional-looking stored-state normalization;
7. the media epoch bound in acknowledgements, operation records, stored state and diagnostic reports (`MAX_SAFE_INTEGER` accepted; `2 ** 53`, `1e300`, fractions, negatives, `NaN`, strings and `null` rejected);
8. malformed operation, participant and binding IDs, every required acknowledgement field missing in turn, malformed or repeated participant IDs inside an operation record, and a stale but well-formed epoch (the parser accepts it; `isCurrentOperation()` rejects it).

The coordinator tests (`packages/sync-engine/src/room.test.ts`, describe "CR-B01 operation contract on a live room") cover the contract on a live room: the media epoch limit; a peer without the capabilities approved mid-Play, returning inside the grace, and restored; a changed binding ID, a changed or lower source generation, and a lower or repeated sample sequence; an acknowledgement for an already cancelled operation; and a join request raising the room revision while an operation is preparing (the operation stays valid and commits).

The extension-internal tests cover the same migration boundary through the state shape consumed by the service worker and content script. Note that `normalizeStoredContractState` in `apps/extension/src/internal.ts` still has no caller outside tests; wiring it into the service worker restore path, or deleting it, is a separate change in a file this change does not own.

### Not covered

- The legacy-peer case in the room service (`apps/room-service/src/server.test.ts`) and the Durable Object (`apps/edge-service/src/worker.test.ts`) is not tested there; the coordinator behavior above is the same code on both paths, but the transport tests are separate work.
- The capabilities the service worker sends are not asserted by a test.
- Mixed-version rooms on real builds, live Crunchyroll, two accounts, two devices, a deployed coordinator and user acceptance have no evidence here.
- The only written review of the contract is the author's own review of PR #82, and the contract changed after it (PR #84, PR #89). Whether that review stands, or a second person reads this refreshed document, is an owner decision.

The repository E2E command was also attempted. The authenticated Crunchyroll test was skipped because its isolated provider storage-state files are not configured. The generic two-profile test failed before scenario setup when Playwright's isolated Chromium process exited with `SIGABRT`; cleanup also reported `EPERM` while trying to kill that process. This is an execution-environment limitation, not evidence that the protocol contract tests failed. It does not establish or deny live Crunchyroll playback behavior.

## Security and privacy boundaries

This change adds no provider API access, protected media access, cookies, credentials, signed URLs, DRM data, screenshots or media bytes. Operation and binding identifiers are opaque coordination values. The contract does not authorize a client based on a participant-supplied identifier, and it does not treat a WebSocket ping, `paused === false`, a pending `play()` promise or an advancing mocked clock as visible playback proof.

## Remaining gates and closure decision

The coordinator and extension now consume this contract, and the local unit and protocol evidence above is in place. The issue stays open: the contract review, the transport-level legacy-peer tests and the unwired `normalizeStoredContractState` are outstanding, and the provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69. No release version bump is justified for a contract-only change.
