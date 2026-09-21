# CR-B07 mixed-version and stored-state migration report

Status: implementation complete on branch `codex/issue-61-mixed-version-migration`; PR and merge are intentionally separate gates.

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

The package version remains `0.2.4`. Release `1.0.0` remains reserved for complete milestone acceptance. Issue #61 must remain open until the PR is independently reviewed at its final head, merged, and its remaining external gates are recorded separately.
