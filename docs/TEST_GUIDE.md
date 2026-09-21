# SyncYourJoy Gates 1-3 Friend Test Guide

**Test build:** SyncYourJoy `0.1.22` beta
**Download:** https://github.com/muaz978/sync-your-joy/releases/download/v0.1.22/sync-your-joy-extension.zip
**Room service:** `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`
**Production coordinator:** deployed and smoke-verified on 2026-08-30

This guide is for two or more people testing the extension on separate devices and separate streaming accounts. It covers the remaining real-device evidence for Gates 1-3 after the production coordinator deployment. The extension synchronizes playback state only. It does not share a screen, video, audio, password, cookie, subscription, or DRM key.

The side panel can report an aligned timeline even when a provider has stopped progressing its real video element. Every pass decision in this guide must therefore check the visible video and its native current time, not only the room label.

For the CR-A06 health-evidence acceptance record, use [`CR_A06_HEALTH_EVIDENCE_ACCEPTANCE_REPORT_TEMPLATE.md`](CR_A06_HEALTH_EVIDENCE_ACCEPTANCE_REPORT_TEMPLATE.md). It defines the `frames`, `clock` and `unknown` evidence vocabulary, the hidden or visible restoration checks, hidden-iframe and Picture-in-Picture boundaries, context-refresh checks, and the distinction between counter progress and visible output.

For the CR-A07 seek-barrier acceptance record, use [`CR_A07_SEEK_BARRIER_ACCEPTANCE_REPORT.md`](CR_A07_SEEK_BARRIER_ACCEPTANCE_REPORT.md). It documents deadline receipt checks, fixed-target timeout pause, fixed quorum behavior, membership/media/lease cancellation and stale acknowledgement rejection.

For the CR-B01 operation contract record, use [`CR_B01_OPERATION_CONTRACT.md`](CR_B01_OPERATION_CONTRACT.md). It defines the media epoch, operation identity, fixed participant quorum, binding/sample evidence, fail-closed capability negotiation and safe defaults for older stored state. It is a schema gate for CR-B02 and CR-B03, not proof of their runtime behavior.

For the CR-C01 stalled-play recovery record, use [`CR_C01_STALLED_PLAY_RECOVERY_REPORT.md`](CR_C01_STALLED_PLAY_RECOVERY_REPORT.md). It defines the bounded unresolved `play()` deadline, explicit Sync retry boundary, stale callback handling and the distinction between deterministic player evidence and authenticated provider acceptance.

For the CR-C02 diagnostic-report record, use [`CR_C02_DIAGNOSTIC_REPORTS.md`](CR_C02_DIAGNOSTIC_REPORTS.md). It defines the operation, media, binding and observation correlation fields, correction evidence, redaction rules, event coalescing and explicit payload truncation evidence.

For the CR-C03 player and panel recovery record, use [`CR_C03_PLAYER_RECOVERY_REPORT.md`](CR_C03_PLAYER_RECOVERY_REPORT.md). It defines the bounded participant status vocabulary, the distinction between ready and confirmed native progress, reason-specific recovery actions, privacy limits and the separate live-provider and headed-browser acceptance gates.

## Before the session

Each tester needs:

- A computer in a normal desktop browser.
- Google Chrome 116 or newer for the primary test. Firefox is optional for the browser-portability test.
- Their own authorized account for the selected video service.
- A stable internet connection.
- The same release ZIP installed on every computer.
- The selected video page available in the tester's region and subscription tier.
- A way to record the visible video time on both devices, for example by reading the native controls or pausing and checking the timestamp.

Use one short, known video first. Do not begin with a long live stream or a page that has multiple unrelated players.

## Install the extension in Chrome

1. Download the ZIP from the link above.
2. Extract it to a permanent folder. Do not load the compressed ZIP directly.
3. Open `chrome://extensions`.
4. Enable **Developer mode**.
5. Select **Load unpacked**.
6. Choose the extracted folder containing `manifest.json`.
7. Pin SyncYourJoy from the Extensions menu.
8. Open a normal HTTP or HTTPS video page.
9. On first use, read the privacy disclosure and select **I understand and continue**.
10. Refresh the video page after installing or reloading the extension.

