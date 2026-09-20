# CR-A05 drift convergence acceptance report

Use this report for issue [#52](https://github.com/muaz978/sync-your-joy/issues/52) and for every PR that claims to implement or verify CR-A05. The report is an evidence record, not a release approval by itself.

CR-A05 is successful only when the player uses a temporary playback-rate correction under healthy, observed progress, stops that correction when the player enters a lifecycle or operation boundary, and reaches either a bounded converged state or an explicit local recovery state. A changing media counter is not proof that visible video is healthy.

## Change identity

| Field | Value |
| --- | --- |
| Issue | #52, CR-A05: Bound drift correction and prove convergence |
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

## Acceptance gates

Mark each gate `Pass`, `Fail`, `Blocked` or `Not run`. Include the command, artifact, log, screenshot or observation that supports the result.

| Gate | Result | Evidence and exact reference |
| --- | --- | --- |
| Source review |  |  |
| Typecheck |  |  |
| Sync-engine unit tests |  |  |
| Content-script integration tests |  |  |
| 30-second delayed-seek simulation |  |  |
| Controlled browser observation |  |  |
| Live Crunchyroll/provider acceptance |  |  |
| Two-profile or two-account acceptance |  |  |
| Two-device acceptance |  |  |
| Packaging and deployment |  |  |
| User acceptance |  |  |

`Pass` means that the named evidence was actually run. A missing account, missing device, missing deployment, unavailable browser, or provider failure is `Blocked` or `Not run`, never an inferred pass. The availability of one signed-in account does not satisfy two-account, two-device, deployment or user-acceptance gates.

## Deterministic source and test evidence

Run from the repository root:

```sh
npm run typecheck
npx vitest run packages/sync-engine/src/clock.test.ts apps/extension/src/content-script.test.ts
npm test
npm run build
npm audit --audit-level=high
git diff --check
```

The CR-A05-specific evidence must cover all of the following:

1. `canApplySoftDriftCorrection` rejects paused, buffering, seeking, pending-operation and no-recent-progress states.
2. A finite playback-rate assignment is accepted only when the observed value remains within the documented tolerance.
3. The content script does not apply a soft rate before real rendered-progress evidence exists.
4. A supported soft rate is restored immediately on buffering, native seeking, pause and media-source lifecycle changes.
5. An ignored, reset or throwing rate setter falls back to at most one hard correction. A second failed convergence does not restart a moving-target seek loop; it pauses and reports explicit recovery.
6. The delayed-seek simulations run for 30 seconds at 800 ms, 1,200 ms and 2,000 ms delays. They record native write count, pause/recovery state and buffering evidence.
7. A newer room command retires the older correction budget and its temporary rate, so the newer target wins.

The deterministic suite proves source behavior and synthetic timing only. It does not prove accepted Crunchyroll playback-rate behavior, visible motion, cross-profile synchronization, device behavior, deployment behavior or user acceptance.

## Controlled browser observation

Record the exact candidate package and browser before beginning. Use an ordinary visible video page and the extension’s state-only integration. Do not inspect or record protected media bytes or private provider APIs.

For each observation:

1. Start with the extension disabled and record the provider’s normal play, pause, seek and visible-motion behavior.
2. Enable the exact candidate package and join a room using the approved test arrangement.
3. Record the room revision, participant role, media identity, current position, native `paused`, `seeking`, buffering indication, playback-rate value, and whether visible frames continue to move.
4. Create moderate drift while the player is visibly progressing. Confirm that a temporary rate is used only after progress evidence, and that the rate returns to `1` on buffering, a scrub, pause and source replacement.
5. Introduce a slow or non-converging seek. Confirm one bounded local correction, no repeated writes toward a moving clock, and an actionable paused recovery state.
6. Send a newer controller command during the correction. Confirm the newer target supersedes the older correction without stale recovery or a late controller intent.
7. Repeat enough times to cover cold and warm player state, a seek near a segment boundary, a buffering event and a source or episode transition. Record failures exactly, including whether they were provider, browser, network, device or extension behavior.

Visible video output, not an advancing `currentTime` value alone, is required for a live or controlled-browser pass. If the provider rejects playback, resets the rate, never produces visible frames, or requires a missing second profile/device, record the precise blocked gate and retain the issue open.

## Result and closure decision

### What passed

-

### What failed or remained blocked

-

### Recovery behavior observed

-

### Release impact

CR-A05 alone does not authorize a release bump. Keep the repository version unchanged unless this change is part of a separately documented, coherent verified release group. The milestone-end release remains `1.0.0` only after all milestone gates and release checks are complete.

### Issue decision

- `Close only when`: every applicable acceptance gate is `Pass`, the controlled or live-provider evidence is attached where required, no known bug or unexplained gap remains, and the issue’s project state and comments record the evidence.
- `Keep open in Verification when`: deterministic implementation is merged but provider, browser, device, deployment or user-acceptance evidence remains.
- `Keep open in Blocked when`: a concrete external dependency prevents the next required gate. Record the dependency precisely, distinguishing missing account, missing device, missing deployment, provider outage, review or product decision.
