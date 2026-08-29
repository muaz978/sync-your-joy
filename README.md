# SyncYourJoy

[![Continuous integration](https://github.com/muaz978/sync-your-joy/actions/workflows/ci.yml/badge.svg)](https://github.com/muaz978/sync-your-joy/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/muaz978/sync-your-joy?display_name=tag)](https://github.com/muaz978/sync-your-joy/releases/latest)

Synchronize play, pause, and seeking across separate streaming accounts without screen sharing.

Every participant watches through their own authorized account. SyncYourJoy coordinates playback state only. It does not capture, proxy, decrypt, record, or retransmit video or audio.

## Download and install

[Download the latest extension ZIP](https://github.com/muaz978/sync-your-joy/releases/latest/download/sync-your-joy-extension.zip) or visit the [latest release page](https://github.com/muaz978/sync-your-joy/releases/latest). A [SHA-256 checksum](https://github.com/muaz978/sync-your-joy/releases/latest/download/sync-your-joy-extension.zip.sha256) is published beside every ZIP.

Chrome cannot load an extension directly from a ZIP file. Each participant must:

1. Download `sync-your-joy-extension.zip`.
2. Extract it to a folder that will remain on the computer.
3. Open `chrome://extensions` in Google Chrome.
4. Enable **Developer mode**.
5. Select **Load unpacked**.
6. Choose the extracted `sync-your-joy-extension` folder, the one that contains `manifest.json`.
7. Pin SyncYourJoy from Chrome's Extensions menu.

After installing a newer release, replace the old extracted folder, select **Reload** on `chrome://extensions`, and refresh any streaming tabs that were already open.

Unpacked extensions do not update automatically. Normal one-click installation and automatic updates on Windows and macOS require publishing through the Chrome Web Store. See [Releasing](docs/RELEASING.md) for the GitHub and future Web Store paths.

## Use a room

1. Everyone signs in to the selected service with their own account.
2. One person opens SyncYourJoy and creates a room.
3. Friends open SyncYourJoy and join with the eight-character room code. They do not need to paste or open a video link first.
4. The controller opens the intended video page, or pastes its page URL under **Video page link** and selects **Open link for everyone**.
5. Everyone waits for **Video matches**, then selects **I'm ready**.
6. The controller uses the streaming player's normal play, pause, and progress-bar controls. SyncYourJoy sends those actions to the room automatically.

If a provider blocks autoplay, click its video once. Use **Sync me now** for one participant or **Sync everyone** for the whole room if a player drifts. No refresh should be required.

## Current public beta

Version `0.1.16` includes:

- automatic room-wide play, pause, forward seek, and backward seek;
- a transactional seek barrier that aligns real players before playback resumes;
- readiness for every participant, retained through brief reconnects and protected against temporary player replacement or media loss;
- controller-driven link launch so guests can join before any video is open, without duplicating a page that is already open;
- normalized link and platform identity matching across nested or signed players;
- a generic HTML5 adapter on HTTP and HTTPS pages, including matching embedded frames and open Shadow DOM players;
- MediaSource/blob, MediaStream, and dynamically initialized source-less player detection after metadata becomes available;
- fast recovery when a single-page app changes history, replaces a player, or swaps media on the same element;
- dedicated identity and player-discovery handling for Crunchyroll, Animerco, and Qfilm;
- a hideable in-page controller with a small restore handle, so it does not cover subtitles;
- one-click local or room-wide resynchronization;
- real-player health checks that stop a false advancing timeline when playback did not start;
- controller handoff after a disconnected-controller grace period;
- a testing-only detailed JSON report assembled from connected participants.

The public beta room coordinator is deployed at `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`. Its health endpoint is `https://sync-your-joy-rooms.sync-your-joy.workers.dev/health`.

## Platform compatibility

| Platform or player | Current status |
| --- | --- |
| Ordinary HTML5 video | Broad beta support through the generic adapter, including controllable embedded frames and open Shadow DOM players |
| Native MP4/WebM/Ogg and adaptive MSE players | Supported when the browser exposes a controllable HTML video element and usable metadata |
| Blob/MediaSource-backed players | Supported when the element is initialized and reports media metadata, even without a normal `src` attribute |
| MediaStream-backed players | Supported as a live session when the browser exposes `srcObject` and a controllable video element |
| Qfilm | Stable identity from the outer `vid` value, independent of temporary PlayerJS and signed HLS URLs |
| Animerco | Click-to-load and nested-player support, with advertising-frame filtering |
| Crunchyroll | Stable episode identity and generic player control, with ongoing live regression testing |
| Netflix and Disney+ | Generic-adapter compatibility only, with dedicated automated compatibility coverage still required |
| Closed-Shadow-DOM, canvas-only, native-app, browser-internal, or inaccessible players | Not supported by the generic HTML5 adapter |

Commercial streaming sites change frequently. The table describes the current beta implementation, not a permanent compatibility guarantee. Please use the [bug report form](https://github.com/muaz978/sync-your-joy/issues/new?template=bug_report.yml) and attach the sanitized detailed report when a supported player behaves incorrectly.

## Privacy and permissions

SyncYourJoy requests `sidePanel`, `storage`, `tabs`, `downloads`, and HTTP/HTTPS content-script access. All-sites access lets the generic adapter discover a controllable video on arbitrary pages. The script does nothing when it cannot find a video.

The extension does not request:

- screen or tab capture;
- cookies;
- web-request interception;
- debugger access;
- streaming credentials or DRM keys.

Room messages contain only synchronization state, a minimal media fingerprint, readiness, latency, and bounded diagnostics. See [Technical architecture](docs/ARCHITECTURE.md) for the complete boundary.

## Develop locally

Requirements: Node.js 22 or newer, npm, and Google Chrome 116 or newer.

```bash
npm ci
npm run check
npm run dev:server
```

Then open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose `apps/extension/dist`.

Useful commands:

```bash
npm run dev:server              # local WebSocket room service
npm run dev:edge                # local Cloudflare Durable Objects runtime
npm run deploy:edge             # deploy the edge room service
npm run smoke:edge -- URL       # exercise two clients against a room service
npm run build                   # server and unpacked extension
npm run typecheck               # strict TypeScript checks
npm test                        # protocol, server, sync, and permission tests
npm run check                   # full verification pipeline
npm run release:check-version   # verify all release versions agree
npm run release:package         # create the production extension ZIP and checksum
```

## Releasing

Pushing a semantic-version tag such as `v0.1.16` runs the release workflow. It verifies the repository, builds against the deployed room coordinator, packages the unpacked extension, validates its checksum, and creates a GitHub Release with a stable ZIP filename.

Maintainers should follow [Releasing](docs/RELEASING.md). Pull requests and pushes to `main` run the same source, test, build, and production-dependency checks through [continuous integration](.github/workflows/ci.yml).

## Project documentation

- [Public beta testing](docs/PRIVATE_BETA.md)
- [Current implementation](docs/IMPLEMENTATION.md)
- [Technical architecture](docs/ARCHITECTURE.md)
- [Reliability review and roadmap](docs/RELIABILITY_REVIEW.md)
- [Product plan](docs/PRODUCT_PLAN.md)
- [Research and constraints](docs/RESEARCH.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

No open-source license has been selected yet. The source is publicly visible, but public visibility alone does not grant permission to copy, modify, or redistribute it. A license should be added only after the project owner chooses the intended terms.
