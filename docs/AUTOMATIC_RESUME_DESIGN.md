# Automatic resume and stuck-seek recovery: design

Status: built and released. The extension part (recovery ladder, diagnostics, `canPlay`, notices) shipped in extension 0.2.10; the coordinator part (automatic resume) is deployed to production (Worker `01829323-1eea-4153-90e9-869ec6e22c6b`, 2026-10-21). Not confirmed on a live Crunchyroll session. Tracking issue: #141 (resume), #138 (stuck seek). Written 2026-10-19 after a live 0.2.9 session (diagnostics report `report_29f1ddf6…`, screenshot of the side panel). Section 7 records the decisions that were taken; section 9 says what was built.

## 1. What the 0.2.9 session actually shows

Both participants (macOS Edge 155 and Windows Chrome 155, both extension 0.2.9) ended in the same state:

| Fact | Value (both players) |
| --- | --- |
| Room | paused at 395.63 s (6:35), revision 154, operation `play` in phase `preparing` |
| Player | `readyState` 1, `networkState` 2, `seeking` true, `paused` true, nothing buffered ahead |
| Buffered data | `[676.7, 736]` and `[672.7, 736]`: about 4.7 minutes away from the target |
| How long | `seeking` true at `readyState` 1 for at least 164 s (P1) and 150 s (P2) before the report |
| Controller's attempts | 7 Play presses, each ended by `operation_timeout_paused` about 3.3 s later (the prepare barrier never completed) |
| Sync | one `manual_sync` on P2 only; the stuck-seek reload advice (after two re-issues) was never reached |

Reading:

1. **This was not a pause the room should have resumed from.** The players could not finish a seek to 6:35. Play cannot succeed while `seeking` is true: a player only counts as prepared when `readyState >= 2`, not seeking, and at the target (`isTransactionallyPrepared`). An automatic Play would have failed exactly like the 7 manual ones. Automatic resume must therefore never retry a Play whose players were never prepared; it would only repeat the loop.
2. **The stall is the one tracked in #138 (a seek that never completes), seen on a fresh build.** Both players' buffers end at 736 s (they were around 11:15 and had prefetched a minute) and the room target is 6:35, a backward jump of about 4.7 minutes into data that was no longer buffered. Neither player fetched data for the new position. Hypothesis H1: Crunchyroll's player does not start loading when `currentTime` is set from outside for a long backward seek outside the buffer. Consistent with the earlier manual test (`currentTime = 400` gave sound without video; `100.5` gave nothing). Not proven.
3. **What moved the room to 6:35 is not in the log.** The report dropped 2,851 and 2,481 events (`payloadTruncated`), and the first retained event is already revision 139. The cause of the jump (a controller seek, a Sync, a restore) cannot be read from it. That is a diagnostics defect in its own right (section 5).
4. **The screenshot shows a misleading panel.** It says "Ready, not playing: the player is ready but has not confirmed native progress" and both people show a green check and "Ready, 72 / 82 ms". Both players are in fact not ready (`readyState` 1, seeking, empty buffer). The check mark is the participant's readiness flag, not the player's state. The text should say what is true: "Still loading 6:35".
5. Both participants are named "Movie friend" (the display name was not changed), which makes the panel hard to read.

## 2. Two separate problems, two mechanisms

| Problem | Example | Mechanism |
| --- | --- | --- |
| A. The room paused because of a transient condition and everyone could play again a moment later | rebuffer that outlasted the 3 s grace; 1.8 s no-progress timeout; report silence | **Automatic resume** (coordinator) |
| B. A player cannot finish a seek and cannot play | the 0.2.9 log above | **Stuck-seek recovery ladder** (extension), then the room can resume |

Resume is only useful once B is solved or does not apply. Do B first or together; A alone would not have changed the session above.

## 3. Automatic resume (problem A)

### 3.1 Principles

1. Resume only what the system paused. A pause the controller made, a seek, a pass of control or a leave all cancel any pending resume and are never undone.
2. Resume when everyone can play, not on a timer. A timer would restart a player that cannot yet play.
3. Bounded: a limited number of attempts, with backoff, then stop and say so.
4. Never loop on a blocked or wedged player. An autoplay rejection or a Play that never prepared ends automatic resume for that pause.
5. No wire change needed for the first version: the coordinator already has everything.

### 3.2 State (coordinator-local, not in the snapshot, not persisted)

```
autoResume: {
  armedAtServerMs, cause,          // 'participant_buffering' | 'participant_playback_stalled' | 'participant_playback_silent'
  revisionAtPause,                 // the revision the pause produced
  attempts, lastAttemptAtServerMs,
  stableSinceServerMs | null,      // start of the current "everyone can play" window
} | null
```

Like the buffering grace map it is lost on a restore: a restarted room stays paused and the controller presses Play (state this in the changelog).

### 3.3 Arming

Armed inside the same code that produces the health pause (`updatePlayerStatus`), only for these causes while the room was `playing`:

