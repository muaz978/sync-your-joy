# SyncYourJoy Whole-Code Audit

**Audit date:** 2026-08-30
**Audited revision:** `main` at `0e7772e` plus the working-tree audit checkpoint
**Latest published beta:** `v0.1.21`
**Scope:** room protocol and coordinator, Cloudflare Durable Object service, local room service, extension service worker, content-script/player discovery, side panel, diagnostics, packaging, browser builds, CI/CD, privacy boundaries, and production-connected behavior.

This is an engineering audit, not a store approval or a claim that every commercial provider works. Findings are separated from checks that passed and from runtime evidence that still requires two real people using real provider accounts.

## Remediation status for the `0.1.22` candidate

The findings below were recorded against the previously published `v0.1.21` baseline. The working tree now contains an implementation of the first remediation slice: bounded diagnostics responses, per-participant reconnect capabilities, Firefox/Safari WebExtension origin handling, reviewed media-identity query-key redaction, pending-connection and maximum-room-lifetime limits, source-map-free release packages, browser-package verification cleanup, and expanded CI/release checks. These changes are covered by the current local check and package verification, but they are not yet a published release and the updated Worker still requires deployment before production behavior changes.

The original findings remain below as an auditable baseline. Their status is therefore: implementation present in the `0.1.22` candidate, local tests passing, production deployment and two-device/provider verification pending.

## Executive summary

The `v0.1.21` baseline was in good shape for a controlled private beta: typechecking, 107 automated tests, production dependency scanning, Chrome/Firefox package checks, Safari macOS conversion smoke, release ZIP validation, and the deployed coordinator protocol smoke all passed. The current `0.1.22` working-tree candidate extends that suite to 113 tests and adds the remediation changes described above, but has not yet been deployed or published.

The current build is not ready for Gate 4 or broad distribution. Three high-priority issues require remediation or an explicit scope decision:

1. **Diagnostic reports can exceed the 16 KB WebSocket limit.** The service worker retains up to 100 one-second player-status events. A representative valid report reaches 16,737 bytes at 100 events, above the edge and local service limit of 16,384 bytes. This can cause a participant's diagnostic response to be rejected with `1009 message_too_large`, producing the missing-participant reports observed during testing.
2. **The production room service does not explicitly allow Firefox or Safari WebExtension origins.** The allowlist accepts no Origin, `chrome-extension://`, and local HTTP origins only. Firefox normally presents a `moz-extension://` origin and Safari uses its own WebExtension origin, so the advertised cross-browser packages are not proven to connect to the production coordinator.
3. **The invite token is generated and returned but never used for authentication.** Any client that knows a room code can join with an arbitrary participant ID, and a client that knows an existing participant ID can replace that participant's socket. The room code is therefore the only access control. This is acceptable only for a tightly controlled beta, not for public distribution.

Additional medium-priority concerns include query-string privacy mismatch, missing global abuse controls and maximum occupied-room lifetime, release workflow coverage gaps, a browser-package verification side effect, stale documentation, and the absence of real two-browser/provider end-to-end tests.

## Severity and release meaning

- **P0:** immediate privacy, data-loss, or security emergency.
- **P1:** release blocker for Gate 4 or public distribution; may break a core beta workflow or a stated security boundary.
- **P2:** important reliability, compatibility, operational, or release-process risk; should be fixed before store submission where practical.
- **P3:** lower-risk hygiene, documentation, or optimization item.

## P1 findings

### SYJ-AUD-001 - Diagnostic response can exceed the WebSocket message limit

**Severity:** P1
**Affected code:** `apps/edge-service/src/worker.ts:8-10, 120-126`; `apps/room-service/src/server.ts:13-15, 90-94`; `apps/extension/src/service-worker.ts:18, 63, 995-1015`; `packages/protocol/src/index.ts:425-458`

The coordinator rejects any message larger than 16,384 bytes. The client records up to 100 diagnostic events, and normal playback emits a `player_status` event every second. The protocol validates each event and field independently but has no aggregate report-size limit or compact encoding.

A representative valid report using the current fields and 100 ordinary player-status events is 16,737 bytes before transport framing. At 95 events it is 15,937 bytes, leaving little room for a longer user-agent, canonical identifier, or event detail. The response is sent as one `diagnostics_response` message, so a longer report is rejected by the edge service and the `ws` local service. On the edge path the socket is closed with code `1009`; the controller then records that participant as missing. This directly explains why a report can contain only one of two participants after the room has been active for a while.

