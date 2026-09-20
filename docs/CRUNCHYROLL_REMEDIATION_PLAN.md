# Crunchyroll synchronization remediation plan

Prepared: 2026-09-19. Tracker and branch status updated: 2026-09-20. Status: durable design plan for an open GitHub initiative. This document does not authorize a production release.

The user first requested a deeper plan and handoff without further implementation. The user later authorized preserving the existing candidate fixes, tests, and documents on `codex/crunchyroll-sync-hardening`. This plan identifies further work; publishing the candidate branch does not declare those changes complete or release-ready.

Related documents:

- [Canonical GitHub issue map](CRUNCHYROLL_ISSUE_MAP.md)
- [Complete investigation and test handoff](CRUNCHYROLL_HANDOFF.md)
- [Earlier analysis and implemented local changes](CRUNCHYROLL_SYNC_ANALYSIS.md)
- [Provider source notes](research/crunchyroll-source-notes.md)
- [Chronological session record](../context-checkpoint.md), checkpoints 29 onward

## 1. Objective and boundaries

Make play, pause, forward/backward seeking, Skip Intro, episode changes and recovery predictable when Crunchyroll loads or replaces its player slowly. Protect working YouTube and generic embedded-player behavior. A room must not silently declare synchronization while one member is stopped, unobservable, on another episode or still loading.

The goal is bounded, diagnosable synchronization. Browser permissions, unavailable content, provider outages and graphics failures cannot be eliminated by this extension. In those cases the room should reach an explicit recoverable state, identify the affected participant and stop issuing commands that worsen the problem.

Use native HTML media APIs and authorized page identity. Preserve state-only transport. Do not collect media bytes, screenshots of protected playback, full DOM, cookies, credentials, signed stream URLs, license traffic or DRM data. No private Bitmovin bridge is part of the initial implementation. A bridge would require demonstrated public access and separate evidence that native APIs are insufficient.

Writing this plan did not itself implement its tasks. The preservation branch also contains earlier candidate code and test changes described in the handoff. Remaining issue implementation, release packaging, and deployment are separate actions.

## 2. Verified starting point

