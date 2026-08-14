# Private beta testing

This beta synchronizes playback commands and timing only. It never captures, uploads, proxies, or retransmits video or audio. Every participant must use their own authorized streaming-service account and open the same title or episode on their own device.

The current extension package connects to the deployed Cloudflare room service at `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`.

## Install on both computers

1. Send `sync-your-joy-beta.zip` to the other tester through your preferred private file-sharing channel.
2. On each computer, unzip it into a folder that will not be deleted during the test.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Select **Load unpacked** and choose the unzipped folder that contains `manifest.json`.
6. Pin SyncYourJoy from Chrome's extensions menu.

Because this is an unpacked beta, Chrome does not auto-update it. Both testers should replace their folder when a new beta ZIP is provided.

Chrome shows an all-sites access warning because the universal adapter must discover HTML5 video on arbitrary HTTP/HTTPS pages. The beta does not request capture, cookies, web-request interception, or debugger access.

After replacing or reloading the extension, refresh the open streaming tab so Chrome injects the updated player adapter.

## Run a two-city test

1. Both testers sign in to the chosen service with their own accounts. The host opens the intended title, pauses near the beginning, opens SyncYourJoy, and selects **Start synced room**.
2. The friend joins with the eight-character code immediately. They do not need a video or link open first.
3. The host can paste the exact video-page URL under **Video page link** and select **Open link for everyone**. Chrome opens that normalized HTTP/HTTPS link in a new tab for every connected participant at the same scheduled time.
4. Navigation clears readiness. Wait for both sides to show **Video matches**, then each participant selects **I'm ready**.
5. After both people show **Ready**, the host tests the streaming player's native play, pause, and progress-bar drag controls. The side-panel remote remains available as a fallback.
6. Test a short buffer or network interruption, then verify that the room pauses and recovers.
7. Finally, close the host's tab for more than ten seconds and verify that control passes to the connected participant.

If SyncYourJoy reports **Wrong video**, focus the tab containing the intended episode and select **Recheck this tab**. Equal normalized page links are treated as a strong match. After a room binds to a player tab and frame, unrelated videos, ads, and background tabs cannot control or overwrite that room.

Play, pause, and dragging the progress bar are automatic when performed by the controller in the streaming player's native controls. If Chrome blocks or stalls playback, press **Sync** once in the in-page SyncYourJoy pill. This aligns the timeline and supplies the user activation Chrome may require; the room pauses instead of letting its displayed timeline run ahead of a stopped guest.

The panel now labels the local reading **Your video**. It comes from the real bound player instead of a mathematical room clock, and it shows **stopped** if the room expected playback but the local video did not start.

Use **Sync me now** in the side panel for an immediate local correction, or **Sync everyone** from the controller panel to schedule the entire room at one authoritative position. Neither action requires refreshing the streaming page.

After **Sync everyone**, **Play all** starts from the room position shown in the remote. A short provider startup wait is treated as normal; a stale buffering report from before the play command cannot force-pause the room.

Dragging the controller's progress bar now creates a room-wide alignment barrier. The panel shows **Aligning x/y** while each provider finishes its real seek, then automatically resumes everyone together if the room had been playing. A newer drag replaces an older one. If a provider cannot load the target, the room stays safely paused and that participant can press **Sync**—no refresh is required.

The fast path responds to the final drag within 60 ms and releases as soon as each player reports that seeking ended at the target. Providers that omit `seeked` are probed every 80 ms, while any unconfirmed network acknowledgement retries automatically.

The controller no longer waits for its streaming site to emit `seeked` before notifying the room. The stabilized scrub target is sent directly, and **Aligning** has a 750 ms maximum: aligned viewers resume together while an unusually slow provider finishes catching up on its own device.

## Download a beta diagnostic report

The controller can select **Download detailed report** under **Beta diagnostics**. SyncYourJoy asks every connected participant for its bounded in-memory playback log, waits up to 2.5 seconds, and downloads one JSON file on the controller's device. The file records room revisions, sanitized player binding changes, play and seek positions, paused or buffering states, connection events, extension versions, and any participants that did not respond.

This testing-only report does not contain video, audio, screenshots, cookies, passwords, subscription data, invite tokens, or page query parameters. Reports are relayed directly through the active room and are not stored as a report archive by the room coordinator. Send the JSON file with the bug description when a synchronization issue needs investigation.

Animerco episode pages initially contain only a poster and create their player iframe after the page's own play action. When such a page is opened through the room link, SyncYourJoy loads the default player server automatically and ignores the page's advertising iframe during player selection.

The default Animerco option may nest a signed wrapper and a Google Drive preview. SyncYourJoy identifies every nested player by the room's original episode URL, waits for media metadata, clamps seeks to the player's available ranges, and waits for seek completion before resuming. If a provider cannot expose the requested position yet, the room pauses and retries; do not refresh.

## What to record

- streaming service, browser version, and operating system;
- whether the extension found the video;
- whether Chrome blocked autoplay until a click;
- any wrong-title or wrong-episode warning;
- perceived delay for play and pause;
- buffering, drift, reconnect, or controller-transfer behavior;
- screenshots of extension errors only—never account, payment, or protected-media information.

The generic adapter runs on HTTP/HTTPS pages and supports ordinary, script-controllable `HTMLVideoElement` players, including embedded frames. It cannot guarantee control of canvas-only, native-app, browser-internal, or deliberately inaccessible players. Commercial sites change often, so treat each service as compatibility testing rather than a production-support guarantee.