- `participant_buffering` (after the 3 s grace),
- `participant_playback_stalled` (1.8 s without progress),
- `participant_playback_silent` (a player that stopped reporting; its own reports must resume before the wait can proceed).
- `participant_playback_startup_timeout` is **not** armed (a player that never started is problem B).

Not armed: `participant_playback_blocked` (needs a user gesture), any controller `pause`, `seek`, `play`, `pass`, an operation that failed in `preparing` (`operation_timeout_paused`), `manual-recovery`, a restore, room expiry.

Disarmed (cancel) on: any accepted control message, revision change not caused by the room itself, controller change, media change, a participant leaving or a new one joining as required, the room closing.

### 3.4 The "can resume" predicate

Evaluated on every accepted fresh status report and by an alarm at the next stability deadline. All must hold for every required participant (connected, ready, `mediaMatches`, the same set the Play operation requires):

- the latest sample is fresh (younger than the report-silence limit) and for the current revision,
- `buffering` is false and `playbackStatus` is not `blocked` or `recovery-required` with a start failure,
- the sample position is within 15 s of the room position (a stalled player is a few seconds behind a room that ran on for the buffering grace; one that is far away is stuck, not waiting),

and it has held continuously for a **stability window** of 1.5 s (two heartbeats), so one lucky sample does not resume a flapping player.

The prepare barrier is the final safety check. A player that reports `buffering: false` but is not prepared (for example `readyState` 1, seeking) fails the barrier and the attempt is counted as failed (3.5). No new extension field is required for the first version; a later one can add `readyState` and buffered-ahead seconds to the status sample to make the predicate stricter and cheaper.

### 3.5 Resume action and bounds

- Issue the same transactional Play a controller press issues (prepare, commit with lead, start acknowledgements) so everyone starts together. Mark the operation `initiator: 'system'` in the diagnostics event, and record `auto_resume_attempt`, `auto_resume_succeeded`, `auto_resume_abandoned` with the reason.
- Success: the operation reaches `started`; the wait is cleared at once and no separate progress confirmation is made. A later stall arms a new wait, within the arm limit.
- Failure (barrier timeout, start timeout, rejection): count it.
  - Autoplay rejection: abandon immediately (needs a gesture).
  - Barrier never prepared (wedged player): abandon after the first failure, mark the participant `recovery-required`, and hand over to problem B.
  - Other failure: retry after 2 s, then after 5 s; the third failure gives up (so at most 3 attempts); overall window 2 minutes from arming.
- Abandoned: the room stays paused, the controller sees "Could not resume automatically. Press Play." naming the participant that was not ready.
- The 3 s buffering grace is unchanged and runs before arming, so a short rebuffer never pauses anyone and never reaches resume.

### 3.5a What cancels the wait, and what it costs

A count of what people did to the room (a control, a readiness change, a join, a leave, a change of controller, any call that changed the room) is taken when the wait begins; a different count cancels it. Revisions are not compared: the coordinator's own health, acknowledgement and failed-operation updates produce revisions that say nothing about a person.

While a wait is open the edge object is woken once a second (the alarm persists the room each time), for at most two minutes per wait: about 120 small writes per wait. The arm limit (three waits inside a rolling two minutes) bounds how fast waits can follow one another, not the total over a long incident. The local service already ticks every 100 ms.

### 3.6 What the user sees

- On a system pause: "Paused: <name>'s player is loading. Resuming automatically when everyone is ready." with a Cancel button for the controller (cancelling = disarm; the room stays paused).
- While waiting past 10 s: the same line says who is not ready yet.
- On abandon: the failure line above.
- Stop notice wording (already changed in 0.2.9) stays accurate.

### 3.7 Mixed versions

A participant whose extension is too old to report reliably is not special-cased: its samples decide. An old extension drops its buffering flag after one report, which looks "ready" immediately; the prepare barrier then fails for it and the attempt is counted. Net effect on old clients: possible extra failed attempts, never a stuck loop (bounded). All testers should still be on the current extension.

## 4. Stuck-seek recovery ladder (problem B)

Runs in the extension, per player, automatically; today only Sync re-issues the seek and the reload advice appears after two failed re-issues.

Trigger: a pending seek is still incomplete after `LOCAL_SEEK_MAX_WAIT_MS` (1.5 s). The ladder does not look at `readyState` or the buffered ranges to start; the first step waits 6 s, and a player that is no longer seeking and has data (at the target, in a paused room) ends the recovery at the next look, so a slow but valid seek is left alone as long as it completes.

Timing origin: every wait is measured from the start of the seek that got stuck for the first step (6 s after it began, not 6 s after the 1.5 s timeout), and from the previous step for the next ones. The ladder looks once a second.

| Step | Action | When | Notes |
| --- | --- | --- | --- |
| 1 | Re-issue the seek to the room's current target (what Sync does, but automatic; in a playing room the target has advanced since the seek began) | 6 s after the seek began | counted even when the player offers nothing to write to |
| 2 | **Nudge**: seek to a buffered position at least a second from the target, then to the room's current position | 6 s after step 1 | tries every buffered range, nearest first; re-issues the seek when none is usable; effectiveness unknown (see 6) |
| 3 | Reload advice, as before | when step 2 has also failed | the room keeps the place; no data is lost |
| 3b | Automatic reload after a visible 20 s countdown that Sync cancels | 8 s after step 2 | at most once per tab in ten minutes; never without `sessionStorage` (decision 1) |

