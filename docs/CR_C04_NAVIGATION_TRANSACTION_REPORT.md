# CR-C04 navigation transaction report

Issue: [#65](https://github.com/muaz978/sync-your-joy/issues/65)

## Decision summary

Episode changes must be treated as media transactions, not as ordinary playback commands. A manual shared-link action is accepted only from the current controller and current lease. It validates and normalizes the page, ignores a same-media link, cancels old operation or seek evidence, increments the media epoch, resets the room to paused position zero, clears participant readiness and publishes fresh navigation state.

The implementation also defines a fail-closed policy for a future optional controller-follow mode. It is disabled by default. If it is later enabled after headed provider validation, it will require the current controller lease, a strong Crunchyroll watch identity and a media change, and it will deduplicate repeated actions by the canonical episode identity. Member navigation, login pages, unavailable pages, weak identities and non-Crunchyroll pages cannot auto-mutate room content through that policy.

## Root cause

The room already supported `open_link`, but its semantics treated every accepted URL as a new media selection. That could restart an unchanged Crunchyroll episode when only the localized path or title changed. The protocol had strong media identity matching for readiness, but the coordinator did not reuse that identity decision when deciding whether a navigation transaction was necessary.

The extension also observed SPA and native next-episode changes through `MEDIA_DETECTED`. Those observations update local player binding and readiness evidence, but must not silently become shared room navigation. Without an explicit, validated controller-follow policy, a member, a login page or a weak page signal must never change room content.

## Manual shared-link transaction

The coordinator's `openLink` path now follows this order:

1. Reject duplicate action IDs, non-controller callers, stale leases, future revisions, stale context and invalid URLs.
2. Compare the normalized URL with the current room media. Strong Crunchyroll watch IDs may match across localized routes. Weak identities match only when the normalized page URL is unchanged.
3. Return `navigation_unchanged` without changing the revision, media epoch, playback, readiness or operation when the link is the current media.
4. For a new media link, cancel pending seek or transactional operation evidence with reason `media-changed`.
5. Increment `contract.mediaEpoch` and clear the current operation.
6. Mark connected participants unready and non-matching, reset statuses to `wrong-media`, and leave disconnected participants `unknown`.
7. Replace room media with the normalized shared page identity, pause at position zero and schedule the shared navigation after the normal command lead time.
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

No version bump is justified for this issue alone. The repository remains at `0.2.4`. A compatible release will be considered only after a coherent verified group, and `1.0.0` remains reserved for complete milestone acceptance.