**Recommended fix:** enforce a serialized report budget before sending, retain fewer or compacted events, and/or add a dedicated bounded diagnostics transport. A safe first fix is to cap the report payload below the transport limit, for example 12 KB, by retaining the newest events and truncating detail values. Add a test that serializes the worst-case report and asserts it remains below the edge limit. Do not simply increase the global message limit without considering abuse and Durable Object memory/cost.

### SYJ-AUD-002 - Production origin allowlist does not cover Firefox or Safari

**Severity:** P1 for cross-browser support
**Affected code:** `apps/edge-service/src/worker.ts:426-432`; `apps/room-service/src/server.ts:367-374`

Both services allow a missing Origin, `chrome-extension://`, and local HTTP origins. They do not allow `moz-extension://` or Safari WebExtension origins. The build produces Firefox metadata and a Safari conversion smoke project, but no live production connection test exercises those origins.

This creates a mismatch between the browser-portability claim and the deployed access policy. Chrome may work while Firefox or Safari receives HTTP 403 during the WebSocket upgrade.

**Recommended fix:** do not broaden the allowlist to every extension origin without another authentication layer. Prefer an authenticated WebSocket handshake using a short-lived room/session capability, then allow the browser origins required by the supported products. Add a live connection test for each target browser or explicitly defer Firefox/Safari from the first release.

### SYJ-AUD-003 - Invite token is unused; room code is the only access control

**Severity:** P1 for public distribution, P2 for private beta
**Affected code:** `packages/protocol/src/index.ts:120-136, 180-190`; `apps/edge-service/src/worker.ts:224-266`; `apps/room-service/src/server.ts:157-210`; `apps/extension/src/service-worker.ts:274-297, 590`

The room creates a random 128-bit `inviteToken` and returns it in `room_joined`, but no client message carries that token and neither service validates it. A join requires only the eight-character room code and a client-chosen participant ID. Because `RoomCoordinator.join` treats an existing ID as a reconnection and the services close the prior socket, someone who knows a participant ID can replace that participant's connection and potentially take over the identity. There is also no host approval step.

The code is high entropy enough to make casual guessing difficult, but it is still a bearer room secret exposed in copy/paste and URLs. The architecture and research documents describe a stronger invite-secret and rate-limited lookup design that is not implemented.

**Recommended fix:** bind a signed or random per-participant capability to the join session, rotate it on reconnect, and require it for reconnecting an existing participant ID. For new guests, use an invite capability or a host approval flow. Add join-attempt throttling and tests for duplicate-ID takeover, replay, expiration, and controller-only operations.

## P2 findings

### SYJ-AUD-004 - Query-string privacy contract is stricter than the implementation

**Severity:** P2 privacy and matching risk
**Affected code:** `packages/protocol/src/index.ts:260-285`; `apps/extension/src/media-fingerprint.ts:19-51, 64-77`; `docs/ARCHITECTURE.md:147-152`; `docs/PRIVACY_POLICY.md:56-58`

`normalizePageUrl` removes fragments and a small set of known tracking keys, but preserves all other query parameters. That is required for some provider identifiers such as Qfilm's `vid`, but it also preserves unknown parameters such as temporary page tokens when a participant creates a room directly on an embedded or provider player page. The architecture document says to strip query strings before transmission unless a platform-specific field is proven safe, while the implementation permits arbitrary non-tracking parameters.

This can create false mismatches when two users receive different temporary parameters, and it can transmit a signed or temporary page parameter to the coordinator. The downloaded report sanitizer removes query parameters, but that does not prevent the room protocol from receiving them.

**Recommended fix:** separate a matching identity URL from a display/navigation URL. Use provider-specific allowlists for required identifiers such as `vid` or YouTube `v`, redact all unknown query keys before room transmission, and add regression tests for temporary tokens and differing regional parameters.

### SYJ-AUD-005 - No global abuse control or maximum occupied-room lifetime

**Severity:** P2 operational/security risk
**Affected code:** `apps/edge-service/src/worker.ts:8-10, 34-61, 165-203, 358-375`; `packages/sync-engine/src/room.ts:480-482`

Message size and per-socket rate limits are present, and empty rooms expire after 30 minutes. There is no global or per-IP limit on WebSocket upgrades, room creation, join attempts, or room-code probing. An occupied room has no maximum lifetime and can remain persisted indefinitely while a client keeps a socket open. Cloudflare may absorb some abuse, but the application itself does not enforce the documented broader expiry and abuse model.

