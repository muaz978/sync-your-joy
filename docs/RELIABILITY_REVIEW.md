# Reliability review and roadmap

Review date: 2026-08-12.

## What this pass fixed

- Native controller play and pause events become authoritative room controls automatically.
- Progress-bar dragging is protected from old-state correction; the final `seeked` position is debounced and synchronized after release.
- Rapid ordered controls remain valid when they share an older room revision, provided the controller lease is still current.
- Programmatic play, pause, and seek operations have separate acknowledgements, preventing feedback loops without hiding a genuine user action behind a broad timer.
- Playback state is sent only to the room's bound player tab and exact frame. Unrelated background videos and embedded ads cannot report state or receive pause/seek commands.
- The generic adapter now runs on HTTP/HTTPS pages and ranks video frames by visible player area before readiness locks the binding.
- The controller can schedule one normalized HTTP/HTTPS link to open in a new tab for everyone. Navigation pauses the room, resets readiness, and automatically re-runs media matching.
- Equal normalized page links are a strong match, with fragments, tracking parameters, default ports, query order, and trailing slashes normalized consistently.
- State barriers reject delayed controls and link commands after membership, readiness, navigation, buffering, disconnect, or controller changes while still allowing rapid ordered controls from one current controller context.
- Joining, reconnecting, losing readiness, navigating, or disconnecting pauses an active room so nobody silently continues out of sync.
- Buffering reports are ignored while seeking and from participants who are not ready on the matching video.
- A visible in-page **Sync** action recovers from Chrome autoplay blocking and hard-aligns the local player without a refresh. Script-initiated `HTMLMediaElement.play()` can be rejected until the page receives a user gesture, so literal zero-click playback cannot be guaranteed by an extension. See [MDN's `play()` behavior](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/play).
- Guests can join before a player or link exists; only the controller supplies the shared page after the room assembles.
- Rejected play promises, unexpected pauses, and non-advancing playback are surfaced as stalls and pause the room instead of allowing the authoritative timeline to advance invisibly.
- Click-to-load Animerco pages receive a narrow automatic bootstrap, while known advertising frames are excluded from player candidacy.
- The in-page **Room** button calls `chrome.sidePanel.open()` directly from its user gesture, matching [Chrome's Side Panel requirement](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).

## Recommended next work

### P0 — before expanding the private pilot

1. **Automated two-browser tests with network shaping.** Run two persistent Chrome profiles against the deployed coordinator and test 50–300 ms latency, jitter, packet loss, reconnects, tab reloads, and host closure. Record command-to-application time and steady-state drift.
2. **Versioned platform adapters.** Keep the generic HTML5 adapter as a fallback, but isolate Crunchyroll, Netflix, and Disney+ media identity, player discovery, capability checks, and known failure modes behind independent kill switches.
3. **Privacy-safe diagnostic export.** Let a tester download a small JSON report containing extension version, adapter version, anonymized room revision timings, RTT, clock uncertainty, correction counts, autoplay failures, and error codes—never URLs, titles, credentials, cookies, video, or audio.
4. **Episode-transition handshake.** When a service advances to the next episode, pause the room, clear readiness, identify the new episode, and require every participant to confirm before resuming.
5. **Reconnect preflight.** After a tab reload or browser suspension, re-measure clock offset, restore the latest snapshot, verify the episode, and require readiness before that participant rejoins playback.
6. **Shared-link trust controls.** Before public distribution, show the destination hostname prominently, warn on cross-domain changes, and optionally let guests require confirmation before a host-opened link.
7. **Player capability handshake.** Report whether each bound player supports seeking, playback-rate correction, and script-initiated play so the room can choose compatible correction behavior instead of discovering limitations mid-watch.

### P1 — synchronization quality

1. **Frame-aware measurements.** Evaluate `HTMLVideoElement.requestVideoFrameCallback()` for presentation-time sampling. It exposes media timestamps and expected display time without reading video pixels, and is designed for frame-timed synchronization use cases. Keep `currentTime` as the fallback. See [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback).
2. **Adaptive correction per participant.** Tune soft-rate and hard-seek thresholds using measured clock uncertainty, buffering history, frame cadence, and whether the destination lies in the player's `seekable` range.
3. **Explicit tab-suspension state.** Detect frozen/discarded bound tabs and show **Tab suspended** rather than pretending they are synchronized. Chrome can freeze or discard hidden pages under resource pressure; see the [Page Lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).
4. **Command acknowledgements.** Add action IDs and client application timestamps to diagnostics so the UI can distinguish **sent**, **scheduled**, **applied**, and **blocked by player**.
5. **Invite hardening.** Pair the human room code with an unguessable invite secret or host approval before broader distribution.
6. **Seek-range validation.** Clamp synchronized seeks to each player's current `seekable` ranges and report a clear **Live edge unavailable** or **Segment not loaded** state when exact placement is impossible.

### P2 — product additions after reliability targets pass

- reactions and lightweight chat;
- configurable pause-on-buffer versus catch-up policy;
- co-host permissions and requests to pause;
- Chrome Web Store packaging, privacy disclosure, support workflow, and automatic updates;
- Firefox/Edge feasibility after the Chrome adapter matrix is stable.

## Performance claims

The deployed design minimizes and measures latency, but no internet product can promise literal zero latency. Public claims should be based on multi-device measurements such as 95th-percentile remote pause time and 95th-percentile steady-state drift under a defined network condition.
