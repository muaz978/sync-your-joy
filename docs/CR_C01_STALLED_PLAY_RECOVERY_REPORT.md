# CR-C01 stalled play recovery report

Status when written (historical): implementation complete locally on branch `codex/issue-62-sync-recovery`; pull-request review, hosted checks, merge, deployment and external acceptance remain separate gates. Update 2026-10-16: merged as PR #90 and shipped in v0.2.5; #62 stays open for the external acceptance gates (live provider, installation, two accounts or devices, user acceptance) under "Remaining gates".

Issue: [#62, CR-C01: Make explicit Sync recover stalled play attempts safely](https://github.com/muaz978/sync-your-joy/issues/62)

## Scope

CR-C01 covers the extension-side case where a provider or browser returns a `HTMLMediaElement.play()` promise that never settles. The unresolved promise previously kept the current play generation occupied indefinitely. A later heartbeat could not begin a new attempt, and correction logic could move the native target while the original player request was still unresolved.

The change remains within SyncYourJoy's state-only integration boundary. It observes the native play promise, media lifecycle and playback-health signals, but does not access provider credentials, private APIs, protected media, signed stream URLs or DRM material.

## Source findings before the change

- `apps/extension/src/content-script.ts` already associated play callbacks with `PlayerOperations` generations and ignored stale success or rejection after a newer room command or source change.
- The existing rejection path distinguished browser permission denial (`NotAllowedError`) from interruption (`AbortError`) and other native failures.
- The existing health path separately represented buffering, rendered-progress evidence, missing progress and explicit playback-start failure.
- `apps/extension/src/player-operations.ts` prevented more than one active play request, but it had no observable active-play state for the authoritative correction loop and no deadline for a promise that never settles.
- A pending play request could therefore remain the owner forever. Because the video could still appear paused, heartbeat correction could also attempt a moving seek while the unresolved play request was waiting for the provider.

## Implementation

### Bounded play-attempt deadline

`PLAY_REQUEST_TIMEOUT_MS` uses the existing shared `PLAYBACK_STARTUP_TIMEOUT_MS` value of 10 seconds. This keeps the local deadline aligned with the coordinator's existing startup-timeout semantics instead of introducing a second uncoordinated timeout.

When the current play promise reaches the deadline:

1. The attempt is retired from `PlayerOperations`.
2. The expected play-event window is cleared.
3. The local recovery barrier is set, preventing heartbeat-driven automatic retries.
4. If the element became unpaused without resolving the request, it is paused and the pause is attributed to the recovery path.
5. Transactional callers receive their failure callback so a later retry can create a fresh operation key attempt.
6. The user receives an actionable notice to press Sync, and a player status report records buffering without marking the failure as a permission denial.

The recovery barrier is released by an explicit Sync action or by a newer room command. Until then, heartbeats do not issue another play request or corrective seek. This prevents a never-settling provider call from becoming a play storm.

### Callback and source ownership

Normal resolution and rejection clear the deadline before settling the current operation. A late resolution or rejection from an old operation cannot clear the timer or mutate the newer attempt because the callback must still match the current play generation, element and `currentSrc`.

`PlayerOperations.hasActivePlay` also makes the pending-play state visible to the authoritative correction loop. While the promise is pending, the loop waits instead of chasing an advancing room clock with a new native seek.

### Failure classification

The existing classifications remain separate:

| Condition | Observable handling |
| --- | --- |
| Never-settling play promise | Bounded timeout, buffering report, recovery notice, explicit Sync retry boundary |
| `NotAllowedError` | `playbackStartFailed` is set and the user is told that a gesture is required |
| `AbortError` | Treated as an interruption from pause, load or source replacement, without a false permission failure |
| Other native rejection | Generic player-start failure notice and health report |
| Missing or replaced player | Existing player scan and lifecycle invalidation retire the old operation and clear its deadline |
| Missing rendered progress | Existing health evidence and coordinator deadlines remain responsible for buffering or stall recovery |

## Regression coverage

The extension lifecycle test now proves that:

- a never-settling play promise remains the sole attempt before its deadline;
- heartbeat processing does not issue corrective seeks while that play request is pending;
- the ten-second deadline retires the attempt and reports buffering without `playbackStartFailed`;
- no additional play call occurs during subsequent heartbeats;
- an explicit Sync retry starts a fresh play attempt;
- the old promise can resolve after the retry without changing the new attempt or causing another play call.

Existing tests continue to cover stale play rejection after a newer pause, source replacement, genuine `NotAllowedError`, `AbortError`, missing progress, player health refresh and replaced or invalidated player operations.

## Transactional path and further coverage (2026-11-15)

The original change bounded a never-settling `play()` for the room's ordinary play command. A transactional play (a committed operation) reached the same deadline, but the heartbeat then started a new `play()` of its own, because the operation's attempt marker is cleared on failure and the transactional path did not look at the recovery barrier. Within 15 seconds the extension made two `play()` calls, with no Sync and no coordinator reply. `applyTransactionalOperation()` and `requestTransactionalPlay()` now honour the barrier: after the deadline the heartbeat asks again only when the barrier has been lifted. It is lifted by an explicit Sync, by a newer room command, and by a new player: a source change (`loadstart`, `emptied`), a media `error` event, an element replacement or a page-identity change reset the player's operations and the barrier with them, because a new player decides for itself whether the browser still refuses playback. That reset allows one new attempt per new player, not a retry on every heartbeat.

Unit tests (`content-script.test.ts`, "a play() that never settles (CR-C01, #62)", with a fake element that reports itself unpaused while the promise is pending and rejects the pending promise with an `AbortError` when paused):

| Behaviour | Test |
| --- | --- |
| A committed operation whose `play()` never settles: one call, the notice at 10 s, still one call after 30 s without a coordinator reply | "is asked for once, then left alone for 30 seconds without a coordinator reply" |
| An explicit Sync starts one fresh `play()` and no more | "starts one fresh play() on an explicit Sync, and only one" |
| A newer operation starts again without a Sync | "lets a newer operation start again without a Sync" |
| The deadline pauses the unpaused element once, the interruption it causes is the old attempt's and is ignored, buffering is reported and the failure is not a permission failure | "pauses the unpaused element once at the deadline, ignores the interruption it causes and reports buffering" |
| A replaced element: the old attempt's late rejection does not touch it and its deadline goes away. The old promise is left pending through `pause()`, so the rejection can only arrive after the replacement (with a fixture whose `pause()` settles the promise, the late result would be a no-op whether or not the guard exists) | "does not let the old element's late rejection touch a replacement element, though its promise stayed pending through pause()" |
| Other native rejections give an actionable notice and no permission claim | "reports a NotSupportedError ..." and "... a TypeError ..." |
| A player that is reloaded after a deadline gets one new attempt, and none more on the heartbeat in between | "is asked for once more per reloaded player, and not on the heartbeat in between" |
| A rejected `play()` (`NotAllowedError`, `NotSupportedError`, `TypeError`), room play command and committed operation: asked for once, and still once after 30 seconds of heartbeats | "a play() the browser rejects", "is not asked for again by the heartbeat ..." (two per rejection) |
| Lifted once by an explicit Sync, by a newer operation, by an unattributed native play event, and by `loadstart`, `emptied` or `error`; and then bound again | "is tried once more on an explicit Sync, and only once", "... for a newer operation ...", "... after an unattributed native play event ...", "allows one new attempt after a loadstart event ..." |
| An `AbortError` is an interruption and is not counted as a rejection | "does not count an AbortError as a rejection: the interrupted play() is asked for again" |
| Sync with no player says the shared player is still loading | "says that the shared player is still loading" |

Mutation checks (a production line edited in place, the file run, the file restored): 21 mutations, 16 killed on a single edit. Of the first 10: removing both barrier guards fails three tests; each guard alone survives because the other still stops the request (defence in depth); the old attempt's timer left in place on replacement survives, because the timer's own `isCurrent()` check already makes it a no-op. Of the 11 for the rejection bound: killed are removing the stale-result guard from the rejection handler (4 tests, including the replacement test above), no latch on a rejection, an `AbortError` that latches, the ordinary path ignoring the latch, the transactional path ignoring it in both places, Sync / a newer command / a new player not lifting it, an unattributed native play not lifting it, and a latch set only for `NotAllowedError`. Survived: the stale-result guard without its `video === target` condition (the operations' own source and command generations already make a replaced element's result stale), and either one of the two transactional checks alone (each is redundant with the other).

### A rejected play() is not retried by the heartbeat

Before this change a `play()` that was rejected with `NotSupportedError`, `AbortError` or `NotAllowedError` was asked for again on every heartbeat while the room kept playing: 31 calls in 30 seconds. In a connected room the coordinator ends the start (on `NotAllowedError` at once, otherwise through the buffering grace), but the content script had no bound of its own. A rejection other than an `AbortError` (an interruption by our own `pause()`, a reload or a replacement, which is expected and is not counted) now sets a latch (`playRequestRejected` in `content-script.ts`). While it is set neither the ordinary path (`playVideo()`) nor the transactional path starts a `play()`. It is lifted by: an explicit Sync; a newer room command; a native play event that the extension did not itself request (unattributed: `handlePlay()` checks only that the play was not the extension's own request, so a person's click and a page script's own `play()` are not told apart, and no user-activation check is made); and a new player (a source change, a media `error` event, an element replacement). So there is no automatic retry after a rejection: the person acts, or the room moves on. The notice already tells the person to press Sync. A reload or an `error` event can lift the latch once per event, so the bound is per player instance and per command, never per heartbeat. By the media element specification a rejected `play()` does not itself fire `loadstart`, `emptied` or `error`, so the loop is not reachable through those events (this was not observed in a browser here).

### Not done

- Sync pressed inside the ten-second window returns silently (the pending play is neither retired nor reported). The owner has not decided whether it should retire the play and show a notice or whether the criterion should say "after the deadline".
- A native media error resets the player's operations but has no notice or participant status of its own (the same open decision).
- The "Hang next play" control in `apps/room-service/static/test-player.html` and a scenario in `tests/e2e/three-profile-browser-matrix.spec.ts`: outside this change, and Chromium could not be run.
- Mapping an expired deadline to "Needs recovery" in the participant status (overlaps #64).

## Verification

Focused local verification completed when the change was written (historical, version 0.2.4):

- `npm exec vitest run apps/extension/src/content-script.test.ts apps/extension/src/player-operations.test.ts --pool=forks --poolOptions.forks.singleFork=true`: 2 files, 64 tests passed.
- `git diff --check`: passed.

The full repository check, typecheck, builds, audit, browser package smoke, local room smoke and edge deployment dry run remain required before opening the pull request. No remote deployment or browser installation has been performed for CR-C01.

## Security, privacy and provider boundary

- The implementation handles only native player state, promise outcomes, operation ownership and health evidence.
- It does not inspect media bytes, captions, audio, screenshots, cookies, credentials, private provider APIs, signed playback URLs or DRM keys.
- The timeout is an extension recovery signal, not proof that the provider's visible video output is healthy or unhealthy.
- A deterministic fake-media test proves callback ownership and retry behavior, not authenticated Crunchyroll playback, visible frames, subscription access, cross-account behavior or two-device acceptance.

## Remaining gates

This report does not establish:

- an independently approved GitHub review, because the repository owner cannot approve their own pull request;
- hosted checks for the final PR head;
- authenticated live Crunchyroll behavior in the signed-in browser session;
- installation of the resulting extension package;
- two-account or two-device acceptance;
- remote staging or production deployment;
- final user acceptance or release qualification.

Issue #62 must remain open until its applicable source, browser, live-provider, device, deployment and user-acceptance gates are recorded. The extension is at 0.2.12 at the refresh of 2026-11-15; no #62 evidence is recorded against v0.2.7 to v0.2.12, and no release or deployment is authorized by this report. Release `1.0.0` remains reserved for complete milestone acceptance.
