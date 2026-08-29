# SyncYourJoy Privacy Policy

**Last updated:** 2026-08-29  
**Status:** Draft for owner review before store submission

This policy describes the SyncYourJoy browser extension and its room coordinator. SyncYourJoy synchronizes playback controls while each person watches through their own authorized streaming account. It does not share or transmit the video or audio itself.

## What SyncYourJoy processes

To provide a synchronized room, the extension processes the minimum information needed for the feature:

- A display name chosen by each participant.
- A randomly generated participant identifier and room code.
- Room membership, readiness, controller, playback, seek, buffering, and reconnect state.
- A minimal media fingerprint used to confirm that participants opened the same page, title, episode, or video. Depending on the page, this can include a provider label, stable content identifier, title, duration, and normalized page URL.
- Connection measurements such as round-trip time, clock uncertainty, and connection state.
- Bounded, sanitized diagnostic events when a participant or the room controller requests a testing report.
- Local extension preferences such as theme and the acknowledgement of this disclosure.

The extension may inspect a page's controllable `HTMLVideoElement` and related metadata to provide its video-matching and playback-control features. It does not read or transmit the video's bytes.

## What SyncYourJoy does not collect

SyncYourJoy does not request or collect:

- Screen, tab, camera, or microphone captures.
- Video or audio bytes, screenshots, or pixels.
- Streaming passwords, cookies, authentication tokens, DRM keys, or payment information.
- Browsing history unrelated to the page the user explicitly synchronizes.
- Advertising profiles, personalized advertising data, or unrelated analytics.
- A user's viewing history or subscription library.

The extension does not use the `cookies`, `webRequest`, `debugger`, `tabCapture`, or `desktopCapture` permissions.

## Why data is used

Data is used only to:

1. Create and operate a synchronized room.
2. Match each participant to the same video page or stable content identity.
3. Apply ordered play, pause, seek, readiness, and recovery commands.
4. Show connection quality and player health in the extension interface.
5. Help a consenting beta tester investigate a synchronization failure through the detailed report.
6. Secure and operate the room coordinator, including rejecting malformed or abusive messages.

SyncYourJoy does not sell, rent, or use this information for advertising or unrelated profiling.

## Room coordinator and transmission

Room synchronization messages are sent over secure WebSocket connections (`wss://`) to the SyncYourJoy room coordinator. The production coordinator currently runs on Cloudflare Workers and Durable Objects. The coordinator holds active room state so that it can serialize commands and reconnects. It is not a media proxy and does not receive video or audio.

The room coordinator may receive the room code, participant display names, participant identifiers, media fingerprints, playback state, readiness, connection measurements, and bounded diagnostic reports described above. Room state is ephemeral and is removed after the room's inactivity/expiration rules run. Diagnostic reports are assembled on the controller's device and are not retained as a report archive by the room coordinator.

## Detailed diagnostic reports

The **Download detailed report** feature is for beta testing. The controller's device asks connected participants for their bounded in-memory diagnostic logs and downloads one JSON file. The report can include extension versions, browser user-agent text, room revisions, sanitized page URLs, provider labels, media identifiers, player health, positions, pause/buffering status, connection events, and collection status.

The report does not intentionally include video, audio, screenshots, cookies, passwords, authentication data, payment data, or URL query parameters. Participants should review a report before sharing it outside the test group.

## Local storage and deletion

The extension stores its display name, theme, privacy acknowledgement, and resumable session state in browser extension storage. A user can leave a room from the side panel. Leaving removes the active room from the extension's live session state; the coordinator removes inactive rooms according to its expiration rules.

To request privacy information or deletion of data that may still be held in an active room, contact the project owner through the [SyncYourJoy support and issue page](https://github.com/muaz978/sync-your-joy/issues). **Before store publication, the owner must replace or supplement this link with a monitored privacy contact address.**

## Security

SyncYourJoy uses HTTPS/WSS for production transport, validates room messages, limits message size and rate, and keeps media transport outside the system. No security measure is perfect. Users should report suspected security issues privately through the repository's security contact rather than posting credentials or private room information in a public issue.

## Service providers and trademarks

SyncYourJoy is an independent synchronization tool. Netflix, Disney+, Crunchyroll, Qfilm, Animerco, YouTube, and other service names are used only to describe compatibility. SyncYourJoy is not affiliated with, sponsored by, or endorsed by those services. Users must maintain their own lawful subscriptions and comply with each provider's terms.

## Changes to this policy

The owner may update this policy when the extension's data practices, coordinator, or store distribution changes. The effective date at the top will be updated when a new version is published.

## Owner approval required before Gate 4

Before submitting to a store, the project owner must:

- Publish this policy at a stable HTTPS URL.
- Replace the draft contact instruction with an actively monitored privacy/support contact.
- Confirm the actual Cloudflare data-retention and account configuration.
- Ensure the store dashboard disclosure, extension UI disclosure, README, and this policy describe the same behavior.
- Obtain any legal review desired for provider terms, privacy law, and store policies.