- Baseline: `main` at `1ac5b1c13ba21d93823c43c3b33f354ba5a9ac68`, package version `0.2.4`.
- Preservation branch: `codex/crunchyroll-sync-hardening`. Candidate code commits are `4debb78`, `9ae24a7`, `0c13a28`, and `ded3527`.
- Earlier live DOM inspection found a top-document `bitmovinplayer-video-null` video, `blob:` source protocol, roughly 1,420-second duration and a broad seekable range with a much smaller buffered interval. This establishes the inspected page's shape, not every Crunchyroll deployment or its exact player version.
- On 2026-09-20, `npm run check` passed 26 files / 189 tests, both TypeScript checks, and both builds. `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities.
- On 2026-09-20, the strengthened local two-profile E2E passed once in 6.9 seconds after isolated Chrome process permission was granted. It exercised the unpacked extension, two profiles, forward and native backward seeks, visible-frame progress, and convergence against the short generic fixture. It is not sustained, adaptive, multi-member, or live Crunchyroll acceptance.
- No authenticated two-account Crunchyroll acceptance or deployment of these changes occurred.

The existing source fixes are a starting candidate. Passing their current tests is evidence for the covered cases, not a reason to skip the additional regressions below.

## 3. Deeper review findings and priorities

These findings come from source review and timing analysis during planning. Unless explicitly described in the handoff as an earlier failing test, they are not newly reproduced runtime failures. Each implementation task begins with a failing regression or a controlled observation that confirms the suspected path.

| ID | Priority | Remaining exposure | Current evidence and required response |
| --- | --- | --- | --- |
| G01 | P0 | Local identity guard can reject supported generic/nested embeds | `content-script.ts:1014` compares all providers locally, but `containerPageUrl` at 1502 may see only a referrer origin or intermediate frame. Worker identity at `service-worker.ts:211` uses the outer tab. Only Crunchyroll has an unknown-identity exception. Establish one authoritative binding and distinguish unknown identity from mismatch. |
| G02 | P0 | Late ACK can resume an expired seek | `room.ts:356` checks revision, readiness and position but does not check the deadline. An ACK can beat a delayed alarm after the nominal deadline. Check expiry inside every ACK and commit transition. |
| G03 | P0 | A failed member can disappear from the seek quorum | Required members are recomputed from ready/matching members at `room.ts:368`. The explicit playback-failure path can clear readiness while a barrier exists. Freeze required membership for an operation and abort when a required participant fails, leaves, becomes unready or changes media. |
| G04 | P0 | Silence is invisible to the startup watchdog | `room.ts:479` evaluates health only when status arrives. `lastSampleReceivedAtMs` is not used by a timer. Both transport timer paths currently check seek/room expiry, not player health. Add independent health deadlines. |
| G05 | P0 | Slow-seek correction can still cycle after the recovery grace | A 1.2-second seek delay creates about 1.2 seconds of drift. Playing at 1.02x for 2.5 seconds recovers only 0.05 seconds, leaving drift above the 0.6-second hard-seek threshold. The existing test stops after the first completion. Prove convergence over sustained playback and escalate persistent drift to a fixed room recovery target. |
| G06 | P0 | Timeout cancellation loses late-event attribution or can leave a pending operation stuck | `APPLY_ROOM_STATE` at 280 clears pending/expected seek when a barrier disappears. A later native event can then look like a controller command. The completion probe at 1411 also stops at timeout; delayed readiness without `seeked` needs a recovery path. Separate native-operation attribution from permission to resume. |
| G07 | P0 | Fresh binding protection is incomplete | Outbound delivery failures have a generation check, but incoming sender checks at `service-worker.ts:855` use tab/frame only; asynchronous `refreshBoundPlayerTab` can return after a newer binding. Scope incoming messages and refresh results to the document/binding incarnation. |
| G08 | P1 | Progress measurement can depend on report timing rather than a stable interval | `reportPlayerStatus` updates baselines on every event and timer report. A report between periodic samples can consume progress evidence; seeking may present one frame without sustained playback. Maintain accumulated evidence and independent last-progress time. |
| G09 | P1 | Edge recovery can restore obsolete health evidence | Healthy status reports update memory but do not call persistence unless room state changes (`worker.ts:397`). Rehydration can recover old health timestamps. Persist a bounded health checkpoint or apply an explicit unknown-health recovery handshake. |
| G10 | P1 | Ordinary Play has no preparation barrier | `room.ts:318` schedules playing immediately after consent/readiness checks. Ready does not prove that every player has loaded the target or can start. Add prepare, scheduled commit and observed-start confirmation. |
| G11 | P1 | Failure pause can move the room to the broken player's arbitrary time | Health handling at `room.ts:514` selects the failing sample's position. Define a trusted pause target for startup, seek and steady-play failures. |
| G12 | P1 | Current browser test cannot prove adaptive-player reliability | The fixture is a short progressive MP4 happy path. E2E build output shares `apps/extension/dist`, cache checks only the endpoint, and manually created contexts do not explicitly start tracing. Isolate build output and add controlled loading/lifecycle faults with verifiable artifacts. |
| G13 | P1 | Native Next Episode has safe blocking but no complete room transaction | Current candidate requires sharing the link and reconfirming readiness. Implement explicit controller navigation handling if seamless native transition is included, preserving this fallback. |
| G14 | P1 | An unsettled play request can make explicit Sync ineffective | `requestVideoPlay` at `content-script.ts:977` retains its pending marker until settlement/reset, while explicit Sync does not necessarily retire it. Add a bounded retry boundary that invalidates old success and rejection callbacks. |
| G15 | P1 | Context refresh can replace a known failure with incomplete health | `currentPlayerContext` at `content-script.ts:813` uses different defaults from periodic status, including false buffering/progress and incomplete failure evidence. Use one read-only health snapshot. |

P0 means the candidate should not be shipped without resolving or disproving the exposure. P1 is required for the stronger reliability claim described here, except optional automatic native navigation activation. Custom room speeds and private vendor APIs are deferred.

## 4. Architecture decisions

### 4.1 Keep the existing coordinator and extract only testable state logic

Do not replace the application or adopt a new framework. Retain `RoomCoordinator`, the existing WebSocket services, native media discovery and the side panel. Extract small pure modules for identity decisions, local operation ownership and health accumulation where doing so permits deterministic tests. Introduce them through end-to-end slices, not a broad rewrite of the content script.

Separate four concepts currently partly conflated:

1. **Consent:** the participant pressed Ready.
2. **Preparation:** this exact player instance has the current media and can play the requested target.
3. **Start application:** the current play request succeeded and useful progress is observed.
4. **Ongoing health:** current, sufficiently fresh evidence still supports playback.

Consent survives a transient buffer shortage. Permission rejection, confirmed wrong media and missing player require explicit recovery. Consent alone never bypasses a prepare/seek barrier.

### 4.2 Use explicit identity and operation scopes

Proposed contract, names subject to a focused schema review before implementation:

| Field | Owner | Meaning |
| --- | --- | --- |
| `roomRevision` | Coordinator | Snapshot ordering, including membership and status changes. |
| `mediaEpoch` | Coordinator | Incremented when the room's chosen content/timed edition changes; retained across same-episode source reload. |
| `operationId` | Coordinator | Unique persisted identity for prepare/play, seek, recovery or navigation. Not invalidated by unrelated snapshot updates. |
| `bindingId` | Extension worker | Identifies the currently accepted document and player context. Reissued after navigation, worker reconstruction or replacement. |
| `sourceGeneration` | Content script | Incremented on video/source lifecycle replacement. Kept local except for an opaque diagnostic/sample incarnation. |
| `sampleSequence` | Current binding | Monotonic report sequence; prevents relying on wall-clock timestamps for ordering. |

Room commands carry media and operation identity. ACKs and samples echo the identities they observed. The worker validates current browser sender identity and binding before forwarding, and the server validates membership, lease where applicable, media and operation identity before changing health or playback. A plain participant-supplied ID is not authorization.

Use Chromium `sender.documentId` when available. For other browsers use a worker-issued binding handshake scoped to the extension runtime sender, not an unauthenticated page event. A media heartbeat must not create a new binding on every report. Late asynchronous reads may update state only if their captured binding is still current.

Local identity returns `match`, `mismatch` or `unknown`. A strong top-document mismatch blocks immediately. An unknown nested-frame identity waits for an acknowledged worker binding to the actual outer tab. Unknown identity is not unconditional permission. Old bindings are invalidated as soon as top-level navigation is observed.

### 4.3 Track operations through completion and cancellation

Local logical states:

| State | Allowed action | Exit evidence |
| --- | --- | --- |
| Unbound / unknown media | Discover and request binding | Valid current binding with media identity |
| Loading | Observe metadata, seekable ranges and errors | Target becomes available, or bounded failure |
| Prepared and paused | Hold the fixed target | Current coordinator commit or cancellation |
| Seeking | One native seek assignment for the current target | Target alignment plus completion/current data |
| Start pending | One current `play()` request | Current resolution plus progress, permission error, fatal error or timeout |
| Playing | Observe progress; bounded soft correction | Pause, drift recovery, loading, mismatch or fault |
| Recovering | Pause, rebind/reprepare once | Current preparation succeeds or actionable failure |
| Blocked / unavailable | Explain who/why; accept explicit recovery | Actual gesture, player return or explicit new operation |

Cancellation ends permission for an operation to resume the room. It does not erase the fact that a native seek is still finishing. Keep a bounded attribution record for the current source until native completion, a different proven target, or a source-generation reset. Targets alone cannot uniquely identify user intent; when an event is ambiguous, do not invent a controller command. Native events, outstanding writes and action timing must be tested together.

Pause, room exit, media change and controller-lease change invalidate pending play callbacks. A plain unrelated snapshot revision must not cancel an otherwise current operation. If a delayed `canplay`, `loadeddata` or periodic observation establishes completion without `seeked`, reconcile it idempotently, without issuing another seek.

### 4.4 Make start and seek room transactions

```mermaid
sequenceDiagram
    participant H as Controller
    participant R as Room coordinator
    participant P as Every required player
    H->>R: Play or seek intent
    R->>P: Prepare operation at fixed media/target
    Note over R,P: Room remains paused; required participant set is fixed
    P->>R: Prepared for current operation/binding
    R->>R: Validate quorum, media, lease and deadline
    R->>P: Commit playing at future server time
    P->>R: Started with fresh progress evidence
    alt Missing, rejected or failed start
        R->>P: Pause once at trusted recovery target
    else All starts confirmed
        R->>P: Healthy playback state
    end