**Recommended fix:** add edge-level admission controls, a short-lived join capability, per-room and per-origin connection limits, and a maximum room lifetime with a clear user-facing expiration event. Record aggregate counters without retaining media or private URLs.

### SYJ-AUD-006 - Release workflow does not repeat browser-package verification

**Severity:** P2 release-process risk
**Affected code:** `.github/workflows/ci.yml:35-42`; `.github/workflows/release.yml:46-56`

Main CI runs `npm run verify:browser-packages`, but the tag-triggered release workflow runs `npm run check` and dependency audit only before packaging. A release can therefore be published from a tag even if a browser-specific packaging regression was introduced after the last main-branch run or if the release workflow is rerun in a different environment.

**Recommended fix:** run the same browser-package verification in the release job before creating the GitHub Release, and persist the manifest/package evidence as a workflow summary or artifact.

### SYJ-AUD-007 - Browser-package verification leaves the unpacked output as Firefox

**Severity:** P2 developer-workflow risk
**Affected code:** `scripts/verify-browser-packages.mjs:17-60`

The verification script builds and copies Chrome, then builds Firefox and copies Firefox, but does not restore a Chrome build to `apps/extension/dist`. After the command succeeds, opening `apps/extension/dist` manually loads the Firefox sidebar manifest rather than the Chrome side-panel manifest. The release packaging script rebuilds the correct production Chrome package, so this does not corrupt the published ZIP, but it is easy to mis-test locally.

**Recommended fix:** rebuild the default Chrome output in a `finally` block or write all browser outputs to staging directories without changing the canonical `dist` directory.

### SYJ-AUD-008 - CI actions show a Node 20 deprecation warning

**Severity:** P2 maintenance risk
**Affected code:** `.github/workflows/ci.yml:24-30`; `.github/workflows/release.yml:25-31`; `.github/workflows/deploy-edge.yml:21-27`

The workflows pin checkout and setup-node v4 action SHAs. The deployment evidence shows GitHub warning that Node.js 20 is deprecated and those actions are being forced to run on Node.js 24. The jobs currently pass, but the action runtime warning should be removed before store/release operations depend on it.

**Recommended fix:** update the pinned action SHAs to the Node 24-compatible major versions after checking the runner requirement, then rerun CI and deployment smoke.

### SYJ-AUD-009 - Real player and two-device behavior is not covered by automated tests

**Severity:** P2 validation gap and current Gate 4 blocker
**Affected code:** `packages/sync-engine/src/*.test.ts`, `apps/extension/src/*.test.ts`, `apps/room-service/src/server.test.ts`, `scripts/smoke-room-service.mjs`, `docs/RELIABILITY_REVIEW.md:46-50`

The automated suite proves coordinator invariants and a production WebSocket protocol flow. It does not drive two persistent browser profiles, a real `HTMLVideoElement`, provider autoplay policy, backward/forward seeking, tab suspension, iframe replacement, or actual frame progress on Netflix, Disney+, Crunchyroll, Qfilm, Animerco, and generic players. The repository documentation correctly marks these as pending, but the current release cannot claim they work merely because the protocol smoke passes.

**Recommended fix:** add headed two-profile browser tests against the generic fixture first, then a provider acceptance matrix using accounts supplied by testers. Capture command sent, command applied, actual media progress, final drift, buffering, reconnect, and seek outcomes. Keep commercial-provider support marked verified only per provider and browser.

### SYJ-AUD-010 - Source maps ship in the release ZIP

**Severity:** P3 information-disclosure and package-size concern
**Affected code:** `scripts/build-extension.mjs:29-38`; `scripts/package-extension.sh:23-25`

The production ZIP includes `content-script.js.map`, `service-worker.js.map`, and `sidepanel.js.map`. These do not contain secrets in the current source, but they expose the complete readable source and internal diagnostic/control structure to every downloader and increase package size.

**Recommended fix:** keep source maps for debugging artifacts, but omit them from the public store/beta ZIP unless the debugging benefit is intentional. If retained, document that they are public and scan them for accidental endpoint or test data exposure.

## Correctness and reliability review

### Strengths verified in code

