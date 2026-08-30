# SyncYourJoy Gates 1-3 Friend Test Guide

**Test build:** SyncYourJoy `0.1.22` beta
**Download:** https://github.com/muaz978/sync-your-joy/releases/download/v0.1.22/sync-your-joy-extension.zip
**Room service:** `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`
**Production coordinator:** deployed and smoke-verified on 2026-08-30

This guide is for two or more people testing the extension on separate devices and separate streaming accounts. It covers the remaining real-device evidence for Gates 1-3 after the production coordinator deployment. The extension synchronizes playback state only. It does not share a screen, video, audio, password, cookie, subscription, or DRM key.

The side panel can report an aligned timeline even when a provider has stopped progressing its real video element. Every pass decision in this guide must therefore check the visible video and its native current time, not only the room label.

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
