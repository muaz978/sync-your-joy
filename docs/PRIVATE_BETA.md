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
2. The friend joins with the eight-character code from any page where SyncYourJoy can detect a video.
3. The host can paste the exact video-page URL under **Video page link** and select **Open link for everyone**. Chrome opens that normalized HTTP/HTTPS link in a new tab for every connected participant at the same scheduled time.
4. Navigation clears readiness. Wait for both sides to show **Video matches**, then each participant selects **I'm ready**.
5. After both people show **Ready**, the host tests the streaming player's native play, pause, and progress-bar drag controls. The side-panel remote remains available as a fallback.
6. Test a short buffer or network interruption, then verify that the room pauses and recovers.
7. Finally, close the host's tab for more than ten seconds and verify that control passes to the connected participant.

If SyncYourJoy reports **Wrong video**, focus the tab containing the intended episode and select **Recheck this tab**. Equal normalized page links are treated as a strong match. After a room binds to a player tab and frame, unrelated videos, ads, and background tabs cannot control or overwrite that room.

Play, pause, and dragging the progress bar are automatic when performed by the controller in the streaming player's native controls. If Chrome blocks the first remote play, select **Enable** once in the in-page SyncYourJoy pill; Chrome requires this user activation and the remaining room controls are automatic afterward.

## What to record

- streaming service, browser version, and operating system;
- whether the extension found the video;
- whether Chrome blocked autoplay until a click;
- any wrong-title or wrong-episode warning;
- perceived delay for play and pause;
- buffering, drift, reconnect, or controller-transfer behavior;
- screenshots of extension errors only—never account, payment, or protected-media information.

The generic adapter runs on HTTP/HTTPS pages and supports ordinary, script-controllable `HTMLVideoElement` players, including embedded frames. It cannot guarantee control of canvas-only, native-app, browser-internal, or deliberately inaccessible players. Commercial sites change often, so treat each service as compatibility testing rather than a production-support guarantee.
