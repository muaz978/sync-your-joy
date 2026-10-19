# Changelog

All notable user-facing changes are recorded here. This project follows semantic versioning for tagged extension releases.

## [Unreleased]

### Fixed

- Extension: pressing Sync on a participant whose player never finished a synchronized seek now asks the player for the position again. Before, the element reported the target as its position while it was still seeking, so Sync adopted the stuck seek and did nothing. After two re-issues that also time out the page says to reload the tab, which the room survives. This is a mitigation for a Crunchyroll stall seen on 0.2.7 (#138, which stays open); the cause is not established.

## [0.2.7] - 2026-10-16

This is a compatible test release. The extension fixes below take effect when each participant loads this package. The coordinator fixes were deployed to production on 2026-10-16 (Worker version `b6ea9ac1-d4c1-4ab0-aa94-b324dd76ce7f`, from `main` at `05a0d68`; previous version `681f31dc-eb31-4ced-a661-1d6304d134ff`): after that deploy the production exposure probe found no exposure and the production smoke test with synthetic participants passed. Where an entry below says a coordinator fix takes effect when the coordinator is deployed, that has now been done for production.

Where an entry applies: unmarked entries are coordinator changes and take effect when the room coordinator is redeployed. Deployed extensions need no update for them (checked in a real browser with the 0.2.5 and 0.2.6 builds; older releases were not checked), because the coordinator now answers an unapproved request with a placeholder that already-installed content scripts leave alone. Entries marked *(local service)* apply to the local room service and local test runs only, entries marked *(local test runs)* apply to the repository's own tests and how they are run and ship nothing, and entries marked *(extension)* ship with the next extension release as a second line of defence. They close gaps found while reviewing the host-approval join (tracking issue #119).

### Fixed

- After a restart, eviction or code update the edge coordinator no longer keeps join requests whose connection is gone (they could be approved into a member with no connection) or members shown as connected with no connection, and it starts the expiry clock for a room nobody is in. Before, such a room kept stale requests and members, and an empty room whose clock was never started stayed in storage. Members that kept their connection through the restart are told which request was withdrawn or which participant was marked disconnected, instead of keeping a stale view until the next unrelated message, and a failure while reconciling, or while saving the result, no longer stops the room from being served.
- A room can no longer pass its ten-participant cap through approvals: members who return while requests wait used to let the host approve past ten (13 connected were reached). The approval is refused with `room_full` and the request stays pending.
- The six-hour room lifetime limit on the edge is now scheduled as an alarm, so it is enforced; before, it only applied if an unrelated alarm happened to fire after the limit. A room that is restored after a restart, eviction or code update has its alarm worked out again whether or not the restore repaired anything, because the alarm that is set belongs to whichever code last wrote the room and can be missing or later than the limit. A room written by an earlier version therefore gets the limit scheduled the first time it wakes; before, a room whose connections only ping could stay without one.
- Control now passes to a connected member when the host does not return after every connection dropped at once (a deploy, a network outage) and the host's grace period ran out with nobody connected. Before, a member who came back afterwards found the absent host still in control, with nothing scheduled to change that, for as long as the members stayed. On both coordinators a recovery is now planned when a member returns while the controller is disconnected and none is pending, and the edge coordinator also plans it when it restores a room in that state. A recovery planned this way waits 20 seconds, longer than the extension's reconnect delay of up to 15 seconds plus jitter, so a host that is only backing off keeps control (a host whose service worker was suspended reconnects through a Chrome alarm that can be held to about 30 seconds, and can find control moved; it is still a member and can be given control back); a host that leaves while members are present still has 10 seconds. The edge coordinator plans none for a host that still has its connection, and drops one it had saved for such a host when it restores a room, so a live host whose reconnect was not saved does not lose control. The local service has a test-only `controllerGraceMs` option that shortens both periods. A restore whose save failed is now tried again on a later frame from a connected client (at most every 5 seconds, and the extension's own metrics report after each pong usually saves it sooner), because a client that sends nothing that writes would otherwise never make the object save, and the alarm that carries the lifetime limit and controller recovery is set by that save. The repair that was withheld from the members is announced as soon as the room is durable, before the alarm is set (so a restart before a retry cannot lose it), and is kept, up to three times, for a member whose attachment could not be read. A recovery plan whose time ran out while nobody was connected is treated as lapsed when a member returns before a late alarm, so the host still gets the re-arm window. A restore that fails part of the way through reconciling keeps what it had repaired and announces it, reads the attached sockets once, and a broadcast skips a socket whose attachment cannot be read instead of stopping at it (it now closes it too; see the entry below).
- A socket whose attachment cannot be read (or has none) is now closed wherever the edge coordinator finds one, so its client can reconnect with a fresh attachment (the extension does when it is in a room) instead of holding a socket that cannot be served: when it counts the pending connections for the per-room cap (the closed socket is not counted), when a frame arrives on it, and when a broadcast, a message to one member or a denial meets it; before, those paths skipped it or failed on it. When such a socket is the one that closes, the edge coordinator now compares the members with the sockets that can be read, as a restore does, instead of throwing before it records the departure: before, the member stayed shown as connected and a controller that was gone had no recovery planned until the next restore. A runtime fault is the only way a socket gets into that state.
- The empty-room expiry clock is now derived from membership in both coordinators, so a missed clear can no longer expire a room under connected members and a missed start can no longer keep an empty room alive, and one socket that throws on close can no longer stop an expiring room from being removed.
- *(local service)* The local room service no longer exits when a client sends a frame that the WebSocket library rejects (a frame over 16 KiB, invalid UTF-8 in a text frame, a protocol violation). Before, one such frame from any client with an allowed Origin ended the process and every in-memory room; the sender is now closed with 1009, 1007 or 1002 and other clients are unaffected. This affects the local service and the local test runs, not the Cloudflare coordinator.
- *(extension)* A page that has left a room can take part in the next one without being reloaded. The service worker clears a page's player binding when the room is left and refuses a media report that carries a token it no longer knows; the page kept the token for good, so after leaving a room the same page was never found as the player again: no "Use current", no ready button, no playback, until it was reloaded. The worker now tells a page when it has no bound player at all (the room was left, no tab could be found to bind, or the page reported no media) and the page drops its token then, as it does when the worker asks it to report afresh. A page that another document replaced is detached without that, keeps its token and stays refused, which is what stops a retired document from taking the binding back (`tests/e2e/rejoin-after-leaving.spec.ts`, which fails without the change and passes with it, "the worker binding token once the worker has no bound player" in `apps/extension/src/content-script.test.ts`, and "what a page is told when the worker stops binding it" in `apps/extension/src/service-worker.test.ts`). The published 0.2.6 build has the problem; the fix is in the next extension build and does not reach anyone with a coordinator deploy.
- *(extension)* A join request that is still waiting now ends when the room is gone. A `room_expired` close, or `room_not_found` after a reconnect, leaves the room with a message instead of keeping the waiting view up and reconnecting into a room that no longer exists, while a close for any other reason (a plain drop, `session_replaced`, `rate_limited`, `test_disconnect`) still reconnects ("still reconnects after an ordinary dropped connection"); the same applies to a member of a room that expires (service-worker.test.ts: "leaves the room, with a reason, when the coordinator closes the waiting request as expired, and does not reconnect", "leaves the room when a reconnect finds that the room no longer exists"). A `room_expired` error is handled the same way, as defence in depth against an older or different coordinator ("leaves the room, as expired, when the coordinator answers a message with room_expired, and does not reconnect"). The current local service only ever sends `room_expired` as a close, because it closes every socket of a room before removing it, so this error frame was not seen in any run; it is not a fix for a reproduced defect. The message also reaches the page the participant is watching on, shown on the pill for eight seconds, so a participant with the side panel closed learns why the room ended (service-worker.test.ts, "with a player tab bound and the side panel closed": "tells the page the player is bound to why the room expired, once", "does the same when the room is reported gone by an error"; content-script.test.ts, "a notice about a room that has ended": "is shown on the page, although there is no room to show, and then goes away", "stays for the whole of its eight seconds", "is kept for eight seconds from the latest notice when a second one arrives"). Before, the notice was sent after the page had been unbound and never arrived. A declined request is told to the page the same way ("tells the page the player is bound to that the host declined the request, once"); before, its notice was never delivered either. Such a notice is only shown for a room that has ended: an ordinary notice is not turned into one ("is not made of an ordinary notice, which has no room to be about"), the room view's error line is not left under it ("does not carry the room view's error line along with it"), an ordinary notice is not written under it either ("does not write an ordinary notice under the room-ended message"), and it does not come back when a room joined while it was up is left, nor when that room was only asked to join ("is not shown again when a room joined while it was up is left", "is not shown again when a room that was only asked to join while it was up is left"). A report of a `room_expired` close now records that the server ended the room (`serverEndedRoom`, with a `room_gone` event) instead of showing the close as one this browser made ("records that the server ended the room, rather than that this client closed the socket", "records that the room ended, once, when the coordinator closes the socket as expired"). A close this browser makes itself (leaving a room, joining another) is not recorded differently by this change: the worker clears its intentional flag before the browser delivers the close event, so such a report can still read `intentional: false`. No test sees this, because the test double delivers the close synchronously; it is not changed here.
- *(extension)* The on-page pill says "Waiting for the host" for a pending request instead of member wording ("Member, 0 connected"), hides the play button and disables Sync (the Room and hide buttons stay usable) (pill-view.test.ts "the on-page pill for a pending join request"; content-script.test.ts "as the pill on the page shows it"). While this browser's own connection is down it says "Reconnecting", as it does for a member, instead of blaming the host, and says that the browser will ask to join again when the connection is back: the coordinator withdraws a request when its connection closes, so it is not pending in the meantime (room-membership.test.ts "does not call the request pending while this browser is not connected"; pill-view.test.ts "shows the connection, not the host, when the requester's own connection is down").
- *(local test runs)* The E2E provenance records which tree the extension was built from. With `SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT` set, `provenance.json` named the current checkout for the commit, tree and hashes of a release build; it now has an `extensionSource` section (root, commit, tree, source, lockfile and configuration hashes of the tree the build was run in, and where its `@syncyourjoy/protocol` and `@syncyourjoy/sync-engine` packages resolve to) next to the unchanged fields that describe the checkout supplying the coordinator and the specs (tests/provenance.test.ts "buildExtensionAndRecordProvenance" and "collectProvenance", including the manifest hash by value). With the variable pointing at a path that does not exist, a tree without a build script, an export with no git history, or a release before v0.2.5 (whose build script ignores the output directory), the run now stops with a message that says so, before the build where it can ("assertExtensionSourceRoot", "buildExtensionAndRecordProvenance"). It also stops when `@syncyourjoy/protocol` or `@syncyourjoy/sync-engine` does not resolve to a directory inside that tree ("where the workspace packages come from"): esbuild finds them by Node resolution from the tree it runs in, so a worktree with no `node_modules` of its own below a directory that has one, as in this repository's own `.claude/worktrees/<name>` layout, or one with another tree's `node_modules` linked in, was built without error from that tree's packages while `provenance.json` named the release tree. What is checked is those two packages; third-party packages are resolved by Node from the tree and are not checked one by one, and the bundle itself is not compared. The same checkout reached through a symlinked spelling (`/tmp` for `/private/tmp`) is the checkout, not another tree ("a symlinked spelling of the checkout"). Which tree is built, from where, and what is recorded now lives in one function that `tests/e2e/global-setup.ts` only calls, so it is tested with stub trees instead of by hand. `room-ended-notice.spec.ts` skips itself, saying why, when the extension in the run was not built from the checkout, because it sends a message only this checkout's build understands ("isCheckoutExtensionBuild").
- *(local test runs)* The pending-approval spec can now fail when a requester's video is rewound while it waits. Its position check passed when the video had been at ten seconds, was wrongly sought to zero and then played for the three-second wait; the spec now starts the video six seconds into the clip, watches the element from before the request, and fails on any backward seek, except the looping clip starting over, so how long the flow takes does not decide it; a rewind that happens to start within a second of the clip's end reads as the loop starting over and is not seen. It also has the host share a link first and counts the requester's pages before the request, so a shared page opened for a waiting requester fails it, and after approval it waits for that link itself to open; before, no link was ever shared and that check could not fail. These are checked by running the spec, not by a unit test: a copy of the spec in which the requester's video is sought to zero right after the request fails it (recorded in checkpoint 112).
- *(local test runs)* The two-profile and three-profile E2E specs can now click the side panel on Linux. The panel was a tab behind the video tab, Chromium on Linux paints a background tab only a few times a second, and the panel redraws on every room-state heartbeat, so Playwright never saw the button stay put for two frames and the first click on it timed out after two minutes ("element is not stable"); the synchronization, seek and matrix assertions after it never ran. The profile helper now opens the panel in a window of its own, so the video tab stays the active tab and both are painted normally. Bringing the panel to the front instead was tried and rejected: it hides the video tab, which then presents no frames, and the room's frame-progress check pauses everyone about two seconds into playback. macOS was not affected. The Linux runs (14 passed, 1 skipped on arm64 and amd64, and the three-profile matrix passed in fifteen of sixteen runs) were made by the author in one VM before the review commits of the previous pull request landed, so only macOS has run the head; see checkpoint 113. The authenticated Crunchyroll spec uses the same helper and was not run.

### Security

- A client whose join request has not been approved no longer receives any room state. Before, it received the full snapshot (shared link, playback state, participant names, transaction contract) and every later broadcast, and the extension acted on it, for example by opening the shared page. It now receives a snapshot that carries only its own pending entry and is excluded from broadcasts until the controller approves it. That snapshot is also inert for a player: it carries a fingerprint that matches no real media, no revision, controller identity or playback time, so an installed extension no longer pauses and rewinds the video a requester is watching while it waits.
- On the edge coordinator, a connection that never sent a join request no longer receives room broadcasts. Before, it could listen to a room for as long as it stayed connected.
- A pending join request is bound to the session issued for it. Sending the same participant id again without that session is refused instead of replacing the request and its approval.
- A pending join request is withdrawn when its connection closes, so it can no longer be approved into a member that has no connection and blocks the room.
- A rejected command or rejected join no longer carries the room snapshot to a client that is not a member. Before, a wrong session token or a full room handed the sender the whole room state inside the rejection.
- An unapproved request no longer cancels the empty-room expiry on either coordinator, and a request that is withdrawn no longer restarts it. Before, anyone who only knew a room code could keep an empty room alive by opening and closing requests less than thirty minutes apart.
- A request that is still waiting when an empty room expires is now closed with `room_expired` instead of being left connected to a room that no longer exists.
- *(extension)* The extension's content script no longer pauses, seeks or starts the page's video while the participant's own join request is pending, whatever snapshot an older coordinator sends it.
- *(extension)* The extension no longer opens the shared page for a join request that is still waiting. A current coordinator sends a requester no link, but an older one sends the whole room and the requester's browser opened the host's page in a new tab before the host had let it in; the page is now opened once the request is approved. (service-worker.test.ts, "and the host has shared a link": "opens no tab for the placeholder", "opens no tab when a coordinator sends the whole room in a room_joined while the request waits", the same for room_snapshot, "opens the shared page once, after the request is approved, even if the room was sent earlier"; and a member still opens it while somebody else's request waits, "opens the shared page once for a member while somebody else's request is waiting".)

### Changed

- Maintenance, no runtime change: `ws` 8.22.0 for the local room service, the dev-dependency group (wrangler 4.147.0, vitest 5.0.3, tsx, type packages), and `github/codeql-action` init, analyze and upload-sarif together at v4.38.3. The shipped extension bundle, local service bundle and coordinator Worker bundle are byte-identical to the previous toolchain's. Dependabot now updates the codeql-action family in one pull request, because a split bump fails the required analysis check on its own.
- Added `docs/DURABLE_OBJECT_RUNTIME_OBSERVATIONS_2026-10-15.md`, the observations from a throwaway Worker on the real runtime that the coordinator's restore step depends on, with how far they go. The v0.2.5 controlled-test runbook gets a revision notice and its stale rollback version is replaced; `docs/ARCHITECTURE.md` now describes the restore step.
- Coordinator deploys and rollbacks now ask for the Durable Object code update to be applied immediately: `apps/edge-service/wrangler.jsonc` pins `durable_objects.code_update_strategy` to `immediate` (wrangler 4.147.0 otherwise sends a deferred, 300-second update on every deploy and rollback), and `npm run rollback:edge -- <version-id>` rolls back with that setting. A rollback run without `--config` is not covered by the pin; see docs/RELEASING.md. On the real runtime, observed once on a throwaway Worker, an active room kept the previous code for about 300 seconds in either mode and was then reset once, so plan a deploy or rollback as a five-minute window (docs/DURABLE_OBJECT_RUNTIME_OBSERVATIONS_2026-10-15.md).
- Documentation, no runtime change: statements that went stale after the 0.2.x releases and the remediation pull requests are corrected in 27 documents (the README, the release, test and private-beta guides, the architecture and implementation documents, the store and privacy pack, the Crunchyroll plan and handoff, and the per-issue reports). Dated records keep their content; where one could mislead a reader, a short dated status note or a minimal correction was added. Among them: the join steps in the beta and test guides now describe host approval, the releasing guide describes the pull-request flow and uses placeholder versions, the seek-barrier ceiling reads 3 seconds, and the permission lists name `alarms`. No code, protocol or behavior changed.

## [0.2.6] - 2026-09-29

This is a compatible test release containing the coordinator and extension fixes merged after `v0.2.5`. The coordinator fixes take effect only after the room coordinator is redeployed. The extension changes take effect when each participant loads this package. The paused-seek fix is a coordinator change, so update participants' extensions together with, or before, the coordinator.

### Fixed

- A seek made while the room is paused no longer makes the room fail about three seconds later with a start timeout that puts every participant into recovery. The seek is reported as committed for its window and is then cleared.
- Repeated presses of Play while a Play is already preparing no longer restart the preparation window and discard the acknowledgements already received.
- A participant's progress report that raced another participant's start acknowledgement is no longer discarded. Discarding it could pause the whole room as stalled a couple of seconds into playback.
- The `Playback blocked` state stays visible to everyone until that participant's browser accepts playback again, including across reconnects, instead of appearing for a fraction of a second.
- The controller's next scrub while the room is paused is no longer pulled back to the previous target while the coordinator still holds the settled seek.

### Added

- Detailed reports include whether the video element was seeking, its media error code, buffered and seekable ranges, buffered-ahead time, the age of a pending seek and whether media keys are attached. They are plain numbers and booleans, never provider text, addresses or keys, and every field is optional so older coordinators relay them unchanged. The side panel's player diagnostics show three of them.
- Repeated heartbeat and status events in a report are merged, so a long stall no longer pushes the start of a failure out of the report.
- A written analysis of the Crunchyroll prepare stall, with a manual validation procedure for two profiles.

### Known limits for this test release

- The stall in the live Crunchyroll report, where both players stayed at metadata, is not fixed and its cause is not established. This release adds the evidence needed to tell what the provider was doing. No option that changes when a player is asked to play was built.
- A 0.2.5 extension talking to a redeployed coordinator can, for about three seconds after a paused seek, have the controller's next scrub pulled back to the old position. This was reproduced only in a unit test.
- The local three-profile browser matrix still fails intermittently on two known causes recorded in `docs/CR_D03_BROWSER_MATRIX.md`.
- This release does not claim authenticated Crunchyroll playback acceptance, two-account acceptance, real two-device acceptance, production deployment acceptance, or final user acceptance.
- The extension remains within its state-only boundary. It does not capture, transmit, or proxy video, audio, credentials, cookies, DRM material, or signed media URLs.

## [0.2.5] - 2026-09-22

This is a compatible test release containing the verified synchronization, recovery, browser-matrix, and diagnostics work merged after `v0.2.4`. The preparation baseline is main commit `da42aa14398dcd2a3c3fd4e2963ca55475408f4d`; the final release commit and tag are recorded in the release PR and GitHub Release provenance.

### Added

- Transactional playback preparation and commit handling across the extension and room coordinator, with explicit compatibility handling for mixed client and coordinator versions.
- Deterministic coverage for stalled-play recovery, playback-health deadlines, reconnect and rehydration behavior, operation ownership, navigation transactions, adaptive loading, and three-profile browser synchronization.
- Isolated browser-profile E2E artifact collection and an opt-in authenticated Crunchyroll two-profile test harness. The Crunchyroll harness safely skips when protected test states are not supplied.
- Structured diagnostic and acceptance documentation for the browser matrix, adaptive fixtures, coordinator health, player recovery, navigation, and release evidence.

### Fixed

- Bounded stalled-play and playback-health recovery so a missing or late player acknowledgement cannot leave the coordinator or room UI waiting indefinitely.
- Seek-barrier and operation-ownership edge cases that could lose acknowledgements, apply stale state, or allow an old player or socket to affect a newer session.
- Episode and shared-navigation transitions so stale media identity, playback position, or deferred navigation state cannot leak into the next video.
- Local and edge coordinator health rehydration, deadline transitions, reconnect handling, and mixed-version state migration.
- Adaptive-fixture and test-harness security boundaries, including secure URL parsing and removal of development-only security false positives from the tested production paths.

### Known limits for this test release

- This release does not claim authenticated Crunchyroll playback acceptance, two-account acceptance, real two-device acceptance, production deployment acceptance, or final user acceptance.
- Issue #30 remains open while the existing signed-in account is supplemented with a second dedicated authorized test state, an HTTPS watch URL valid for both states, a second-device environment, the exact candidate deployment identity, and a sanitized acceptance report.
- The extension remains within its state-only boundary. It does not capture, transmit, or proxy video, audio, credentials, cookies, DRM material, or signed media URLs.

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
