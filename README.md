# SyncYourJoy

SyncYourJoy is a Chrome extension for synchronized watch parties. Every participant watches through their own streaming-service account; SyncYourJoy coordinates only playback state such as play, pause, seek, readiness, and drift.

## Project status

An end-to-end local MVP is implemented. It includes the Manifest V3 extension, authoritative WebSocket room service, shared synchronization engine, generic HTML5 adapter, local test player, and automated tests.

The current backend listens on localhost, so it is a development vertical slice rather than an internet-deployed release. Remote parties require the room service to be deployed and the extension's WebSocket endpoint and content security policy to be updated.

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
- a generic HTML5 video adapter enabled on YouTube, Netflix, Disney+, Crunchyroll, and the local test player;
- an ordered room protocol with clock-offset estimation, scheduled playback, acknowledgements, and drift correction.

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
4. Open `http://127.0.0.1:8787/test-player`, or open a supported streaming page.
5. Select the same local test video in two Chrome profiles, open SyncYourJoy, create a room in one profile, and join with the code in the other.

The test player never uploads the selected file. Each browser creates a local object URL for its own copy.

## Commands

```bash
npm run dev:server      # local WebSocket room service
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

## Working name

`SyncYourJoy` is the working project name. Naming, visual identity, and public positioning are deliberately deferred until the core synchronization experience is validated.
