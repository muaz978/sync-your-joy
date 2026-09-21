# CR-C03 Player and panel waiting/recovery report

Status: implementation candidate on issue #64. This document records the deterministic implementation boundary and the evidence required before the issue can be closed.

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
- `apps/extension/src/sidepanel.ts` displays a local status card, uses reason-specific repair labels, and adds the bounded status to each participant row.
- `apps/extension/src/content-script.ts` uses the same local status language in the in-page controller. `In sync` is no longer emitted as a generic readiness or room-clock label.

The browser still controls the native player. SyncYourJoy does not inspect private provider APIs, read protected media, transport audio or video, or collect credentials.

## Status transition rules

1. A new or not-yet-ready matching participant starts as `preparing`.
2. A matching ready participant in a paused room is `ready`.
3. A controller play operation marks the required set as `preparing`; a seek marks it as `seeking`.
4. A fresh player sample with `progressed: true`, `paused: false` and no buffering marks that participant `playing`.
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
- existing content-script visibility, fullscreen, replacement and recovery behavior.

Run the focused implementation checks with:

```sh
npm exec vitest run \
  packages/sync-engine/src/participant-status.test.ts \
  packages/sync-engine/src/room.test.ts \
  apps/extension/src/playback-status.test.ts \
  apps/extension/src/content-script.test.ts
```

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
