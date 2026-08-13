# Current implementation

## What works

- Chrome Manifest V3 extension with a persistent side panel.
- Floating Shadow DOM status pill that does not modify proprietary player controls.
- Generic `HTMLVideoElement` detection on HTTP/HTTPS pages, including embedded video frames.
- Room creation and joining with an eight-character code.
- Two to ten participants with persistent participant identity for reconnects.
- One authoritative controller with a server-issued lease epoch.
- Pass-the-remote control transfer.
- Explicit ready controls for every participant, including the controller, with canonical media fingerprint matching.
- Stable Crunchyroll episode fingerprints based on the `/watch/{episode-id}` value, independent of domain, locale path, page slug, or translated title.
- Per-room tab-and-frame binding with largest-player selection, so background videos and embedded ads cannot overwrite media identity or playback state.
- A controller-only **Open link for everyone** action that validates and normalizes an HTTP/HTTPS video-page URL, schedules a new tab on all connected clients, pauses the room, and clears readiness.
- Video-free create/join onboarding, allowing the room to assemble before the controller chooses and launches a page.
- A guarded Animerco click-to-load adapter that starts the site's default player only for a room-shared page and filters known advertising frames.
- Shared-page identity propagation through arbitrarily nested players, preventing per-client signed iframe URLs from causing false mismatches.
- Related-frame injection for `about:`, `data:`, and `blob:` player documents through Manifest V3 `match_origin_as_fallback`.
- Same-normalized-link matching as a strong media identity signal, including generic platforms and localized page metadata.
- A **Recheck this tab** recovery action when the active player does not match the room.
- Automatic controller intent capture from the native player's play, pause, and completed seek events.
- Scrub protection that lets the controller drag freely, then broadcasts the final progress position after release.
- Operation-specific feedback-loop suppression so a real controller action is not mistaken for a programmatic correction.
- In-page **Sync**, side-panel **Sync me now**, and controller **Sync everyone** recovery actions that avoid page refreshes.
- Automatic blocked-play and stalled-progress detection that reports buffering and pauses the authoritative room timeline.
- Metadata-aware seeking with duration and `seekable`-range clamping, retry-on-media-ready, and `seeked` completion gating before synchronized playback resumes.
- Revision-bound player-health reports so a delayed pre-play buffering sample cannot cancel a newer play command.
- A shared 2.5-second scheduled-play settling window that ignores expected decoder/network startup while retaining automatic pause-all for genuine later stalls.
- Authoritative **Play all** positioning after **Sync everyone**, independent of an older local player sample.
- Transactional seeks: the room timeline pauses at a fixed target, every active player confirms a completed `seeked` operation with current-frame data, and playback resumes on one new effective server time.
- Last-target-wins handling for overlapping drags; acknowledgements from superseded seek revisions are ignored.
- Finite-duration VOD seeks target the requested time even when a provider temporarily exposes only a partial `seekable` range; live/unknown timelines remain range-clamped.
- Fast seek completion: 60 ms final-drag debounce, native `seeked` acknowledgement without an extra decoded-frame gate, 80 ms fallback probes for providers that omit the event, and 250 ms retries until the room—not merely the local worker—confirms receipt.
- Scrub-first capture: controller targets are broadcast from the stabilized `currentTime` during `seeking`/`timeupdate`, without waiting for a provider's optional or delayed `seeked` event; a later duplicate completion is suppressed.
- A 750 ms authoritative barrier ceiling releases already aligned participants while any unusually slow provider continues catching up locally, eliminating indefinite `Aligning` deadlocks.
- Immediate local controller pause followed by an immediate room broadcast.
- Latency-aware scheduled play and seek.
- Server clock-offset estimation from low round-trip samples.
- Automatic drift handling: ignore small drift, temporarily adjust playback rate for moderate drift, and seek for large drift.
- Debounced buffering detection with pause-for-everyone behavior.
- Monotonic room revisions, ordered rapid controls under the current controller lease, duplicate action suppression, and snapshot recovery.
- Controller disconnect pause, ten-second recovery grace period, and deterministic handoff.
- Light and dark themes with a restrained neumorphic control treatment.
- Local test player that accepts a device-local video through an object URL.
- Cloudflare Worker routing each room code to one stateful Durable Object.
- Hibernating edge WebSockets with persisted room snapshots and alarm-driven controller recovery and room expiry.
- Environment-specific extension builds for localhost or a deployed WSS coordinator.
- A two-client deployment smoke test covering create, join, ready, ping, scheduled play, progress seek, and rapid pause/play.

## Explicit privacy boundary

The manifest does not request:

- `tabCapture`;
- `desktopCapture`;
- `cookies`;
- `webRequest`;
- `debugger`.

Universal player discovery requires content-script host access on HTTP and HTTPS pages, so Chrome will show an all-sites access warning for this beta. The script does nothing on pages without a video, and room playback state is delivered only to the selected tab and frame.

The content script reads only the bound video element's playback state and a minimal media fingerprint containing service, canonical media ID, title, duration, and normalized containing-page URL. It does not read streaming credentials, cookies, DRM data, decoded frames, video bytes, audio bytes, page network responses, or unrelated browsing history.

## Current platform approach

All HTTP/HTTPS platforms use the generic standards-based video adapter in this build. The adapter calls ordinary `HTMLMediaElement` operations such as `play()`, `pause()`, `currentTime`, and `playbackRate`. It does not access or alter DRM.

Commercial streaming sites change their page structure and playback behavior regularly. Each platform still needs a dedicated compatibility and regression test pass before it can be described as production-supported. The generic adapter fails visibly when it cannot find a controllable video instead of attempting to bypass the player.

## Current beta limitations

- The Node room service is still available for local development; the remote beta build targets the Durable Objects backend.
- The deployed beta endpoint is `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`.
- Rooms are intentionally ephemeral and expire after all participants have left.
- The extension is an unpacked development build and is not ready for Chrome Web Store submission.
- There is no account system, chat, voice, video calling, or room history.
- Episode transitions still require participants to confirm the new media state; the host can coordinate them with **Open link for everyone**, but automatic next-episode detection is not implemented.
- There is no production abuse prevention beyond message validation, room size limits, per-connection rate limiting, expiring empty rooms, and unguessable internal room tokens.
- Automated two-browser compatibility tests on live Netflix, Disney+, and Crunchyroll players are still required.

## Verification

The repository currently checks:

- clock estimation and expected timeline calculations;
- soft and hard drift correction decisions;
- readiness gating and media mismatch;
- controller-only actions and lease transfer;
- at-most-once action IDs and monotonic revisions;
- buffering pause behavior;
- WebSocket create/join flow and malformed message handling;
- absence of capture, cookie, interception, and debugger permissions;
- strict TypeScript compilation;
- server and extension production builds;
- room coordinator serialization and restoration;
- a two-client smoke flow covering shared-link navigation, create/join, readiness, scheduled play, seek, and rapid controls against local or deployed Cloudflare Workers.

Run everything with:

```bash
npm run check
```

## Next production milestone

1. Run the private two-city pilot and record connection, autoplay, buffering, and drift observations.
2. Add browser automation across two persistent Chrome profiles with network shaping.
3. Create versioned compatibility fixtures for Crunchyroll, Netflix, and Disney+.
4. Add privacy disclosures, telemetry consent, retention policy, and adapter kill switches.
5. Validate performance objectives before making synchronization claims.
