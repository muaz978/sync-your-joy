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

After replacing or reloading the extension, refresh the open streaming tab so Chrome injects the updated player adapter.

## Run a two-city test

1. Both testers sign in to the same supported service with their own accounts and open the exact same title and episode.
2. Pause both players near the beginning and open SyncYourJoy.
3. The host selects **Start synced room** and sends the eight-character code to the friend.
4. The friend enters the code and joins. Both the host and friend confirm the video match and select **I'm ready** on their own side panel.
5. After both people show **Ready**, the host tests play, pause, and seeking. Test one action at a time and allow the UI to report whether both participants are in sync.
6. Test a short buffer or network interruption, then verify that the room recovers.
7. Finally, close the host's tab for more than ten seconds and verify that control passes to the connected participant.

If SyncYourJoy reports **Wrong video**, focus the tab containing the intended episode and select **Recheck this tab**. Background YouTube or streaming tabs are ignored after a room binds to its player tab.

## What to record

- streaming service, browser version, and operating system;
- whether the extension found the video;
- whether Chrome blocked autoplay until a click;
- any wrong-title or wrong-episode warning;
- perceived delay for play and pause;
- buffering, drift, reconnect, or controller-transfer behavior;
- screenshots of extension errors only—never account, payment, or protected-media information.

The generic HTML5 adapter is enabled for YouTube, Netflix, Disney+, and Crunchyroll, but commercial player implementations change often. Treat this as compatibility testing, not a production-support guarantee.
