# Two-Device Network-Chaos and Reconnect Report

Issue: [#34](https://github.com/muaz978/sync-your-joy/issues/34)

This template records the real-device acceptance gate for network throttling, offline/online transitions, sleep/wake and reconnect recovery. The repository's deterministic protocol tests are useful supporting evidence, but they do not replace this report because they do not exercise a real operating-system network stack, browser suspension or physical device lifecycle.

This is a runbook, not a result or release approval. Use it only with authorized test accounts and devices against an exact identified candidate.

## Evidence and privacy boundary

Record only sanitized synchronization evidence: candidate identities, browser and operating-system versions, device labels, network profile labels, room revision, connection state, controller/lease state, readiness, native media state, bounded position and drift, visible playback observation, error category and timestamps.

Do not record passwords, cookies, storage-state files, signed URLs, source URLs with tokens, media bytes, provider HAR files, screen recordings, protected screenshots or DRM information. A reconnect is not successful merely because a WebSocket reports connected. Confirm the native player, visible motion, room revision and participant state after recovery.

## Run identity and prerequisites

| Field | Value |
| --- | --- |
| Report ID | `SYJ-CHAOS-YYYYMMDD-###` |
| Date and timezone |  |
| Operator |  |
| Candidate commit SHA |  |
| Extension artifact and SHA-256 |  |
| Coordinator deployment identity |  |
| Room endpoint label | Non-secret environment label only |
| Device A label and operating system |  |
| Device B label and operating system |  |
| Browser A and version |  |
| Browser B and version |  |
| Selected fixture or provider label |  |
| Account/role labels | Do not record account identifiers |
| Other extensions and network controls |  |
| Protected data handling confirmation | `Confirmed: no secrets or protected media attached` |

Required prerequisites:

- Two physical devices with independently observable native playback are available.
- The exact extension artifact and coordinator deployment identity are recorded.
- Both devices can run the selected local fixture or authorized provider page before faults are introduced.
- A controlled network throttle or offline action can be applied to one device without changing the candidate.
- Sleep/wake can be performed on at least one device, or the limitation is recorded as blocked.
- The operator can inspect the visible player after recovery. Room labels and counters alone are not sufficient.

## Baseline

Run at least one no-fault session before each fault family with the same candidate, devices, browsers, room setup and selected media.

| Baseline check | Device A | Device B | Result | Notes |
| --- | --- | --- | --- | --- |
| Room created and joined |  |  |  |  |
| Intended player bound |  |  |  |  |
| Both participants ready |  |  |  |  |
| Native play and pause |  |  |  |  |
| Visible motion on both devices |  |  |  |  |
| Position/drift within declared tolerance |  |  |  |  |
| Native forward/backward seek |  |  |  |  |
| Reconnect not yet exercised |  |  |  |  |

If the baseline fails, stop the fault run, preserve the sanitized evidence and classify the fault scenario as blocked by the baseline rather than attributing it to network chaos.

## Fault matrix

Run each applicable scenario with the controller and guest roles swapped. Record a new row for every attempt, including failed attempts and retries.

| # | Fault scenario | Device affected | Fault duration/profile | Controller role | Baseline result | Candidate recovery result | Status |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 | Network throttle or latency/jitter |  |  |  |  |  |  |
| 2 | Offline during active room |  |  |  |  |  |  |
| 3 | Offline during pending seek or play |  |  |  |  |  |  |
| 4 | Online/reconnect after offline period |  |  |  |  |  |  |
| 5 | Laptop sleep and wake |  |  |  |  |  |  |
| 6 | Browser tab background and return |  |  |  |  |  |  |
| 7 | Tab refresh and normal reconnect |  |  |  |  |  |  |
| 8 | Controller device disconnect and return |  |  |  |  |  |  |

Use the exact fault duration and network profile in the report. Do not label a run “offline” when the device was only delayed, and do not label a run “sleep/wake” when the browser tab remained active throughout.

## Recovery evidence record

| # | Time | Device/role | Room revision before/after | Connection state | Controller/lease | Readiness | Native paused/seeking/ready | Native time | Aggregate progress | Visible motion | Drift | Safe pause or resume | Result | Error category/notes |
| ---: | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | ---: | --- | --- | --- |
| 1 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

Record these phases for each scenario:

1. Stable pre-fault state.
2. Fault introduced and the first observed connection/player change.
3. During the fault, including whether the room pauses safely or incorrectly continues.
4. Network/device recovery action.
5. Reconnection and snapshot restoration.
6. Native player recovery, visible motion and final participant state.

Keep these evidence classes separate:

- Connection: connected, reconnecting or disconnected, plus timestamps.
- Room state: revision, controller/lease identity, readiness and authoritative position.
- Native player: paused, seeking, ready state, current time and visible player identity.
- Aggregate progress: frame or clock evidence with its quality label.
- Human observation: visible motion, frozen output, black loader, buffering or other directly observed display state.

## Recovery acceptance rules

Mark a scenario `PASS` only when all applicable rules are satisfied:

- the room does not silently continue as if the missing participant were healthy;
- a pending operation is either completed with matching evidence or ends in a safe, visible recovery state;
- reconnect restores the correct participant identity and does not allow a stale participant or stale command to overwrite the room;
- the room revision and controller/lease state are coherent after recovery;
- readiness is retained only when the same participant and matching media genuinely return, and is revoked when media or identity changed;
- the native player reaches the authoritative position and shows visible progress when playback should be active;
- no unsafe resume, old-media write, lost pause, duplicate command or unbounded retry occurs;
- sleep/wake, tab backgrounding and network recovery are reported separately rather than merged into one explanation.

Use the following outcomes:

- `PASS`: all required recovery observations are directly verified.
- `FAIL`: a required rule is violated, including counter progress with frozen or black visible output.
- `BLOCKED`: a required physical device, fault control, deployment, browser or baseline is unavailable.
- `UNRESOLVED`: evidence conflicts or is insufficient and requires a controlled repeat.

## Sanitized failure record

For each `FAIL` or `UNRESOLVED` row, record:

- report ID, attempt number, candidate SHA and device/browser labels;
- exact fault action and duration/profile;
- last coherent room revision and participant/lease state;
- native state, aggregate evidence quality and visible observation;
- whether the room paused safely and whether manual recovery was needed;
- the exact user-visible error category, if any;
- whether the run was repeated, with a new attempt number;
- the next experiment or implementation issue required.

Do not guess that a failure is DRM, network, autoplay or provider-specific without evidence. A black or frozen display with advancing time is a visible-output failure or unresolved player observation.

## Completion checklist

The issue remains open unless the applicable gates are verified with sanitized evidence.

- [ ] No-fault baseline passes on both devices.
- [ ] Network throttling or latency/jitter run completed.
- [ ] Offline/online transition completed mid-room.
- [ ] Offline/online transition completed during a pending play or seek where applicable.
- [ ] Sleep/wake completed, or the limitation is explicitly recorded as blocked.
- [ ] Browser background/return and tab refresh reconnect tested.
- [ ] Controller and guest roles swapped.
- [ ] Room revision, participant state and controller/lease state verified after recovery.
- [ ] Native time, aggregate progress and visible motion verified separately.
- [ ] Safe pause/resume behavior verified.
- [ ] No stale command, old-media write, readiness resurrection, lost pause or unbounded retry observed.
- [ ] Every failed or unresolved attempt has sanitized evidence and a follow-up decision.
- [ ] Candidate build and coordinator deployment identity recorded.
- [ ] User acceptance recorded for the tested device/browser matrix.

## Final decision

| Decision | Select one | Evidence |
| --- | --- | --- |
| Accepted for the tested two-device matrix |  |  |
| Partially accepted with explicit limitations |  |  |
| Blocked by missing device, deployment or fault control |  |  |
| Failed and requires implementation work |  |  |

Operator confirmation:

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files, protected screenshots or
screen recordings. I separately verified room state, native player state, aggregate
progress and visible motion after each recovery event.
```
