# Research and constraints

Research checked on 2026-08-10. Links point to primary documentation or official product pages where possible.

## Market patterns

| Product | Useful pattern | Gap/opportunity for SyncYourJoy |
| --- | --- | --- |
| [Teleparty](https://ww1.teleparty.com/) | Browser extension, synchronized playback, chat, broad service support | Lead with measurable sync quality, clearer control ownership, readiness, and diagnostics rather than a broad feature list |
| [Teleparty support](https://ww1.teleparty.com/support) | Each participant needs their own service access; free and premium service tiers | Keep the same lawful account model and make media/privacy boundaries explicit |
| [Scener FAQ](https://new.scener.com/faq) | One remote holder controls playback and can pass the remote; text/video/social features | Adopt the clear remote-owner model, but defer heavy social features until sync reliability is proven |
| [Syncplay](https://syncplay.pl/about/syncplay/) | Sends position/play state without sharing media; managed rooms restrict control | Its explicit managed-room model and state-only transport are strong precedents |

The differentiator should not be “watch together exists.” It should be that control authority is obvious, mismatches and buffering are handled deliberately, sync quality is visible, and recovery is dependable.

## Chrome extension constraints

- [Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3) uses event-driven service workers and disallows remotely hosted executable code.
- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) can run on supported pages, but persistent host access must be justified and minimized.
- The [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) provides a persistent companion UI alongside the page in Chrome 114+.
- Chrome documents [WebSockets in extension service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets), including keepalive behavior for current Chrome versions.
- Chrome autoplay rules can reject `play()` without an accepted user interaction. The [autoplay policy](https://developer.chrome.com/blog/autoplay/) makes an explicit ready/join gesture and a visible recovery prompt necessary.
- Chrome Web Store policy requires [minimum permissions and secure handling](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq). Browsing activity and website content count as user data, even when processed locally.
- [Manifest V3 store requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) allow server communication but require extension functionality to remain discernible from the submitted package. Remote configuration may be data, not executable logic.
- Chrome's content-script `all_frames` and `match_origin_as_fallback` options cover matching child frames and related `about:`, `data:`, `blob:`, and `filesystem:` frames, but they do not bypass frame-injection restrictions or expose closed Shadow DOM.

## Generic player coverage

- [HTMLMediaElement.currentSrc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentSrc) is the browser's chosen absolute media resource and may be empty while the media network state is `EMPTY`.
- [HTMLMediaElement.readyState](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState) distinguishes no media information from initialized metadata and current/future decoded data. The generic adapter uses these signals with `networkState` and `srcObject` to avoid rejecting initialized MSE or MediaStream players while filtering pre-created decoys.
- [ShadowRoot](https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot) allows traversal of open roots. Closed roots intentionally remain outside the extension's capability boundary.
- Native MP4/WebM/Ogg, HLS/DASH through browser-native or MSE playback, and DRM-backed providers are compatible only when they expose an ordinary controllable `HTMLVideoElement`. The extension never obtains DRM keys, decoded frames, media bytes, or network responses.

## Realtime backend findings

[Cloudflare Durable Objects WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) describes one stateful object coordinating many WebSocket clients and recommends the hibernation API. That maps naturally to one authoritative coordinator per room. Cloudflare also documents Durable Objects as a strongly consistent primitive for [real-time applications](https://developers.cloudflare.com/use-cases/web-apps/real-time/).

WebSocket transport alone does not produce synchronization. The protocol still needs ordered revisions, clock-offset estimation, scheduled effective times, idempotency, readiness, drift measurement, and correction. W3C community material on [media synchronization on the web](https://www.w3.org/community/webtiming/files/2018/05/arntzen_mediasync_web_author_edition.pdf) likewise frames the problem around relating media position to a shared clock and correcting player drift.

## Platform and terms risk

This is a product risk, not a claim that a particular implementation is lawful or unlawful. Qualified counsel and/or platform permission should be a public-launch gate.

- Netflix's [Terms of Use](https://help.netflix.com/legal/termsofuse) prohibit, among other things, automated access, inserting code or manipulating service content, bypassing protections, and reverse engineering. The terms were last updated April 10, 2026.
- The current Disney+ [Subscriber Agreement](https://www.disneyplus.com/en-sg/welcome/subscriber-agreement) restricts automated access, modifying the service, reverse engineering the player, and bypassing protections.
- Crunchyroll's [Terms of Service](https://www.crunchyroll.com/terms) prohibit DRM/security circumvention and geo-restriction evasion and allow device/version support to change.

Therefore the technical design must never capture/rebroadcast content, bypass protections, scrape catalogs, access credentials, or reverse engineer DRM/proprietary player internals. Even a narrow playback-control extension may still raise terms questions. Existing competitors do not remove that risk.

## Main engineering risks

| Risk | Mitigation |
| --- | --- |
| A site changes its DOM/player | Capability detection, adapter versions, fixtures, canary tests, kill switches, and graceful unsupported state |
| Browser blocks remote play | Explicit user-ready gesture, preflight, and a one-click recovery prompt |
| Different episode/cut/ads | Strong media fingerprint, duration check, readiness gate, and no automatic bypass of ads |
| Network latency cannot be zero | Honest service objectives, shared clock estimate, scheduled play/seek, immediate pause broadcast, and drift correction |
| Buffering cascades into event loops | Debounce, one authoritative state machine, action IDs, revision ordering, and tagged local writes |
| MV3 service worker sleeps | WebSocket lifecycle support plus persisted resumable state; never rely on process memory for correctness |
| Room code is guessed | High-entropy invite secret, expiring code, rate limiting, optional host approval |
| Extension permissions discourage users/store review | Domain-scoped optional access where practical, clear justifications, and no unrelated data collection |
| Platform terms or store policy blocks distribution | Legal/product gate, narrow non-circumvention architecture, platform outreach, and a generic/approved-platform fallback |

## Recommended conclusion

Build the synchronization engine and UX against a fake player and generic HTML5/YouTube first. In parallel, run narrow feasibility spikes for subscription services without DRM access, scraping, or proprietary-player reverse engineering. Treat each commercial service as an adapter that can be disabled independently and must clear both technical and terms/legal review before public release.
