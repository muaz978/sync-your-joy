# CR-C02 diagnostic report implementation record

Status: implemented and locally verified on the `codex/issue-63-diagnostic-reports` branch. This record documents the source-level change for issue #63. It does not claim authenticated Crunchyroll acceptance, deployment, or release readiness.

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

Diagnostic events may mark critical transitions. The service worker coalesces consecutive `player_status` events with the same bounded health signature and adds a `repeatCount` detail. It retains transition, error and operation events as critical records. The in-memory ring prefers dropping non-critical events when it reaches its limit, and records `eventsDropped`.

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

Focused result at implementation checkpoint: 5 test files passed, 107 tests passed.

The full repository check, package verification, audit and any browser or provider validation are recorded separately after they run. A passing local suite proves the bounded source and synthetic behavior only. It does not prove live authenticated Crunchyroll behavior or visible frame presentation on every browser/device combination.

## Acceptance gates still separate from this implementation

- Headed authenticated Crunchyroll testing with the user's signed-in browser remains a live-provider acceptance gate.
- Cross-browser package verification and deployment remain separate gates.
- Issue #63 must remain open until the implementation, exact PR head checks, review, merge, and any required live validation evidence are complete.