- The coordinator serializes revisions and rejects stale control contexts.
- Controller-only play, pause, seek, and shared-link operations are guarded by the lease epoch.
- Controller-originated seeks count the controller as acknowledged while guests must still confirm their own target.
- Seek retries are bounded, and a 1.8-second barrier deadline safely pauses instead of releasing an asymmetric timeline.
- Readiness is retained across a brief same-media reconnect and is revoked for confirmed media changes, navigation, or disconnects.
- Player status separates real progress from a play promise and can pause the room for an explicit autoplay failure or sustained stall.
- Player binding is frame-aware and rejects stale or unrelated senders in the service worker.
- Side-panel rendering preserves input focus, text drafts, and scroll position during state updates.
- Diagnostic events and reports are bounded in memory and page URLs are sanitized before the downloaded report is written.

### Reliability risks that need live evidence

- A valid room snapshot can report aligned state while a provider player remains paused or has not presented a real frame. The existing player-health path may pause later, but the user-visible transition must be measured on real devices.
- Provider seekability differs substantially for VOD, live streams, MSE, and DRM players. `resolveSeekTarget` can clamp to duration or seekable ranges, but the acceptance test must confirm the requested point was actually applied.
- Player replacement and frame rebinding intentionally clear readiness in some paths. This is safe but can feel like readiness cancellation if a provider recreates its element during quality changes; the report should correlate the replacement, media fingerprint, and readiness revision.
- `sendToPlayerTab` clears the frame binding after a failed message. A navigation or iframe recreation between detection and control can therefore require a fresh detection cycle; test this without refreshing the page.

## Security and privacy review

### Positive controls

- No capture, cookies, debugger, webRequest, or media transport permissions are requested.
- Messages are schema-validated, bounded, and rate-limited per connection.
- Production packaging appends the configured WSS origin to the effective extension CSP. The static manifest contains localhost development endpoints, while a production package built by `scripts/package-extension.sh` contains `wss://sync-your-joy-rooms.sync-your-joy.workers.dev` as well.
- User-visible reports intentionally exclude query parameters, media bytes, credentials, screenshots, and cookies.

### Security decisions still required

- Decide whether the private-beta room code is sufficient temporarily or implement the invite/session capability before public distribution.
- Decide whether broad all-HTTP/HTTPS content-script access is necessary for the “any page video” promise. It is technically aligned with that promise, but it increases store review and privacy disclosure burden.
- Publish the privacy policy at a stable HTTPS URL with a monitored contact before Gate 4. The repository policy is still explicitly a draft.

## Verification evidence

The following checks passed during this audit:

- `npm run check`: typechecking, 21 Vitest files, 107 tests, server build, and extension build.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- `npm_config_cache=/tmp/npm-cache-syj npm audit signatures`: 159 packages with verified registry signatures and 85 verified attestations. The first attempt used the user's root-owned npm cache and failed with `EPERM`; the clean temporary cache run passed.
- `npm run smoke:edge -- wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`: production-connected smoke passed, including room creation/join, diagnostics relay, shared navigation, readiness, play, seek barrier, timeout-safe pause, rapid controls, and buffering guards.
- `npm run verify:browser-packages` passed after granting the macOS packaging tool access to its staging directory: Chrome and Firefox manifest checks plus Safari macOS conversion smoke passed.
- Production release packaging with `RELEASE_VERSION=0.1.21` and the deployed WSS URL passed `unzip -t`, checksum generation, and effective manifest inspection.
- `git diff --check` passed before this report was created.

## Gate 4 verdict

**Do not enter Gate 4 submission yet.** The repository-side baseline is strong enough for a controlled beta, but the following must be resolved or explicitly excluded from the first store release:

1. Fix or bound diagnostic response size and prove a two-participant report after a long session.
2. Implement invite/session authentication or document a deliberately private, code-only beta with abuse limits.
3. Decide whether Firefox and Safari are in the first release, then either allow and test their real WebExtension origins or remove those support claims.
4. Complete two-device, headed browser acceptance for generic HTML5 first, followed by each provider that will be listed.
5. Publish the real privacy/support URL and align the policy with actual query-parameter and retention behavior.

## Recommended remediation order

1. Fix `SYJ-AUD-001` and add a regression test for the 16 KB boundary.
2. Fix `SYJ-AUD-002` and `SYJ-AUD-003` together as one authenticated, cross-browser WebSocket handshake design.
3. Clarify and implement URL identity redaction (`SYJ-AUD-004`).
4. Add browser E2E and long-running diagnostics acceptance (`SYJ-AUD-009`).
5. Close release-process issues (`SYJ-AUD-006` and `SYJ-AUD-007`), update action runtimes (`SYJ-AUD-008`), and decide on public source maps (`SYJ-AUD-010`).
6. Re-run the full Gate 1-3 matrix with the exact release package, then reassess Gate 4.
