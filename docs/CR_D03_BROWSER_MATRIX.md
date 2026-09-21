# CR-D03 Local Browser Matrix

Issue: [#68](https://github.com/muaz978/sync-your-joy/issues/68)

This record defines the deterministic local browser evidence for the CR-D03 matrix. It is deliberately separate from authenticated Crunchyroll acceptance, physical-device acceptance, deployment verification and visible-motion user acceptance.

## Scope

The matrix is implemented by [`tests/e2e/three-profile-browser-matrix.spec.ts`](../tests/e2e/three-profile-browser-matrix.spec.ts). It launches three isolated Chromium persistent profiles, loads the real unpacked extension into each profile, starts the real in-process room service, opens the repository-owned test player in each profile and loads the same user-selected local adaptive fixture into all three players.

The scenario covers:

1. Host creation, two join requests, host approval and a fixed three-member quorum.
2. Controller play and native progress evidence from every participant.
3. A 30-second sustained window sampled every 500 ms.
4. Paired drift, presented-frame progress and hard current-time write limits.
5. Exact forward seek destination acknowledgement, followed by convergence.
6. Source replacement and readiness re-detection on participant C.
7. One-shot local `NotAllowedError`, visible playback-blocked state, local gesture, in-panel Sync and explicit readiness recovery.
8. Controller transfer from A to B, B playback, and transfer back to A.
9. A real server-side disconnect of C, service-worker reconnect, room-code preservation, readiness preservation and explicit post-reconnect resume.
10. Native controller scrubbing at a paused room boundary and remote convergence.

Navigation scenarios are not claimed by CR-D03 because CR-C04, issue [#65](https://github.com/muaz978/sync-your-joy/issues/65), remains an explicit dependency.

## Commands

Run the focused matrix during implementation:

```bash
npm run test:e2e -- --grep "three-profile local browser matrix"
```

Run the complete E2E suite:

```bash
npm run test:e2e
```

Run the complete suite in a visible headed Chromium window:

```bash
SYNCYOURJOY_E2E_HEADED=1 npm run test:e2e
```

The E2E global setup starts the room service on an ephemeral localhost port, builds an isolated extension into the run output directory and writes sanitized provenance and profile artifacts. Host browser permission may be required on macOS for local Chromium launches.

## Acceptance metrics

The matrix treats the following as separate assertions:

| Metric | Local assertion | Meaning |
| --- | --- | --- |
| Quorum | Three connected, approved and matching participants | The operation is not accepted from a two-member shortcut |
| Sustained samples | At least 50 samples during 30 seconds | The room remains observable for the full recovery window |
| Drift | Maximum paired drift at or below 0.75 seconds | Native local timelines remain bounded |
| Hard corrections | At most 8 additional current-time writes per player in the sustained window | Stable playback does not repeatedly seek to hide drift |
| Progress | Presented-frame count increases for every player | The test observes real native frame progress, not only a room clock |
| Exact seek | Every player reports the requested destination within 0.75 seconds | The assertion checks the requested target, not only forward movement |
| Reconnect | C enters `reconnecting`, then returns to `connected` with the same room code and readiness | The real extension connection lifecycle is exercised |
| Post-reconnect play | Controller A explicitly resumes after reconnect and all three players progress | The coordinator safety pause on participant disconnect is respected |
| Native scrub | Controller page changes native `currentTime` while paused and every player converges | The native media event path is covered |

The local fixture reports bounded event history, `currentTimeWrites`, source generation, presented-frame count, quality-frame count, last seek destination and controlled play-rejection count. It does not expose media bytes or credentials.

## Why reconnect uses a local control route

Browser-context offline emulation does not reliably terminate a WebSocket owned by an MV3 service worker. In that situation the production heartbeat can report `Connected · Offline` without producing the close event required to enter the reconnect state.

The local room service therefore exposes `POST /__test/disconnect` only when the E2E global setup supplies an unpredictable, process-local `testControlToken`. The test sends the room code and C's participant identity, and the route closes exactly that server-side socket. Normal server construction and deployed instances do not pass the option, so the route is absent outside this local harness.

The route is covered directly by `apps/room-service/src/server.test.ts` for wrong-token rejection, exact participant selection and participant-disconnected state publication. The E2E test then verifies the extension's real reconnect path. No endpoint is added to the edge service or production room service configuration.

When a participant disconnects, the coordinator pauses the room as a safety invariant. Reconnect therefore restores membership and readiness but does not silently resume playback. The matrix explicitly resumes from controller A before asserting native progress again.

## Reconnect single-flight protection

The MV3 service worker uses both a `setTimeout` retry and a Chrome alarm fallback. These can wake close together. `apps/extension/src/service-worker.ts` now uses a single-flight `reconnectPromise` so overlapping callbacks share one connection and `join_room` handshake instead of sending duplicate joins on one socket.

This is a production lifecycle correction exposed by the controlled local disconnect, not a test-only bypass.

## Security finding remediation

The first hosted evaluation of PR #96 was not accepted as merge-ready. GitHub Advanced Security reported one high-severity CodeQL alert and three DevSkim review findings, and each was treated as an actionable correction:

1. CodeQL identified the local fixture's `video.src = activeUrl` assignment as a DOM text-to-HTML interpretation sink. The fixture now parses the URL returned by `URL.createObjectURL(file)`, requires the parsed protocol to be exactly `blob:`, revokes and rejects any unexpected result, then assigns the allowlisted URL to the media element. The source remains a user-selected local file and no remote media is introduced.
2. DevSkim identified the literal `http://localhost` URL used only as a `new URL()` parsing base in the test-control route. The base is now the non-routable `syncyourjoy.invalid` sentinel, with no change to the server's actual bind address or request behavior.
3. DevSkim identified the literal loopback hostname used by the test-only playback rejection hook. Production builds now replace two explicit build constants with disabled values. E2E setup enables the hook only for the generated test-player origin, so the production content script has no provider-page localhost branch.
4. DevSkim identified the suite-level `test.setTimeout(180_000)` call as an untrusted-duration pattern. The unnecessary override was removed. The suite now uses the repository's bounded Playwright timeout and the observed matrix remains below one minute.

A direct Chromium probe also confirmed that `HTMLMediaElement.srcObject` cannot accept a `File` in the supported browser, so that alternative was rejected after it caused the matrix to wait indefinitely for metadata. The final implementation preserves the proven blob-backed playback flow while adding the explicit scheme boundary. No scanner alert was dismissed as a substitute for a code change. Fresh hosted checks and final-head review remain required before merge.

## Evidence boundary

A passing local matrix proves the behavior of this source tree, the built unpacked extension, Chromium, the in-process room service and the owned local fixture for that run. It does not prove:

- Authenticated Crunchyroll playback or entitlement.
- Any protected media, DRM path, signed URL, private player API or provider-specific source behavior.
- Every title, locale, timed edition, browser graphics path or future provider deployment.
- Physical two-device Wi-Fi, sleep/wake, OS-level offline behavior or real user latency.
- Navigation coverage while issue #65 remains open.
- Production deployment or release readiness.

For authenticated provider work, use the opt-in state-only procedures in [`TEST_GUIDE.md`](TEST_GUIDE.md) and the dedicated acceptance reports. Do not copy daily-browser cookies into the deterministic fixture profiles.

## Current implementation evidence

The focused green run after the security remediation reported:

```text
1 passed
test duration: 38.4 seconds
```

That run covered the complete local scenario listed above. The full repository checks and both complete E2E modes are recorded below. Hosted PR checks and the remaining issue #68 acceptance gates are still separate requirements.

The final local verification completed after the implementation and documentation changes:

- `npm run check`: passed, 36 Vitest files and 319 tests, followed by successful server and extension builds.
- `npm run test:e2e`: 5 passed, 1 skipped. The skipped test was the opt-in authenticated Crunchyroll test because protected storage-state inputs were not supplied. The three-profile matrix passed in 38.8 seconds.
- `SYNCYOURJOY_E2E_HEADED=1 npm run test:e2e`: 5 passed, 1 skipped. The three-profile matrix passed in the visible headed runtime in 38.3 seconds.

These results establish source, unit, build and local Chromium evidence for CR-D03. They do not close issue #68 because navigation depends on #65 and live-provider, deployment, physical-device and user-acceptance gates remain separate.