## Production preflight

The maintainer has deployed the room coordinator and passed the production smoke test. If the coordinator is redeployed before a test session, run these commands from the repository directory, not from `~`:

```bash
cd /Users/muazsabbagh/Codex/Projects/SyncYourJoy
npm run deploy:edge
npm run smoke:edge -- wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms
```

Participants do not need Node.js, Wrangler, or a Cloudflare account. They only need the published extension ZIP.

## Create and join a room

1. The host opens the intended video page, pauses it near the beginning, and opens the SyncYourJoy side panel.
2. The host selects **Start a synced room**.
3. The friend opens SyncYourJoy and enters the eight-character room code. The friend does not paste a video URL.
4. The host enters the page URL under **Video page link** and selects **Open link for everyone**. Guests do not paste a video URL. If a new tab is blocked, allow popups for the current page and retry once.
5. Wait for each side to show the intended player, a moving or controllable native timeline, and **Video matches**.
6. Each participant selects **I'm ready**.
7. Confirm that every participant sees the ready button, both participants show **Ready**, and readiness does not disappear during the next tests unless the video genuinely changes or a connection is lost.
8. Keep the side panel open for status. Hide the mini controller if it covers subtitles or player controls.

## Test A: automatic play and pause

1. With everyone ready, the host clicks the video's native play button.
2. Verify that every participant starts without clicking Play all.
3. Wait 30 seconds and compare the visible playback positions.
4. The host clicks the native pause button.
5. Verify that every participant pauses without refreshing.
6. Repeat play and pause three times.

Pass when every participant's real video starts and stops, not merely the room timeline. Record the visible video time on both devices, perceived delay, and any **stopped**, **buffering**, or **autoplay blocked** message.

## Test B: forward and backward seeking

1. Start playback and drag the host's progress bar forward by about 30 seconds. Do not refresh either page.
2. Confirm that both native video elements reach the target, not just that the side panel says aligned.
3. Repeat with a backward seek of about 30 seconds. Wait at least five seconds and verify actual frame progress after the seek.
4. Repeat with three rapid drags in different directions. The final drag must win on both real timelines.
5. Repeat while the room is paused, then press play once from the host.
6. Select **Sync everyone** once. Verify that both videos jump to the displayed position and continue progressing.
7. If only the room seconds change while one video remains frozen, stop testing, download the detailed report before refreshing, and mark the case failed.

Pass when no refresh is required, both real videos reach the target, the room does not resume before the guest confirms the target, and a failed or slow seek leaves the room safely paused rather than letting the timeline run ahead.

## Test C: autoplay and manual recovery

1. Open Chrome site settings for the provider and use a clean tab if possible.
2. Start a room and select **I'm ready** on both sides.
3. Have the host start playback.
4. If a browser blocks a guest's script-initiated play, click the video once on that guest's device.
5. Select **Sync me now** in the side panel or **Sync** in the in-page pill.
6. Confirm that the guest joins the authoritative position without a refresh and that its real video continues progressing for at least 15 seconds.

Pass when the UI explains the user gesture requirement and one explicit click repairs playback.

## Test D: reconnect and readiness stability

1. Start playback with both participants ready.
2. Temporarily disable the friend's network for 5 to 15 seconds, then restore it.
3. Confirm that the side panel shows reconnecting and then connected.
4. Confirm that a brief reconnect with the same video does not unnecessarily cancel readiness. If readiness cancels, record whether the media URL, selected player, or room connection actually changed.
5. Repeat by backgrounding the video tab and returning to it.
6. Repeat after putting one computer to sleep briefly.
7. Refresh the friend's video tab and wait for the player to be detected again.

Pass when state recovers without manual page refreshes beyond the deliberate refresh test, and when a genuine navigation or different video correctly requires readiness again.

## Test H: provider and browser matrix

Run the core play/pause and forward/backward seek tests on each provider you intend to claim in release notes. Use the same room and test order, but do not assume that success on one provider proves another provider.

