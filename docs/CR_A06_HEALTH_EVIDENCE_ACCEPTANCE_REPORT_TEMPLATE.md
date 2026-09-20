# CR-A06 health evidence acceptance report

Use this report for issue [#53](https://github.com/muaz978/sync-your-joy/issues/53) and for every PR that claims to implement or verify CR-A06. This is an evidence record, not a release approval by itself.

CR-A06 is successful only when periodic player reports, context refreshes and diagnostics read the same local health snapshot, when progress evidence identifies its source, and when lifecycle boundaries do not convert missing or reset counters into false progress. A changing media counter or media clock is not proof that visible video output is healthy.

## Change identity

| Field | Value |
| --- | --- |
| Issue | #53, CR-A06: Make health evidence stable and consistent |
| PR |  |
| Commit under test |  |
| Candidate package SHA-256 |  |
| Repository version |  |
| Test date and timezone |  |
| Tester or verification owner |  |
| Browser and version |  |
| Operating system |  |
| Provider and title |  |
| Account/profile arrangement |  |
| Deployment or local endpoint |  |

Do not record passwords, cookies, storage state, account names, signed media URLs, DRM data or protected media bytes. Use dedicated authorized test profiles for any isolated authenticated run. The user’s already signed-in daily browser can support a controlled headed observation, but its cookies must not be copied into Playwright storage state.

## Evidence vocabulary

The health snapshot reports one explicit `progressEvidence` value:

| Value | Meaning | What it does not prove |
| --- | --- | --- |
| `frames` | A valid, non-decreasing presented-frame counter was available and advanced for the observation. | It does not prove that the final display was free of black pixels, stale composition or provider-specific visual failure. |
| `clock` | Frame counters were absent, unavailable, hidden, throwing or otherwise unusable, so a bounded media-clock observation was used. | It does not prove that the browser rendered a new visible frame. |
| `unknown` | The observation was paused, seeking, locally seeking, before startup grace, or affected by a counter reset. | It is not a health pass and must not be upgraded by inference. |

The snapshot also retains buffering and playback-start failure signals, plus whether any real progress has ever been observed for the current source and command. Context refresh must reuse these values. A source change or new playback command resets the source-specific baseline. Visibility restoration only rebases observation cursors and must not erase a known failure before a fresh observation replaces it.

## Acceptance gates

Mark each gate `Pass`, `Fail`, `Blocked` or `Not run`. Include the command, artifact, log, screenshot or observation that supports the result.

| Gate | Result | Evidence and exact reference |
| --- | --- | --- |
| Source review |  |  |
| Protocol validation |  |  |
| Player-health unit tests |  |  |
| Content-script integration tests |  |  |
| Service-worker diagnostics tests |  |  |
| Typecheck |  |  |
| Full test and build |  |  |
| Controlled browser observation |  |  |
| Live Crunchyroll/provider acceptance |  |  |
| Two-profile or two-account acceptance |  |  |
| Two-device acceptance |  |  |
| Packaging and deployment |  |  |
| User acceptance |  |  |

`Pass` means the named evidence was actually run. A missing account, missing device, missing deployment, unavailable browser, or provider failure is `Blocked` or `Not run`, never an inferred pass. The availability of one signed-in account does not satisfy two-account, two-device, deployment or user-acceptance gates.

## Deterministic source and test evidence

Run from the repository root:

```sh
npx vitest run apps/extension/src/player-health.test.ts packages/protocol/src/index.test.ts apps/extension/src/content-script.test.ts
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
git diff --check
```

The CR-A06-specific evidence must cover all of the following:

1. The pure health model uses `clock` evidence when frame counters are absent or a browser API throws, and it never treats a missing counter as a rendered-frame pass.
2. A zero frame counter is a valid baseline. It must not be treated as absent, and progress is reported only after the counter advances.
3. A decreasing or reset frame counter is `unknown` for that observation and cannot be counted as progress.
4. Native seeks, local seeks and pending seeks do not produce progress evidence or clear a known failure by themselves.
5. A stalled playing player becomes buffering after the bounded no-progress interval, while a player still inside startup grace is not falsely marked stalled.
6. A temporary hidden or background rendering state uses clock evidence when appropriate. Returning to visible rendering rebases the counter baseline, then accepts frame evidence only from a subsequent counter observation.
7. A hidden iframe and a Picture-in-Picture player remain state-only observations. Their evidence quality is recorded, but neither context proves visible final output.
8. A context refresh returns the shared buffering, progress-evidence and playback-start-failure state instead of reconstructing `buffering: false` and `progressed: false` from the native element alone.
9. A source replacement or new room playback command clears source-specific health state and counters. The new source cannot inherit a previous player’s progress or failure claim.
10. Diagnostics and the side panel expose the same evidence quality and health signal that status reporting uses.
11. The protocol accepts only `frames`, `clock` or `unknown` for progress evidence and rejects malformed values.

The deterministic suite proves source behavior and synthetic timing only. It does not prove accepted Crunchyroll playback, final visible output, cross-profile synchronization, device behavior, deployment behavior or user acceptance.

## Controlled browser observation

Record the exact candidate package and browser before beginning. Use an ordinary visible video page and the extension’s state-only integration. Do not inspect or record protected media bytes or private provider APIs.

For each observation:

1. Start with the extension disabled and record the provider’s normal play, pause, seek, buffering and visible-motion behavior.
2. Enable the exact candidate package and open the same approved page in the controlled browser session.
3. Record the room revision, participant role, media identity, current position, native `paused`, `seeking`, buffering indication, `progressEvidence`, and whether visible frames continue to move.
4. Exercise a healthy visible player and confirm that `frames` evidence appears only after the presented-frame counter advances.
5. Hide or background the page, then return it to the foreground. Confirm that the extension does not call the hidden period visible-frame proof, that the baseline is rebased on restoration, and that a later frame-counter advance is reported separately.
6. Exercise a nested player or hidden iframe and, if the browser supports it, Picture-in-Picture. Record the actual document visibility and evidence quality. Do not mark visible-output acceptance from counters alone.
7. Trigger waiting or stalled playback and then request a context refresh or diagnostics report before recovery. Confirm that the known buffering state remains present in both the context and the report.
8. Trigger a browser-rejected synchronized play request, then request context and diagnostics without starting a new source. Confirm that the permission failure remains explicit until a successful start, command reset or source change clears it.
9. Replace the media source or navigate to a new episode. Confirm that prior progress, buffering and permission-failure state does not leak into the new source.
10. Repeat enough times to cover cold and warm player state, a provider lifecycle event, a hidden period, a seek and a source transition. Record failures exactly, including whether they were provider, browser, network, device or extension behavior.

Visible video output, not an advancing `currentTime` value or counter alone, is required for a live or controlled-browser pass. If the provider rejects playback, never produces visible frames, or requires a missing second profile or device, record the precise blocked gate and retain the issue open.

## Diagnostics and privacy review

The implementation may expose only minimal playback health metadata:

- buffering state;
- progress evidence quality;
- whether real progress has been observed;
- whether synchronized playback was rejected by browser policy;
- native player state already used by the extension.

It must not add cookies, passwords, account identifiers, storage-state contents, media bytes, audio, screenshots, signed URLs, DRM data or private provider API calls. `progressEvidence: frames` is an evidence classification, not a claim that the user’s display is correct.

## Result and closure decision

### What passed

-

### What failed or remained blocked

-

### Evidence-quality observations

-

### Recovery and reset observations

-

### Release impact

CR-A06 alone does not authorize a release bump. Keep the repository version unchanged unless this change is part of a separately documented, coherent verified release group. The milestone-end release remains `1.0.0` only after all milestone gates and release checks are complete.

### Issue decision

- `Close only when`: every applicable acceptance gate is `Pass`, the controlled or live-provider evidence is attached where required, no known bug or unexplained gap remains, and the issue’s project state and comments record the evidence.
- `Keep open in Verification when`: deterministic implementation is merged but provider, browser, device, deployment or user-acceptance evidence remains.
- `Keep open in Blocked when`: a concrete external dependency prevents the next required gate. Record the dependency precisely, distinguishing missing account, missing profile, missing device, missing deployment, provider outage, review or product decision.
