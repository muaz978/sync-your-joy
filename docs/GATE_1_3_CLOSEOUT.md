# Gate 1-3 Closeout and Gate 4 Entry Criteria

**Current candidate:** `0.1.22` (not yet published from this working tree)
**Purpose:** record what can be completed by the repository and what requires two real people, real provider accounts, or marketplace accounts.

## Verified in the repository and production workflow

- The complete TypeScript test suite passes.
- Typechecking passes for the root and edge-service projects.
- Chrome and Firefox production extension builds complete.
- Production dependency audit passes at high severity.
- The Cloudflare room coordinator health endpoint responds successfully.
- The production-connected protocol smoke covers room creation, joining, readiness, shared-link navigation, play, seek barriers, timeout-safe pause, diagnostics, reconnect-safe state, and startup/stale buffering protection.
- The GitHub release workflow publishes a versioned ZIP and SHA-256 checksum.
- The public `v0.1.19`, `v0.1.20`, and `v0.1.21` packages were published, downloaded independently, and checksum-verified. The `v0.1.22` candidate adds bounded diagnostics, reconnect capabilities, reviewed media URL identity, cross-browser origin handling, room-lifetime/admission guards, and release-package hardening. It is still pending Worker deployment, GitHub publication, and two-device acceptance.
- Release page for the prior beta: https://github.com/muaz978/sync-your-joy/releases/tag/v0.1.19

## Gate 1: synchronization proof

### Repository-side work

- [x] Ordered authoritative room revisions.
- [x] Host-only controls with controller leases.
- [x] Readiness and media-match barrier.
- [x] Automatic play, pause, forward seek, backward seek, and progress-bar synchronization.
- [x] Bounded seek retries and a 1.8 second server safety ceiling.
- [x] Real playback progress and explicit autoplay failure reporting.
- [x] Recovery after tab visibility, bfcache, focus, and player replacement changes.

### User-side acceptance still required

- [ ] Two people in different cities complete the test guide using the exact same release.
- [ ] Native play and pause are applied on both devices without refreshing.
- [ ] Forward and backward seeks align both players.
- [ ] Repeated and rapid seeks converge to the final target.
- [ ] Autoplay-block recovery works through the visible Sync action.
- [ ] A real provider buffering event pauses and resumes according to policy.
- [ ] Refresh, bfcache, sleep/wake, and host disconnect behavior are acceptable.

## Gate 2: connectivity and observability

### Repository-side work

- [x] RTT, clock uncertainty, and connection-quality state.
- [x] Heartbeat watchdog and bounded reconnect.
- [x] Sanitized participant diagnostic reports.
- [x] Diagnostics response budget below the 16 KB room-message ceiling.
- [x] Production deployment workflow with source/test checks.
- [x] Room message-size and rate-limit protections.
- [x] Per-participant reconnect capabilities and duplicate-identity protection.
- [x] Pending-connection and maximum occupied-room lifetime guards.
- [x] Room expiration and controller-recovery behavior.

### User-side acceptance still required

- [ ] Test 50-300 ms latency and jitter between two real devices.
- [ ] Test temporary offline/online transitions.
- [ ] Test laptop sleep/wake and tab backgrounding.
- [ ] Test reconnect after several seconds and inspect the detailed report.
- [ ] Record measured pause, seek, and steady-state drift values.

## Gate 3: flexibility and browser portability

### Repository-side work

- [x] Standards-first WebExtensions API selection.
- [x] Firefox metadata and build path.
- [x] Generic native-video, MSE/blob, MediaStream, open Shadow DOM, nested-frame, and SPA coverage.
- [x] Provider identity normalization for nested and signed player URLs.
- [x] Reviewed media-identity query-key redaction for temporary provider parameters.
- [x] Player diagnostics, Redetect player, and selected-player lock controls.
- [x] Generic fixture page and regression tests.
- [x] Privacy policy draft, store submission pack, reviewer instructions, and in-extension disclosure.

### User-side acceptance still required

- [ ] Real Firefox install and two-person smoke.
- [ ] Headed Chrome fixture pass.
- [ ] Safari conversion/package pass if Safari is included in the first launch.
- [ ] Multiple competing videos are correctly selected or locked.
- [ ] Each claimed commercial provider is tested in an authenticated account without bypassing DRM or provider controls.

## Gate 4 entry criteria

Gate 4 may begin as preparation when the repository-side items above are complete. Submission should wait until:

1. Every user-side Gate 1-3 acceptance item is either passed or explicitly removed from the first supported release.
2. There are no open P0 or P1 synchronization defects.
3. The privacy policy is published at a stable HTTPS URL with a monitored contact.
4. Store listing disclosures match the shipped manifest and actual data flows.
5. Chrome package, Firefox package/source, and any Safari package are reproducible and tested.
6. A rollback and support plan are ready.

## If the user test finds a defect

- Download the detailed report immediately after the failure.
- Record browser, operating system, provider, URL, room role, connection quality, and exact action sequence.
- Treat a wrong title, wrong episode, unsynchronized seek, room clock running while a guest is stopped, or refresh-required recovery as a release-blocking defect until reproduced and fixed.
- Publish the next patch version rather than replacing an already distributed release.
