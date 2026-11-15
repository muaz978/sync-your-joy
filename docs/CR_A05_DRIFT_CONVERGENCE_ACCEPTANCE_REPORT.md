# CR-A05 drift convergence acceptance report (deterministic rows)

This is a filled copy of [the acceptance template](CR_A05_DRIFT_CONVERGENCE_ACCEPTANCE_REPORT_TEMPLATE.md) for issue [#52](https://github.com/muaz978/sync-your-joy/issues/52). It records unit-level evidence only: a fake video element that advances with a simulated clock, driven by Vitest fake timers. Nothing was loaded in a browser and nothing was observed on a provider page. A passing row below means the named test passed, not that any provider, account, device or deployment behaved.

Per the owner decision of 2026-10-31 on #52, the provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69, and the dependency on #50 is waived. The decisions that are not recorded are listed under "Not decided" and were not guessed.

## Change identity

| Field | Value |
| --- | --- |
| Issue | #52, CR-A05: Bound drift correction and prove convergence |
| PR | The pull request that adds this report (draft). It changes tests and documentation only; no production file is changed. |
| Commit under test | Base `8d8bf2a` (main, extension 0.2.12) plus that pull request. A file cannot name the commit that contains it; the head SHA of the pull request is the candidate. |
| Candidate package SHA-256 | No package was built or loaded, and production code is unchanged. |
| Repository version | 0.2.12 |
| Test date and timezone | 2026-11-15, UTC+03:00 |
| Tester or verification owner | Implementation agent for the owner, muaz978 |
| Operating system | macOS 27.2.1 (build 26B131), arm64 (Darwin 27.2.0) |
| Browser and version | None. Vitest 5.1.0 on Node. |
| Provider, account, device, deployment | None. |

## Acceptance gates

| Gate | Result | Evidence and exact reference |
| --- | --- | --- |
| Source review | Pass, author only | `content-script.ts` (`applyAuthoritativeState`, `tryApplySoftCorrection`, `requestBoundedPlaybackRecovery`, `trySetProgrammaticPosition`) and `clock.ts` were read at the base commit. No independent review. |
| Typecheck | Pass | `npm run typecheck`, clean. |
| Sync-engine unit tests | Pass | `npm test` includes `packages/sync-engine/src/clock.test.ts`; unchanged by this pull request. |
| Content-script integration tests | Pass, fake element | `apps/extension/src/content-script.test.ts`, the block "convergence of a player that keeps playing (CR-A05, #52)" (26 tests) in the "adaptive player lifecycle" suite. `npm test`: 51 files, 1,104 tests. The file alone, three runs in a row: 164 passed each. |
| 30-second delayed-seek simulation | Pass, advancing fake player | The matrix below: 15 combinations of rate behavior and seek delay, each run for 30 simulated seconds with a player that advances. |
| Controlled browser observation | Not run | |
| Live Crunchyroll/provider acceptance | Not run | |
| Two-profile or two-account acceptance | Not run | |
| Two-device acceptance | Not run | |
| Packaging and deployment | Not run | No package or deployment. `npm run build`: built. `npm audit --audit-level=high`: 0 vulnerabilities. |
| User acceptance | Not run | |

## What the advancing player changes

The 30-second runs of CR-A05 used a player whose position and frames did not move, so they could only show that the extension ends paused. The player used here advances with the clock at its playback rate (with frames), takes a configurable time to finish a seek the extension asked for, and can keep, ignore, reset at assignment, take back later, or throw on a rate assignment. The room keeps playing throughout.

## Deterministic evidence by template item

| Item | Result | Test |
| --- | --- | --- |
| 1. Soft rate rejects paused, buffering, seeking, pending and no-progress states | Pass (unchanged) | `clock.test.ts`. The buffering input is also a redundant guard at the content-script call site (see mutation results). |
| 2. A rate is accepted only if the observed value stays within tolerance | Pass (unchanged) | `clock.test.ts`; and "ignore", "reset" and "throw" rows below. |
| 3. No soft rate before real rendered progress | Pass | "does not start a soft correction for a player that shows no recent rendered progress, and corrects it hard once" against "does start a soft correction for the same drift once the player has shown recent rendered progress" (the same 0.3 s drift; one with no progress, one with). This replaces the earlier test of that name, which only compared 1 with 1.02 and never had a case without progress. |
| 4. Rate restored on buffering, native seek, pause and source change | Pass (unchanged) | The four existing "stops a soft rate correction ..." tests. |
| 5. Ignored, reset or throwing setter: at most one hard correction, then explicit recovery | Pass | The matrix: "a player that %ss the rate, with a %sms seek delay and a reset after %s ms, ends paused with one recovery entry and bounded writes". For each of accept, ignore, reset, accept-then-reset-after-500-ms and throw, at 800, 1,200 and 2,000 ms: paused, exactly one recovery notice, exactly one hard write, one soft attempt (the rate written `[1.02, 1]` for a player that kept it, `[1.02]` otherwise), and no further attempt over 30 s, not even inside the grace after the hard seek. Final drift is asserted per row (see the table below). |
| 6. 30-second runs at 800, 1,200 and 2,000 ms | Pass | The same matrix. No combination converges, because one soft rate of about 2 % for at most 2.5 s closes about 0.05 s and the hard seek lands a whole seek delay behind a room that did not wait (this confirms the source trace on #52). |
| Final drift per recovery row | Pass | Asserted in each matrix row (rounded to 0.1 s) and not left transient. A recovery row is, by design, not converged: the player is paused and the room kept playing. See "Final drift of the 15 matrix rows". |
| 7. A newer room command retires the older correction | Pass (unchanged) | "lets a newer room command retire the previous soft correction". |
| Reset after acceptance (not only a rejection at assignment) | Pass | "notices an accepted rate that the player then resets and corrects hard within two seconds, not at the expiry". |
| The 2.5 second expiry | Pass | "puts the rate back when the 2.5 second expiry fires, and does not apply another soft rate" (rate still 1.02 at 2.49 s, back to 1 at 2.52 s, no second soft write in 20 s). |
| A drift the soft rate can close does converge | Pass | "converges without a hard seek or a recovery entry when the player accepts the rate and is only 0.15 s behind, whatever the %sms seek delay": drift under 0.12 s, playing, no write, rate restored, no recovery entry. |
| Recovery entries counted | Pass | Every matrix row counts the notice "Playback could not converge" and expects exactly one. |
| What the room engine does with the player's reports | Pass (one end state only) | "is read by the room engine: a player that %ss the rate and is %s s behind leaves the room %s": the real `RoomCoordinator` receives the real `PLAYER_STATUS` messages. A player that ignores the rate at 0.3 s behind pauses the room; one that accepts it at 0.15 s behind leaves the room playing. |
| What the recovery reports to the room, and when | Pass (outgoing-message evidence) | "reports the recovery state to the room as buffering once the startup grace has passed, at most once per second". This observes the status messages the content script sends (recorded from its mocked `sendMessage`), not what the room does with them. The real `RoomCoordinator` is fed those messages only in the two tests of the row above, which assert the end state (room paused or still playing), not when the room paused. |

## Final drift of the 15 matrix rows

The room keeps playing for the whole 30 simulated seconds, so a player that ends paused is behind by what it missed. Asserted per row with `toBeCloseTo(..., 1)`; none is under 0.12 s, which is what separates the recovery end from the converged end.

| Rate behavior | Seek delay 800 ms | 1,200 ms | 2,000 ms |
| --- | --- | --- | --- |
| accepted (soft rate kept 2.5 s, then put back) | 27.50 s | 27.50 s | 27.01 s |
| accepted, then reset by the player after 500 ms | 29.00 s | 29.00 s | 28.01 s |
| ignored | 30.00 s | 30.00 s | 30.00 s |
| reset at assignment | 30.00 s | 30.00 s | 30.00 s |
| throws | 30.00 s | 30.00 s | 30.00 s |

## Mutation checks

A production line edited in place, the focused block run, the file restored with `git checkout`: 10 mutations, 7 killed. Killed: recovery that does not set its barrier, recovery with no notice, a hard correction never marked attempted, a throwing setter not marked attempted, an accepted-then-reset rate not noticed before the expiry, a soft rate that needs no recent progress, and the 0.2 s alignment tolerance. Survived: the expiry timer not restoring the rate, and the active correction not checking its own 2.5 s window (each is redundant with the other, since the timer re-evaluates and the evaluation restores an expired rate); and the soft-rate eligibility not checking `buffering` (the evaluation returns before it for a buffering player, so the check is redundant at that call site).

## Findings

1. **A hard correction for a drift of 0.12 to 0.2 s writes nothing and is spent.** `chooseDriftCorrection()` calls 0.12 s drift, but `trySetProgrammaticPosition()` treats a player within 0.2 s of its target as aligned and returns without a write. When the soft rate cannot close such a drift (it was refused, threw, was reset, or only closed part), the one hard correction is consumed with no write, the next heartbeat enters the recovery state, and the player is paused for everyone having never been moved. Pinned by "spends the one hard correction on no write when the drift is between 0.12 and 0.2 s, and then enters recovery (measured)". Not changed here: which tolerance should move is a policy decision, and `trySetProgrammaticPosition()` is shared by seeks. (The test helper also showed a boundary: a drift of exactly 0.2 s is a write or not depending on floating-point rounding, so cases here use 0.3 s or clearly under 0.2 s.)
2. **The recovery entry's own buffering report can say "not buffering".** When the recovery is entered inside the room's startup grace (here 0.8 s after the play command), the player-health model keeps the latch it had, so the report sent by `requestBoundedPlaybackRecovery()` carries `buffering: false`. The room hears "buffering" from the next heartbeat after the grace (about 5 s here), once per second. The room then paused in the cross-component test, but the reported state lags the local one. Pinned by the timeline test above.

## Not decided (no owner decision is recorded, so none was guessed)

- Whether a paused local recovery state satisfies "emit one recovery request" until a protocol recovery exists, or a follow-up issue is opened.
- Whether the hard seek gets a latency lead or the word "converge" is dropped from the criterion (the matrix shows no combination converges on the hard seek).
- Which tolerance changes for finding 1, and whether finding 2 is acceptable.
- Whether boxes 1 and 3 of the issue are ticked (met only at local class).

## Not done, and why

- Induced-drift test on the adaptive fixture with the real unpacked extension: `tests/e2e` and the fixture's delay values are outside this change (the list in `adaptive-fixture-server.ts` has no 800 or 1,200 ms value), and Chromium could not be run.
- A paused-player case in `clock.test.ts`: `clock.ts` is in `packages/sync-engine`, outside this change.
- The controlled Crunchyroll run, the two-account and two-device runs, release, deployment and acceptance: carried by #30, #33, #34, #35 and #69.

## Release and closure decision

This report does not authorize a release or a version change. #52 stays open: the provider, two-profile, two-device, deployment and user-acceptance gates are not run, and the two findings and the decisions above are open.
