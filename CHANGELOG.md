# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning for tagged extension releases.

## [Unreleased]

### Added

- Explicit player-health signals for real progress, confirmed synchronized-play start, and browser play rejection.
- Control-channel quality reporting with RTT, clock uncertainty, and heartbeat age, plus an automatic heartbeat watchdog.
- Standards-first WebExtensions API selection and Firefox package metadata.

### Fixed

- A transient paused sample no longer stops the room immediately after a play command.
- Synchronized backward and forward seeks retry at a bounded 120 ms cadence instead of waiting a full second between attempts.
- Player health baselines recover after visibility changes, bfcache restores, and page focus recovery.

## [0.1.17] - 2026-08-29

### Added

- Player diagnostics in the side panel, including binding frame, light-DOM/open-Shadow-DOM origin, source kind, playback position, pause/buffer state, ready state, network state, duration, and MediaStream status.
- A Redetect player action in every room state, including while a shared page is still loading or has no controllable video.
- Clear unsupported-player guidance for pages that use canvas rendering, closed Shadow DOM, inaccessible frames, or browser-internal surfaces.
- A local generic-player fixture for native video, open Shadow DOM, MediaStream, player replacement, and SPA route testing.
- Additional regression coverage for YouTube, Disney Plus, and generic player-source identity normalization.

### Fixed

- Included player diagnostics in the sanitized detailed report without collecting media bytes, credentials, cookies, or signed URL parameters.

## [0.1.16] - 2026-08-29

### Added

- Broad generic player discovery through light DOM and open Shadow DOM roots.
- Coverage for initialized MediaSource/blob and MediaStream-backed HTML video players, including players that do not expose a normal `src` attribute.
- Continuous recovery for dynamic player insertion, player replacement, metadata/source changes, and single-page-app history navigation.

### Fixed

- Avoided rejecting initialized source-less MSE players while continuing to filter hidden, empty, and decorative video elements.
- Rebound media identity promptly when a site reuses a page or video element for a different route or episode.
- Kept the compatibility boundary explicit for closed Shadow DOM, canvas-only renderers, native applications, browser-internal pages, and inaccessible frames.

## [0.1.15] - 2026-08-29

### Added

- Explicit **Use current**, **Select**, and **Clear** actions for the controller's shared video-page link.
- Interaction-safe side-panel rendering that defers live redraws during text editing, selection, pointer gestures, and button activation.
- Automated Chrome DevTools verification for shared-link selection and Ready-button delivery during a simultaneous room-state update.

### Fixed

- Disabled browser URL autofill in the shared-link field so unrelated clipboard or application history is not inserted automatically.
- Preserved the user's current link selection and manual edits during live playback, latency, and participant updates.
- Prevented duplicate Ready clicks while the first readiness change is waiting for room confirmation.
- Preserved readiness across a brief WebSocket reconnect when the participant returns with the same matching media.
- Prevented an old replaced WebSocket from marking the newly reconnected participant offline.
- Debounced transient media mismatches and extended the player-replacement grace period for ready participants from three to ten seconds.
- Prevented stale mismatching or tiny embedded videos from replacing a ready participant's bound player.
- Reused an already matching bound tab instead of opening a duplicate tab for the controller.
- Completed the clean-install lockfile so CI and release runners can install the edge-service workspace.

## [0.1.14] - 2026-08-29

### Added

- Hide and restore controls for the in-page mini controller, with the preference retained across pages.
- Stable Qfilm media identity based on the outer `vid` parameter.
- Generic nested-player discovery and room-page identity propagation for signed or temporary iframe sources.
- Tag-driven GitHub Release automation, a stable downloadable ZIP filename, and a published SHA-256 checksum.
- Public installation, update, contribution, bug-reporting, and maintainer release documentation.

### Fixed

- Prevented temporary, decoy, and advertising media from replacing the selected room player.
- Improved same-link media matching when participants receive different nested-player URLs.
- Preserved the side-panel scroll position during live room updates.
- Prevented stale buffering samples from immediately pausing a newer play command.
- Kept readiness through ordinary heartbeats and short player replacement during seeking or quality changes.
- Made forward and backward scrubbing use the final controller target, retry acknowledgements, and keep the room safely paused when a real player cannot confirm alignment.

## [0.1.13] - 2026-08-15

### Added

- Sanitized, room-wide detailed diagnostic report collection for beta testing.
- Explicit media detection and confirmed media-loss events.

### Fixed

- Prevented temporary player loss from canceling guest readiness.
- Allowed a paused backward seek to finish without waiting for media-time progress that cannot occur while paused.
- Improved diagnostic visibility for missing seek participants and seek timeout state.

[0.1.15]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.15
[0.1.16]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.16
[0.1.17]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.17
