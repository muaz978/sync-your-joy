# CR-C02 diagnostic report implementation record

Status when written (historical): implemented and locally verified on the `codex/issue-63-diagnostic-reports` branch. This record documents the source-level change for issue #63. It does not claim authenticated Crunchyroll acceptance, deployment, or release readiness. Update 2026-10-16: merged as PR #91 and shipped in v0.2.5; the addendum at the end covers the 0.2.6 additions. #63 stays open.

Related tracker: [CR-C02: Make diagnostic reports explain operation failures](https://github.com/muaz978/sync-your-joy/issues/63)

## Scope

CR-C02 makes a bounded report explain which operation, media epoch, player binding and observation produced the current evidence. It also makes the report safer and more useful after long sessions by coalescing identical heartbeat status events, retaining critical transitions ahead of ordinary heartbeat noise, and reporting when the event history was dropped or truncated.

The state-only boundary remains unchanged. Reports do not contain media bytes, screenshots, cookies, credentials, signed stream URLs, license traffic, private player bridges or raw provider error text.

## Implemented behavior

### Correlation and observation fields

The protocol now accepts and validates these optional bounded report fields:

- `mediaEpoch`, `operationId`, `operationKind`, `operationPhase` and `reason` identify the current coordinator operation without treating a report as an authorization mechanism.
- `bindingId` identifies the worker-accepted player document binding. It is cleared when the binding or player context changes.
- `sourceGeneration` and `sampleSequence` identify the player/source observation incarnation received in the latest operation acknowledgement.
- `targetPositionSeconds` and `observedPositionSeconds` distinguish the requested location from the last observed native location.
- `progressConfidence` records `frames`, `clock` or `unknown` evidence.
- `observationAgeMs` records how old the last sample was when the report was built.
- `correctionCount` records bounded local soft and hard correction attempts since the current correction budget began.

The content script resets the correction count with the existing correction budget and increments it only for an accepted soft-rate correction or a newly created hard seek. Repeated attempts to assign an already pending seek are not counted as new corrections.

### Event retention and truncation

Diagnostic events may mark critical transitions. The service worker coalesces `player_status` events with the same bounded health signature and adds a `repeatCount` detail (later extended, see the addendum, so events merge across other events too). It retains transition, error and operation events as critical records. The in-memory ring prefers dropping non-critical events when it reaches its limit, and records `eventsDropped`.

Before transport, `fitDiagnosticsReport` enforces the 12,000-byte report budget. It removes non-critical events first, retains critical events while possible, and sets `payloadTruncated` plus an explicit `eventsDropped` count. If the fixed report fields themselves exceed the budget, the final fallback shortens the bounded identity fields and removes events while preserving the truncation evidence.

### Redaction and reason handling

Server-controlled error messages continue to be available for the immediate user notice and connection state, but they are not copied into diagnostic events. Reports retain only a bounded error code and a normalized diagnostic reason. Room snapshot reasons are recorded as a fixed `room_snapshot` event with a bounded code detail, preventing untrusted server text from becoming an event name or message.

Canonical media identifiers and page URLs continue to use the existing sanitizers. Query parameters and URL fragments are removed before a report is constructed. The report exposes only source kind, such as `blob` or `https`, and never the active source URL.

## Verification

The implementation is covered by the following deterministic checks:

- `packages/protocol/src/index.test.ts` accepts valid correlation, correction, reason, critical-event and truncation fields and rejects an invalid correction count or unrecognized reason.
- `apps/extension/src/diagnostics-budget.test.ts` verifies the serialized budget, newest-event retention, critical-event retention and explicit truncation counters.
- `apps/extension/src/service-worker.test.ts` verifies operation/media/binding/sample correlation, correction count propagation and removal of untrusted server message text from generated reports.
- `apps/extension/src/content-script.test.ts` and `apps/extension/src/player-operations.test.ts` continue to cover bounded correction and asynchronous player lifecycle behavior.

Focused result at the implementation checkpoint (historical, 2026-09): 5 test files passed, 107 tests passed. The current counts are in the update at the end of this document.

The full repository check, package verification, audit and any browser or provider validation are recorded separately after they run. A passing local suite proves the bounded source and synthetic behavior only. It does not prove live authenticated Crunchyroll behavior or visible frame presentation on every browser/device combination.

## Acceptance gates still separate from this implementation

- Headed authenticated Crunchyroll testing with the user's signed-in browser remains a live-provider acceptance gate.
- Cross-browser package verification and deployment remain separate gates.
- Issue #63 must remain open until the implementation, exact PR head checks, review, merge, and any required live validation evidence are complete.

## Addendum: media-element evidence and merged events

A later change ([Crunchyroll prepare stall analysis](CRUNCHYROLL_PREPARE_STALL_ANALYSIS.md)) extends the report without changing its schema version. Every addition is optional, so an older coordinator relays it unvalidated and a newer one validates it only when present.

- `playerSeeking`, `playerErrorCode` (`MediaError.code`, 1 to 4, never the message), `playerBufferedRangeCount`, `playerBufferedRanges` (at most four `[start, end]` pairs), `playerSeekableRangeCount`, `playerSeekableRanges` (at most two pairs), `playerBufferedAheadSeconds`, `playerPendingSeekAgeMs` and `playerHasMediaKeys`. They are plain numbers and booleans, bounded and rounded, so the state-only boundary is unchanged. The worst case costs about 375 bytes of the 12,000-byte budget.
- `media_detected` events also carry `seeking`, `errorCode` and `aheadBucket`, so a change in element state gets its own event.
- Identical `media_detected` and `player_status` events are now merged with the previous event of the same kind, not only with the event immediately before them. A merged event moves to the tail, where its latest occurrence belongs, so trimming the oldest events never removes the freshest. `atLocalMs` is the latest occurrence, `details.firstAtLocalMs` the first, and `details.repeatCount` the number of occurrences. A media loss, a socket change or a room join ends a run. This replaces the statement above that only consecutive `player_status` events are coalesced.

## Update: the `reason` field, and reading a downloaded report

Every result in this update was run against commit `40d1386613f71689c83869f78348b0bb13b84ac4` (the last code commit of its pull request): `npm run typecheck` clean and `npm test` 51 files, 1142 tests passed. This document lands in a following docs-only commit, which a file cannot name itself.

Evidence class for everything in this update: unit and worker tests against a mocked `chrome` API with fake sockets, and protocol validation of the reports they build. No browser, provider, two-profile, deployment or acceptance evidence is claimed; those gates are carried by #30, #33, #34, #35 and #69, not by this card.

### What `reason` says

`reason` is one of the codes the protocol already validates. A coordinator that predates a new code drops the whole report, so no code was added; the coordinator's exact string stays in the `room_snapshot` event beside it (`details.reason`).

Where it comes from, in order:

1. The coordinator's own operation reason (`contract.operation.reason`, for example `start-timeout` or `deadline-expired`), when the current operation has one.
2. Otherwise the last reason the worker recorded for the operation that is current now, or for no operation if none is current. A reason recorded for another operation is not shown.
3. Otherwise `none`.

What the worker records, and the code it gives:

| Seen | Code |
| --- | --- |
| Room snapshot `operation_timeout_paused`, `seek_timeout_paused` | `deadline-expired` |
| `operation_binding_changed` | `binding-changed` |
| `participant_not_ready`, `participants_not_ready` | `participant-not-ready` |
| `participant_buffering` | `waiting-for-data` |
| `participant_playback_stalled`, `participant_playback_silent` | `stalled` (the room cannot tell a player that stopped progressing from one that stopped reporting) |
| `participant_playback_startup_timeout` | `startup-timeout` |
| `participant_playback_blocked` | `permission-denied` (the browser refused `play()`) |
| `participant_disconnected`, `participant_disconnect_timeout` | `participant-disconnected` |
| `participant_status_changed` | read from the connected participants' coarse statuses, worst first: `blocked` is `permission-denied`, `recovery-required` is `recovery-required`, `silent` is `stalled`, `buffering` is `waiting-for-data`, `wrong-media` is `media-changed`; none of them is no reason |
| This player reports buffering without progress | `stalled` |
| This player's browser refused `play()` | `permission-denied` |
| The coordinator refused a command | `command-rejected` |
| The coordinator sent an error | `server-error` |

Any other snapshot reason (`participant_ready`, `operation_started`, `control_play`, the auto-resume reasons, a reason added later) gives no code. The codes `interrupted`, `provider-error`, `player-missing` and `connection-lost` stay valid but nothing produces them: a report can only be requested while the room connection is up, and a rejoin clears the reason, so a lost connection never reaches a report as a reason. The outage itself is in the `socket_closed`, `reconnect_scheduled` and `socket_opened` events.

When a reason ends: when the operation it was recorded for is no longer the current one; when the room has taken this client back (a rejoin, or a new room); when this player reports healthy playback again (only the reasons the player itself gave); and when a room snapshot that gives no new reason shows the room playing. A snapshot older than the room state the worker holds gives no reason.

### The downloaded file

The room controller's "download detailed report" writes `syncyourjoy-report-<room code>-<timestamp>.json`. Its envelope (`schemaVersion` 2):

- `generatedAt`, `reportId`, `roomCode`, a `privacy` sentence, and `collection` (`attempts`, `expectedParticipants`, `receivedParticipants`, `complete`).
- `missingParticipantIds`: connected participants who did not answer within the collection window.
- `room`: the coordinator's own timeline (`generatedAtServerMs`, `revision`, `mode`, `coverageStartedAtServerMs`, `entriesDropped`, `entries`), or `null` when the coordinator is too old to send it.
- `participants`: one entry per answering participant, `participantId`, `participantName` and `report`.

What the file contains that identifies people or rooms: the room code (in the file name and in `roomCode`; the worker's own events carry none, a connection-event test pins that, and the coordinator's `room` timeline was not checked for it), each participant's display name, and each participant's `userAgent` string. It contains no cookies, credentials, source or stream URLs, query strings, fragments, media bytes or raw provider or server error text. Whether the room code, display names and user agent are acceptable under criterion 3 of #63 is not recorded as an owner decision; this document states what the file holds and does not decide that.

### History after a worker restart

A participant's events live in the service worker's memory. When Chrome restarts the worker, the list starts empty and the dropped and merged counters start at 0. The first event of a restarted worker is `worker_started` (`details.resumedRoom` says whether a room was waiting to be rejoined), and it is kept ahead of ordinary events, so the point where a report's history begins is visible. Events before it are gone. Whether that loss is accepted is not recorded as an owner decision either.

### Reading one report

Read `reason` first, then the last events before the stall. A worked example of a stalled player, from the fields:

1. `playbackStatus` is `paused` and `reason` is `stalled`: the room is paused and the last explanation is that a player reported no progress.
2. In `events`, find `room_status_changed` with `reason` `participant_playback_stalled`, and the `player_status` events just before it (merged ones carry `repeatCount` and `firstAtLocalMs`). `progressed: false` with `buffering: true` is the player that stopped.
3. `operationId`, `operationKind` and `operationPhase` say which operation was current, `targetPositionSeconds` against `observedPositionSeconds` how far the player was from it, `progressConfidence` how that was known (`frames`, `clock` or `unknown`), and `observationAgeMs` how old the sample was when the report was built (the sample's age, or the player's last sighting when there is no sample, or `null`).
4. `playerReadyState`, `playerNetworkState`, `playerErrorCode`, `playerBufferedAheadSeconds` and `playerHasMediaKeys` separate a player that never fetched data from one that was refused it.
5. `eventsDropped`, `eventsCoalesced` and `payloadTruncated` say how much history is missing.

### Tests added with this update

`apps/extension/src/diagnostics-budget.test.ts` (`diagnosticReasonForRoomReason`: every mapping, that every code passes protocol validation, unmapped reasons, status reading and its precedence), and in `apps/extension/src/service-worker.test.ts` the blocks `the reason a report gives` and `what a report strips and what it counts` (reasons from snapshots and from the player, the coordinator and the server; the reason ending; the query and fragment removed from the page address and from a page-based canonical ID; an address that cannot be read; `observationAgeMs` from a sample, from a sighting, and absent; a long run of distinct critical events keeping the newest and the restart marker).
