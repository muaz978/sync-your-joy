# SyncYourJoy

SyncYourJoy is a planned browser extension for synchronized watch parties. Every participant watches through their own streaming-service account; SyncYourJoy coordinates only playback state such as play, pause, seek, readiness, and drift.

## Project status

The project is in product and technical planning. No production extension or synchronization service has been implemented yet.

## Product principles

- Host controls must feel immediate and behave predictably.
- Everyone must watch the same title and episode through their own authorized account.
- The service never captures, proxies, decrypts, or retransmits video or audio.
- Synchronization quality must be measured honestly. The internet cannot provide literal zero latency, so the product targets an explicit sync tolerance and corrects drift automatically.
- Permissions and collected data stay as narrow as possible.

## Recommended first release

The first release is a Chrome Manifest V3 extension backed by an authoritative room service over secure WebSockets. It combines:

- a compact in-page sync pill for status and essential actions;
- a Chrome side panel for create/join, participants, readiness, control ownership, and diagnostics;
- a generic HTML5 video adapter plus explicit, versioned adapters for supported services;
- an ordered room protocol with clock-offset estimation, scheduled playback, acknowledgements, and drift correction.

## Planning documents

- [Product plan](docs/PRODUCT_PLAN.md)
- [Technical architecture](docs/ARCHITECTURE.md)
- [Research and constraints](docs/RESEARCH.md)

## Working name

`SyncYourJoy` is the working project name. Naming, visual identity, and public positioning are deliberately deferred until the core synchronization experience is validated.
