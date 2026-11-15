# CR-C03 Player and panel waiting/recovery report

Status when written (historical): implementation candidate on issue #64. This document records the deterministic implementation boundary and the evidence required before the issue can be closed. Update 2026-10-16: the implementation merged as PR #92 and shipped in v0.2.5; #64 stays open for the gates under "Acceptance gates that remain separate". The Release decision below is the pre-merge position (historical).

Update 2026-11-15: the side panel's status rendering moved into a pure module, `apps/extension/src/panel-status-view.ts`, with unit tests. See "Side panel status view" below for what that changed, what is still open on the card, and what evidence it does and does not provide. The evidence is unit tests and one local fixture render; nothing here was seen in a docked side panel, on Crunchyroll, with two accounts or on two devices, and nothing is user accepted.

## Problem

The room clock and a browser video element are different evidence sources. A room can be ready while a player is still loading, a seek can be pending while the native element is moving to its target, and a `play()` request can be rejected or stop progressing after the room has entered the playing state. A single `Ready` or `In sync` label hides those distinctions and gives the user no reason-specific recovery action.

## Public status contract

The coordinator exposes one bounded `playbackStatus` value per participant in the room snapshot. It is deliberately coarse and contains no raw `PlayerSample`, source URL, provider error string, media bytes, cookie, credential or DRM value.

| Status | Meaning | User-facing next action |
| --- | --- | --- |
| `preparing` | The participant is not ready, has no usable player yet, or is waiting for a play operation to prepare. | Retry preparation or wait for the selected player. |
| `ready` | The participant is ready while the room is paused. This is not a claim that native playback is progressing. | Play when everyone is ready. |
| `playing` | The participant has a fresh sample with explicit native progress evidence while the room is playing. | Continue, pause or seek from the controller. |
| `seeking` | A shared seek or transactional seek operation is still being prepared or acknowledged. | Wait for the fixed target or retry the seek. |
| `blocked` | The browser rejected synchronized playback. | Use one local gesture, then press Sync again. |
| `buffering` | The player is waiting for data without yet triggering a room-wide failure. | Wait for data, then retry if necessary. |
| `silent` | No sample arrived before the bounded startup or report-silence deadline. | Redetect the player or reopen the shared page. |
| `wrong-media` | The local media identity does not match the room's selected media. | The controller can open the current episode for everyone; a member asks the host to share it. |
| `recovery-required` | Native playback is paused, stalled or drifted while the room expected progress, or a bounded operation timed out. | Sync the local player and inspect the player diagnostics. |
| `unknown` | The participant is disconnected or the status cannot be established. | Reconnect before starting playback. |

`playing` is intentionally stricter than `ready`. A ready participant may have a paused video. A participant is not publicly marked as playing merely because the coordinator's mathematical timeline is advancing.

## Implementation boundary

The change is limited to the state-only extension protocol and its presentation:

- `packages/protocol/src/index.ts` adds the optional bounded `ParticipantPlaybackStatus` field to `ParticipantState`.
- `packages/sync-engine/src/participant-status.ts` maps internal operation, readiness and health evidence into that bounded vocabulary.
- `packages/sync-engine/src/room.ts` persists the public status across room snapshots and restart restoration, updates it on readiness, media, operation, health and disconnect transitions, and broadcasts a snapshot only when a participant's public status changes.
- `apps/extension/src/playback-status.ts` derives the local in-page status and owns the shared user-facing explanation and next-action copy.
- `apps/extension/src/sidepanel.ts` puts state into `apps/extension/src/panel-status-view.ts` and the result on the page. That module decides the local status card, the repair button labels and each participant row (see "Side panel status view").
- `apps/extension/src/content-script.ts` uses the same local status language in the in-page controller. `In sync` is no longer emitted as a generic readiness or room-clock label.

The browser still controls the native player. SyncYourJoy does not inspect private provider APIs, read protected media, transport audio or video, or collect credentials.

## Status transition rules

1. A new or not-yet-ready matching participant starts as `preparing`.
2. A matching ready participant in a paused room is `ready`.
3. A controller play operation marks the required set as `preparing`; a seek marks it as `seeking`.
4. A fresh player sample with `progressed: true`, `paused: false` and no buffering marks that participant `playing`. This is what the coordinator does as merged. The owner's decision of 2026-10-31 is stricter: `playing` and the started acknowledgement need rendered-frame evidence, and clock-only progress must not show "Playing, confirmed". The panel enforces that for this browser's own player (below); the coordinator rule (`packages/sync-engine/src/participant-status.ts`) and the started acknowledgement still follow the merged behavior and are tracked separately.
5. A rejected play marks the participant `blocked` and removes its readiness so the same failed command cannot silently repeat.
6. Buffering, paused-while-playing, stale reports and bounded no-progress deadlines map to `buffering`, `recovery-required` or `silent` according to the evidence available.
7. A media mismatch always takes precedence over playback state and maps to `wrong-media`.
8. A disconnect maps to `unknown`. A restored old snapshot without this optional field receives a safe status derived from connected, matching and ready flags.

## Tests

The focused regression suites cover:

- readiness versus confirmed native progress;
- preparation and seek states;
- explicit playback rejection, buffering and recovery;
- startup silence, report silence and no-progress recovery;
- controller versus member mismatch action copy;
- room snapshot status changes and privacy-safe participant fields;
- existing content-script visibility, replacement and recovery behavior (there is no test of `fullscreenchange` or `pageshow` yet; the pill in fullscreen and a browser-restored tab have not been observed);
- the side panel's card, repair buttons and people list for all ten statuses, a non-connected state and the unconfirmed-progress labels, in `apps/extension/src/panel-status-view.test.ts` (next section).

