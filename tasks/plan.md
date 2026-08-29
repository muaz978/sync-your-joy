# Implementation Plan: Broad browser video-player compatibility

## Overview

Expand SyncYourJoy's generic adapter so it detects and tracks the largest practical set of browser-hosted media players without screen capture, media transport, DRM access, or page-specific hacks. The first slice targets native HTML5, MSE, MediaSource/blob, MediaStream, dynamically inserted players, open Shadow DOM, nested matching frames, and single-page navigation.

## Architecture decisions

- Keep the synchronization boundary on `HTMLVideoElement` playback state only. Native HTML5, MSE, HLS/DASH adapters, and most DRM players expose a video element even when the underlying media format differs.
- Traverse open Shadow DOM roots in the content script. Closed Shadow DOM is intentionally unsupported because browser page isolation does not expose its internals to ordinary content scripts.
- Retain `all_frames`, `match_about_blank`, and `match_origin_as_fallback` so matching child frames and related `data:`, `blob:`, and `filesystem:` frames can receive the adapter.
- Treat a player as usable when it has a source, a source object, or an initialized media network state with metadata. Do not reject valid MediaSource players merely because a temporary `src` attribute is absent.
- Re-evaluate page identity on SPA history changes and source/metadata events without replacing the selected element. This avoids stale fingerprints on sites that reuse one video element for a playlist.
- Continue selecting one primary visible player per frame. Canvas-only renderers, native applications, browser-internal pages, closed Shadow DOM, and cross-origin frames that Chrome does not inject into remain explicit compatibility limits.

## Task list

### Phase 1: Generic discovery foundation

- [x] Task 1: Add tested recursive discovery for light DOM and open Shadow DOM video elements.
- [x] Task 2: Expand usable-source checks for MediaSource/blob, MediaStream, and initialized source-less media elements while retaining decoy protection.

### Checkpoint: Discovery foundation

- [x] Focused discovery and adapter tests pass.
- [x] Existing full test suite remains green.

### Phase 2: Lifecycle and identity resilience

- [x] Task 3: Observe open Shadow DOM roots and dynamic player changes with bounded MutationObservers.
- [x] Task 4: Detect SPA history changes and media metadata/source transitions immediately, preserving room binding and readiness semantics.

### Checkpoint: Lifecycle resilience

- [x] TypeScript, tests, and production builds pass.
- [ ] A real browser fixture verifies a player inserted inside an open Shadow DOM root and a same-element SPA URL change. The installed Chrome's headless mode did not inject MV3 content scripts, so this remains a headed/manual validation item rather than a release claim.

### Phase 3: Compatibility documentation and release readiness

- [x] Task 5: Document the compatibility matrix, unsupported renderer classes, permission boundary, and troubleshooting path.
- [x] Task 6: Run the existing production-connected protocol smoke and package a versioned release after the generic adapter regression suite passed. Provider playback remains subject to per-site manual validation.

### Checkpoint: Complete

- [x] The code, tests, builds, documentation, and package acceptance criteria are verified.
- [x] No claim is made for closed Shadow DOM, canvas-only, native-app, or inaccessible browser-internal players.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Multiple videos on a page | Wrong player receives room commands | Keep visibility, source, readiness, active-playback, and area scoring; require matching media before readiness. |
| Shadow-root observer growth | Memory or CPU overhead | Track only discovered open roots, reuse observers, and disconnect roots no longer reachable during scans. |
| Signed or per-client media URLs | False mismatch between participants | Prefer authoritative shared page identity and stable provider IDs; never use transient signed query strings as identity. |
| Autoplay or provider policy blocks play | Room clock can advance without frames | Preserve existing player-health reporting and explicit user-gesture Sync recovery. |
| Closed or canvas-only players | No controllable HTML media element | Surface an explicit unsupported-player status and document the browser security limitation. |

## Official references

- Chrome content script frame matching: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- Chrome related-frame injection: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- HTMLMediaElement.currentSrc: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentSrc
- HTMLMediaElement.readyState: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState
- ShadowRoot: https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot
