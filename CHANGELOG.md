# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning for tagged extension releases.

## [0.2.4] - 2026-09-18

### Fixed

- Opening a new video link now starts it at position zero. `openLink()` was carrying the previous video's extrapolated position forward across a media change, so an episode transition could authoritatively "pause" the brand-new episode wherever the last one happened to be -- a real friend hit this as a fresh episode starting seconds from its own end.
- The extension no longer sends routine messages (readiness, player status, seek acknowledgement) on a socket that has reopened but not yet finished rejoining its room. That race could surface a live "Create or join a room first" error while the panel still showed a fully connected room.
- The stall detector now also recognizes a video stuck at a low `readyState` as a real problem, not just one that's `paused` when it shouldn't be. A provider stream that never receives enough data to actually play could previously go unreported indefinitely, since this content script's own play() retries could make the `paused` flag flicker and mask the stall.

## [0.2.3] - 2026-09-18

### Fixed

- `room-service`'s local dev WebSocket server now caps how many rooms one IP (20) or the whole process (1,000) can have open at once, matching the protection the deployed edge Worker already had through its per-room Durable Object isolation. Room-service holds every room in one process's memory, so an unbounded `create_room` rate could previously grow its memory without limit.

### Removed

- The unused `inviteToken`: every room generated one and returned it in `room_joined`, but no client message ever carried it back and neither backend validated it. Host-approval join already covers the access-control gap it was originally meant to close.

## [0.2.2] - 2026-09-18

### Fixed

- The room now clears a participant's readiness when their browser explicitly rejects a synchronized `play()` call (an autoplay-policy block), instead of leaving them marked "ready" forever. Previously, a controller pressing play again immediately re-triggered the identical rejection every time -- the browser restriction hadn't changed -- producing a starts-then-immediately-stops loop that looked exactly like unreliable syncing, with the "People" list incorrectly showing the blocked participant as ready the whole time.
- The side panel's participant list now always shows a participant's status icon (ready, not ready, wrong video, disconnected) alongside the controller's "Pass" control button instead of hiding it, so the controller -- the person most likely to need to diagnose why the room isn't syncing -- can actually see what's wrong with someone else's connection.

## [0.2.1] - 2026-09-18

### Fixed

- The side panel no longer crashes when a room snapshot from a room coordinator that predates `pendingJoinRequests` omits that field entirely, which happens against a room coordinator that has not yet been upgraded to host-approval join.
- `scripts/smoke-room-service.mjs` now joins the friend using the room's actual server-assigned code instead of the client-generated code it originally proposed, since `room-service` mints its own code and ignores the client's suggestion; it also no longer sends a stale, hardcoded revision for the shared-link `open_link` step.

## [0.2.0] - 2026-09-18

### Added

- Host-approval join: a brand-new participant's `join_room` becomes a pending request the controller must explicitly approve or deny (a new `respond_to_join` message) before that identity becomes a real room member. Reconnecting an already-known participant identity is unaffected and stays instant. This closes the last open gap in `docs/CODE_AUDIT.md` SYJ-AUD-003.
- The project's first real two-browser-profile end-to-end test (`npm run test:e2e`): two isolated Chrome profiles with the actual unpacked extension, the real room-service, and the local generic-fixture test player, driving a real create/request-to-join/approve/play/seek/pause flow.
- A seeded property-based fuzz-testing harness for the room state machine: 240 random operation sequences x 55 steps each, checking 6 invariants after every single step.

### Fixed

- Two real bugs the fuzz harness found: a reconnecting participant could push a full room past the 10-connected cap, and an adversarial or buggy player-status report could leave the room's playback position past the media's known duration.
- The extension's player-status handler no longer blocks its response on a `chrome.storage.session` write, found during an audit of the service worker's restart-persistence behavior (which otherwise confirmed the existing whole-state persist/restore pattern already correctly survives a Manifest V3 service-worker restart).

### Changed

- Room-code generation and the WebSocket origin allowlist are now single shared implementations in `@syncyourjoy/protocol` instead of being duplicated across the extension, room-service, and the smoke-test script.
- Routine dependency updates: `vitest` 5, `unocss`, `@types/node`, `@types/chrome`, `tsx`, and the CI-only `actions/checkout`, `actions/setup-node`, and `github/codeql-action`.

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
