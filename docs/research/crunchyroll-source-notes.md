# Crunchyroll player source notes

Research date: 2026-09-19. Scope: public documentation, public page access attempts, and the lead agent's read-only observation of the user's existing Crunchyroll page. No authenticated API, media stream, DRM, token, cookie, or private player state was accessed for this research.

## Current observation and confidence

The lead agent inspected the existing watch page at `https://www.crunchyroll.com/watch/GE00365016JAJP/extreme-level-3-situation` through the browser UI/DOM tooling on 2026-09-19 and supplied these observations:

- A top-document video with ID `bitmovinplayer-video-null`.
- `currentSrc` uses the `blob:` protocol. The full blob URL was not needed or retained here.
- `duration = 1420.002`, `readyState = 4`, `playbackRate = 1`.
- Seekable range approximately `0..1420`, buffered range approximately `80..139` at inspection time.
- No player iframe on this page. The observed iframe was for OneTrust.
- Visible player controls included Skip Intro, Next Episode, Playback Speed Menu, and audio/subtitle selection.

This strongly suggests a Bitmovin-based player on the inspected page. The exact library version, streaming format, account/region rollout, internal instance access, and configurations were not established. The blob URL alone does not prove a specific streaming technology. Do not generalize this snapshot into a claim that every Crunchyroll user currently has the same player.

Earlier public integrations reference a `static.crunchyroll.com/.../player.html` iframe and a Vilos player. Those references are historical/community leads. They are not evidence that the user's current video is in such an iframe. The observed current page means a Vilos-only strategy would miss this user's actual player.

## Primary source findings

### Crunchyroll website behavior

The official website guide describes audio-language switching, subtitle/caption selection, keyboard playback controls, and an Autoplay setting. These are independent player controls that a synchronization extension must account for. The guide does not specify whether an audio switch keeps the same media node, changes episode identity, or reloads the stream. Those effects require direct observation.