| Provider or page type | Browser | Account available | Play/pause | Forward seek | Backward seek | Real progress | Report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Generic HTML5 fixture | Chrome | N/A |  |  |  |  |  |
| Crunchyroll | Chrome |  |  |  |  |  |  |
| Netflix | Chrome |  |  |  |  |  |  |
| Disney+ | Chrome |  |  |  |  |  |  |
| Animerco or nested player | Chrome |  |  |  |  |  |  |
| Qfilm or cross-origin player | Chrome |  |  |  |  |  |  |
| Selected provider | Firefox |  |  |  |  |  |  |

## Test E: controller handoff

1. Start playback with both participants ready.
2. Close the controller's video tab or browser for more than ten seconds.
3. Confirm the room pauses safely.
4. Confirm that control transfers to the remaining participant according to the room UI.
5. Have the new controller play and pause once.

Pass when the former controller cannot continue issuing controls and the new controller's lease is visible to both sides.

## Test F: matching and multiple players

1. Open the same page on both devices using the host's **Open link for everyone** action.
2. Confirm that different regional page titles or nested player URLs still match when the canonical content is the same.
3. Open a page with more than one video element.
4. Inspect **Player diagnostics**.
5. Use **Lock selected player**, then trigger play, pause, and seek.
6. Confirm that an advertisement or unrelated background video cannot replace the selected player.
7. Select **Redetect player** after the page replaces its player or changes route without a full reload.

Pass when the intended video remains bound and unrelated videos do not change readiness or room state.

## Test G: network-quality and chaos checks

Run this test only if you know how to use your browser or operating-system network tools. Do not intentionally damage another person's computer.

1. Add approximately 50 ms latency and repeat Test A and Test B.
2. Add approximately 150 to 300 ms latency and repeat Test A and Test B.
3. Add jitter or brief packet loss.
4. Disconnect and reconnect the network.
5. Observe the side-panel quality label, RTT, clock quality, and reconnect state.
6. Download a report after each failure.

Pass when the UI shows degraded/offline state honestly, reconnect is bounded, and a slow seek remains safe rather than releasing an unconfirmed participant into playback.

## How to download the detailed report

Only the room controller can collect the room-wide report.

1. Open the side panel while the room is still connected.
2. Expand or locate **Beta diagnostics**.
3. Select **Download detailed report**.
4. Wait for the JSON file to download.
5. Keep the report together with the exact test step and time of the failure.
6. Review it before sharing. It is designed to exclude passwords, cookies, media bytes, audio, screenshots, and URL query parameters, but do not attach unrelated private files.

If the failure involves seeking, download the report before refreshing either tab. Include whether the side-panel seconds changed, whether the native video time changed, and whether the video rendered new frames.

## Fast recovery when a video is not progressing

Use this order once, then collect a report instead of repeatedly clicking controls:

1. Confirm the affected tab still shows the intended video and native controls.
2. Click the video once if the browser may have blocked script-initiated playback.
3. Select **Sync me now** or the in-page **Sync** action.
4. Wait 10 seconds and compare the visible video time, not only the room timeline.
5. If it is still frozen, download the detailed report before refreshing.
6. Refresh only as a separate recovery test and record that a refresh was required.

## What to record for every issue

- Test letter and step.
- Provider and exact page type.
- Host or guest.
- Browser and version.
- Operating system.
- Whether the video was visible and controllable.
- The native video time before and after the control.
- Whether new frames visibly rendered after play or seek.
- Side-panel status and RTT.
- Whether readiness changed unexpectedly.
- Whether the room clock moved while the local video was stopped.
- Whether a refresh was required.
- The downloaded detailed-report filename.
- A short screen description, without account or payment information.

## Pass/fail worksheet

| Test | Result | Delay or drift | Refresh required | Report filename | Notes |
| --- | --- | --- | --- | --- | --- |
| A. Automatic play/pause |  |  |  |  |  |
| B. Forward/backward seek |  |  |  |  |  |
| C. Autoplay recovery |  |  |  |  |  |
| D. Reconnect/readiness |  |  |  |  |  |
| E. Controller handoff |  |  |  |  |  |
| F. Matching/multiple players |  |  |  |  |  |
| G. Network chaos |  |  |  |  |  |
| H. Provider/browser matrix |  |  |  |  |  |

