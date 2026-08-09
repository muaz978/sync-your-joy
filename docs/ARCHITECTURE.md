# Technical architecture

## 1. Recommended system

```text
Streaming page
  └─ versioned site adapter + in-page status pill
       ⇅ chrome.runtime messaging
Chrome extension side panel / service worker
       ⇅ WSS
Edge gateway
       ⇅
One authoritative room coordinator per room
       ├─ ordered room state
       ├─ host lease and membership
       └─ ephemeral persistence / telemetry
```

Recommended implementation direction:

- **Extension:** TypeScript, Chrome Manifest V3, a small UI framework only if it materially improves accessibility and state management.
- **Realtime backend:** Cloudflare Worker routing each room to one Durable Object, with WebSocket hibernation.
- **Shared packages:** protocol types, room state machine, adapter contract, and test fixtures.
- **Testing:** unit/property tests for the state machine, a fake-player simulator, Playwright extension tests across multiple persistent Chrome contexts, and network-shaping tests.

Cloudflare Durable Objects fit the room model because one object can serialize a room's state and coordinate its WebSocket clients. This is a recommendation, not a locked dependency; a single-region Node/WebSocket service is a valid early prototype if infrastructure simplicity matters more than global latency.

## 2. Extension components

### Site adapter

Each adapter exposes a capability-based contract rather than leaking site selectors into synchronization logic:

```ts
interface PlayerAdapter {
  detect(): Promise<PlayerIdentity | null>;
  readState(): Promise<PlaybackSample>;
  play(atSeconds: number): Promise<void>;
  pause(): Promise<void>;
  seek(atSeconds: number): Promise<void>;
  setPlaybackRate?(rate: number): Promise<void>;
  subscribe(listener: (event: PlayerEvent) => void): Unsubscribe;
}
```

The generic adapter observes `HTMLMediaElement` state and events. Platform adapters add safe media identification, navigation awareness, buffering semantics, and capability checks. They must not inspect credentials, cookies, DRM keys, decoded media, network responses containing protected content, or unrelated page data.

When a site's player requires page-world access, use a small packaged bridge and explicit `window.postMessage` schema. All executable logic ships inside the extension; the server may send feature flags and thresholds, but never code or selectors that are evaluated as code.

### Side panel

The side panel owns room UX and holds a long-lived extension page while open. It communicates with the active supported tab and renders a single room state derived from server messages.

### Service worker

The service worker handles installation, permission requests, supported-tab routing, notifications, and recovery. An active WebSocket can extend a Manifest V3 service worker's lifetime in modern Chrome, but correctness must never depend only on in-memory globals. Persist resumable session identifiers and the latest room revision in `chrome.storage.session` or another appropriately scoped store.

### In-page pill

The content script mounts one accessible, visually isolated status element. It does not replace or cover native playback controls. It reflects authoritative state and sends intent; it does not independently decide room state.

## 3. Authoritative room model

A room snapshot contains at least:

```ts
type RoomSnapshot = {
  roomId: string;
  revision: number;
  controller: { participantId: string; leaseEpoch: number };
  media: MediaFingerprint | null;
  playback: {
    status: "paused" | "playing";
    positionSeconds: number;
    effectiveAtServerMs: number;
    playbackRate: number;
  };
  participants: ParticipantState[];
  policy: { buffering: "pause-all" | "catch-up" };
};
```

Every control intent includes a unique action ID, the caller's participant ID and lease epoch, the room revision it was based on, and the latest local playback sample. The coordinator validates authority, assigns the next revision, computes an effective server time, stores the new snapshot, and broadcasts one canonical event.

Clients:

- discard duplicate action IDs;
- never apply a revision older than the latest applied revision;
- request a full snapshot when a revision gap is detected;
- tag adapter writes so resulting native media events do not create feedback loops;
- acknowledge application time and measured position for observability.

## 4. Clock and synchronization strategy

### Clock offset

On join and periodically during a room, each client exchanges several ping/pong samples with the coordinator. It estimates server clock offset from the lowest-round-trip samples and maintains uncertainty. Wall-clock time alone is not trusted; elapsed local timing uses a monotonic clock.

### Pause

The controller pauses locally immediately and sends the authoritative paused position. The coordinator broadcasts it without an artificial delay. Remote devices pause as soon as it arrives, then correct to the authoritative position if necessary.

### Play and seek

The coordinator schedules the effective time slightly in the future. The lead is adaptive to observed room latency and clock uncertainty, with a small lower bound so the control remains snappy. Each client seeks/prepares first, then plays when its local estimate reaches the shared server time.

### Drift correction

During playback, clients compare sampled position against:

```text
expected = authoritativePosition
         + (estimatedServerNow - effectiveAtServerTime) * authoritativeRate
```

Initial policy to validate in the simulator:

- absolute drift below 120 ms: do nothing;
- 120–600 ms: temporarily adjust playback rate by at most 2% when the adapter safely supports it;
- above 600 ms, or unsupported rate control: seek to the authoritative position;
- repeated correction or high clock uncertainty: show **Unstable connection** and collect a privacy-safe diagnostic.

Thresholds are configuration data and must be tuned from tests. Avoid frequent hard seeks because they can trigger buffering and make synchronization worse.

## 5. Media identity and readiness

A `MediaFingerprint` should be minimal and service-specific:

- service ID;
- stable title/episode ID if safely available, otherwise a canonical URL stripped of query parameters plus normalized visible metadata;
- season/episode label when present;
- rounded duration and content type;
- adapter version.

Never rely only on the visible title or duration. The coordinator blocks readiness when strong identifiers differ and asks for confirmation when only weak identifiers are available. Region-specific catalog availability is a user-visible condition, not an error to bypass.

## 6. Buffering, navigation, and disconnects

- Debounce short buffering events to avoid pause/resume flapping.
- In `pause-all` mode, one sustained stall produces one ordered room pause. Resume requires readiness and controller intent.
- Navigation or episode transition invalidates readiness until the new fingerprint matches.
- On controller disconnect, pause the room and hold its lease briefly for reconnection. After the grace period, transfer only through a deterministic server rule and broadcast the new lease epoch.
- WebSocket reconnect uses exponential backoff with jitter, the last applied revision, and an expiring resume token.

## 7. Security and privacy boundaries

- WSS/HTTPS only.
- Random 128-bit room secret in invite links; human codes map to rooms through rate-limited, expiring lookups.
- Ephemeral rooms, default expiration after the party, with an explicit maximum lifetime.
- No streaming-service tokens, cookies, passwords, media bytes, screenshots, decoded frames, full DOM, or full browsing history.
- Strip URL query strings and fragments before any transmission unless a platform-specific review proves a field essential and safe.
- Minimize Chrome host permissions; request supported domains when the user enables them where practical.
- Redact logs and set short retention before collecting production telemetry.
- Rate-limit creation, join attempts, messages, and control intents.
- Validate every message against a versioned schema and size limit.
- Threat-model room-code guessing, malicious members, replayed controller commands, stale leases, cross-site message spoofing, extension compromise, and adapter event loops.

## 8. Suggested repository layout for implementation

```text
apps/
  extension/
  room-service/
packages/
  protocol/
  room-state/
  adapters/
  sync-engine/
  test-player/
tests/
  e2e/
  network/
docs/
```

Keep the room state machine independent of Chrome and Cloudflare so it can be tested deterministically and reused if the infrastructure choice changes.