Source: [Crunchyroll website guide](https://help.crunchyroll.com/hc/en-us/articles/22728708616852-Getting-started-on-Crunchyroll-website).

Crunchyroll documents Skip Intro on the website for eligible titles and Premium users. Its help article says coverage varies and describes opening-sequence skipping. This is a user-initiated timeline discontinuity, so suppression intended for extension corrections must not swallow the user's real skip. The document is not a reliable complete inventory of today's controls: the live page also exposed Next Episode.

Source: [Crunchyroll Skip Intro help](https://help.crunchyroll.com/hc/en-us/articles/20369940738708-What-is-the-Skip-Intro-feature).

Crunchyroll lists extension interference among possible causes of browser black screens and stuttering. This does not identify SyncYourJoy as the cause. It supports including a controlled baseline comparison with this extension disabled, then enabled, while keeping account, episode, browser, and other extensions constant.

Source: [Crunchyroll browser playback support](https://help.crunchyroll.com/article/why-can-t-i-watch-videos-on-my-browser).

### HTML media seeking and state

The HTML standard defines asynchronous seeking. A new seek can abort an existing seek; empty seekable ranges cause the seek algorithm to return; out-of-range targets are adjusted to available ranges. `fastSeek` trades precision for speed. Buffer depletion can produce `waiting` while `paused` remains false. A successful play request and actual playback readiness are distinct states. Setting a playback rate queues `ratechange`, which does not itself identify user intent.

Engineering implications: coalesce pending seeks, validate readiness/ranges, distinguish commanded position from completed seek, use native completion events, and preserve the latest desired state through loading. Do not treat every native media event as a fresh user command.

Source: [HTML media standard](https://html.spec.whatwg.org/multipage/media.html#media-elements).

### MSE seekability is different from buffering

Media Source Extensions specifies separate `seekable` and `buffered` behavior. Finite-duration media can be seekable across its duration even while only small portions are buffered. Buffered intervals can be disjoint and can change as segments are removed. An extension must not clamp a legitimate remote seek to the currently buffered interval. It should allow the provider to fetch the destination and wait for actual playback readiness.

The observed `seekable ~0..1420` versus `buffered ~80..139` illustrates why these properties cannot be substituted. That observation is compatible with MSE but is not alone proof of MSE.

Source: [MSE HTMLMediaElement extensions](https://www.w3.org/TR/media-source-2/#htmlmediaelement-extensions).

### Play promises and browser policy

Chrome documents that script-initiated audible playback can be denied and that the returned promise must be checked. For cross-origin frames, permission delegation can also matter. A real user action may be required; retry loops do not grant permission.

Engineering implication: classify `NotAllowedError` as user action required, retain desired room state, and retry after an actual gesture rather than reporting success immediately.

Source: [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay).

Chrome separately documents pending `play()` requests being interrupted by `pause()`, `load()`, or source changes. These are lifecycle/race failures, not automatically autoplay failures. The promise resolves only after playback starts.

Engineering implication: stale promise resolutions or rejections must not overwrite state for a newer command, a replacement video, or another episode. Classify `AbortError` separately from permission and unsupported-media errors.

Source: [Chrome interrupted play requests](https://developer.chrome.com/blog/play-request-was-interrupted).

### Extension execution context

Chrome content scripts use an isolated JavaScript world but share the document DOM. `all_frames` applies only to frames whose URLs match the content script's URL requirements. Related blank/blob/data frames have separate matching options. Main-world script injection uses the page's CSP.

Engineering implication: a media-element adapter can operate on native DOM without depending on player private globals. Discovery must support the observed top-document player and any legitimately matching iframe layout. Verify the built content-script bundle and runtime injection rather than assuming `all_frames` alone proves coverage.

Source: [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

### Bitmovin documented API, applicability conditional

Bitmovin's public API offers `getVideoElement()`, `seek()`, `getSeekableRange()`, `getBufferedRanges()`, `play()`, and `setPlaybackSpeed()`. The play promise represents actual start. Native HTML5 speed changes are supported by the documented API. This supports preserving playback-rate correction as a capability to test, instead of disabling it solely because the service is Crunchyroll.

This documentation does not establish that Crunchyroll exposes a usable player instance, nor that it uses the documentation's latest version. A future official API bridge would need demonstrated access and lifecycle tests. Avoid private global or minified-property hooks based only on a recognizable video ID.

Source: [Bitmovin PlayerAPI](https://cdn.bitmovin.com/player/web/8/docs/interfaces/core.playerapi.html).

Bitmovin distinguishes `Play`, actual `Playing`, readiness, stalling, and speed-change events. Its `Seek` and `Seeked` event documentation says those events are triggered through public API calls. Therefore a native `video.currentTime` write cannot be assumed to follow the same vendor-event path. Observe native media events when using the native media API, and verify UI state during live testing.

Source: [Bitmovin PlayerEvent](https://cdn.bitmovin.com/player/web/8/docs/enums/core_events.playerevent.html).

Recent Bitmovin documentation describes optional decode-error recovery that reloads the source and restores playback position, tracks, and speed while suppressing some vendor lifecycle events. Crunchyroll's version and setting are unknown. Treat same-episode source reload as a robustness test scenario, not a confirmed diagnosis of the user's problem.

Source: [Bitmovin PlaybackConfig](https://cdn.bitmovin.com/player/web/8/docs/interfaces/core_config.playbackconfig.html).

## Recommended synchronization boundaries

These are engineering recommendations derived from the documented contracts and observed architecture, not claims that every listed failure already occurred:

1. Discover the active visible content video across top-document and supported frame layouts. Bind listeners to each video generation and release them on replacement.
2. Derive content identity from the top-level watch episode, not a blob URL or iframe HTML URL. Detect navigation even if the media node persists. Do not equate alternate language editions solely by stripping unexplained ID suffixes.
3. Track requested playback state separately from native `paused`, buffering, and in-flight seeking. A temporary stall is not a user's pause command.
4. Check seekable ranges before correction. Keep a pending desired target during startup/replacement and retry after readiness evidence. Use buffered data to assess readiness, not permitted seek destinations.
5. Allow one active corrective seek, coalesce newer targets, and wait for completion or a bounded timeout. Avoid restarting a long provider seek every polling interval.
6. Distinguish extension-originated media changes from native controls and Skip Intro. A time-only suppression window is vulnerable both to late acknowledgments and to swallowing real user actions.
7. Confirm rate assignments actually persist. Preserve the user's/room's base rate, stop rate correction while buffering/seeking, and prevent native rate events from echoing an extension correction back into the room.
8. Handle native play promises with a command/video generation so old completions cannot overwrite newer state. Surface permission problems separately from lifecycle interruption and fatal media errors.
9. On Next Episode or language/source reload, invalidate stale corrections and re-establish identity/readiness before the next room command.
10. Retain limited diagnostics for native event ordering, requested/applied targets, readiness, ranges, rate, generation, and error name. Do not record stream URLs, credentials, license traffic, or full page storage.

## Validation matrix that remains necessary

| Scenario | Observable result needed |
| --- | --- |
| New host / new guest joins mid-episode | One stable correction after metadata/ranges exist, then normal playback |
| Guest behind/ahead, small and large drift | Small drift converges without rate feedback; large drift has bounded seeks |
| Remote seek outside buffered interval | Correct destination loads rather than clamping to old buffer |
| Host Skip Intro / scrubbing | Native user intent is propagated once and guests converge |
| Pause/play while another seek or play is pending | Latest desired state wins; no stale promise mutation |
| Buffer depletion / slow destination loading | No pause feedback loop, repeated seek storm, or speed correction during stall |
| Next Episode | Old identity/actions cleared, fresh identity and readiness established |
| Audio-language change | Observe actual node/source/identity changes and preserve appropriate room state |
| Playback speed selection | Intentional base speed stays distinct from temporary correction |
| Video replacement or same-node source reload | Listeners, generation, and pending commands are rebuilt safely |
| Autoplay permission denied | Clear gesture-required state and successful retry after a real gesture |
| Provider error or decode recovery | Distinct provider failure; no infinite correction loop |
| Top-document versus legacy iframe | Native adapter attaches correctly in each actually encountered layout |

## Chronological research activity and limitations

1. Searched current Crunchyroll help/news for browser playback, Skip Intro, autoplay, and audio/subtitle behavior. Official current help supported these controls. The 2019 web-player launch post was treated as historical only.
2. Tried opening a public watch page with web tooling. It was inaccessible. A direct unauthenticated HTTP fetch returned a 5,585-byte Cloudflare challenge document titled `Just a moment...`, with no player scripts or iframe available to inspect. No challenge was bypassed.
3. Tried two historically referenced public static player HTML locations: `https://static.crunchyroll.com/vilos-v2/web/vilos/player.html` and `https://static.crunchyroll.com/vilos/player.html`. Both returned HTTP 502 from this execution environment. This does not prove the URLs are unavailable to normal browsers.
4. Search results exposed community references to Vilos and a newer Katamari UI. They were used only to identify possible architecture drift and were not accepted as vendor-confirmed current architecture.
5. Read WHATWG HTML, W3C MSE, Chrome extension/autoplay documentation, and Chrome's interrupted-play article.
6. The lead agent supplied the live DOM observation summarized above. This superseded any initial working assumption that the player's video necessarily resides in a static Crunchyroll iframe.
7. Read Bitmovin's current official API/event/configuration documentation because of the observed video ID. No exact player-version or private API claim was made.
8. Created this source note. This subtask did not alter extension implementation or run authenticated two-participant Crunchyroll synchronization tests. Live validation belongs to the lead investigation and must be reported separately from source/documentation review.