## Release-blocking outcomes

Report these as release blockers until reproduced and fixed:

- A guest shows a different title or episode as matched.
- The room timeline advances while a participant's real video is stopped.
- A forward or backward seek requires a refresh.
- A later seek loses to an older seek.
- Readiness cancels during ordinary playback or a short reconnect.
- A participant receives controls for an unrelated player or advertisement.
- A controller that lost its lease can still control the room.
- A report includes credentials, cookies, video, audio, or other unexpected sensitive data.

## Automated two-profile E2E test (for contributors)

This section is for people working on the code, not for friend-test sessions above. It runs `tests/e2e/two-profile-sync.spec.ts`, the repository's first automated two-browser-profile test (see `docs/CODE_AUDIT.md`, `SYJ-AUD-009`). It launches two separate, isolated Chrome profiles with the real unpacked extension loaded in each, has one create a room and the other join it with the real room code, opens the project's own local `apps/room-service/static/test-player.html` fixture page in both, loads the same tiny local `fixtures/sync-test-clip.mp4` file into each through its file picker, and drives play, pause, and a forward seek from the first profile's real side panel while asserting the second profile's real `<video>` element converges to the same position and play state. It uses the real room-service and the real extension end to end; nothing here is mocked.

Run it with:

```bash
npm run test:e2e
```

This needs a Chromium build Playwright controls, installed once with:

```bash
npx playwright install chromium
```

The test:

1. Starts the room-service in-process on an ephemeral port (the same `createRoomService` helper `apps/room-service/src/server.test.ts` uses), so it never collides with a `npm run dev:server` you already have running or with another `test:e2e` run.
2. Builds `apps/extension/dist` against that exact port and reuses it on a later run only if it is already built for the same port.
3. Launches two persistent Chrome profiles in Chrome's `--headless=new` mode (set `SYNCYOURJOY_E2E_HEADED=1` to watch it run in a visible window instead) with `--load-extension` pointed at `apps/extension/dist`.

This test is separate from `npm test` (Vitest) on purpose: it drives real browsers and a real extension, so it is slower and needs its own timeouts. It is not part of `.github/workflows/ci.yml` yet — wiring a dedicated, separately-tuned CI job for it is a deliberate follow-up, not an oversight.