```

Preparation proves alignment and usable native data, not guaranteed future autoplay permission or decoder success. A user-gesture activation attempt must occur in the actual in-page interaction when necessary. Do not depend on a side-panel click surviving asynchronous messaging as page activation. Observe actual starts after commit and compensate with a room pause when a required player cannot start.

Freeze the required participant set when preparing. Any required member's readiness loss, identity change, disconnect, generation invalidation or fatal error aborts preparation. Join/approval or control transfer cancels and rebuilds preparation under the new membership/lease instead of silently changing the quorum. ACKs are idempotent, deadline-checked on receipt, and cannot revive cancelled operations.

### 4.5 Use fixed recovery targets and bounded retries

Do not repeatedly seek toward a room clock that keeps moving while the player loads. Permit one local hard correction per operation. Small drift can use a supported temporary rate change. If residual drift remains large or rate assignment does not persist, report recovery-required and pause/reprepare the room at one fixed target.

Proposed pause-target policy:

- Explicit controller pause uses its current validated position.
- Startup or seek failure retains that operation's fixed target.
- Steady-play failure uses a fresh validated controller sample projected only within its bounded freshness window, otherwise the coordinator's authoritative timeline at the pause decision. Do not select an arbitrary stalled guest's jumped position.
- Stop playback first. Perform target alignment as a separate preparation step so a broken player is not forced into another seek before it is ready.

One automatic recovery attempt per failure episode is an initial limit, followed by an explicit participant action. A newer controller action supersedes recovery. Never use automatic page refresh, source clearing, `load()` loops, quality switching or repeated player clicks as a generic black-screen remedy.

### 4.6 Evaluate silence even without messages

Coordinator exposes a deterministic next-health-deadline and `evaluateHealth(now)` alongside operation expiry. Both backend timer paths invoke it. Track last accepted status receipt using server time and ordering using sequence/binding; a live WebSocket ping does not prove a live media player.

Edge alarms include operation, player-health, controller recovery and room-lifetime deadlines. Persist enough operation and health state to survive hibernation. A focused first implementation may persist a compact health record per accepted periodic sample; benchmark storage overhead before batching. If writes are batched, persisted deadlines must remain conservative and reconstruction must request fresh player evidence rather than interpreting stale state as healthy. Duplicate alarm callbacks cause at most one pause transition.

Cloudflare documents that hibernation can preserve WebSockets while memory is reset, which makes reconstruction behavior part of correctness, not an optional optimization. [Cloudflare WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

### 4.7 Measure progress independently of event frequency

Maintain accumulated forward progress since the last periodic sample plus last observed useful progress time. Event-triggered status must not erase evidence used by periodic health checks. Exclude commanded seeks, reverse jumps and source resets.

Prefer frame-callback metadata when available, backed by validated playback-quality counters and bounded clock evidence. Feature-detect and handle counter reset, constant/unsupported values, visibility changes, a hidden iframe inside a visible page, Picture-in-Picture and long main-thread pauses. Record evidence quality as `frames`, `clock` or `unknown`; unknown is not a confirmed rendering failure.

Frame callbacks indicate submission for composition and can be delayed. They do not prove that the final display is free of black pixels. Playback-quality counters reset on media loading. These are reasons to retain a live visual acceptance step and explicit generation resets. [Frame callback draft](https://wicg.github.io/video-rvfc/), [Playback quality specification](https://w3c.github.io/media-playback-quality/)

### 4.8 Episode navigation and timing editions

Same episode/source reload: invalidate local source operations, reacquire preparation, and preserve the room media epoch. Strong different episode: immediately suppress old controls/samples and clear preparation. Never strip ID suffixes to force dubbed/subbed editions to match.

Always support the explicit Share new link flow. Add optional **Follow controller's next episode** only after the binding and transaction work is complete. The worker reports a verified strong Crunchyroll watch identity under the current lease. The coordinator pauses, increments media epoch, cancels old operations, resets readiness and broadcasts one navigation. Guests' independent navigation never changes room media. Availability/login/error pages are unresolved navigation, not ready players. Native auto-next and explicit link submission for the same transition must deduplicate.

The initial default is manual sharing; automatic follow remains disabled until its acceptance matrix passes and the room enables it. No consent/readiness is carried to a different timed edition.

### 4.9 Diagnostics and user feedback

Bounded diagnostics include operation/media/binding identifiers, native event name, target/observed position, readiness/seeking state, source kind only, error category, selected progress evidence, visibility, last progress age, receipt age, correction count and outcome. Include only a few numeric seekable/buffered intervals if necessary; never include source URLs. Retain critical transitions separately from repetitive heartbeat noise within the existing payload cap.

Expose participant-level causes: Preparing video, Seeking, Waiting for permission, Player stopped responding, Different episode, Provider error, and Recovery needed. Distinguish permission denial from interrupted play, unsupported media, waiting for data and frame-progress uncertainty. `AbortError` is not an autoplay rejection. [Chrome play interruption explanation](https://developer.chrome.com/blog/play-request-was-interrupted)

## 5. Timing policy to validate

These are proposed initial engineering values, not measured Crunchyroll guarantees. Keep them centralized and test boundaries. Change them from evidence, not by merely increasing every timeout.

| Policy | Current candidate | Proposed experiment |
| --- | --- | --- |
| Local seek slow indicator | 1.5-second completion timeout | Keep 1.5 seconds as a progress/status threshold; preserve observation after it. |
| Shared seek preparation | 1.8-second hard expiry | Trial a fixed 10-second maximum for Crunchyroll preparation, with visible slow-state feedback. Healthy ACKs still release immediately. Do not extend forever with heartbeats. |
| Startup | 10-second report-triggered timeout | Preparation deadline plus a separate observed-start deadline of 3 seconds after scheduled commit. Measure cold-player cases before final tuning. |
| Missing periodic sample | No health deadline | Trial 5 seconds since last accepted sample while playback is expected; invalidate health on expiry even if socket ping is alive. |
| Visible frozen progress | Local 2.5 seconds, server 1.8 seconds | Align one documented policy with sample interval and measured frame cadence; trial 3 seconds without useful progress. Avoid two conflicting clocks. |
| Soft drift correction | 0.98/1.02 around 1x | Preserve bounds only when rate assignment persists and data/progress are healthy. End correction on buffering or operation change. |
| Repeated hard correction | No complete attempt budget | One local correction, then one coordinated recovery, then explicit action. |
| Seek target tolerance | 0.5 seconds | Preserve initially, measure at fixed paused target. Do not label this steady-play precision. |

Include delays immediately below/at/above deadlines, 1.2/2/5/9/11-second seeks, unavailable seekable ranges and a player that never completes. Silent participants and visible-buffering participants can reach different reason codes while both end safely paused.

## 6. Delivery stages and task index

The canonical tracker is milestone [M3/M5: reliability and real-device validation](https://github.com/muaz978/sync-your-joy/milestone/1), filtered by [`initiative: crunchyroll-sync`](https://github.com/muaz978/sync-your-joy/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22initiative%3A%20crunchyroll-sync%22). Twenty-two new issues were created and existing issue 33 was reused for CR-D04. [The static issue map](CRUNCHYROLL_ISSUE_MAP.md) links all 23 task IDs without duplicating their live status or acceptance checkboxes.

| Stage | Tasks | Exit condition |
| --- | --- | --- |
| A. Stabilize the existing candidate | A01-A07 | New identity/lifecycle/correction regressions are reproduced and fixed; existing providers remain covered. |
| B. Make coordinator transactions complete | B01-B07 | Fixed quorum, explicit operation identity, prepared start, silence detection and both backends agree. |
| C. Recovery, diagnosis and episode flow | C01-C04 | Failure states are actionable; new episode transition is explicit and stale operations are inert. |
| D. Prove the result and prepare release | D01-D05 | Exact candidate passes deterministic, browser and real-provider gates; release is separately authorized. |

Dependencies: A01 starts first. A02/A03/A04 establish local identity/lifecycle ownership. A05/A06 and A07 close convergence/quorum gaps. B01 locks the shared schema before parallel client/server work. B02 and B03 implement preparation on each side; B04 defines health deadlines; B05/B06 wire the two services, B07 verifies compatibility. C work consumes those contracts. D01/D02 may run alongside implementation after A01; D03/D04 acceptance follows integrated behavior. D05 is last.

One owner edits `content-script.ts`; one edits `room.ts`; one owns protocol/internal contracts until fixed. Parallel work may inspect shared files but must coordinate edits. Run build-producing tasks serially until D01 isolates artifacts. Checkpoint after each stage, preserving failures and superseded decisions.

## 7. Validation and release gates

### Gate A: deterministic contracts

Each new failure is first demonstrated by a meaningful regression. Add operation sequences to `room.fuzz.test.ts` and deterministic chaos coverage: missing/duplicate/reordered ACK, late completion, participant failure during preparation, controller transfer, old source report, cancelled command and room reconstruction. Tests use injected time, not sleeps. All current regressions remain passing unless a changed contract is explicitly documented.

### Gate B: local real browsers

Use the unpacked extension and real local coordinator with two fresh profiles, then a three-profile run for quorum and membership. Longer test-owned media must cover repeated operations without hitting EOF. Add an unencrypted segmented/MSE fixture with controlled delays, plus generic top-document, nested-frame, open-shadow-root and SPA variants. Synthetic freezes complement real frame observation; they do not emulate protected decoding.

Verify destinations, not merely time movement. Pair samples with timestamps and bounded sample skew; do not compare sequentially read clocks as if simultaneous. Require sustained progress after operations, observation beyond recovery grace/deadlines, absence of duplicate seek assignments and bounded pause/recovery. Explicitly collect traces on manually created local-fixture contexts. Failures must include command log, room state and sanitized player evidence from all participants.

Run at least 20 consecutive two-profile scenarios without retries and 10 repeated fault scenarios for each critical lifecycle failure. A retry is a new run, not an erased failure. Include a 30-minute soak with at least 50 mixed play/pause/seek/Skip Intro-style actions.

### Gate C: authorized live Crunchyroll

Two separate authorized accounts/devices, same timed edition, roles swapped. Start with an extension-disabled baseline; repeat with the exact built candidate and fixed other extensions/network conditions. Cover current Edge and Chrome first, then any other claimed browser. Use native controls and the extension controls. Capture only sanitized state reports and human confirmation of visible motion, not provider HAR, video recordings or screenshots of protected media.

Required scenarios: initial Play when both ready; cold and warm seeks both ways; Skip Intro during correction; rapid repeated scrubs; pause during pending play; missing/slow participant; audio/subtitle change; native Next Episode and manual shared link; same-source reload; video/frame replacement where observed; hide/show and sleep/wake; reconnect; permission denial; player error/black loader. Record the actual failure code if visible rather than assigning a DRM or network cause without evidence.

### Proposed measurable acceptance

- Zero old-media writes, stale-command resurrection, quorum bypasses, lost pause commands or unbounded automatic retry loops across the required matrix.
- Preparation either completes for every required participant before deadline or leaves everyone paused with a named reason. Silence must terminate by its configured deadline plus observed scheduler/network delay.
- Both players show at least 0.6 seconds of media/frame progress and at least three new presented frames in the local fixture start probe; continue paired observations for at least 10 seconds, and 30 seconds after correction-cycle tests.
- On a healthy connection with RTT at most 200 ms, target p95 steady drift at most 250 ms over at least 60 seconds, and p95 remote pause application at most 250 ms over at least 30 pause events. Record maximum and sample skew as well. These are release targets to validate, not existing results.
- Large drift must enter explicit preparation/recovery or settle, rather than repeatedly pausing and seeking. Unavailable/blocked provider playback is allowed to stop with an actionable explanation; it is not a successful playback test.
- YouTube plus generic/nested HTML5 regressions must pass before claiming the Crunchyroll changes preserve other platforms.

### Gate D: rollout and rollback

Use additive negotiated capabilities for new message fields and operations while protocol version 1 remains supported, or explicitly design a version bump if required. Current parser rejects mismatched versions, so silently changing the constant is not a migration plan. Enhanced operation semantics activate only when server and all required clients support them. An old client must receive a visible legacy/update-required path, never implicit preparation acknowledgement.

Deploy a backward-compatible backend with enhanced mode disabled first, then the matching extension; enable per room/capability only after staging and live canary evidence. Test new server/old extension, old server/new extension, mixed room and restored old room state. Provide a static capability/feature switch to fall back to a paused legacy-compatible session. No remotely downloaded executable behavior.

Publication requires separate authorization. Build the release with an explicit production endpoint; the default build and E2E dist can target localhost. Verify archive version, endpoint, source SHA and checksum. Run production smoke and limited live canary before broad distribution. Rollback disables enhanced operations, pauses active enhanced rooms, and requires a fresh readiness handshake; it must not reinterpret an in-flight new operation as legacy Play.

## 8. Deferred choices and evidence needs

- Exact preparation/health deadlines need live seek/start measurements. Defaults above make the implementation testable without pretending calibration is complete.
- Automatic native Next Episode is proposed as an optional room mode, initially off. The explicit link flow remains required regardless.
- Keep a 1x room base rate in this remediation. Native custom speed selection must be visibly unsupported or brought back to room rate; a full base-speed feature is separate work.
- Audio editions may not share timing even when labels match. Observe identity/source changes rather than merging identifiers heuristically.
- DRM/CDN/graphics failures remain possible when progress counters look normal. Only live visible-output acceptance can narrow that class, and the extension should report uncertainty.
- The earlier source tests do not validate the deeper review findings. Do not silently mark these tasks complete because they resemble previous fixes.

## 9. Plan completion rule

This plan is prepared when its architecture, dependencies, evidence boundaries, handoff, and review checks are complete. GitHub issue state is authoritative. Publishing this plan or the preservation branch does not mark any remediation issue complete.
