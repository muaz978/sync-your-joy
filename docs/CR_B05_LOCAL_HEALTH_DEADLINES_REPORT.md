# CR-B05 local room-service health deadline report

Issue: [#59](https://github.com/muaz978/sync-your-joy/issues/59)
Dependency: [CR-B04 / #58](https://github.com/muaz978/sync-your-joy/issues/58)
Branch: `codex/issue-59-local-health-deadlines`
Base: CR-B04 merge `c9149219c86a2c2c995c72e42a699640ed13b51f`
Current version: `0.2.4`
Scope: local Node room-service deadline evaluation, timer-driven health recovery, WebSocket broadcast behavior and regression evidence
Status: implementation and final local verification complete; PR review, merge and post-merge issue verification remain separate gates

This report is intentionally specific about what was verified. It covers the local room service and its WebSocket contract. It does not claim authenticated Crunchyroll visible-output acceptance, a second account, a second physical device, deployment, migration, or final user acceptance.

## 1. Problem statement and acceptance interpretation

CR-B04 made the sync engine's health deadlines deterministic and added coordinator methods for startup, report-silence, no-progress and transactional-operation expiry. CR-B02 and CR-B03 added negotiated preparation, observed-start acknowledgements and local backend dispatch. CR-B05 is the local room-service integration gate that must prove those coordinator deadlines are actually evaluated by the server timer, without relying on a later player message.

The issue acceptance criteria are interpreted as follows:

1. The existing local cleanup timer evaluates seek, transactional-operation and playback-health deadlines independently of inbound message handlers.
2. A deadline transition is broadcast through the normal `room_snapshot` path and is authoritative for the room.
3. A single timer turn cannot publish multiple competing transitions for the same room. Once one deadline method changes state, later deadline methods wait for the next tick and observe the new state.
4. A connected player that sends one healthy status report and then becomes silent is paused by the timer when its server-side progress deadline expires. No additional `player_status`, ping or control message is required.
5. Existing negotiated transaction dispatch remains covered at socket level, including capability negotiation, preparation acknowledgements, commit, started acknowledgements and the resulting snapshots.
6. Existing participant replacement and cleanup behavior remains covered. A closed socket can be replaced with its issued session token and a room with no connected participant remains subject to the existing lifecycle cleanup rules.

## 2. Baseline and root cause

Before this slice, `apps/room-service/src/server.ts` already called the three relevant coordinator methods from its 100 ms cleanup timer. That existing behavior was necessary but did not have a dedicated socket-level regression for a timer-only health transition.

The timer invoked the methods sequentially and independently:

```text
releaseExpiredSeek()
releaseExpiredOperation()
evaluateHealth()
```

Each result was independently eligible for a broadcast. The coordinator's state machine normally makes the later calls return `null` after a pause, but the service did not express or test the intended one-transition-per-timer-turn rule. That left a gap between coordinator-level deterministic tests and local WebSocket evidence.

The issue was therefore not treated as permission to rewrite the coordinator or to assume that a direct call from a unit test proves server behavior. The implementation keeps the existing deadline ordering and makes the local timer's transition boundary explicit.

## 3. Changed files

| File | Change | Purpose |
| --- | --- | --- |
| `apps/room-service/src/server.ts` | Replaced three independent deadline result checks with a null-coalescing, ordered deadline evaluation and one broadcast | Ensures a timer turn publishes at most one authoritative `room_snapshot` transition per room |
| `apps/room-service/src/server.test.ts` | Added a real WebSocket timer-driven silent-player regression, one-transition assertion and bounded message wait helpers | Proves local server behavior without requiring an inbound report at the failure boundary |
| `docs/CR_B05_LOCAL_HEALTH_DEADLINES_REPORT.md` | Added this report | Records root cause, implementation, evidence, security analysis, external limits and closure boundary |

No private provider API, Crunchyroll credential, cookie, signed media URL, DRM material, media byte, screenshot or arbitrary page-execution capability was added. No extension player logic, protocol schema or edge Durable Object code was changed in this slice because those responsibilities were already covered by the preceding CR-B02, CR-B03 and CR-B04 work and are outside this local-server issue's minimal change.

## 4. Implementation details

### Ordered deadline evaluation

The cleanup timer now computes one result:

```text
releaseExpiredSeek(now)
  ?? releaseExpiredOperation(now)
  ?? evaluateHealth(now)
```

The order preserves the existing transition precedence:

1. A pending seek barrier is released first.
2. A negotiated transactional operation deadline is released next.
3. Playback health is evaluated only when neither earlier deadline changed the room.

If a method returns a successful `RoomResult`, the server broadcasts exactly that result once for the current timer turn. If no deadline is due, no snapshot is emitted. A later 100 ms tick can inspect the changed state, but it cannot replay the same transition because the coordinator is paused or the operation is cancelled or failed.

This does not make the timer the correctness boundary for client messages. The coordinator still validates exact room revision, operation identity, participant readiness, connection status, media match, binding continuity and server-clock deadlines. The timer is the independent delivery mechanism that ensures the server can act when no new player message arrives.

### Socket-level silent-player regression

The new test creates a real local WebSocket room and performs the following sequence:

1. Create a room with an eight-character protocol-valid room-code fixture.
2. Mark the controller ready and verify the readiness snapshot.
3. Start playback and verify the `control_play` snapshot reports `playing`.
4. Send one `player_status` sample with `progressed: true` and `playbackStarted: true`.
5. Send no further messages.
6. Wait for the server's cleanup timer to publish `participant_playback_stalled`.
7. Verify the broadcast snapshot is paused and its revision is exactly one greater than the play snapshot.
8. Wait an additional 300 ms and verify that no second message is emitted for the same failure episode.

The test uses the actual server interval and `ws` client rather than calling `RoomCoordinator.evaluateHealth()` directly. It therefore covers the timer, room lookup, coordinator invocation, broadcast path, JSON message delivery and observable one-transition behavior together.

### Existing negotiated transaction coverage retained

The same focused server suite continues to cover two capability-bearing clients through:

- pending join approval;
- transactional capability negotiation;
- readiness on both sides;
- `control_play` operation creation;
- authenticated prepare acknowledgements;
- committed operation broadcast;
- authenticated started acknowledgements;
- final `operation_started` snapshot.

The server obtains the participant identity from the tracked socket and passes the acknowledgement to the coordinator. The payload's participant ID is not used as authorization.

### Existing replacement and cleanup coverage retained

The existing replacement test continues to verify that a participant can reconnect with its issued session token, replace the prior socket, remain connected and ready, and receive an unchanged readiness confirmation. The close handler still marks a participant disconnected, pauses the room through the coordinator, schedules controller recovery when applicable and marks an empty room for the existing TTL cleanup. This issue did not alter those paths.

## 5. Acceptance mapping

| Issue criterion | Evidence | Result |
| --- | --- | --- |
| Evaluate deadlines from the existing timer independently of message handlers | New real-WebSocket test sends no message after the baseline status sample and receives the health transition from the 100 ms cleanup timer | Passed |
| Dispatch negotiated preparation/start/sample behavior and broadcast one resulting transition | Existing transactional server test in the same focused suite covers capability negotiation, prepare, commit and started snapshot dispatch; the timer source now has one-result short-circuit semantics | Passed in local source and test scope |
| Silent connected player is paused without another message | New timer-driven test observes `participant_playback_stalled`, `paused` playback and exactly one revision increment | Passed |
| Disconnect, replacement and room lifecycle remain safe | Existing replacement WebSocket test remains green; full suite remains green after the timer change | Passed for covered local behavior |
| Preserve state-only/provider boundary | No provider or media-access code changed; report records live-provider and user-acceptance limits separately | Passed for scope control |

## 6. Security and privacy review

- Deadline evaluation uses the server's `Date.now()` value passed to the coordinator. A client-local `sampledAtLocalMs` value cannot extend or shorten the server deadline.
- A WebSocket ping does not update the participant's last media sample and therefore cannot manufacture playback health evidence.
- A stale room revision or stale operation acknowledgement remains rejected by the coordinator before it can update health state.
- The server still takes participant identity from its authenticated socket map. A JSON participant ID remains a consistency field, not an authorization credential.
- The fixed operation participant set remains coordinator-owned. The local timer does not shrink a quorum because one participant is silent.
- The one-result short circuit prevents duplicate room snapshots from competing deadline paths during one timer turn. It does not weaken later ticks, which continue to evaluate the current authoritative state.
- No new persistent user data is collected. No media bytes, provider credentials, cookies, signed URLs or DRM information are stored or transmitted by this change.
- The test fixture uses a synthetic YouTube-labelled media fingerprint only to exercise the existing generic room protocol. It is not a provider integration test.

## 7. Verification performed

### Baseline before implementation

```text
npx vitest run apps/room-service/src/server.test.ts
PASS, 1 file, 13 tests
```

### Focused local room-service verification

```text
npx vitest run apps/room-service/src/server.test.ts
PASS, 1 file, 14 tests
```

The first attempt failed immediately because the new synthetic room-code fixture was nine characters. The protocol requires eight characters. The fixture was corrected from `HEALTH123` to `HEALTH12`, and the rerun passed. This was a test-fixture error, not a product failure.

### Coordinator and server regression verification

```text
npx vitest run packages/sync-engine/src/playback-health.test.ts packages/sync-engine/src/room-streaming-regressions.test.ts packages/sync-engine/src/room.test.ts apps/room-service/src/server.test.ts
PASS, 4 files, 88 tests
```

### Repository-wide verification

```text
npm run check
PASS
```

The command completed all of the following:

- TypeScript typecheck, including the edge-service TypeScript project;
- all 30 Vitest files;
- all 280 tests;
- room-service bundle build;
- Chrome extension build.

### Version and diff hygiene

```text
npm run release:check-version
0.2.4
```

```text
git diff --check
PASS
```

No version bump is part of CR-B05. Release `1.0.0` remains reserved for complete milestone acceptance, and a grouped release before that milestone remains a separate explicit release step.

### Browser-package smoke

The first sandboxed run reached the macOS Safari converter but failed because `safari-web-extension-converter` could not access the temporary staging directory. The same command was rerun with host filesystem access:

```text
npm run verify:browser-packages
PASS
```

Verified results:

- Chrome manifest version `0.2.4`, service worker present;
- Firefox manifest version `0.2.4`, sidebar present;
- Safari macOS package smoke completed successfully.

The initial sandbox failure is recorded as an environment access limitation, not as a browser-package source failure.

### Local Playwright E2E

The first sandboxed launch failed before the test began because Chromium aborted while opening its persistent extension profile. No test assertion or room-service operation ran in that attempt. The same test was rerun with host browser access:

```text
npm run test:e2e -- --grep "profile A creates a room"
PASS, 1 test, 6.4 seconds
```

This is a generic local two-profile fixture test. It is not authenticated Crunchyroll playback and does not prove visible output from a live provider.

## 8. Evidence boundaries and remaining gates

Confirmed by this issue slice:

- local room-service source behavior;
- local WebSocket timer dispatch;
- deterministic coordinator behavior through the focused and full suites;
- server and extension build integrity;
- Chrome, Firefox and Safari package smoke;
- one generic local Playwright two-profile scenario.

Not claimed by this issue slice:

- authenticated Crunchyroll playback;
- visible video frames or provider-specific media health;
- two independent Crunchyroll accounts;
- two physical devices;
- deployed edge-service behavior;
- migration or mixed-version persistence behavior;
- release packaging and staged installation acceptance;
- final user acceptance.

The user's signed-in Crunchyroll account is available for the separate headed provider gate when that issue's scope reaches it. It is not a blocker for CR-B05 because this issue proves a generic local server deadline and WebSocket transition.

## 9. Closure and release decision

This report does not close issue #59. The issue remains open until the issue-specific PR is source-reviewed at its exact head, all PR checks pass, the PR is merged, and the post-merge state is verified. After merge, the issue should move to the public project `Verification`, not be silently marked complete if any applicable gate remains outstanding.

CR-B05 does not bump the extension version and does not create a release. The current version remains `0.2.4`. The `1.0.0` release remains reserved for the end of the milestone after the dependent reliability, real-device, deployment and user-acceptance gates are complete.
