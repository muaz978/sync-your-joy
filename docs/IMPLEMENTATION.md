# Current implementation

## What works

- Chrome Manifest V3 extension with a persistent side panel.
- Floating Shadow DOM status pill that does not modify proprietary player controls.
- Generic `HTMLVideoElement` detection on YouTube, Netflix, Disney+, Crunchyroll, localhost, and the local test player.
- Room creation and joining with an eight-character code.
- Two to ten participants with persistent participant identity for reconnects.
- One authoritative controller with a server-issued lease epoch.
- Pass-the-remote control transfer.
- Ready state and canonical media fingerprint matching.
- Immediate local controller pause followed by an immediate room broadcast.
- Latency-aware scheduled play and seek.
- Server clock-offset estimation from low round-trip samples.
- Automatic drift handling: ignore small drift, temporarily adjust playback rate for moderate drift, and seek for large drift.
- Debounced buffering detection with pause-for-everyone behavior.
- Monotonic room revisions, stale-command rejection, duplicate action suppression, and snapshot recovery.
- Controller disconnect pause, ten-second recovery grace period, and deterministic handoff.
- Light and dark themes with a restrained neumorphic control treatment.
- Local test player that accepts a device-local video through an object URL.

## Explicit privacy boundary

The manifest does not request:

- `tabCapture`;
- `desktopCapture`;
- `cookies`;
- `webRequest`;
- `debugger`.

The content script reads only the active video element's playback state and a minimal media fingerprint. It does not read streaming credentials, cookies, DRM data, decoded frames, video bytes, audio bytes, page network responses, or unrelated browsing history.

## Current platform approach

The subscription platforms use the generic standards-based video adapter in this first build. The adapter calls ordinary `HTMLMediaElement` operations such as `play()`, `pause()`, `currentTime`, and `playbackRate`. It does not access or alter DRM.

Commercial streaming sites change their page structure and playback behavior regularly. Each platform still needs a dedicated compatibility and regression test pass before it can be described as production-supported. The generic adapter fails visibly when it cannot find a controllable video instead of attempting to bypass the player.

## Current development limitations

- The room service is in-memory and localhost-only.
- Rooms disappear when the service restarts.
- The extension is an unpacked development build and is not ready for Chrome Web Store submission.
- There is no account system, chat, voice, video calling, or room history.
- Episode transitions require participants to confirm the new media state; automated next-episode coordination is not implemented.
- There is no production abuse prevention beyond message validation, room size limits, per-connection rate limiting, expiring empty rooms, and unguessable internal room tokens.
- The backend is not yet deployed to Cloudflare Durable Objects.

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
- server and extension production builds.

Run everything with:

```bash
npm run check
```

## Next production milestone

1. Port the room coordinator to Cloudflare Durable Objects with WSS.
2. Replace the hard-coded local endpoint with environment-specific build configuration.
3. Add browser automation across two persistent Chrome profiles with network shaping.
4. Create versioned compatibility fixtures for Crunchyroll, Netflix, and Disney+.
5. Add privacy disclosures, telemetry consent, retention policy, and adapter kill switches.
6. Run a small private pilot before making synchronization performance claims.
