# Generic player fixture

The repository includes a disposable compatibility page at `fixtures/generic-player.html`. It exercises the browser-facing discovery boundary without accessing accounts, cookies, DRM, network responses, or captured media.

Start it with:

```bash
npm run dev:fixture
```

Open `http://127.0.0.1:8788/generic-player` in a normal Chrome window with the unpacked extension loaded. The page can add an open Shadow DOM player, replace the native player, change its SPA route, and attach a canvas-backed MediaStream. Use the SyncYourJoy side panel's **Redetect player** action after each fixture operation and inspect **Player diagnostics** for the selected origin, frame, source kind, ready state, network state, position, and MediaStream flag.

The flower video is an external browser-test resource. If it is unavailable, the fixture still exercises dynamic DOM, Shadow DOM, route, and MediaStream detection, but actual playback controls cannot be validated until the source loads.

This fixture is intentionally not a claim that every provider is compatible. Authenticated services and providers that use closed Shadow DOM, canvas-only rendering, browser-internal pages, or inaccessible frames require separate manual validation.