It drives the side panel's own HTML and JavaScript by opening `sidepanel.html` as an ordinary tab at its `chrome-extension://` URL rather than through Chrome's docked side-panel UI region, which Playwright cannot click into (that requires a real click on the browser's own toolbar icon). The panel's code has no dependency on being docked to run, so every button the test clicks runs the same real code path either way; see the comment at the bottom of `tests/e2e/two-profile-sync.spec.ts` for the full investigation, including why driving the extension purely through `chrome.runtime` messages to its service worker was not needed here.

### Authenticated Crunchyroll two-profile E2E

Issue [#30](https://github.com/muaz978/sync-your-joy/issues/30) adds an opt-in provider run beside the generic fixture. The spec is `tests/e2e/crunchyroll-two-profile.spec.ts`. It launches two isolated extension profiles, opens the same authorized Crunchyroll `/watch/` URL in both profiles, waits for a visible metadata-ready native video, and drives the real room flow through play, forward seek, native backward seek, frame-progress observation, convergence, and pause.

The provider run is deliberately state-only. It does not read or print cookies, credentials, signed media URLs, media bytes, screenshots, page HTML, DRM data, or private player APIs. Its browser assertions are limited to native media state and frame-progress evidence. A passing provider run proves the tested URL, browser, account state, extension build, and coordinator combination for that run only. It does not prove every Crunchyroll title, locale, timed edition, browser, graphics path, or future provider deployment.

The provider spec is skipped by the ordinary `npm run test:e2e` command unless all three variables below are supplied. This keeps normal contributor runs deterministic and prevents accidental use of a signed-in account:

```bash
export SYNCYOURJOY_CRUNCHYROLL_URL='https://www.crunchyroll.com/watch/REDACTED'
export SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_A='/secure/path/crunchyroll-a.json'
export SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_B='/secure/path/crunchyroll-b.json'
npm run test:e2e -- --grep 'authenticated Crunchyroll'
```

The same run has a dedicated package script for CI and repeatable local use:

```bash
npm run test:e2e:crunchyroll
```

The two storage-state files are sensitive authentication material. Create them only in a protected local directory or a protected CI secret, never commit them, never paste them into an issue or pull request, and remove or rotate them after the acceptance run. Do not copy browser cookies manually from a daily-use profile. Use dedicated authorized test profiles and the normal Playwright storage-state format.

The separately tuned manual CI workflow is `.github/workflows/e2e-crunchyroll.yml`. Run it from GitHub Actions with an HTTPS Crunchyroll `/watch/` URL and the two repository secrets `SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_A_B64` and `SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_B_B64`. The workflow decodes those secrets only into the ephemeral runner temp directory, validates that they are JSON, runs the provider spec, and never echoes their contents. It is manual by design because authenticated provider accounts and protected media must not be used on ordinary pull requests or fork builds.

### CR-D04 two-account and cross-provider acceptance

Issue [#33](https://github.com/muaz978/sync-your-joy/issues/33) is the broader manual acceptance matrix. It is distinct from the opt-in two-profile harness above: CR-D04 requires extension-disabled baselines, the exact candidate build, Edge and Chrome, role swaps, at least three episodes or timed editions, cold and warm seeks, Skip Intro, audio or source changes, episode transitions, YouTube and generic or nested players, and at least 30 seek or intro actions per claimed browser/controller combination.

Use [`docs/CRUNCHYROLL_CRD04_ACCEPTANCE_REPORT_TEMPLATE.md`](CRUNCHYROLL_CRD04_ACCEPTANCE_REPORT_TEMPLATE.md) for every controlled run. It keeps native media state, aggregate progress evidence and human visible-motion observation separate. A changing counter with black or frozen visible output is not a pass. Missing accounts, devices, deployment or title access must be recorded as blocked or not run, never converted into a successful result.

### Real two-device network-chaos and reconnect acceptance

Issue [#34](https://github.com/muaz978/sync-your-joy/issues/34) is a separate physical-device gate. The deterministic `network-chaos.test.ts` and room fuzz harness cover protocol delay, reordering and duplication, but they do not prove OS-level throttling, offline/online transitions, sleep/wake or browser reconnect behavior.

Use [`docs/SYJ_TWO_DEVICE_NETWORK_CHAOS_REPORT_TEMPLATE.md`](SYJ_TWO_DEVICE_NETWORK_CHAOS_REPORT_TEMPLATE.md) for each controlled run. It records the exact candidate and deployment, two-device baseline, fault profile, room revision, connection and lease state, readiness, native playback, aggregate progress, visible motion and safe recovery outcome. A WebSocket reconnect or advancing counter alone is not proof that the real player recovered.

### Headed-browser and cross-platform acceptance

Issue [#35](https://github.com/muaz978/sync-your-joy/issues/35) is a separate headed-runtime gate. Headless Chromium CI and package-build checks do not establish open Shadow DOM behavior, same-element SPA changes, player-lock UI behavior, a real Firefox installation or a Safari conversion/runtime pass.

Use [`docs/SYJ_HEADED_CROSS_PLATFORM_REPORT_TEMPLATE.md`](SYJ_HEADED_CROSS_PLATFORM_REPORT_TEMPLATE.md) for each claimed runtime. Record Chrome or Edge headed lifecycle evidence, Firefox installation and coordinator-origin smoke when claimed, and Safari conversion, Xcode and runtime evidence when claimed. An unavailable runtime must be marked blocked or not claimed, not passed by inference.

### CR-A02 player identity acceptance

Issue [#49](https://github.com/muaz978/sync-your-joy/issues/49) tracks the remaining identity acceptance boundary after the deterministic identity changes in PR #70. The content script and worker must make the same identity decision for top-document Crunchyroll, an origin-only Crunchyroll iframe, a generic nested embed and Qfilm. Commands, controller intents, samples and seek acknowledgements must remain bound to the selected player, while unrelated frames and known mismatches remain blocked.

Use [`docs/CR_A02_IDENTITY_ACCEPTANCE_REPORT_TEMPLATE.md`](CR_A02_IDENTITY_ACCEPTANCE_REPORT_TEMPLATE.md) for the report. The deterministic matrix in `apps/extension/src/content-script.test.ts` is supporting evidence only. A real headed nested-frame run is still required before issue #49 can be accepted for release.

### CR-A03 operation ownership acceptance

Issue [#50](https://github.com/muaz978/sync-your-joy/issues/50) tracks ownership of asynchronous native seek and play operations through cancellation, timeout, source replacement, room exit and controller changes. The operation token and generation contract must prevent a late provider event from becoming a new controller intent, keep one same-target native write in flight, and allow read-only completion observation after timeout without a retry loop.

Use [`docs/CR_A03_OPERATION_OWNERSHIP_ACCEPTANCE_REPORT_TEMPLATE.md`](CR_A03_OPERATION_OWNERSHIP_ACCEPTANCE_REPORT_TEMPLATE.md) for the evidence record. `apps/extension/src/player-operations.test.ts` is the isolated ownership contract suite, while `apps/extension/src/content-script.test.ts` covers integration with native readiness, room state, source lifecycle, local pause and controller intent. These deterministic tests do not prove commercial-provider playback, visible frame output, deployment behavior or user acceptance. Record those separately when a headed browser or provider run is requested.

### CR-A04 player binding and document replacement acceptance

Issue [#51](https://github.com/muaz978/sync-your-joy/issues/51) tracks the remaining worker-side binding boundary after the partial protections in PR #70. Use [`docs/CR_A04_PLAYER_BINDING_ACCEPTANCE_REPORT_TEMPLATE.md`](CR_A04_PLAYER_BINDING_ACCEPTANCE_REPORT_TEMPLATE.md) for the evidence record. The worker must bind sender-bound messages to the selected tab, frame, Chromium document identity when available, or the worker-issued opaque fallback token when document identity is unavailable. `apps/extension/src/service-worker.test.ts` covers same-frame document replacement, stale old-document status, media-loss, seek acknowledgement and player-intent rejection, exact document-targeted delivery, fallback token stability and token rotation after loading. These deterministic tests establish worker-level identity protection only. They do not prove authenticated Crunchyroll playback, two-profile or two-account behavior, two-device behavior, deployment identity or user acceptance. Record those separately when the corresponding gate is actually run.

### CR-A05 drift correction and convergence acceptance

Issue [#52](https://github.com/muaz978/sync-your-joy/issues/52) tracks bounded correction after a player falls behind during a delayed seek or resets its playback rate. Use [`docs/CR_A05_DRIFT_CONVERGENCE_ACCEPTANCE_REPORT_TEMPLATE.md`](CR_A05_DRIFT_CONVERGENCE_ACCEPTANCE_REPORT_TEMPLATE.md) for every claimed run.

The sync-engine policy allows a temporary `0.98` or `1.02` rate only when the player is playing, not buffering or seeking, has no pending native operation, and has recent progress evidence. The content script verifies that the player accepted the assigned rate, retires it on buffering, seeking, pause, source change or operation change, and does not reapply it indefinitely. An ignored or reset rate falls back to one hard correction and then an explicit paused recovery state if convergence still fails. A newer controller command resets the old correction budget and wins.

Run the deterministic coverage with:

```sh
npx vitest run packages/sync-engine/src/clock.test.ts apps/extension/src/content-script.test.ts
```

The content-script cases include no-progress refusal, accepted-rate application, lifecycle termination, ignored/reset-rate fallback, 30-second delayed-seek observation and newer-command precedence. The 800 ms, 1,200 ms and 2,000 ms synthetic delays prove bounded local behavior only. They do not prove that Crunchyroll accepts playback-rate changes, that visible frames are moving, or that two accounts or devices remain synchronized.

For a controlled headed observation, record the exact candidate package, room revision, player position, native state, playback-rate value, buffering and seek events, recent progress evidence, visible motion and recovery outcome. Use the active signed-in Crunchyroll browser only as an authorized visible observation. Do not copy daily-browser cookies into isolated test state, use private provider APIs, access protected media bytes or treat a changing media clock as visible-video proof.
