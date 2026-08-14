# SyncYourJoy

SyncYourJoy is a Chrome extension for synchronized watch parties. Every participant watches through their own streaming-service account; SyncYourJoy coordinates only playback state such as play, pause, seek, readiness, and drift.

## Project status

An end-to-end private beta is deployed. It includes the Manifest V3 extension, a Cloudflare Durable Objects WebSocket coordinator, a local development server, the shared synchronization engine, a generic HTML5 adapter, a local test player, and automated tests.

The beta room service is available at `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`. Its HTTP health endpoint is `https://sync-your-joy-rooms.sync-your-joy.workers.dev/health`.

## Product principles

- Host controls must feel immediate and behave predictably.
- Everyone must watch the same title and episode through their own authorized account.
- The service never captures, proxies, decrypts, or retransmits video or audio.
- Synchronization quality must be measured honestly. The internet cannot provide literal zero latency, so the product targets an explicit sync tolerance and corrects drift automatically.
- Permissions and collected data stay as narrow as possible.

## Implemented MVP

The current build combines:

- a compact in-page sync pill for status and essential actions;
- a Chrome side panel for create/join, participants, readiness, control ownership, and diagnostics;
- a generic HTML5 video adapter enabled on HTTP/HTTPS pages, including videos inside embedded frames;
- controller-driven shared-link navigation that opens the same normalized video page for every participant and resets readiness safely;
- link-first rooms where guests join before opening any video, plus one-click local and room-wide resynchronization;
- an ordered room protocol with clock-offset estimation, scheduled playback, acknowledgements, and drift correction;
- real-player health checks that stop the room when a participant remains paused or stops progressing;
- a testing-only, controller-triggered JSON report containing sanitized logs from all connected participants.

It does not request screen capture, desktop capture, cookies, web request interception, or debugger permissions. It never captures or retransmits video or audio.

## Run locally

Requirements: Node.js 22 or newer and Google Chrome 116 or newer.

```bash
npm install
npm run check
npm run dev:server
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select `apps/extension/dist`.
4. Open `http://127.0.0.1:8787/test-player`, or any HTTP/HTTPS page with a controllable HTML5 video.
5. Select the same local test video in two Chrome profiles, open SyncYourJoy, create a room in one profile, and join with the code in the other.

The test player never uploads the selected file. Each browser creates a local object URL for its own copy.

## Deploy an edge beta

Authenticate Wrangler, deploy the room coordinator, and build the extension with the resulting WSS endpoint:

```bash
npx wrangler login
npm run deploy:edge
SYNCYOURJOY_ROOM_SERVER_URL=wss://YOUR-WORKER.workers.dev/rooms npm run build:extension
npm run smoke:edge -- wss://YOUR-WORKER.workers.dev/rooms
```

The build script inserts that endpoint into the extension bundle and adds its origin to the Manifest V3 content security policy. See [private beta testing](docs/PRIVATE_BETA.md) for installation and two-city test instructions.

## Commands

```bash
npm run dev:server      # local WebSocket room service
npm run dev:edge        # local Cloudflare Durable Objects runtime
npm run deploy:edge     # deploy the edge room service
npm run smoke:edge -- URL # exercise two clients against a room service
npm run build           # server and unpacked extension
npm run typecheck       # strict TypeScript check
npm test                # protocol, server, sync, and permission tests
npm run check           # full verification pipeline
```

## Planning documents

- [Product plan](docs/PRODUCT_PLAN.md)
- [Technical architecture](docs/ARCHITECTURE.md)
- [Research and constraints](docs/RESEARCH.md)
- [Current implementation](docs/IMPLEMENTATION.md)
- [Private beta testing](docs/PRIVATE_BETA.md)
- [Reliability review and roadmap](docs/RELIABILITY_REVIEW.md)

## Working name

`SyncYourJoy` is the working project name. Naming, visual identity, and public positioning are deliberately deferred until the core synchronization experience is validated.
