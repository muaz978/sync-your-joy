# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning for tagged extension releases.

## [Unreleased]

### Changed

- Joining a room now requires host approval: a brand-new participant's `join_room` becomes a pending request the controller must explicitly approve or deny (a new `respond_to_join` message) before that identity becomes a real room member. Reconnecting an already-known participant identity is unaffected and stays instant. This closes the last open gap in `docs/CODE_AUDIT.md` SYJ-AUD-003.

## [0.1.23] - 2026-09-18

### Fixed

- `acknowledgeSeek()` no longer permanently deadlocks a pending seek when an unrelated readiness/handoff event bumps the room revision mid-barrier.
- The 10-participant room cap now counts currently-connected participants instead of every participant ID ever seen, so a churny room can't get permanently stuck at capacity.
- Seek/play targets and drift-derived positions are now clamped to the known media duration.
- Stale, out-of-order player-status samples no longer reset stall detection and mask a real freeze.
- Room snapshots no longer leak two internal-only timing fields to every room member.
- The per-provider page-URL allowlist is now actually applied to the media fingerprint that gets stored and broadcast, closing the last part of the query-string privacy gap.
- `room-service`'s pending-connection cap is now scoped per remote IP instead of globally per process; both `room-service` and `edge-service` now reject a missing WebSocket `Origin` header and rate-limit repeated connection attempts from one IP over time, not just concurrently open ones.
- `diagnostics_response` is now checked against an outstanding `request_diagnostics`, so a connected member can no longer flood the controller with fabricated reports.
- `room-service` now always mints its own random room code instead of trusting a client-supplied one.
- The service worker's reconnect backoff now has a `chrome.alarms` fallback so it survives being suspended, and a stale socket's `close` handler can no longer kill a newer socket's heartbeat.
- Shared-navigation state is no longer marked "handled" before its deferred side effect runs, and the `OPEN_LINK` path now uses the same page-URL allowlist as the rest of the protocol.
- A late native `seeked` event after a local-seek timeout is no longer misclassified as a fresh seek and re-broadcast to the room.
- The shared-link draft in the side panel can no longer be overwritten by server state while the field is focused, and a pointer-down inside the panel released outside it no longer permanently blocks re-renders.
- A participant record created without a session token can no longer be impersonated on reconnect.
- Room codes are now generated with rejection sampling instead of a plain modulo, so uniformity no longer silently depends on the alphabet length dividing 256 evenly.
- `apps/extension/dist` is now restored to the Chrome build even when the Firefox verification step fails.
- Patched dependency vulnerabilities in `sharp` (via `wrangler`/`miniflare`) and `vitest`/`@vitest/mocker`.

### Added

- CodeQL code scanning and Dependabot version-update PRs, plus a security policy for reporting vulnerabilities privately.
- DevSkim as a second, free code scanner alongside CodeQL.
- A branch-protection ruleset on `main`: no force-push or deletion, and typecheck/test/build plus CodeQL must pass before merging.

### Changed

- `vitest` 4 -> 5, `unocss`/`@unocss/preset-wind4`, `@types/node`, `@types/chrome`, `tsx`, and `actions/checkout`/`actions/setup-node`/`github/codeql-action` (CI-only) updated via Dependabot; re-verified with a clean install and the full test suite afterward.

### Fixed (continued)

- CodeQL's biased-random-number rule on room-code generation (3 locations): switched from a plain modulo to rejection sampling so uniformity no longer silently depends on the alphabet length dividing 256 evenly.
- Reviewed and dismissed one CodeQL DOM-XSS alert as a false positive (a local file-input selection turned into a `blob:` URL, never remote data), with the reasoning documented at the source.
- Reviewed and dismissed 30 DevSkim alerts as false positives: `setTimeout` calls that only ever receive a function (DevSkim's rule can't distinguish that from the legacy string-eval form), and intentional, already-documented local-development `localhost`/`http://` references.

## [0.1.22] - 2026-08-30

### Fixed

- Keep diagnostics responses below the room WebSocket message budget by trimming the oldest events first.
- Protect participant reconnects with issued session capabilities and allow Firefox/Safari WebExtension origins.
- Remove unknown query parameters from media identity URLs while preserving reviewed video identifiers.
- Add pending-connection and maximum-room-lifetime safeguards.
- Verify browser packages during tagged releases, restore Chrome output after browser smoke, omit source maps from public ZIPs, and update GitHub Actions to Node 24-compatible action majors.

## [0.1.21] - 2026-08-30

### Fixed

- All controller seek paths now count the controller side immediately, preventing native dragging and side-panel seek controls from waiting forever for a second controller acknowledgement while still requiring every guest to confirm.

## [0.1.20] - 2026-08-30

### Fixed

- Controller-originated native seeks now confirm the controller side immediately after its own `seeked` event, preventing a one-sided seek barrier from timing out while still requiring every guest to acknowledge.
- Room-wide detailed diagnostic collection now retries for up to eight seconds so a waking or throttled guest is less likely to be missing from the debug report.

## [0.1.18] - 2026-08-29

### Added

- Explicit player-health signals for real progress, confirmed synchronized-play start, and browser play rejection.
- Control-channel quality reporting with RTT, clock uncertainty, and heartbeat age, plus an automatic heartbeat watchdog.
- Standards-first WebExtensions API selection and Firefox package metadata.

### Fixed

- A transient paused sample no longer stops the room immediately after a play command.
- Synchronized backward and forward seeks retry at a bounded 120 ms cadence instead of waiting a full second between attempts.
- Player health baselines recover after visibility changes, bfcache restores, and page focus recovery.

## [0.1.19] - 2026-08-29

### Added

- First-use in-extension privacy disclosure and acknowledgement before creating or joining rooms.
- Deterministic network-chaos coverage for delayed controls, duplicate actions, seek barriers, and seek timeouts.
- Reproducible PNG toolbar/store icons and Chrome, Firefox, and macOS Safari package smoke verification.
- Gates 1-3 privacy, store, closeout, and two-city friend-test documentation in Markdown, Word, and PDF formats.

### Fixed

- Release and package documentation now points to one consistent beta version and the downloadable test guide artifacts.

## [Unreleased]

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
[0.1.18]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.18
[0.1.19]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.19
[0.1.20]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.20
[0.1.21]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.21
[0.1.22]: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.22
