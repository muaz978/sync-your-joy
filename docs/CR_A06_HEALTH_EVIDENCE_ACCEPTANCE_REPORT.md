# CR-A06 health evidence acceptance report (deterministic rows)

This is a filled copy of [the acceptance template](CR_A06_HEALTH_EVIDENCE_ACCEPTANCE_REPORT_TEMPLATE.md) for issue [#53](https://github.com/muaz978/sync-your-joy/issues/53). It records unit-level evidence only: a fake video element driven by Vitest fake timers. Nothing was loaded in a browser and nothing was observed on a provider page. Every row that needs a headed browser, a provider session, a second account, a second device or a deployment is `Not run`. It is not a release approval and does not close the issue.

Per the owner decision of 2026-10-31 on #53, the provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69. #50 and #51 do not gate acceptance of this card.

## Change identity

| Field | Value |
| --- | --- |
| Issue | #53, CR-A06: Make health evidence stable and consistent |
| PR | The pull request that adds this file |
| Commit under test | Base `257afb6` (main, extension 0.2.12) plus that pull request. A file cannot name the commit that contains it; the head SHA of the pull request is the candidate. |
| Candidate package SHA-256 | No package was built or loaded. For the bundle only: `npm run build` at the code commit gives `apps/extension/dist/content-script.js` SHA-256 `f1b5d200c66fdc0848eb66c646467253bf2efa3bf43c3fee3bbf23972f4ce5a8` (the documentation commit does not change it). This is the hash of one built file, not a release archive. |
| Repository version | 0.2.12 |
| Test date and timezone | 2026-11-15, UTC+03:00 |
| Tester or verification owner | Implementation agent for the owner, muaz978 |
| Browser and version | None. Vitest 5.1.0 on Node. |
| Operating system | macOS (Darwin), the development machine |
| Provider and title | None |
| Account/profile arrangement | None |
| Deployment or local endpoint | None |

No credential, cookie, storage state, signed URL or media byte appears in this report.

## Acceptance gates

| Gate | Result | Evidence and exact reference |
| --- | --- | --- |
| Source review | Pass, author only | The content script, `player-health.ts` and `playback-status.ts` were read at the base commit and after the change. No independent review. |
| Protocol validation | Pass | `npx vitest run packages/protocol` (no protocol change in this pull request). |
| Player-health unit tests | Pass | `apps/extension/src/player-health.test.ts`, including the new "rendered-frame evidence" and "progress that media events report between periodic samples" blocks. |
| Content-script integration tests | Pass, fake element | `apps/extension/src/content-script.test.ts`, the block "player health evidence in the content script (CR-A06, #53)". |
| Service-worker diagnostics tests | Pass | `apps/extension/src/service-worker.test.ts` runs in `npm test`. |
| Typecheck | Pass | `npm run typecheck`, clean. |
| Full test and build | Pass | `npm test`: 51 files, 1,143 tests at the head of this branch (the stacked CR-B03 tests are not in this count). `npm run build`: built. |
| Controlled browser observation | Not run | |
| Live Crunchyroll/provider acceptance | Not run | |
| Two-profile or two-account acceptance | Not run | |
| Two-device acceptance | Not run | |
| Packaging and deployment | Not run | No package or deployment. `npm audit --audit-level=high`: 0 vulnerabilities. |
| User acceptance | Not run | |

## Deterministic evidence by template item

| Item | Result | Test |
| --- | --- | --- |
| 1. Clock evidence when counters are absent or throw | Pass | `player-health.test.ts` "uses explicit clock evidence..."; content script: "when it throws, ..." and "when it is missing, ..." and "reports a count that is not a number" |
| 2. Zero is a valid baseline | Pass | `player-health.test.ts` "accepts zero as a real frame counter baseline..." |
| 3. A decreasing counter is `unknown` | Pass | "does not treat a reset frame counter as progress" |
| 4. Seeks give no progress evidence | Pass | "excludes native and local seeks from progress evidence" |
| 5. Stalls and startup grace | Pass | "reports a stalled playing state after the bounded no-progress interval"; "reports a freeze when the callbacks stop but the media clock keeps running" |
| 6. Hidden then visible | Pass, with a defect fixed | "falls back to the media clock while the page is hidden ..." and "counts frames again, from a rebased baseline, once the page is visible". See below. |
| 7. Hidden iframe and Picture-in-Picture | Not claimed | No dedicated visible-output handling or coverage. The general frame-counter handling and an origin-only iframe identity test exist; a CSS-hidden iframe can still report a visible document. |
| 8. Context refresh reuses the shared state | Pass | "keeps a known buffering signal when the worker refreshes player context" and the permission-failure twin (existing) |
| 9. Source replacement clears; a command keeps a start failure | Pass | "does not inherit the old source's progress, evidence or buffering"; "autoplay permission rejection (#68)" (existing) |
| 10. Diagnostics and panel expose the same signal | Pass for diagnostics, panel not covered | The diagnostics `health` block is asserted next to the sample. The side panel is outside this change. |
| 11. Protocol accepts only the three values | Pass | `packages/protocol/src/index.test.ts` (existing) |
| 12. Callback counter, visibility order, missing API | Pass | "is used when the browser has it...", "uses the playback-quality counter when the browser has no frame-callback API", "starts counting again, and stops asking the old element for frames, when the element is replaced"; "moves the baseline when the counter changes from the playback-quality count to the first callbacks, so the switch is neither a reset nor a freeze" |
| 13. Throwing, missing or non-numeric quality counter and its recovery | Pass | the `it.each` pair under "the playback-quality counter" |
| 14. Frames required for "Playing, confirmed" and the started acknowledgement | Pass | "what confirms that a player is playing" and "the started acknowledgement of a transactional play" |
| 15. Event reports between periodic samples | Pass | "reports that fall between two periodic samples" |
| 16. Waiting latch cleared only by new progress | Pass | "a stall after progress that an event report already saw" (pure and content script), "clearing a waiting latch with and without a frame counter" |
| 17. A verdict takes the evidence of the comparison that made it | Pass | "the evidence quality of a carried verdict", "the evidence a verdict claims comes from the comparison that made it" (named sequences and the seeded random sequence test), "progress that only the periodic cursor can see" |

## Defects found at unit level

1. A hidden tab could read as frozen. `presentedFrameCount()` returned the frame-callback count before it looked at the document's visibility. In a hidden tab the media clock runs and no callback fires, so the count stopped; `player-health.ts` then reported buffering 2.5 s after the last progress, and the coordinator could pause the room. The visibility check now comes first. This was suspected by reading on 2026-10-16 and is reproduced at unit level only; whether a real hidden tab behaves so is not observed. The mutation that restores the old order fails two tests.
2. A report that fell between two frames said "no progress". `progressed` was judged against the previous report of any kind, so an event report (play, canplay, seeked...) straight after the periodic sample read `false`, and a periodic sample after an event that had seen progress read `false` as well. Event reports now measure from the last periodic sample, leave its cursor alone and carry a fresh periodic verdict (at most 1.5 s old). `lastProgressPositionSeconds` and `lastProgressFrames` were written and never read; they are removed.
3. A stall after progress that an event report had already seen lost its waiting latch. With the periodic cursor left in place by event reports, a delayed buffering report (and the next periodic sample) compared the same frames with the old cursor, read them as new progress and cleared `buffering`, so the coordinator's 1.8 s no-progress watchdog could pause the room instead of honouring the buffering grace. Only new progress compared with the latest observation of any kind now clears the latch (a new frame while a counter is available; the media clock only when there is no counter at all, and then it is not rendered-frame evidence); progress since the last periodic sample is still reported, unless the player has stalled. Found in review; reproduced first by a failing test (24 → 26 → stall → buffering report must not clear), at unit level only.
4. Clock progress could be labelled `frames`. A counter that went missing between two reports and came back (periodic frames 10, event with no counter, event frames 10) reported clock progress with the `frames` label, so the pill showed "Playing, confirmed" with no frame advance. The observation core is now one model: a fresh comparison (against the latest observation) and an accumulated one (against the last periodic sample), each with its own evidence quality, and a verdict takes the quality of the comparison that made it. Found in review and reproduced first by the named sequence; a seeded random sequence test (3,000 sequences) finds the same bug on the old code and passes on the new.
5. Clock-only progress showed "Playing, confirmed" and passed the started-acknowledgement gate. Per the owner decision of 2026-10-31 it no longer does.

## Not covered, and what the content script does not own

- The coordinator derives the participant status "playing" from `sample.progressed` alone (`packages/sync-engine/src/participant-status.ts`), and the side panel prefers that status and calls `localPlaybackStatus` without `progressEvidence` (`sidepanel.ts`). Both still call a clock-only player "Playing, confirmed". Closing that needs the coordinator to read `sample.progressEvidence` and the panel to pass it; both are outside the files of this change.
- A player with no frame counter, or in a hidden tab, now never sends the started acknowledgement of a transactional play, so the coordinator ends that start at its deadline. That is the owner's decision as written; the consequence for such a player is not evaluated here.
- Hidden iframe and Picture-in-Picture handling, which needs a headed run to decide.
- Every browser, provider, account, device, deployment and acceptance row.

## Decision and release boundary

CR-A06 alone does not authorize a release. #53 remains open. No tag, release or deployment is made or implied.
