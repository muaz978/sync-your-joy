# CR-D04 Two-Account Cross-Provider Acceptance Report

Issue: [#33](https://github.com/muaz978/sync-your-joy/issues/33)

This is a runbook and report template for the authorized live-provider acceptance gate. It is not a test result, release approval or substitute for two real authorized accounts and devices. Complete it only against an exact identified extension and coordinator candidate.

## Evidence boundary

This acceptance task records synchronization and visible-playback evidence without accessing or transporting protected media. Reports may contain sanitized build identities, browser versions, provider labels, episode or timed-edition labels, native media time, paused/seeking/ready state, aggregate progress evidence, visible-motion observations, error categories and timestamps.

Do not record or attach passwords, cookies, Playwright storage-state contents, signed media URLs, source URLs with tokens, license traffic, media bytes, provider HAR files, protected screenshots, video recordings or DRM information. A native time counter or aggregate progress counter advancing while the visible player is black, frozen or unchanged is a failure or an unresolved observation, not a pass.

## Run identity and prerequisites

Complete every field before beginning the matrix.

| Field | Value |
| --- | --- |
| Report ID | `CR-D04-YYYYMMDD-###` |
| Date and timezone |  |
| Operator |  |
| Candidate commit SHA |  |
| Extension artifact name and SHA-256 |  |
| Coordinator deployment identity |  |
| Room service endpoint label | Record a non-secret environment label only |
| Account A role and device label | Do not record account email or credentials |
| Account B role and device label | Do not record account email or credentials |
| Browser A and version | Edge or Chrome, exact version |
| Browser B and version | Edge or Chrome, exact version |
| Operating systems |  |
| Network profile | Normal, constrained or explicitly faulted |
| Other extensions | Fixed list or clean profile |
| Provider region or locale | Record only if needed to explain a result |
| Protected data handling confirmation | `Confirmed: no secrets or protected media attached` |

Required prerequisites:

- Two separate authorized provider accounts and two physical devices are available to the operator.
- Both accounts can access the same selected title, episode and timed edition.
- The exact candidate extension artifact and coordinator deployment identity are recorded.
- The baseline can be run with the extension disabled, while keeping browser, network, title, accounts and device conditions fixed.
- Edge and Chrome are installed at the versions recorded above.
- Any claimed provider or browser support outside Edge and Chrome is explicitly listed as not tested unless a separate acceptance run exists.
- The operator can observe visible motion on both devices. Native time alone is insufficient.

## Matrix design

Run the baseline and candidate with the same conditions. Repeat the candidate with controller roles swapped. A retry is a new run and must remain in the report.

### Browser and role combinations

| Combination | Controller | Guest | Baseline | Candidate | Candidate with roles swapped |
| --- | --- | --- | --- | --- | --- |
| Edge to Edge | Edge device A | Edge device B |  |  |  |
| Chrome to Chrome | Chrome device A | Chrome device B |  |  |  |
| Edge to Chrome | Edge device A | Chrome device B |  |  |  |
| Chrome to Edge | Chrome device A | Edge device B |  |  |  |

Record a combination as not run when the required browser, device or account is unavailable. Do not convert it to a pass.

### Provider and edition coverage

| Provider or page type | Episode or timed-edition label | Same edition confirmed | Baseline result | Candidate result | Report ID or notes |
| --- | --- | --- | --- | --- | --- |
| Crunchyroll | Episode or edition 1 |  |  |  |  |
| Crunchyroll | Episode or edition 2 |  |  |  |  |
| Crunchyroll | Episode or edition 3 |  |  |  |  |
| YouTube | Selected video |  |  |  |  |
| Generic HTML5 fixture | Fixture identity | N/A |  |  |  |
| Nested or embedded player | Page type and provider label |  |  |  |  |

Do not merge dubbed, subbed, audio or timed editions because their labels look similar. Record a different edition explicitly and treat an identity mismatch as a failure or a required readiness block.

## Scenario procedure

For every browser and role combination, complete the extension-disabled baseline first, then install or enable the exact candidate without changing the surrounding conditions.

1. Create the room with account A and join with account B.
2. Confirm the intended player and edition on both devices before readiness.
3. Record the initial native time, paused/seeking state, ready state and visible-motion observation on both devices.
4. Mark both participants ready only after the native player is controllable on each device.
5. Run initial play, pause and resume. Confirm visible motion on both devices, not only a changing room label.
6. Run a cold forward seek and a cold backward seek while paused, then a warm forward seek and a warm backward seek during playback.
7. Run Skip Intro or an equivalent native discontinuity when the selected title exposes it.
8. Run rapid repeated scrubs and record the final controller target and every unsafe resume or stale-target result.
9. Pause during a pending play or seek and verify that no late completion resumes the room unexpectedly.
10. Change audio or source when the provider exposes the control. Confirm that the new edition is independently prepared and readiness is not carried across an unverified identity.
11. Run native Next Episode and the extension's explicit shared-link episode transition separately. Confirm old controls and samples do not affect the new episode.
12. Repeat the core actions after hiding and showing the player, backgrounding the tab and reconnecting where the environment permits.
13. Repeat with controller and guest roles swapped.
14. For each browser/controller combination, execute at least 30 normal-condition seek or intro actions. Count every action, including failures and retries.

## Per-action evidence record

Use one row per action. Add rows rather than replacing failed attempts.

| # | Provider and edition | Browser/controller | Action | Cold or warm | Native time A before/after | Native time B before/after | Aggregate progress A/B | Visible motion A/B | Converged | Unsafe resume | Result | Error category or notes |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  |  |  |  |  |  |  |  |  |
| 2 |  |  |  |  |  |  |  |  |  |  |  |  |
| 3 |  |  |  |  |  |  |  |  |  |  |  |  |

Use these result values consistently:

- `PASS`: both native timelines reached the intended result, both visible players progressed where play was expected, convergence was observed within the declared tolerance, and no unsafe resume or stale command occurred.
- `FAIL`: a required behavior did not occur, an unsafe resume occurred, an old target or old episode affected the result, or visible playback was black/frozen while counters advanced.
- `BLOCKED`: the required account, device, browser, deployment, title or permission was unavailable. A blocked row is not a pass.
- `UNRESOLVED`: evidence was insufficient or contradictory and requires another controlled run.

Keep three evidence columns separate:

1. Native state: `currentTime`, `paused`, `seeking`, `readyState`, duration and any relevant native error category.
2. Aggregate progress: frame or clock evidence reported by the extension, with its quality label such as `frames`, `clock` or `unknown`.
3. Human visible motion: moving frames, frozen output, black loader, buffering or another directly observed display state.

## Summary and acceptance calculation

Complete the calculation independently for each browser/controller combination. Do not combine baseline, candidate and role-swapped rows into one denominator.

| Browser/controller combination | Normal-condition action count | PASS count | FAIL count | BLOCKED/UNRESOLVED count | Success rate | Unsafe resumes | Accepted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Edge to Edge |  |  |  |  |  |  |  |
| Chrome to Chrome |  |  |  |  |  |  |  |
| Edge to Chrome |  |  |  |  |  |  |  |
| Chrome to Edge |  |  |  |  |  |  |  |

The provisional normal-condition target is at least 95% successful actions for every claimed browser/controller combination, with zero unsafe resumes. This target does not waive a required scenario failure, visible frozen output, identity mismatch, stale command, lost pause or unbounded automatic retry.

## Sanitized failure record

For every failed or unresolved action, record:

- report ID, action number, candidate SHA and browser/device labels;
- provider label, episode or timed-edition label and scenario;
- last known native state and sanitized diagnostic report identity;
- whether native time, aggregate progress and visible motion agreed or diverged;
- exact user-visible error category or UI state, if any;
- whether the room paused safely and whether a manual recovery was required;
- whether the same action was repeated, with the new action number;
- a precise next experiment.

Do not assign a DRM, network, autoplay or provider cause unless the observable evidence supports that category. A black or frozen output with advancing time should be recorded as a visible-output failure or unresolved player observation, not explained away by the counter.

## Completion gate

The issue remains open unless every applicable item is checked with attached sanitized evidence.

- [ ] Extension-disabled baselines completed for Edge and Chrome.
- [ ] Candidate run completed against the exact recorded build and deployment.
- [ ] Roles swapped and repeated.
- [ ] At least three episodes or timed editions tested where available.
- [ ] Cold and warm forward/backward seeks tested.
- [ ] Skip Intro or equivalent native discontinuity tested.
- [ ] Audio/source change tested where available.
- [ ] Native Next Episode and explicit shared-link transition tested separately.
- [ ] YouTube and generic/nested-player usability confirmed or explicitly marked not claimed.
- [ ] At least 30 seek/intro actions completed per claimed browser/controller combination.
- [ ] Native state, aggregate progress and visible motion recorded separately.
- [ ] No unsafe resumes, stale commands, old-episode writes or unbounded retries observed.
- [ ] Every failure has a sanitized report and a follow-up decision.
- [ ] Normal-condition success is at least 95% for every claimed combination.
- [ ] Deployment identity and user acceptance are recorded.

## Final decision

| Decision | Select one | Evidence |
| --- | --- | --- |
| Accepted for the tested matrix |  |  |
| Partially accepted, specific limitations remain |  |  |
| Blocked by missing account, device, deployment or title |  |  |
| Failed and requires implementation work |  |  |

Operator signature or issue comment:

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files or protected screenshots.
I have distinguished native time, aggregate progress and visible motion, and I have
not treated an advancing counter as proof of visible playback.
```
