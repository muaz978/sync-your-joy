# CR-B05 local room-service health deadline report

Issue: [#59](https://github.com/muaz978/sync-your-joy/issues/59)
Dependency: [CR-B04 / #58](https://github.com/muaz978/sync-your-joy/issues/58)
Branch: `codex/issue-59-local-health-deadlines`
Base: CR-B04 merge `c9149219c86a2c2c995c72e42a699640ed13b51f`
Version when written: `0.2.4` (historical; sections 1 to 9 describe the state at that version)
Current version when refreshed (2026-11-15): `0.2.12`; section 10 describes everything that came after
Scope: local Node room-service deadline evaluation, timer-driven health recovery, WebSocket broadcast behavior and regression evidence
Status when written (historical): implementation and final local verification complete; PR review, merge and post-merge issue verification remain separate gates. Update 2026-10-16: merged as PR #87 and shipped in v0.2.5; #59 stays open for acceptance evidence. Update 2026-11-15: the socket tests for seek, operation, startup and silence expiry exist (PR #168) and the exactly-one-broadcast and room-cleanup tests were added (section 10); #59 stays open.

This report is intentionally specific about what was verified. It covers the local room service and its WebSocket contract. It does not claim authenticated Crunchyroll visible-output acceptance, a second account, a second physical device, deployment, migration, or final user acceptance. Under the owner decision recorded on #59 on 2026-10-31, those gates are carried by #30, #33, #34, #35 and #69; this card is judged on its own acceptance criteria and local evidence.

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

Issue #59 stays open after this report. The issue remains open until the issue-specific PR is source-reviewed at its exact head, all PR checks pass, the PR is merged, and the post-merge state is verified. After merge, the issue should move to the public project `Verification`, not be silently marked complete if any applicable gate remains outstanding.

CR-B05 does not bump the extension version and does not create a release. When this section was written the version was `0.2.4`; the extension is at `0.2.12` now, and none of the later work on this card changes it. The `1.0.0` release remains reserved for the end of the milestone after the dependent reliability, real-device, deployment and user-acceptance gates are complete.

## 10. Refresh at version 0.2.12 (2026-11-15)

Sections 1 to 9 describe the state at `0.2.4`, when the change was PR #87. This section records what was added afterwards. Evidence class throughout: unit and local socket tests on synthetic fixtures (an injected clock and the `ws` client). Nothing here was observed in a browser, on Crunchyroll, in production, with two accounts or two devices, or as user acceptance.

### 10.1 Where the change is released

- PR #87 (the timer evaluating the deadlines, one transition per turn) is in `v0.2.5` and `v0.2.6`.
- Since then the timer chain has grown to five calls, in this order: `releaseExpiredSeek`, `releaseExpiredOperation`, `evaluateHealth`, `evaluateDisconnectGrace`, `evaluateAutoResume`. The first one that returns a result is broadcast, and the rest wait for the next turn (`apps/room-service/src/server.ts`, the cleanup timer). The extension is at `0.2.12`.
- PR #168 (test only) and the tests of this section are on `main` and in no release tag.

### 10.2 What PR #168 added

Twenty-seven socket tests on an injected clock (`now` and `cleanupIntervalMs`), each asserting the exact snapshot reason, the revision step and that no second snapshot follows: seek expiry (`seek_timeout_paused`); a negotiated Play with the prepare acknowledgement withheld and with the start acknowledgement withheld (`operation_timeout_paused`); startup timeout; report silence, including a player that last reported paused or buffering; a silent player beside a reporting one in legacy and negotiated rooms; WebSocket pings that are not reports; one transition per timer turn when several windows have run out; participant replacement while a seek, an operation or a silence deadline is pending; a healthy room across a join request and a denial; and a healthy legacy room across a control transfer. At its base, deleting `releaseExpiredSeek` or `releaseExpiredOperation` from the timer left every test passing; after it, each of the five calls, the exclusive chain and the broadcast are pinned.

That PR met the owner condition on #59 ("stays open until the socket tests for seek, operation, startup and silence expiry exist").

### 10.3 What this change adds (14 tests, `apps/room-service/src/server.test.ts`)

At the base the file had 71 tests; it has 85 now (84 pass and 1 is an expected failure, see 10.5). The full run is 50 files and 1050 passed plus the 1 expected failure.

Exactly one broadcast per inbound message, in a negotiated two-player room, asserted for both sockets with the revision step and a check that nothing follows later:

- an inbound `player_status` that pauses the room (`participant_playback_blocked`, revision plus one), one that only changes what the room shows for that player (`participant_status_changed`, revision unchanged), and a repeat that changes nothing (no snapshot at all);
- each `operation_ack`: the first and the last `prepared` (`operation_participant_prepared`, then `operation_committed`) and the first and the last `started` (`operation_participant_started`, then `operation_started`), and a repeated start (`operation_start_duplicate`, revision unchanged).

Room cleanup, on the injected clock:

- the per-IP room cap is lifted by exactly one slot when a room ends, whether its empty-room clock runs out or it reaches its maximum lifetime (this replaces the old test of the same title, which only checked the 21st-room cap);
- a room that still has a member ends at its maximum lifetime and not one millisecond before, and every socket of it, a waiting request included, is told `room_expired`;
- a controller's recovery plan is cancelled when its room ends, by empty expiry and by maximum lifetime (the test watches `clearTimeout` receive the very timer the service made);
- an empty-room clock is measured from the last time the room became empty, not from the first;
- one timer turn acts on two rooms, for a seek deadline and for empty expiry, so a timer that stops at the first room fails.

Control transfer in a negotiated room:

- the transfer is announced once, with the other player as controller, one revision step, and no timer transition afterwards;
- the test that the room keeps playing is an `it.fails`, see 10.5.

### 10.4 Mutation checks

Each production edit below was made in place, `apps/room-service/src/server.test.ts` was run, and the file was restored from its saved original bytes (`git status` showed only the intended files afterwards). 16 mutations: 15 are caught, 1 survives.

| Mutation | Result |
| --- | --- |
| `player_status` broadcast sent twice | 17 tests fail |
| `operation_ack` broadcast sent twice | 5 tests fail |
| empty expiry does not release the IP slot | 1 fails |
| lifetime expiry does not release the IP slot | 1 fails |
| empty expiry does not clear the recovery timers | 1 fails |
| lifetime expiry does not clear the recovery timers | 1 fails |
| maximum lifetime never fires (`else if (false)`) | 4 fail |
| maximum lifetime one millisecond late (`>` for `>=`) | 4 fail |
| timer visits only the first room | 2 fail |
| join no longer clears the empty-room clock | 1 fails |
| neither the join nor the timer clears the clock | 2 fail |
| empty expiry never fires | 6 fail |
| coordinator: a started Play stops counting as live on a control transfer | the `it.fails` test of 10.5 fails (as it should once the room keeps playing) |
| coordinator: a status-only report moves the revision | 10 fail |
| coordinator: the first prepare moves the revision | 1 fails |
| the timer no longer calls `reconcileEmptyClock` | survives, 0 fail |

The survivor is a redundant defence, not a gap in the test: every path that makes a room non-empty (the join, the only way a member returns) already clears the clock, so removing the timer's reconciliation alone changes nothing a socket can observe. With both removed the tests fail (the row "neither the join nor the timer clears the clock"). The helper itself is unit-tested in `packages/sync-engine/src/empty-room-clock.test.ts`. A room that is empty with no clock cannot be built through the socket interface.

### 10.5 Open question, not decided and not changed

In a negotiated room, `transferControl` in `packages/sync-engine/src/room.ts` pauses a Play that has already started and is healthy, because `hasActiveOperation()` is true for the `started` phase and the transfer pauses for any live operation. A legacy room in the same situation keeps playing. The comment above that code speaks only of cancelling a pending seek, so the pause may be intended. It was first raised on PR #168. The test `keeps a healthy two-player negotiated room playing after control passes to the other player` states the behaviour a healthy room would have and is an `it.fails`: it passes while the room pauses and fails the moment that changes. It needs the owner's decision (intended, or a fix, which belongs in `packages/sync-engine/src/room.ts` and not in this change); then it becomes a plain `it`, or is deleted.

### 10.6 What is not evidenced

- The five deadline calls are pinned through the server timer; their relative order is pinned for the pairs a test makes due together (operation before health, health before grace). Two orders are still free: `evaluateAutoResume` moved ahead of the others, and swapped with the disconnect grace, because no test has them due in the same turn (this was already the case after PR #168).
- A ping-only health test exists (PR #168), but the real wall clock is not exercised beyond the one pre-existing silent-player test; every other timing here is on the injected clock.
- Windows, Linux and a loaded CI runner were not run for the new tests; a macOS run was repeated six times without a failure.
- The headed Crunchyroll run with a silent participant, a second account, a second physical device, a deployed coordinator and user acceptance remain with #30, #33, #34, #35 and #69 by the owner decision of 2026-10-31. Production runs the edge service, not this local service.
- The edge Durable Object has its own cleanup and is not covered by anything in this section.

### 10.7 Closure

Issue #59 stays open after this section. The owner's stated condition on the card is met (10.2), the two criteria that the second verification pass found only partly pinned (one broadcast per transition, room cleanup) now have tests with mutation checks (10.3, 10.4), and one question needs the owner (10.5). Closing the card is the owner's call.