Run the focused implementation checks with:

```sh
npm exec vitest run \
  packages/sync-engine/src/participant-status.test.ts \
  packages/sync-engine/src/room.test.ts \
  apps/extension/src/playback-status.test.ts \
  apps/extension/src/panel-status-view.test.ts \
  apps/extension/src/content-script.test.ts
```

## Side panel status view

`apps/extension/src/panel-status-view.ts` is a pure module: state in, text and HTML out, no `document`, no `chrome.*`. `sidepanel.ts` calls it and writes the result to the page, so the panel's wording and structure can be tested without a browser. The in-page pill still has its own pure module, `pill-view.ts`.

The panel's key is the ten public statuses plus three that only the panel needs:

| Key | Label | When |
| --- | --- | --- |
| `disconnected` | Disconnected | A participant the room lists as not connected. Their last status is not shown. |
| `clock-only` | Clock only, unconfirmed | The status is `playing`, but this browser's player reports clock progress only (no frame counter). |
| `frames-unconfirmed` | Frames unconfirmed | The status is `playing`, but this browser has no frame evidence for it yet. |

What changed, as unit-tested behavior:

- **Connection first.** When this browser is not `connected` to the room, the card and every row say "Connection unclear". The card used to read the participant's own last `playbackStatus` before it looked at the connection, so it could say "Playing, confirmed" beside "Reconnecting".
- **No confirmed label without frames.** For this browser's own player, `playing` is kept only when the player's progress evidence is `frames`. Evidence `clock` shows "Clock only, unconfirmed", missing or `unknown` evidence shows "Frames unconfirmed". This follows the owner's decision of 2026-10-31 and uses only fields already in the shared state (`PlayerSample.progressEvidence`, `PlayerDiagnostics.health.progressEvidence`).
- **Status at every width.** Each person's status label sits under the name instead of in a badge hidden below 640 px (`hidden sm:inline-flex`), and the card's label shares the heading's line and may wrap, so the detail has the full width. A docked side panel is normally narrower than 640 px (the width was not measured in a real docked panel).
- **Status-aware row icon.** The icon follows the status (play, check, waiting, sync, warning, offline), not the ready flag. A participant who needs recovery no longer shows a tick, and a blocked one no longer shows a clock.
- **Card words match the controls.** "Next action" names the button the panel has for that status (for example "Use Sync gesture" for `blocked`, "Redetect player" for `silent`). `unknown` says to wait for the connection to return, because no control reconnects.
- **Media error code.** When the selected player reports a standard `MediaError.code` (1 to 4), the card names it and points to Player diagnostics. Only the code is shown, never a message.
- **Styles.** UnoCSS reads class names only from the files `scripts/build-extension.mjs` lists, so the build now lists this module; a test pins that.

### Evidence

- Unit tests: `apps/extension/src/panel-status-view.test.ts`.
- One local fixture render, not committed: the built `sidepanel.html` opened as an ordinary page in Playwright's Chromium at 320, 360 and 900 px with a stubbed `chrome.*` and a snapshot from the real `RoomCoordinator`, in four scenarios (frames evidence, clock-only, reconnecting, media error). Every row's status label was visible inside its row and the panel did not overflow horizontally in any of them. That is a synthetic fixture on a page that is not docked.

### Still open on the card

- The panel can only apply the frame rule to this browser's own player. The public snapshot has no evidence quality for other participants, so another person's row shows whatever the coordinator published. A clock-only `playing` from another participant needs the coordinator to stop publishing it as `playing` (`packages/sync-engine/src/participant-status.ts`), or an additive optional field.
- `playbackStatusCopy` (`playback-status.ts`) and `pill-view.ts` are unchanged: the pill still says "Reconnect" for `unknown`, has no media error action, and keeps Sync enabled for `silent` where the panel disables it. The pill has no per-status label test.
- Nothing tests `fullscreenchange` or `pageshow` in `content-script.ts`.
- `docs/PRODUCT_PLAN.md` still proposes the label "In sync".
- Preparing, seeking, buffering, silent, wrong-media and recovery-required were not rendered in a browser on another participant's row or on the pill.
- The new labels are proposals. The owner has not accepted the wording, and has not said what "restored tabs" means.

The source check must also include `npm run check`, `npm audit --audit-level=high`, `npm run release:check-version` and `npm run verify:browser-packages` before a PR is reviewed.

## Acceptance gates that remain separate

Passing deterministic tests proves the bounded state contract and UI rendering logic. It does not prove:

- authenticated Crunchyroll or other commercial-provider playback;
- visible frame progress on every provider or browser;
- two authorized accounts or two physical devices;
- a deployed candidate's exact runtime identity;
- headed Firefox or Safari acceptance;
- network chaos, sleep/wake or provider entitlement behavior;
- user acceptance.

Those gates remain in issues #30, #33, #34, #35 and #49 and must be recorded separately. Issue #64 must remain open until representative panel and in-page behavior is directly verified in addition to the source and test checks.

## Privacy and security review

The status field is a finite enum. It contains no user-entered display text, page URL, current source URL, current time, raw error message, sample counters, media position or operation identifier. The full diagnostic report remains the designated path for sanitized troubleshooting evidence, with its existing bounded budget and redaction rules.

## Release decision

This issue alone does not justify a release bump. The repository remains on `0.2.4`. A compatible release will be selected only after a coherent verified group, and `1.0.0` remains reserved for complete milestone acceptance.
