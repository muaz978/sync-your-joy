# Crunchyroll synchronization investigation

Date: 2026-09-19. Branch and verification updated: 2026-09-20. Baseline: SyncYourJoy v0.2.4, commit `1ac5b1c`. Status: candidate implementation and regression validation preserved on `codex/crunchyroll-sync-hardening`; production deployment and authenticated multi-device Crunchyroll acceptance are separate steps.

Subsequent planning review: [the deeper remediation plan](CRUNCHYROLL_REMEDIATION_PLAN.md) identifies additional source-level gaps beyond the tested cases in this report. [The issue map](CRUNCHYROLL_ISSUE_MAP.md) links the canonical GitHub trackers, and [the handoff](CRUNCHYROLL_HANDOFF.md) records the full evidence and remaining work. The candidate test results below do not establish release readiness for the broader scenarios. The remaining remediation plan has not been implemented.

## Finding

Several reproducible defects in the extension and room coordinator can produce the reported symptoms: interruption during seeks, premature resume, false autoplay failures, obsolete episode identity, and a room clock continuing while no useful video progress occurs. They are general media-lifecycle defects that slow or frequently reconfigured streaming players can expose. The investigation does not establish that Crunchyroll itself is defective, or that every reported black screen shares one cause.

The local changes address those defects without depending on private player globals, intercepting streaming requests, or accessing protected media. A complete native Next Episode workflow still uses the existing shared-link action followed by fresh readiness. The changes prevent new-episode playback from being mistaken for the old episode; they do not introduce automatic sharing of every native navigation.

## What was observed in the actual player

The existing watch page for SPY x FAMILY episode 48 exposed a native video in the top document with ID `bitmovinplayer-video-null`. At inspection it had a `blob:` source, duration 1420.002 seconds, `readyState=4`, playback rate 1, and a seekable interval covering the episode. Only approximately seconds 80 through 140 were buffered. There was no player iframe on this page, only a OneTrust iframe. Skip Intro, Next Episode, speed, and audio/subtitle controls were present.

This is strong evidence of a Bitmovin-based player on this inspected page. It does not establish the player version, all-account rollout, streaming format, DRM implementation, or an available public JavaScript instance. Older Vilos iframe assumptions are insufficient for this page. The existing native video discovery already reaches the top-document player, so replacing discovery wholesale or hooking undocumented Bitmovin globals is unnecessary.

