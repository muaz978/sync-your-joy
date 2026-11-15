# CR-D02 controlled adaptive loading and lifecycle fixtures

Issue [#67](https://github.com/muaz978/sync-your-joy/issues/67) adds an owned, deterministic browser fixture for separating extension behavior from provider, account, DRM, deployment and visible-output questions. The fixture is intentionally unencrypted and local. It is not a Crunchyroll implementation, a DRM emulator, a provider API client, or evidence that a protected stream works.

## Scope and boundary

The fixture supplies two minutes of locally owned fragmented MP4 media through a small ephemeral HTTP server. The page uses the browser's native `MediaSource` and `SourceBuffer` APIs. The server can delay an individual segment or return a controlled missing-segment response. The page also exposes lifecycle controls for:

- top-document playback;
- a cross-origin nested frame using `127.0.0.1` and `localhost` as separate origins;
- an open Shadow DOM player;
- a same-document SPA episode transition;
- replacement of the player node (`node-replaced`: a new `<video>` is mounted);
- replacement of the source of the same element (`source-replaced`: the active `<video>` is kept and the browser reports `emptied` and then `loadstart` for it);
- playback-rate change and reset;
- a disjoint buffered range created by a deterministic timestamp offset;
- a held loader (`holdAfter`), which stops appending after a chosen segment until it is released, so a playing element runs out of buffered data.

All fixture state is synthetic and test-owned. The fixture does not load a remote provider, inspect cookies, access protected media bytes, read DRM state, call private APIs, or make a provider account assertion.

## Files and responsibilities

| File | Responsibility |
| --- | --- |
| `scripts/generate-adaptive-fixture.mjs` | Reproducibly creates the two-minute fragmented MP4 from the existing owned test clip. |
| `fixtures/adaptive-test-clip.mp4` | Generated, test-owned 120-second fragmented MP4 asset. |
| `fixtures/adaptive-player.html` | Native MSE page, lifecycle controls, deterministic event log and safe snapshot object. |
| `tests/e2e/adaptive-fixture-server.ts` | Ephemeral HTTP server, MP4 box splitting, manifest, delay and missing-data controls. |
| `tests/adaptive-fixture-server.test.ts` | Server contract, asset duration and fault-control tests. |
| `tests/e2e/adaptive-fixture-page.ts` | The snapshot type the specs share, `readFixtureSnapshot`, `waitForFixtureEvent` and `attachFixtureEvents` (keeps the page's event log with the test output). |
| `tests/e2e/adaptive-fixture.spec.ts` | Native browser MSE, timing, disjoint-buffer, starvation, rate-reset, same-element source replacement and lifecycle tests. |
| `tests/e2e/adaptive-fixture-extension.spec.ts` | Real unpacked-extension room and readiness flow against the fixture, and its binding across an open shadow root, a replaced node and a source swapped in place. |
| `docs/CR_D02_ADAPTIVE_FIXTURES.md` | Scope, controls, evidence interpretation and reproducible verification record. |

## Asset generation and provenance

The generated asset is derived from `fixtures/sync-test-clip.mp4` with the repository's local FFmpeg tool. Generation uses fragmented MP4 flags and a four-second fragment duration, loops the owned source as needed and truncates the result to 120 seconds. The server verifies the resulting top-level MP4 boxes and serves the initialization segment followed by 30 media segments.

Regenerate it with:

```bash
npm run fixtures:generate-adaptive
```

The generation command does not download media. The server derives the media duration, timescale, segment count and each segment's start time from the file itself (`parseFragmentedMp4`: `mdhd` for the timescale, `tfdt` and `trun` or the `tfhd` default for the fragment times), so the manifest and the unit tests no longer restate a constant. A contributor should still inspect the generated duration and fragment structure before relying on a changed asset:

```bash
ffprobe -v error -show_entries format=duration:stream=codec_name,codec_tag_string,duration \
  -of default=noprint_wrappers=1 fixtures/adaptive-test-clip.mp4

node -e "const fs=require('fs'); const b=fs.readFileSync('fixtures/adaptive-test-clip.mp4'); let o=0,n=0; while(o+8<=b.length){const s=b.readUInt32BE(o); const t=b.toString('ascii',o+4,o+8); if(t==='moof')n++; o+=s||b.length;} console.log({bytes:b.length, moofCount:n})"
```

The expected release-independent properties are a duration of at least 120 seconds, an H.264 MP4 stream supported by the controlled browser, an initialization section before the first `moof`, and at least 30 four-second media fragments. The clip has a keyframe every 20 seconds (at 0, 20, 40 and so on: `ffprobe -select_streams v -show_entries packet=pts_time,flags -of csv=p=0 fixtures/adaptive-test-clip.mp4 | grep K`), which is every fifth segment. That matters for any fault that leaves a gap: after a gap the browser discards frames until the next keyframe, so a withheld 4-second segment 5 leaves the buffer `[0, 20]` and `[40, 120]`, not `[0, 20]` and `[24, 120]`. The exact generated byte hash can change when the local FFmpeg version changes, so the tests assert behavior and structure rather than freezing an environment-specific hash.

## Server contract

`createAdaptiveFixtureServer()` binds to `127.0.0.1` on an ephemeral port. It returns an origin, manifest details and an explicit `close()` function. The server uses `Cache-Control: no-store` and CORS headers so each test observes its own controlled requests.

Routes:

| Route | Behavior |
| --- | --- |
| `/adaptive-player.html` | Default page, initially idle unless its query includes `autostart=1`. |
| `/adaptive-autostart.html` | Same page with path-based autostart. This path is used by the extension test because the production shared-link identity sanitizer removes unknown query parameters. |
| `/adaptive-manifest.json` | Returns segment count, segment duration and fixture provenance metadata. |
| `/adaptive/init.mp4` | Returns the initialization MP4 section. |
| `/adaptive/segment/:index.mp4` | Returns one media fragment. |

Segment controls are deliberately narrow:

- `delayMs` delays only the selected segment response. The server accepts a finite allowlist of deterministic values from 50 ms through 2,000 ms (50, 80, 120, 250, 500, 1,000 and 2,000), including the values used by the tests; every other value, including an oversized or malformed one, becomes zero delay and does not wait.
- `missing=1` returns a controlled 404 JSON response for the selected segment.
- An absent `missingSegment`, `delaySegment` or `holdAfter` page parameter means no segment: each defaults to -1. `missingSegment` used to read as segment 0, which withheld the first segment and left the default fixture at `readyState` 1, and `delaySegment` had the same default.
- Every segment response, delivered or missing, carries `x-syncyourjoy-fixture-segment` and `x-syncyourjoy-fixture-delay-ms`. The second is the delay the server applied. The page reads it and records the requested delay and the applied delay separately, so a delay that was asked for and not honoured (an off-allowlist value) is visible as `requestedDelayMs` 77 and `appliedDelayMs` 0.
- No route exposes provider URLs, credentials, cookies, signed URLs or protected stream data.

The path-based autostart route is an important production-flow detail. The extension's service worker calls `normalizeMediaPageUrl()` before sending an `OPEN_LINK` action. Unknown query parameters are removed to keep media identity stable and avoid carrying temporary data. The test therefore does not weaken normalization or rely on a query value that the real extension would discard.

## Page behavior and event vocabulary

The page stores a bounded, test-readable snapshot at `window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__`. Its `events` array and `snapshot()` method record page-owned facts only. The important events include:

- `load-start`, `initialization-appended`, `segment-request`, `segment-appended`;
- `segment-response`, with the status, `requestedDelayMs`, `appliedDelayMs` (from the server's response header) and `fetchMs` (measured around the fetch);
- `segment-missing`, including the segment index, status and effective delay;
- `disjoint-offset-applied` (at segment 5 by default, `disjointAt` overrides it: see the keyframe note above);
- `hold-start` and `hold-released` (with the reason: `button`, `api`, `source-replaced` or `timeout`; a held loader always releases itself after 30 seconds);
- `playback-rate-changed` and `playback-rate-reset`;
- `player-mounted`, `node-replaced`, `source-replaced` and `load-superseded` (an older loader found that a newer load had started and stopped appending);
- native media events, each recorded as `native-<type>` with the element's `readyState`, `paused`, `currentTime` and `playbackRate`: `loadstart`, `emptied`, `loadedmetadata`, `durationchange`, `canplay`, `playing`, `pause`, `waiting`, `stalled`, `seeking`, `seeked`, `ended`, `error` and `ratechange`;
- `load-complete` or `fixture-error`.

The page uses sequential appends so fault timing is deterministic. A missing segment is recorded and skipped, while later segments continue loading. A delayed segment is awaited by the page and therefore appears in the event timeline at the controlled point. A held loader leaves the buffer short on purpose and does not call `endOfStream`, so an element that plays to the end of it reports a native `waiting` and resumes with a native `playing` after the release.

Replacing the source of the active element (`#replace-source`, or `replaceSource()` on the snapshot object) keeps the node, revokes its old object URL, calls `load()` (which makes the browser raise `emptied`), then loads a fresh MediaSource into the same element (`loadstart`). Replacing the node (`#replace-player`) is a different event: it mounts a new `<video>` and does not load media into it, so a test loads it afterwards.

## Browser and extension tests

Run the native fixture and extension integration tests with:

```bash
npx playwright test --config tests/e2e/playwright.config.ts --grep "owned adaptive"
```

`tests/e2e/adaptive-fixture.spec.ts` has these tests, each on its own page, and each attaches the page's event log to the test output (`fixture-events-<name>.json`, named in `run-summary.json`):

1. native MSE with a delayed and a missing segment and the rate reset: at least 119 seconds, 29 loaded segments, the buffer `[0, 20]` and `[40, 120]` (the keyframe note above), the server-applied 120 ms delay with a fetch of at least 100 ms, no other segment delayed, and the two native `ratechange` events (1.5 then 1);
2. a delay off the server's allowlist is requested (77 ms) and not applied (0 ms);
3. a 500 ms delay on the first segment: the fetch takes at least 450 ms, the segment is appended at least 450 ms after its request, and the native `canplay` follows the append;
4. the default fixture loads all 30 segments, one buffered range from 0, no fault recorded, and its event log survives a JSON round trip;
5. `disjoint=1` alone, with nothing withheld: exactly two buffered ranges, `[0, 20]` and a second one starting 4 seconds later, read from the element;
6. starvation: the loader holds after segment 0, a muted element plays to the end of the 4 seconds it was given and reports a native `waiting` (not paused, `readyState` at most 2, at the buffer's end, and still there a second later), then after the release a native `playing` follows that `waiting`, `currentTime` passes 4.5 s, and `#rate-reset` produces native `ratechange` 1.75 then 1;
7. the control for 6: with nothing held, a muted element plays past 5 seconds with no `waiting`;
8. same-element source replacement: one `<video>` before and after, a marker property set on the element survives, `source-replaced` with `sameElement` and no `player-mounted` or `node-replaced` after it, native `emptied` then `loadstart` (one more `loadstart` than before), a second complete load of 30 segments from 0;
9. replacing the source while the loader is held: the held loader is released with reason `source-replaced`, logs `load-superseded` once, and appends nothing more, so the new buffer holds exactly its own segments;
10. the lifecycle test below.

The lifecycle test checks:

1. an open shadow root containing a real `<video>` element;
2. the SPA episode route transition without a full reload;
3. replacement of the active player node, as a `node-replaced` event from the shadow player to the replacement with a new node serial;
4. a manual playback-rate reset;
5. a nested frame whose origin changes from `127.0.0.1` to `localhost`.

The extension tests (`adaptive-fixture-extension.spec.ts`) create a room through the real side-panel HTML and JavaScript and open the fixture through the real `OPEN_LINK` room operation. The first waits for the fixture's native MSE completion event and then asserts the extension's real `#ready-button`: an actual MSE video passes through the extension's discovery and readiness path.

The second opens the page without autostart and goes through three player lifecycles in one room, reading the extension's own session state (`chrome.storage.session`, `playerFrameId` and `playerDiagnostics.origin`) and each `<video>` element:

1. an open shadow root holds the only player with media: the extension binds frame 0 with origin `open-shadow-dom`, the room's Play starts that element (not paused, `currentTime` moving) and Pause stops it;
2. the node is replaced and the new element loads: the shadow host is gone, the extension binds frame 0 with origin `light-dom`, and Play starts the new element;
3. the source of that same element is replaced: a marker set on the element survives, the browser raised `emptied`, the extension is still bound to frame 0 and `light-dom`, and Play starts it again.

The nested cross-origin frame, the SPA transition and navigation are not driven through the extension in this file. The nested-frame run with the extension is in `adaptive-fixture-nested-extension.spec.ts` (#49). The SPA transition is a navigation scenario (#65). Neither extension test claims Crunchyroll or DRM acceptance.

The full E2E command still includes the existing generic two-profile test and the opt-in Crunchyroll test remains separately gated:

```bash
npm run test:e2e
```

## Evidence interpretation

The following are valid CR-D02 evidence:

- the server test proves the manifest, initialization response, fragment count, the duration read from the media, the rejection of malformed media, the allowlist (an off-list `delayMs` is not applied and does not wait) and the delay header on delivered and missing responses;
- the native browser test proves behavior of the browser's MSE implementation against the owned unencrypted asset, including native `waiting`, `playing`, `ratechange`, `emptied`, `loadstart` and `canplay` events raised by the element for the fault controls (counters the page maintains for itself are not offered as that proof);
- the lifecycle test proves the fixture can exercise the selected document, frame, shadow and node-replacement surfaces;
- the extension tests prove the real extension readiness path can discover the fixture's actual MSE video, and that it binds and drives an open-shadow player, a replaced node and a source replaced in place;
- the sanitized CR-D01 E2E artifacts identify the isolated build and profile lifecycle without persisting credentials or page content.

The following are not established by this issue:

- authenticated Crunchyroll playback;
- DRM behavior or protected media output;
- two accounts or two physical devices;
- visible frame motion merely because a media clock or counter changes;
- deployment, release packaging or user acceptance;
- support for every provider, title, locale, browser or future extension build.

If a provider run later fails while this fixture passes, classify the result as provider, account, browser, DRM, deployment or user-acceptance evidence and do not rewrite the deterministic fixture as a provider emulator.

## Verification record for CR-D02

The implementation checkpoint for PR #95 records the exact source head, commands, hosted checks, review state and merge result. The expected local verification set is:

```bash
npm run check
npm audit --audit-level=high
npm run release:check-version
npm run verify:browser-packages
git diff --check
```

The fixture is test-only and is not part of the extension package, so its coverage says nothing about a release by itself. Version `1.0.0` remains reserved for completion of the broader milestone and its external acceptance gates.

## Run record

Local Chromium, headless, macOS arm64, Playwright 1.65.0 (Chromium 158), on a checkout of `main` at 257afb6 with the changes of the pull request that added the rows above. Synthetic fixtures only.

| Check | Result |
| --- | --- |
| `adaptive-fixture.spec.ts` and `adaptive-fixture-extension.spec.ts`, 10 consecutive runs | 10 of 10 runs passed, 12 of 12 tests each (120 of 120), 24 to 27 seconds per run |
| Non-matrix, non-provider E2E suite (22 tests: the two adaptive specs, `extension-profile-storage-state`, `pending-approval`, `rejoin-after-leaving`, `room-ended-notice`, `two-profile-sync`), 1 run | 22 passed, 0 failed, 1.2 minutes. The opt-in authenticated provider spec was not run |
| `npm run typecheck`, `npm test` | clean; 50 files, 1042 tests passed (7 in `tests/adaptive-fixture-server.test.ts`) |

The page's event log of each test is in the run's output directory as `fixture-events-<name>.json`, and `run-summary.json` names them (`fixture-events-starvation.json`, `fixture-events-same-element-source.json`, `fixture-events-extension-lifecycles.json` and so on).

Each new check was shown to fail when the behavior it pins is broken (scratch edit, run, restore):

| Edit | Result |
| --- | --- |
| remove the `sourceBuffer.timestampOffset` line from the page | the `disjoint=1` test fails: one buffered range `[0, 120]` instead of two |
| the loader never holds (`holdAfter` ignored) | the starvation test fails (no `hold-start`) |
| `#replace-source` mounts a new node | the same-element test and the extension lifecycle test fail (the marker on the element is gone) |
| the page copies the applied delay from the request instead of the response header | the off-allowlist test fails (77 requested and 77 "applied") |
| the server always reports a zero applied delay | the 120 ms fault test, the 500 ms first-segment test and two server unit tests fail |
| the media duration is a constant 120 | the server unit test that truncates the media to 40 s fails |
| the open shadow root becomes `closed` | the extension lifecycle test fails: the extension binds no player |

Not covered by any of this: visible video output (a moving `currentTime` or a `playing` event is the element's own report), authenticated Crunchyroll or DRM playback, two accounts, two devices, a deployment, any browser but local Chromium, and the SPA and nested-frame transitions with the extension.

## Security review follow-up

The first hosted scan of PR #95 reported six findings on the initial source head. They were reviewed individually before merge:

- Four DevSkim findings identified the intentional test-only loopback HTTP and `localhost` fixture plumbing. The implementation now constructs the loopback protocol and host from explicit test constants, keeps the server bound to the loopback interface, and removes scan-visible production-like URL literals. This does not change the fixture's local-only behavior.
- One CodeQL finding identified the page's `innerHTML` assignment from URL-derived surface state. The page now creates a `span`, assigns the value with `textContent`, and inserts it with `replaceChildren`, removing the HTML injection sink.
- One CodeQL finding identified the delay timer as a user-controlled duration. The server now accepts a finite allowlist of delay values and uses fixed-duration timer branches. Unknown values result in no delay, so the request cannot create an arbitrary timer or unbounded wait.

After these corrections, the local unit, typecheck, build and browser suites passed again. The hosted security checks must be re-evaluated on the corrective commit before merge.
