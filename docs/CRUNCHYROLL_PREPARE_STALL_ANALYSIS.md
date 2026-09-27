# Crunchyroll prepare stall: analysis and fix record

Status: source-level change with synthetic and local-browser evidence only. This record does not claim live authenticated Crunchyroll behavior, two-device behavior, deployment, or release readiness. It does not fix the stall in the diagnostic report it analyzes; it fixes two defects found on the way and adds the evidence needed to settle what remains.

Related trackers: [CR-B03 (#57)](https://github.com/muaz978/sync-your-joy/issues/57), [CR-C01 (#62)](https://github.com/muaz978/sync-your-joy/issues/62), [CR-C02 (#63)](https://github.com/muaz978/sync-your-joy/issues/63) and [two-account acceptance (#33)](https://github.com/muaz978/sync-your-joy/issues/33). All stay open.

## 1. The report

A controller and a guest, both on extension 0.2.5, downloaded one detailed report after Play stopped working in a live Crunchyroll room. The controller ran Edge 153 on macOS and the guest ran Chrome 152 on Windows. The room code and identifiers are intentionally not repeated here.

What the report shows for both participants:

- The room's last operation is `failed` with reason `deadline-expired`, target and observed position both `197.442125`.
- `playerReadyState` is `1` (metadata only) and `playerNetworkState` is `2` (loading) on every retained `media_detected` heartbeat, over about 20 s on the controller and 33 s on the guest. The source is a `blob` with no `srcObject`.
- `sample.buffering` is `true` while the room is `paused`. That value can only come from a pending seek that is at least 1.5 s old (`apps/extension/src/content-script.ts`, `seekPendingTooLong`), or from the one-shot report after the 1.5 s local seek timeout. Each `buffering: true` status begins 1.5 to 1.6 s after a new operation reached the participant.
- The retained window holds 44 (controller) and 43 (guest) events out of 1,172 and 1,485 dropped. It starts at the controller's revision 49 and the guest's revision 43, so it holds no `operation_ack` and no `seek_applied` event for either participant, and no snapshot from an acknowledgement.
- The window contains at least six Play presses about 200 ms apart, a Sync, a readiness toggle and one seek at the paused position.

What it does not contain: `video.error`, whether the element was `seeking`, buffered or seekable ranges, the time each acknowledgement arrived, or why a source generation of 7 was reached on the guest. Those are the fields that separate a player that never fetched data from one that was refused it.

## 2. Root cause

### 2.1 Confirmed: a paused seek fails the room three seconds after it was created

When every participant prepares a paused seek, the coordinator moves it to `committed` and pauses at the target. A paused seek never sends a `started` acknowledgement (`docs/CR_B03_EXTENSION_ACK_REPORT.md`), yet the coordinator kept the preparation deadline that was set when the seek was created. About three seconds after creation `releaseExpiredOperation` failed it with `start-timeout`, paused the room and marked every participant `recovery-required`.

Evidence, on unmodified `main`:

- Unit: after both participants prepare a paused seek, its creation-time deadline still ends in `failed` with `start-timeout` (`packages/sync-engine/src/room.test.ts`, "settles a committed paused seek when its window closes instead of failing the room").
- Browser: in `tests/e2e/two-profile-sync.spec.ts`, two real extension profiles and the real coordinator, a native seek while paused leaves the room at `phase: failed`, `reason: start-timeout` when observed 4.5 s later. With the change the seek reads `committed` inside its window and is then cleared: no operation, both participants `ready`.

Consequence: every `+10 s`, "Sync everyone" and native seek while paused in a transactional room ended in a recovery state after three seconds. This is consistent with the `operation_timeout_paused` at revision 44 in the report, whose reason the retained window does not show. That link is an inference, not an observation. It also means steps 12a and 12b of `docs/V0_2_5_CONTROLLED_TEST_SESSION.md` show `failed` with `start-timeout` instead of `committed` when they are read more than three seconds after the seek, against the coordinator deployed from `v0.2.5`.

### 2.2 Confirmed: a repeated Play restarts the preparation window

Each Play press created a new operation, which discarded every prepared acknowledgement and opened a new three-second window. The buttons are not disabled while preparing, so a burst of presses kept the deadline moving and kept a slow participant from ever finishing. In the room test five presses 500 ms apart moved the deadline from 13,000 to 15,500 before the change.

The change has one cost. A press in the last moments of the window is absorbed and the operation still fails at its deadline; the next press then starts a fresh one. Before, that late press would have opened a new window. The deadline can no longer be extended by pressing, which is the point.

### 2.3 Not confirmed: why both players stayed at `readyState` 1

The working hypothesis was a deadlock: the prepared check demands `readyState >= HAVE_CURRENT_DATA`, and a paused element at `HAVE_METADATA` that already sits on target is never asked to fetch anything. The report does not support that state. It shows a seek that stayed pending past 1.5 s, which requires `video.seeking` to have been `true`. Both the prepared check and any relaxation of it also require `!video.seeking`, so relaxing the `readyState` requirement would not have fired.

What the evidence allows:

- The most likely state is a native seek that never completed: `readyState` 1, `networkState` 2, `seeking` true, nothing buffered around the target. This is an inference from timing, not an observation.
- Whether the provider only fetches while playing, refused the stream (a simultaneous-stream or licence limit), or something else, cannot be told from this report. The class predates 0.2.5: 0.2.4 already recorded a provider stream that never receives enough data to play.
- A `sourceGeneration` of 7 on the guest at its last acknowledgement means its element or page identity was reset several times, but not when or why.

A live session with the new diagnostics (section 6) is the way to settle it.

## 3. Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| (a) Accept prepared once the seek landed, even at `HAVE_METADATA` | Not shipped | It would not fire in the observed state (`seeking` stays true). It also has to change the committed-phase gate, or a cold participant trades `deadline-expired` for `start-timeout` 4.3 s after commit. It reverses a deliberate fix: release 0.1.9 (`b50acef`) dropped the `HAVE_CURRENT_DATA` gate on seek acknowledgement to shorten the aligning wait, and a later Crunchyroll investigation restored it after a metadata-only seek was acknowledged. Issue #33 requires zero unsafe resumes. No existing test pinned the transactional gate; one now does (section 5). |
| (b) Muted `play()` then `pause()` as a fetch kick during preparation | Not shipped | It is the only option that supplies the missing fetch trigger, but it needs a keyed exemption from the preparing pause, `expectPlayEvent` and `expectPauseEvent` handling, muted-state restoration and handling of a rejected kick. It cannot be validated without the real provider, and playing a paused element is what the transactional contract exists to prevent. |
| (c) Per-room fallback to the legacy contract | Not shipped | The coordinator can degrade without a wire change, but it needs a sticky persisted flag, re-exposes the CR-B02 defects the transactional contract fixed, and the legacy path has the same seek gates. |
| (d) Fix the two provider-independent defects, instrument, decide with data | Chosen | Sections 2.1 and 2.2 are reproduced and fixed. The stall itself gets the evidence that would justify (a) or (b), and the reversal conditions below say when. |

Reversal conditions, to apply after a live capture:

- `errorCode` 2, 3 or 4, or `readyState` 0 with a source: a provider or stream failure. Neither (a) nor (b) applies; the extension should say so instead of retrying.
- `seeking` true, `bufferedAheadSeconds` 0, `errorCode` null, `pendingSeekAgeMs` past 1,500 and `media_detected` events that repeat with `seeking` true for many seconds, and the same element accepts `play()` when the user presses the provider's own button: the provider fetches only while playing. Option (b) becomes worth building, behind a test against a fixture that models exactly that.
- `seeking` false, aligned, `readyState` 1: the original hypothesis. Then option (a) needs the commit-phase and start-window changes above, and a test that fails today.

## 4. Deadline realism

The values in play, unchanged by this change: preparation `SEEK_BARRIER_MAX_WAIT_MS` 3,000 ms, local seek timeout 1,500 ms, post-commit `PLAYBACK_STARTUP_GRACE_MS` 2,500 ms plus `PLAYBACK_PROGRESS_TIMEOUT_MS` 1,800 ms (a 4,300 ms start window), and `PLAYBACK_STARTUP_TIMEOUT_MS` 10,000 ms.

- The 3,000 ms preparation window came in with the three-person local browser matrix (commit `d5ceef7`). It was set to make that matrix reliable and has not been measured against a real provider. A seek to an unbuffered position on a slow connection can plausibly take longer, so it may be tight for real use.
- No evidence here supports a longer window. Both players stayed at `readyState` 1 for 20 to 33 s, so a longer window would only have lengthened the wait for the same failure, and, with the press behavior in section 2.2, widened the storm. The window is left alone.
- The 10 s startup timeout is unreachable in transactional mode: the 4,300 ms operation deadline fires first unless every participant has already acknowledged the start. A participant that needs 5 to 10 s after `play()` is failed even though the health layer and the player would tolerate it. This is recorded, not changed.

## 5. What changed

| Area | Change |
| --- | --- |
| Coordinator (`packages/sync-engine`) | A committed paused seek is settled: it is reported as `committed` for its window, never fails with `start-timeout`, never shows a participant as `seeking`, accepts no `started` acknowledgement, and is cleared (snapshot reason `operation_seek_settled`) when its window closes (`operation-state.ts`, `room.ts`, `participant-status.ts`). A repeated Play for the Play that is already preparing, at the same position and inside its window, is answered `control_play_unchanged` and changes nothing. |
| Extension (`apps/extension`) | The content script no longer runs the transactional alignment for a settled paused seek, so the controller's next scrub is honoured while the seek is still in the snapshot. New element evidence in the report and the side panel. Repeated heartbeats and failing statuses are merged instead of filling the event history. |
| Protocol (`packages/protocol`) | Optional report fields, validated when present (section 6). No capability, contract version or enum value changed. |
| Fixture (`fixtures/adaptive-player.html`) | An absent `missingSegment` parameter now means none. It used to read as segment 0 (`Number(null)`), which withheld the first segment and left the default fixture stuck at `readyState` 1 with nothing before 20 s buffered. |

Tests added:

- `room.test.ts`: a settled paused seek is committed inside its window, refuses a start acknowledgement and is cleared, not failed, when the window closes; repeated Play keeps the operation, prepared evidence and deadline; the first deadline still fails it; different position, committed, expired and a join start a new one.
- `participant-status.test.ts`: only a committed paused seek is settled.
- `content-script.test.ts`: a player stuck at metadata never claims prepared, never plays and does not thrash the element; it reports its state; an on-target element without data is not prepared (this fails if the gate is relaxed to `HAVE_METADATA`); the controller can scrub again and a guest is still pulled back.
- `service-worker.test.ts`, `diagnostics-budget.test.ts`, `media-ranges.test.ts`, `packages/protocol/src/index.test.ts`: the new fields, their bounds, privacy and validation, and retention over a long stall.
- `tests/e2e/two-profile-sync.spec.ts` and `tests/e2e/adaptive-fixture.spec.ts`: the paused seek is cleared, not failed, in two real profiles and a second paused scrub still works; the default fixture loads all 30 segments.

## 6. Diagnostics

New optional report fields, all plain numbers or booleans and all `null` when the player has not reported them:

| Field | Meaning |
| --- | --- |
| `playerSeeking` | Native `seeking`. |
| `playerErrorCode` | `MediaError.code`, 1 to 4. Never the message. |
| `playerBufferedRangeCount`, `playerBufferedRanges` | True count, and at most four `[start, end]` pairs in seconds, nearest the playhead first, listed ascending. |
| `playerSeekableRangeCount`, `playerSeekableRanges` | The same, at most two pairs. |
| `playerBufferedAheadSeconds` | Contiguous media after the playhead. 0 when nothing is buffered there; a playhead within 0.05 s before a range counts as inside it. |
| `playerPendingSeekAgeMs` | Age of the extension's own pending seek, or null. |
| `playerHasMediaKeys` | Whether media keys are attached. A boolean only; nothing about the key system or the session. |

The worst case costs about 375 bytes; a typical stalled player about 250. `media_detected` events also carry `seeking`, `errorCode` and `aheadBucket` (`empty`, `low`, `ok`) so a change in element state gets its own event.

Event history: identical `media_detected` and `player_status` events are merged even when other events sit between them, and a media loss, a socket change or a room join ends the run so a heartbeat after one is a new event. A merged event moves to the tail, where its latest occurrence belongs, so trimming the oldest events under the byte budget never removes the freshest one. `atLocalMs` is the latest occurrence, `details.firstAtLocalMs` the first and `details.repeatCount` how many. In the test 150 pairs of one heartbeat and one failing status, interleaved, leave two events and drop none; before the change the same run evicted every earlier room event. The side panel's player diagnostics show `Seeking`, `Buffered ahead` and `Media error code`.

Compatibility: the v0.2.4 report validator ignores unknown report fields, and the current one keeps and relays them (a protocol test locks the current behavior). A newer coordinator validates the new fields only when present. Only the coordinator can settle a paused seek, so the paused-seek fix reaches a client once the coordinator is redeployed; the extension part protects an updated client that meets a settled seek.

Mixed-version note for that redeploy: a 0.2.5 extension applies a committed paused seek as a live operation every second for as long as it is in the snapshot. That window is the same three seconds it always was; the 0.2.5 coordinator ended it by failing the seek, the fixed one ends it by clearing the seek. Within the window a 0.2.5 controller's next paused scrub is exposed. Reproduced at unit level with the 0.2.5 content script: if the once-a-second alignment lands inside the scrub's 60 ms intent debounce, the player is written back to the old target and the seek intent reports that target, so the room moves back. The frequency in a real browser was not measured. Updating the extensions before the coordinator avoids it; the change does not lengthen the window.

## 7. Manual validation with two Crunchyroll profiles

Use two profiles with the extension built from this change, both signed in with their own authorized accounts, on the same `/watch/` episode, in one room, both ready. The coordinator has to include the change: a local `npm run dev:server`, or a deployment after release approval. Record versions and the exact URL kind, never a room code.

1. On each profile, before doing anything else, run this in the Console with the context dropdown set to the frame that matches the panel's Binding and Origin. It prints numbers and one boolean. It reads the first video in the frame, which is the player on a Crunchyroll watch page; `undefined` means the frame has no video. Do not print `src` or `currentSrc`.

   ```js
   v = document.querySelector('video'); v && ({ rs: v.readyState, ns: v.networkState, err: v.error?.code, seeking: v.seeking, buf: [...Array(v.buffered.length)].map((_, i) => [v.buffered.start(i), v.buffered.end(i)]), t: v.currentTime })
   ```

   If the page holds more than one video, or the player is in a shadow root, say so instead of guessing.
2. While paused, press `+10 s` on the controller. Wait 10 s.
   - Expected: the operation reads `committed` with prepared `2/2` for about 3 s and is then cleared (the report shows the snapshot reason `operation_seek_settled`). Both participants stay `Ready` and the room stays paused throughout.
   - Fail: `recovery-required` or `start-timeout` about 3 s after the press. Capture the snippet on both profiles and a report.
3. Press Play once.
   - Expected: started `2/2` within a few seconds.
   - If it fails with `deadline-expired`: do not press again yet. Within 5 s run the snippet on both profiles, then download the detailed report. Read `playerSeeking`, `playerErrorCode`, `playerBufferedRanges`, `playerBufferedAheadSeconds`, `playerPendingSeekAgeMs` and the `media_detected` events against the reversal conditions in section 3.
4. Press Play four times within one second on a room that is paused. Expected: one operation. The report shows `control_play_unchanged` snapshots, not four operations.
5. Scrub the controller's native player twice while paused, five seconds apart. Expected: both scrubs are honoured and the guest follows, with no jump back.

What a pass proves: the two fixed defects against the real provider. It does not prove the stall is gone. If step 3 still fails, the report now says why.

## 8. Not claimed

- No live Crunchyroll run, two-account run or two-device run was made for this change.
- The cause of the stall in the report is not established; section 2.3 lists what is known and what is inferred.
- No option in section 3 that changes when a player is asked to play was built or tested.
- The 10 s startup timeout, the unreachable start window, a committed operation with a partial start failing persisted-state validation on the edge coordinator, and whether a seek issued during a preparing Play should keep its resume intent are recorded follow-ups, not part of this change.
