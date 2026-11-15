# CR-C04 navigation transaction report

Issue: [#65](https://github.com/muaz978/sync-your-joy/issues/65)
Status: PR #93 is merged (releases 0.2.5 and later). Section "Post-merge update" below (against `main` at `8d8bf2a`, extension 0.2.12) refreshes this report for the coordinator half of the owner's decisions of 2026-10-31 and corrects the statements it supersedes. Evidence is unit and protocol tests only; no browser, Crunchyroll, two-account, two-device, deployment or acceptance run is claimed, and those gates are carried by #30, #33, #34, #35 and #69.

## Decision summary

Episode changes must be treated as media transactions, not as ordinary playback commands. A manual shared-link action is accepted only from the current controller and current lease. It validates and normalizes the page, ignores a same-media link, cancels old operation or seek evidence, increments the media epoch, resets the room to paused position zero, clears participant readiness and publishes fresh navigation state.

The implementation also defines a fail-closed policy for a future optional controller-follow mode. It is disabled by default. If it is later enabled after headed provider validation, it will require the current controller lease, a strong Crunchyroll watch identity and a media change, and it will deduplicate repeated actions by the canonical episode identity. Member navigation, login pages, unavailable pages, weak identities and non-Crunchyroll pages cannot auto-mutate room content through that policy.

## Root cause

The room already supported `open_link`, but its semantics treated every accepted URL as a new media selection. That could restart an unchanged Crunchyroll episode when only the localized path or title changed. The protocol had strong media identity matching for readiness, but the coordinator did not reuse that identity decision when deciding whether a navigation transaction was necessary.

The extension also observed SPA and native next-episode changes through `MEDIA_DETECTED`. Those observations update local player binding and readiness evidence, but must not silently become shared room navigation. Without an explicit, validated controller-follow policy, a member, a login page or a weak page signal must never change room content through the observation path. (The manual shared link is a different path: it was not limited to episode pages until the post-merge update.)

## Manual shared-link transaction

The coordinator's `openLink` path now follows this order:

1. Reject duplicate action IDs, non-controller callers, stale leases, future revisions, stale context and invalid URLs.
2. Compare the normalized URL with the current room media. Strong Crunchyroll watch IDs may match across localized routes. Weak identities match only when the normalized page URL is unchanged.
3. Return `navigation_unchanged` without changing the revision, media epoch, playback, readiness or operation when the link is the current media.
4. For a new media link, cancel pending seek or transactional operation evidence with reason `media-changed`.
5. Increment `contract.mediaEpoch` and clear the current operation.
6. Mark connected participants unready and non-matching, reset statuses to `wrong-media`, and leave disconnected participants `unknown`.
7. Replace room media with the shared page's identity (a real Crunchyroll episode page is keyed to its watch ID; see the post-merge update, which supersedes the earlier "normalized shared page identity" for it), pause at position zero and schedule the shared navigation after the normal command lead time.
8. Require fresh player detection, media matching and readiness before later shared playback commands can proceed.

The revision and effective navigation checks also make rapid queued transitions fail closed. A navigation side effect is applied only for the current snapshot revision, so an older scheduled target cannot reopen after a newer room transition supersedes it.

## Controller-follow safety policy

`apps/extension/src/navigation-transaction.ts` contains the policy for a future opt-in. The default is explicitly disabled with `CONTROLLER_FOLLOW_NAVIGATION_ENABLED = false`.

When enabled in a separately validated build, the policy requires:

- the local participant to be the current controller;
- a valid current controller lease;
- a strong Crunchyroll canonical watch identity;
- a Crunchyroll page URL containing the watch identity;
- a media identity different from the room's current media; and
- an episode identity that was not already submitted by the current follow action.

The policy rejects members, login and unavailable routes, generic or weak page identities, non-Crunchyroll pages, same-media localized changes and repeated episode observations. It never uses provider-private APIs, protected media, signed URLs, credentials or cookies.

## Changed surfaces

- `packages/protocol/src/index.ts`: added `mediaMatchesPageUrl`, which reuses the existing strong canonical identity rules for page-link no-op decisions.
- `packages/protocol/src/index.test.ts`: added localized Crunchyroll same-episode and weak generic URL coverage.
- `packages/sync-engine/src/room.ts`: made manual `openLink` idempotent for the selected media and repeated navigation target before mutating room state.
- `packages/sync-engine/src/room.test.ts`: covered localized same-episode no-op behavior.
- `apps/extension/src/navigation-transaction.ts`: added the disabled-by-default controller-follow policy and strong identity deduplication key.
- `apps/extension/src/navigation-transaction.test.ts`: covered strong identity, member and lease rejection, disabled mode, same-media no-op and repeated identity deduplication.
- `apps/extension/src/service-worker.ts`: wired the policy into observed media handling without enabling automatic follow, and reset its deduplication state across room sessions.
- `apps/extension/src/service-worker.test.ts`: verified that an observed new episode does not auto-follow while the feature remains disabled and does not change the room media.
- `docs/TEST_GUIDE.md`: linked this report.

## Security and privacy boundaries

The public room state continues to contain only bounded media fingerprints and navigation URLs already selected by the controller. No raw player samples, stream URLs, media bytes, cookies, credentials, provider-private errors, DRM material or private provider endpoints are introduced.

The controller-follow policy is fail-closed. A member cannot cause shared navigation merely by reporting a different page. A login or unavailable page cannot provide a strong watch identity. A same-media localized URL cannot cancel readiness or advance the media epoch.

## Verification plan and evidence classes

The deterministic gate covers the protocol helper, coordinator transaction ordering, service-worker policy and regression tests. It does not establish authenticated Crunchyroll visible playback, two-account behavior, two-device behavior, deployment acceptance or user acceptance.

The issue remains open after the source merge until the navigation transaction is exercised in the D03 SPA fixture and the D04 controlled manual browser path. The signed-in Crunchyroll account is available for that later gate, but account presence alone is not playback evidence.

## Release decision

No version bump is justified for this issue alone. A compatible release will be considered only after a coherent verified group, and `1.0.0` remains reserved for complete milestone acceptance. (As written for PR #93 the repository was at `0.2.4`; this change was made against 0.2.12 and does not bump it.)

## Post-merge update (against `main` at `8d8bf2a`, extension 0.2.12)

### Owner decisions that bound this change (2026-10-31)

- A controller may share only Crunchyroll `/watch/` pages in a Crunchyroll room, and the coordinator rejects other pages (login, unavailable or non-watch) so they do not advance the room. What the coordinator can check is the address only (see "What the guard checks" below), so an unavailable page is rejected only when its address is not an episode address.
- The 3 second readiness debounce for a member who moves to a different strong episode stays; it is a known limit (a member can be counted as ready for up to that long after moving; no test presses Play in that window).
- This card may be accepted ahead of its seven open dependencies.
- The provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69.

### What the coordinator now does

1. **A shared Crunchyroll episode link is keyed to its watch ID.** After PR #93 a first shared link stored the room's media as `shared-link` / `page:<url>`, a weak identity. A second link to the same episode on another locale was therefore a new media (a second epoch), and a participant reporting `crunchyroll:<ID>` from a localized route stayed `wrong-media`. `openLink` now stores a link that has a Crunchyroll watch ID (`crunchyrollWatchId()` in the protocol package) as `{ service: 'crunchyroll', canonicalId: 'crunchyroll:<ID>', title: <host>, durationSeconds: null, pageUrl }`, the same shape a room created on that episode has. Every other page keeps the `shared-link` identity.
   - a second link to the same episode on another locale is `navigation_unchanged` (revision, epoch, media, navigation and readiness untouched);
   - a participant on any localized route of the episode matches and can become ready;
   - a different watch ID starts a new epoch, including going back to the first episode (A, B, A is three epochs);
   - a readiness message for the previous episode that arrives after the controller moved on does not count (`wrong-media`).
2. **A Crunchyroll room refuses non-episode pages.** A room is a Crunchyroll room when its media says `crunchyroll`, or carries only a Crunchyroll page address (a room a shared link opened before this change, restored from stored state). In such a room `openLink` answers `unsupported_page` for any address that is not a Crunchyroll episode address (see "What the guard checks"), before anything changes: no epoch advance, no readiness reset, no navigation. The action is not remembered, so a repeat is refused the same way.

   **What the guard checks, and what it does not.** `crunchyrollWatchId()` is a pattern check on the address. It requires the host `crunchyroll.com` or a subdomain of it (not a lookalike such as `crunchyroll.com.evil.example`) and a path that is `/watch/<ID>` at the root or behind exactly one locale segment (`/de/watch/<ID>`, `/pt-br/watch/<ID>`, `/es-419/watch/<ID>`), with at most one title segment after the ID and nothing else. So `/foo/watch/<ID>`, `/a/b/watch/<ID>`, `/series/<ID>/watch/<ID>`, `/watch/<ID>/a/b`, `/watch`, the login page, the home page and series pages give no watch ID and are refused. It does not check that the ID names an episode that exists, that it is available in anyone's region or to anyone's account, or that the page is not an unavailable or error page served at an episode address. A well-formed `/watch/<ID>` address for an unavailable episode passes the guard, advances the epoch and un-readies everyone, exactly as a playable one does; telling them apart takes the page itself (the extension side) or the provider, and neither is used here. Rooms on other services and rooms that have not chosen a page yet may still share any page.

`unsupported_page` is a plain string code in `command_rejected`; an older extension shows the message and takes no other action.

### Corrections to the statements above

- Section "Manual shared-link transaction", step 7, and the root-cause text were written for the first transition only. After the first shared link the media was weak, so the "same episode on another locale is unchanged" rule held only while the room still had its original media. It now holds after a shared link too, for Crunchyroll episode pages.
- Section "Controller-follow safety policy" is unchanged: follow is a compile-time switch (`CONTROLLER_FOLLOW_NAVIGATION_ENABLED = false`), accepted as off. The follow policy rejects login and unavailable routes itself; the coordinator now also refuses non-episode addresses (login, home, series and similar) for a manual share, but not an unavailable page at a well-formed episode address. Its lease guard in the service worker (`hasCurrentLease`) is true whenever the worker holds a snapshot, so the coordinator's `stale_lease` check is the real lease guard; the enabled branch has no test.

### Tests

`packages/sync-engine/src/room.test.ts`, describe "a shared Crunchyroll episode link (CR-C04, coordinator half)" (10 tests): keying to the watch ID, a second localized link unchanged, readiness on a localized route, a new epoch for a different ID, stale readiness not counted (with the host ready, so only the friend decides), non-episode pages refused with the room unchanged, deeper paths containing `/watch/` refused, the guard on rooms a shared link opened and on page-address-only rooms, free sharing for other services and empty rooms, and non-Crunchyroll keying unchanged.

`packages/protocol/src/index.test.ts`: `crunchyrollWatchId` over episode addresses (root, one locale of the shapes `de`, `pt-br` and `es-419`, a title segment, a trailing slash) and over non-episode addresses (login, home, series, `/watch` without an ID, `/foo/watch/<ID>`, `/a/b/watch/<ID>`, `/watch/<ID>/a/b`, two locale segments, a long locale name, a lookalike host, another host, another scheme); `isCrunchyrollUrl` for the host only (a Crunchyroll `/login` address is true, a lookalike host and a non-address are false); `normalizeCanonicalId` and `mediaMatches` for the same legitimate and non-episode forms (the older host-and-path canonical id), and `mediaMatchesPageUrl` for a deeper path. Deeper-path and locale cases are attributed to the functions that test them: `crunchyrollWatchId`, `normalizeCanonicalId`, `mediaMatches` and `mediaMatchesPageUrl`, not `isCrunchyrollUrl`.

### One rule for the episode path

`CRUNCHYROLL_EPISODE_PATH` in `packages/protocol/src/index.ts` is the only pattern the protocol and the coordinator use for a Crunchyroll episode path. `crunchyrollWatchId()` (the shared-link guard and keying), `mediaMatchesPageUrl()` and the Crunchyroll branch of `normalizeCanonicalId()` (participant and room identity, through `mediaMatches`) all use it. Before this, `normalizeCanonicalId()` still read the ID with an unanchored `/watch/` pattern, so `mediaMatches` treated `www.crunchyroll.com/foo/watch/<ID>` and `www.crunchyroll.com/watch/<ID>/a/b` as the same episode as the anchored forms.

Copies of the old pattern remain in two extension files this change does not own: `apps/extension/src/media-fingerprint.ts` (`canonicalMediaId`, which produces `crunchyroll:<ID>` from a page path) and `apps/extension/src/navigation-transaction.ts` (the controller-follow policy, off by default). They need the same change in the extension half.

Mixed-version effect. This is a tightening of what the coordinator accepts, with no new field, capability, version or enum value. An older client (including the released 0.2.12 extension) that reports the plain form `crunchyroll:<ID>` is unaffected, whatever page it is on: the coordinator never sees its path, only the ID it computed, so an older client on `/foo/watch/<ID>` still reports `crunchyroll:<ID>` and still matches. What changes is the older host-and-path canonical id form (`www.crunchyroll.com/watch/<ID>/title`): the root and one-locale forms normalize exactly as before; a path with extra leading or trailing segments is no longer reduced to `crunchyroll:<ID>`, so it is compared as the raw string and does not match the episode (`wrong-media`). Nothing in the released extension is known to produce such an id (it produces `crunchyroll:<ID>`). An older coordinator keeps the unanchored rule. Stored state holds the fingerprints as sent and is not rewritten.

### Not done in this change

- The extension and the service worker: a worker test for a tab redirected to a localized route, the enabled controller-follow branch (it needs a test seam because the switch is a constant), dedup between a manual share and an observed episode, and the audio-edition case by name. These belong to another change.
- `open_link` round trips in `apps/room-service/src/server.test.ts` and `apps/edge-service/src/worker.test.ts`.
- The D03 navigation scenario on the owned fixture and `docs/CR_D03_BROWSER_MATRIX.md` lines 24 and 101.
- Any browser or live-provider run (D04): shared link, audio edition, both controller roles.

### Mixed-version effect

No new field, capability, contract version or enum value. A room a new coordinator opens a link in now carries a `crunchyroll` / `crunchyroll:<ID>` fingerprint, which is the shape every released extension already handles for a room created on an episode; the `navigation` object is unchanged. An older coordinator keeps the `shared-link` keying. An older extension as controller meets `unsupported_page` only for a non-episode page in a Crunchyroll room, shown as the rejection message.