The re-issue, the nudge and each stage of the reload (countdown, cancelled, declined, sent) are reported to the diagnostics as `stuck_seek_step` events, so a later report shows how far the ladder got; the reload advice that precedes a countdown is shown on the page but is not an event of its own. When any step succeeds, the player reports prepared and problem A's resume (or the controller's Play) works as normal.

Coordinator side (not built): when every required player has reported the same unprepared seek target, a repeated Play press is futile; answer with a status line ("Players are still loading 6:35") instead of starting another doomed 3.3 s operation each time.

## 5. Diagnostics fixes (needed to learn anything from the next report)

1. Keep an **incident ring** separate from the rolling log: pin the first `operation_timeout_paused`, the first stall, and the last 10 *room position changes* with their cause (`control_seek`, `manual_sync`, `restore`, `drift`, `navigation`), so the report shows what moved the room, which this one does not.
2. Coalesce the repeating `room_snapshot` / `participant_status_changed` pairs (about 5 per 3.3 s cycle) so they do not evict the beginning of the incident.
3. Add `stuckSeek.step`, `readyState`, `seeking` and buffered ranges to the periodic sample (the report already has the last three).

## 6. Unknowns, to settle by experiment before building the ladder

- Whether H1 holds: reproduce a backward seek of several minutes outside the buffer through `currentTime` in a live Crunchyroll tab with and without the extension. A stuck tab, kept open, is the best test bed; run step 1 and step 2 by hand in its console and record which one frees it.
- Whether the "nudge" works on Crunchyroll's player at all; if neither step helps, only the reload does and step 3b becomes the real fix.
- What moved the room to 6:35 in this session (needs section 5.1).

## 7. Decisions taken

The owner delegated these ("use your best reasoning"); each is the recommendation made in the first version of this document.

1. **Automatic reload of a stuck tab: on, behind a visible 20 s countdown that Sync cancels, at most once per tab in ten minutes.** The cooldown is kept in the tab's `sessionStorage`; a tab whose storage is unavailable is never reloaded automatically (a reload that recurs would loop), and the page says to reload instead.
2. **A player that never becomes ready: the room waits for the two-minute window and stops.** There is no "continue without <name>".
3. **A member's own pause of a playing room: unchanged.** It is handled by the existing stall rules; changing who may pause the room is a separate decision that needs its own look at the unexpected-pause branch.
4. **Deploy: done on the owner's go, 2026-10-21,** from `main` at `2b96d13` (Worker `01829323-1eea-4153-90e9-869ec6e22c6b`; rollback target `b640977c-5e4b-4ee3-a923-f2e65e362df7`, then `b6ea9ac1-d4c1-4ab0-aa94-b324dd76ce7f`).

## 8. Test plan

Coordinator (`room.test.ts`, fake clock): arms on buffering and stall pauses only; does not arm on controller pause, seek, blocked, startup timeout, restore; disarms on any control message, controller change, media change, participant change; resumes only after everyone can play for the full stability window; one flapping sample does not resume; fails an attempt on a barrier timeout and abandons on the first never-prepared failure; backoff and 3-attempt and 2-minute caps; rejected autoplay abandons; a stale revision report does not extend the window; duplicate and same-timestamp reports; a restore leaves the room paused; a deliberate pause immediately after a system pause wins.

Extension (`content-script.test.ts`): ladder steps in order, reset on success, reload advice and countdown, the notice text; panel text for "still loading" instead of "ready".

Browser (e2e fixtures): a stall that recovers on its own resumes without a click and without a second pause; a wedged player never produces more than one failed Play and ends in the recovery notice; a user pause during the wait stays paused; the 20-run matrix on the final head.

## 9. What was built

- Diagnostics (section 5): events that began or answered an incident (`room_position_changed`, `stuck_seek_step`, controls, errors) are the last to be dropped, repeated `participant_status_changed` snapshots the first; the room position change is recorded when a snapshot moves it by more than 3 s beyond playback.
- Status text (section 1.4): a paused player that still reports waiting for data is shown as Buffering, not Ready (coordinator and extension).
- Ladder (section 4): re-issue at 6 s, nudge through a buffered point at 12 s, countdown 8 s later, reload 20 s after that; Sync cancels; the steps are reported to the diagnostics.
- Automatic resume (section 3): in the coordinator, armed by a buffering, no-progress or silent pause in a room that runs transactional operations; `canPlay` is a new optional field of the player sample, and an older extension is judged by `buffering` alone; the player page is told when the room resumes and when it gives up.
- Not built: the experiment of section 6 (needs a stuck tab kept open), the "Cancel" button for the controller (a controller's own Pause, Seek or any other control already cancels the wait), a panel line that names the player the room waits for.