The player can seek across the episode while fetching only a short section at a time. A destination outside `buffered` is legitimate. The extension must allow loading at that destination and avoid repeatedly cancelling it. `seekable` and `buffered` have distinct contracts in the [W3C Media Source Extensions specification](https://www.w3.org/TR/media-source-2/#htmlmediaelement-extensions).

Native `play()` is asynchronous. A source change or `pause()` can interrupt it without an autoplay policy failure. Chrome documents this behavior in its [interrupted play request explanation](https://developer.chrome.com/blog/play-request-was-interrupted). Bitmovin also distinguishes requested play from actual playing, and documents its vendor Seek/Seeked events as public-API events. Native controls must therefore be verified using native media events, without assuming identical vendor-event behavior. See the [Bitmovin event reference](https://cdn.bitmovin.com/player/web/8/docs/enums/core_events.playerevent.html).

The detailed source record, failed public fetch attempts, supporting links and confidence limits are in [crunchyroll-source-notes.md](research/crunchyroll-source-notes.md).

## Reproduced defects and implemented behavior

| Area | Failure mechanism | Local change |
| --- | --- | --- |
| In-flight seek | Every heartbeat can replace an unfinished seek with the advancing room position, interrupting loading again. | A playing client waits for its current seek rather than changing the target each second. A newer explicit room target can still supersede it. |
| Slow successful seek | Completion immediately starts another hard seek because the room moved more than the 0.6-second threshold during loading. | A 2.5-second recovery window permits playback with mild rate correction before another hard correction. This is a recovery policy, not a guarantee that large drift instantly converges. |
| Native controller seek | The room barrier can arrive while the host is already seeking to exactly that target. Reassigning `currentTime` restarts it. | Adopt the native seek at the correct destination without assigning it again. |
| Seek timeout ownership | Clearing the local operation at timeout allows repeated retries, and a very late completion can be broadcast as a new host action. | Retain the operation's target after timeout. A native completion, a genuinely different user seek, source reset, or explicit Sync can resolve/supersede it. Do not restart the same timed-out target on every paused heartbeat. |
| Skip Intro and scrubbing | A broad expected-seek time window suppresses genuine user seeks to another target. | Suppression also checks the target. A different native target supersedes the old operation and propagates as controller intent. |
| Seek readiness | Position equality and `seeking=false` can acknowledge an element with metadata but no frame data. | Acknowledgement requires at least current-frame data. Empty seekable ranges defer new assignments. Valid VOD targets remain independent of buffered intervals. |
| Controller premature acknowledgement | Coordinator automatically acknowledged the host as soon as it received the seek request. | Every participant, including the controller, acknowledges actual completion. |
| Queued play during alignment | A play command can clear an incomplete seek barrier. | Coordinator rejects play with `seek_in_progress` until alignment completes or the barrier expires. Existing timeout remains paused at its fixed target. |
| False autoplay failure | Any rejected play promise sets the gesture-required flag, including ordinary `AbortError`. | Only current `NotAllowedError` is a permission rejection. Aborts are treated as interruptions; other media failures retain separate recovery messaging. |
| Stale asynchronous play | Old promises mutate the state of a newer pause, source or video. | Play requests are scoped to their generation, element and source. Immediate local pause, source lifecycle and replacement invalidate pending callbacks. Only one current play promise is issued at a time. |
| Frozen frames behind advancing time | Time movement, including correction seeks, can look like real playback. | Visible-video health uses `getVideoPlaybackQuality()` frame counters where available. Native seeks do not count as normal progress. Hidden tabs and unsupported counters use bounded forward-clock evidence instead of assuming absent rendering is failure. |
| Server progress masking | `progressed:false` is overridden by position change, and stale revisions mutate health before rejection. | Explicit progress evidence is honored. Mismatched revisions are discarded before changing progress/sample state. |
| Indefinite initial loading | `playbackStarted:false` exempts a pending startup from both buffering and normal stall handling indefinitely. | After the scheduled startup window and ten seconds without real progress, coordinator pauses the room without treating it as a permission denial or clearing readiness. Recent progress protects transient restarts. |
| Wrong episode identity | Worker overwrites actual tab identity with the old shared URL after native navigation. | Actual tab URL takes precedence, including worker restoration. Strong local Crunchyroll episode identity gates incoming operations and outgoing control/status immediately, before the next polling cycle. Origin-only legacy iframe referrers defer to worker identity. |
| Replacement frame recovery | Equal-size replacement frames can be rejected once the participant becomes unready. | A stale matching frame can be replaced regardless of that readiness transition, retaining size and room checks. |
| Removed/unreachable frame | Stale media and ready state survive a failed delivery to a missing player. | Clear stale player data, signal unready, retain the tab for rediscovery, and record the failure. A binding generation prevents late failures from retiring a freshly bound replacement. |
| Localized same-episode links | Host/locale/slug variants can open a duplicate tab and discard an initialized player. | Reuse the tab when official Crunchyroll URLs identify the same episode. Preserve complete episode IDs, including observed 14-character IDs. |
| Misleading status and evidence | All ready can display “In sync” even when playback is paused, buffering or catching up. Diagnostic events omit progress/start flags. | Pill distinguishes Ready, Player buffering and Catching up. Diagnostics retain sanitized progress, started and permission-failure flags. |

The initial player harness produced five failures against the original code: repeated seek assignment, aborted play misclassification, stale play rejection, premature seek acknowledgement, and undetected frame freeze. Separate coordinator and worker regressions also failed before their fixes. Later tests cover slow completion, late completion, explicit retry/supersession, healthy/background playback, immediate pause, source reset, episode transition and readiness arrival.

## How synchronization should proceed

1. Identify the actual episode and bind the active video/frame. An old shared URL is an intended destination, never proof of current content.
2. Confirm room readiness. Readiness is a participant's willingness to start; it is not proof that every provider decoder has already started.
3. Schedule play, then observe actual playback. Classify browser permission rejection separately from loading or interruption. Pause the room if startup cannot make progress within the bounded window.
4. For a controller seek or Skip Intro, freeze the room at the requested target. Each participant loads the target and acknowledges independently after seeking ends and current-frame data exists.
5. Resume only after the complete barrier. A timed-out barrier stays paused. A later native completion or explicit Sync can recover the target without forcing a page refresh.
6. During ordinary playback, use gentle rate correction for small differences. Allow a completed slow correction to start playing before another hard seek. Measure frame/clock progress separately from commanded position.
7. On a different episode, stop applying the old timeline and invalidate old operations. Share the new episode using the existing room link control, then confirm readiness again. Equivalent localized URLs for the same episode can reuse the already initialized tab.

## Validation and its limits

Automated results are recorded below and in the session checkpoint. On 2026-09-20, the complete candidate source pass was green: 26 test files, 189 tests, TypeScript validation and both builds. The strengthened real two-profile local-video E2E also passed once on the exact candidate. The test loads two isolated Chrome profiles, the unpacked extension, its real worker/content script/panel and the real local room coordinator. It verifies forward and native backward seeks, visible-frame advancement and convergence against the short generic fixture. It does not use Crunchyroll accounts or protected streams.

The 2026-09-20 sandbox E2E attempt failed before scenario execution with Chrome process SIGABRT/EPERM. Retrying the same command with isolated browser-process permission passed the strengthened scenario in 6.9 seconds, with 4.4 seconds in the scenario. The first attempt was an environment failure and is not counted as a failing product scenario. One passing generic-fixture run is not the D03 repetition, fault, three-member, headed, adaptive or soak matrix.

The browser-package verifier completed its extension builds and reached the macOS Safari packager, which rejected the sandbox staging path with `safari-web-extension-converter requires access to the supplied path`. `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities. No Safari packaging claim is made from this run.

The candidate has been organized into focused commits on `codex/crunchyroll-sync-hardening` for review. It has not been deployed to the production Worker or published as an extension release. Updating the extension alone would not activate the coordinator watchdog, explicit host acknowledgement or server barrier guard in production. Any future release must coordinate backend and extension compatibility, then run the normal production smoke and live acceptance gates.

## Remaining decisions and acceptance work

- **Real protected playback:** Test two separate authorized accounts on the same episode in Edge/Chrome. Repeat with each device as controller. Direct DOM inspection and local media tests do not prove protected decoding, account entitlements, CDN behavior or graphics rendering.
- **Native Next Episode automation:** Current safe flow requires sharing the new link and reconfirming readiness. Automatic controller next-episode sharing should be a deliberate navigation transaction with stale-event protection and readiness reset, then tested independently. This pass prevents silent corruption across episodes; it does not claim seamless native auto-next synchronization.
- **Slow loading policy:** The existing 1.5-second local timeout and 1.8-second room barrier still favor stopping together. Those deadlines can be shorter than an uncached Crunchyroll seek. Collect real seek-duration percentiles before changing them. If extended, preserve the fixed paused target and incomplete-participant indication rather than releasing into divergent playback.
- **Playback speed:** Room playback currently uses a 1x base rate and temporary 0.98/1.02 correction. Native custom speeds are not a synchronized room feature. Do not assume the extension honors every speed-menu selection as room intent. A future capability/base-speed handshake should be separate from drift correction.
- **Audio/language variants:** Do not strip suffixes from episode IDs to force matches. Same episode labels can represent different editions or timing. Test Japanese/subbed, dubbed and audio changes; require the same timed edition when their timelines differ.
- **Frame-counter limits:** Counters detect lack of frame advancement, not whether the visible image is semantically correct. Some graphics/compositor failures can still produce black output while counters advance. No image capture or DRM inspection was added. Confirm visible movement during live testing.
- **Vendor controls:** Native `currentTime` writes may not update every Bitmovin UI/event exactly as its public player API would. Validate UI time, actual time and visible playback together before considering a vendor API bridge. No accessible public Crunchyroll player instance was established.

### Focused live acceptance checklist

| Scenario | Pass condition |
| --- | --- |
| Both ready, Play all | Both native clocks and visible frames advance; no one-sided playback |
| Forward and backward seek inside/outside local buffer | One stable destination per command; both resume, or both remain paused with alignment/recovery state |
| Rapid scrub and Skip Intro after a correction | Final controller target wins; old completion never creates a new room seek |
| Slow guest loading | Fixed target is retained; no second-by-second seek storm or indefinite false “In sync” |
| Pause during pending play or seek | Pause wins on both devices; old promise cannot restart playback or falsely demand another gesture |
| Native Next Episode, then share new link | No old-episode seek applies to new content; fresh readiness is required |
| Audio/source change, video/frame replacement | Binding recovers or clearly becomes unready; stale completion cannot affect replacement |
| Hide and restore a tab | Background rendering suspension is not a false freeze; visible playback health is re-established |
| Permission rejection | Gesture-required participant becomes not ready, local gesture and readiness recovery allow a new host play |
| Freeze/black loader | Detailed report distinguishes no progress, never-started loading and permission failure; visible frames verified separately |

For a failure, collect the detailed report before refreshing and note episode ID, browser/version, controller role, last action, wall-clock time, native current time, visible frame movement and any player error code. Do not include cookies, tokens, license requests or stream URLs.
