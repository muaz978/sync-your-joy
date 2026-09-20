# CR-B01 operation identity and compatibility contract

Issue: [#55](https://github.com/muaz978/sync-your-joy/issues/55)
Purpose: define the shared contract required by CR-B02 coordinator transactions and CR-B03 extension application.
Status: contract implementation complete locally; coordinator preparation, extension transaction application, deployment and live-provider acceptance remain separate follow-up work.

## Scope and decision

CR-B01 defines the data and admission rules before the coordinator and extension start using prepare/commit/start transactions. It deliberately does not claim that the current room coordinator already performs those transactions. That behavior belongs to CR-B02 and CR-B03, which depend on this schema.

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
- Media epochs, source generations and sample sequences are non-negative safe integers.
- Positions and timestamps must be finite and non-negative.
- Operation phases are `preparing`, `prepared`, `committed`, `started`, `cancelled` and `failed`.
- Terminal phases require one bounded reason code. The reason vocabulary distinguishes supersession, deadline expiry, membership/media/binding invalidation, startup failures, unsupported peers, stale operations and explicit recovery.
- `requiredParticipantIds` is fixed for the operation. Prepared and started sets must contain unique members of that fixed set and cannot be silently recomputed from current readiness.

`OperationAcknowledgement` carries the operation identity, participant identity, binding identity, source generation, sample sequence, observed position and local observation time. The participant identity is still taken from the authenticated room socket by the eventual coordinator implementation; the payload field is evidence, not authorization.

## Capability and room-mode policy

The transactional mode requires all of these capabilities:

- `media-epoch`
- `operation-identity`
- `prepare-start`
- `binding-sequence`

`negotiateRoomMode()` is fail-closed. If any peer is absent, advertises contract version `0`, advertises an unknown capability, duplicates capability data, or lacks any required capability, the negotiation result is `legacy` with the peer listed as incompatible. `canAcknowledgeOperation()` returns false in legacy mode. This prevents a legacy or unsupported peer from being counted as an implicit prepare/start acknowledgement and prevents a room from silently downgrading an active operation.

The existing create/join messages accept an optional capabilities advertisement so old clients remain parseable. Omission is not treated as support: the future server/client wiring must normalize omission as `LEGACY_CLIENT_CAPABILITIES` and either remain in legacy mode or reject a transactional operation explicitly.

## Stored-state migration defaults

`normalizeRoomContractSnapshot()` and `normalizeStoredContractState()` provide the migration boundary for old state:

- missing or malformed contract state becomes `mode: legacy`;
- `mediaEpoch` defaults to `0`;
- there is no active operation;
- capabilities default to contract version `0` with an empty list;
- binding identity defaults to `null`;
- source generation and sample sequence default to `0`.

An invalid operation inside an otherwise transactional-looking record is discarded. A structurally valid operation is retained only when the normalized contract still has all transactional capabilities and the operation's `mediaEpoch` matches the room's `mediaEpoch`. This means an old pending seek, a cross-epoch operation or a partially written record cannot satisfy a new prepare/start transaction after restart. CR-B07 will add cross-version transport, coordinator restoration and rollback fixtures that exercise this policy end to end.

## Verification performed for this issue

The focused protocol tests cover:

1. operation identity remaining independent of snapshot revision;
2. fixed participant bounds, subset rules and required terminal reasons;
3. valid binding/source/sample acknowledgements and malformed or unsafe values;
4. all-new negotiation versus a mixed new/legacy room;
5. optional legacy create/join messages and rejection of unknown capabilities;
6. old, malformed and transactional-looking stored-state normalization.

The extension-internal tests cover the same migration boundary through the state shape consumed by the service worker and content script.

The repository E2E command was also attempted. The authenticated Crunchyroll test was skipped because its isolated provider storage-state files are not configured. The generic two-profile test failed before scenario setup when Playwright's isolated Chromium process exited with `SIGABRT`; cleanup also reported `EPERM` while trying to kill that process. This is an execution-environment limitation, not evidence that the protocol contract tests failed. It does not establish or deny live Crunchyroll playback behavior.

## Security and privacy boundaries

This change adds no provider API access, protected media access, cookies, credentials, signed URLs, DRM data, screenshots or media bytes. Operation and binding identifiers are opaque coordination values. The contract does not authorize a client based on a participant-supplied identifier, and it does not treat a WebSocket ping, `paused === false`, a pending `play()` promise or an advancing mocked clock as visible playback proof.

## Remaining gates and closure decision

CR-B01 is ready for review when the focused and repository checks pass. It must not be treated as the completion of CR-B02 or CR-B03. The issue should remain open until the coordinator and extension actually consume this contract, mixed-version behavior is tested, and the applicable local browser, provider, deployment and user-acceptance gates are evidenced. No release version bump is justified for a contract-only issue.
