# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning for tagged extension releases.

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
