# CR-C01 stalled play recovery report

Status: implementation complete locally on branch `codex/issue-62-sync-recovery`; pull-request review, hosted checks, merge, deployment and external acceptance remain separate gates.

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

## Verification

Focused local verification completed:

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

Issue #62 must remain open until its applicable source, browser, live-provider, device, deployment and user-acceptance gates are recorded. The package version remains `0.2.4`. Release `1.0.0` remains reserved for complete milestone acceptance.
