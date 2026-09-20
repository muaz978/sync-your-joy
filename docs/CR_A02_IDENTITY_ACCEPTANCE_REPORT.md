# CR-A02 Player Identity Acceptance Report

Issue: [#49](https://github.com/muaz978/sync-your-joy/issues/49)

Report ID: `SYJ-CR-A02-20260920-001`

This report records the evidence collected for CR-A02 after the deterministic implementation merged in [PR #76](https://github.com/muaz978/sync-your-joy/pull/76). It deliberately separates source and deterministic evidence, real local browser evidence, package evidence, and live-provider acceptance. It does not close the issue or authorize a release.

## Privacy and state-only boundary

The run recorded only sanitized identity labels, room and player state, bounded positions, native media state, visible-motion evidence from the local fixture, test results, package metadata and error categories. No credentials, cookies, storage-state contents, signed URLs, token-bearing source URLs, protected media bytes, provider HAR files, protected screenshots or screen recordings were collected.

The controlled Edge session visibly had the user's Crunchyroll account signed in. The live-provider gate was not marked as missing an account. It remained unverified because this browser-control session cannot navigate to Edge's internal extension-management page, so the exact candidate could not be freshly loaded into that existing Edge profile.

## Candidate and environment

| Field | Value |
| --- | --- |
| Report ID | `SYJ-CR-A02-20260920-001` |
| Candidate source SHA | `d3053f2fcb5e1c4affd298c2e1d0180f1e05e014` |
| Extension package | `sync-your-joy-extension.zip` |
| Extension package SHA-256 | `205d12330370a643e8f3e81ff603730a00cc8b597036aade828fc491740fcc69` |
| Package version | `0.2.4` |
| Coordinator evidence | Local ephemeral room-service coordinator in the two-profile E2E run; no live deployment claim |
| Local browser evidence | Playwright Chromium, real persistent profiles, host-level run |
| Controlled provider browser | Microsoft Edge session with signed-in Crunchyroll account visible; exact browser version was not exposed by the controlled surface |
| Operating system | macOS 27.0, build 26A428 |
| Role | Local profile A controller and profile B member; live provider roles not claimed |
| Fixture/provider label | Local room-service `test-player` fixture; no protected provider playback claimed |
| Protected-data handling | Confirmed: no secrets or protected media attached |

## Verification commands and results

### Deterministic CR-A02 matrix

Command:

```text
npm test -- --run apps/extension/src/player-identity.test.ts apps/extension/src/content-script.test.ts apps/extension/src/player-tab.test.ts apps/extension/src/service-worker.test.ts apps/extension/src/media-fingerprint.test.ts
```

Result: **PASS**, 5 test files and 91 tests.

The matrix covered the four identity layouts and state paths in the issue-specific tests:

- top-document Crunchyroll;
- origin-only Crunchyroll iframe;
- generic nested embed;
- nested Qfilm player;
- incoming playback commands;
- player samples;
- controller play, pause and seek intents;
- seek acknowledgement only after matching native readiness;
- same-tab and frame binding, stale replacement and wrong-media rejection;
- observed episode identity and stale-room protection;
- Crunchyroll and Qfilm media fingerprint normalization.

This is source and deterministic evidence only. It is not a real cross-origin frame or live-provider acceptance claim.

### Repository and package checks

| Check | Result | Evidence |
| --- | --- | --- |
| Full Vitest suite | **PASS** | 30 files, 263 tests |
| Root and edge TypeScript checks | **PASS** | `npm run typecheck` |
| Chrome extension build | **PASS** | `npm run build:extension`, version `0.2.4` |
| Browser package verification | **PASS** | Host-level run verified Chrome MV3, Firefox sidebar and Safari macOS packaging |
| Git whitespace check | **PASS** | `git diff --check` |
| Production extension package | **PASS** | SHA-256 recorded above |

The first restricted run of `npm run verify:browser-packages` failed inside Apple's `safari-web-extension-packager` with `Unable to parse manifest.json` from the temporary staging path. The generated manifest parsed successfully with Node and contained the expected MV3 fields. The same verification rerun with host-level access passed Chrome, Firefox and Safari packaging, so the first failure was an execution-environment access restriction, not a manifest defect.

### Real local two-profile browser gate

Command:

```text
npm run test:e2e -- --grep "profile A creates a room"
```

The first restricted run aborted Chromium during process launch with `SIGABRT` before the test opened a page. A host-level rerun passed:

```text
1 passed (5.5s)
```

The passing run exercised the real unpacked extension, two isolated browser profiles, the real side-panel HTML and messaging, the real room-service coordinator, a real local `HTMLVideoElement`, play, pause, forward seek, native backward seek, frame progress and convergence. It is strong local browser evidence, but it is not evidence for Crunchyroll, cross-origin nested frames or protected media.

## Identity layout matrix

| Layout | Deterministic result | Headed provider result | Decision |
| --- | --- | --- | --- |
| Top-document Crunchyroll | **PASS** in source matrix | `NOT CLAIMED` | Provider headed run remains required |
| Origin-only Crunchyroll iframe | **PASS** in source matrix | `BLOCKED` | Exact candidate could not be loaded into controlled Edge |
| Generic nested embed | **PASS** in source matrix | `BLOCKED` for the required headed nested-frame gate | Exact candidate could not be loaded into controlled Edge |
| Nested Qfilm player | **PASS** in source matrix | `NOT CLAIMED` | Provider headed run remains required |

The source matrix confirms that unresolved nested identity is safe only after an acknowledged worker binding, that a different binding does not inherit authority, and that stable provider IDs still remain scoped to the selected player tab and frame. The real provider lifecycle behavior is intentionally not inferred from those tests.

## State-path matrix

| State path | Deterministic result | Real local browser result | Live-provider result |
| --- | --- | --- | --- |
| Incoming play and pause | **PASS** for all four layouts | **PASS** through both local profiles | `NOT CLAIMED` |
| Controller play and pause intents | **PASS** for all four layouts | **PASS** through the real side panel and local players | `NOT CLAIMED` |
| Controller seek intent | **PASS** for all four layouts | **PASS** for forward and native backward seek | `NOT CLAIMED` |
| Player samples and progress evidence | **PASS** for all four layouts | **PASS** with real frame progress | `NOT CLAIMED` |
| Seek acknowledgement after native readiness | **PASS** for all four layouts | Exercised by the local end-to-end seek path | `NOT CLAIMED` |
| Unrelated-frame rejection | **PASS** in deterministic coverage | Required real nested-frame row not run | `BLOCKED` |
| Wrong episode rejection | **PASS** in deterministic coverage | Required provider lifecycle row not run | `BLOCKED` |
| Recovery after frame replacement or navigation | **PASS** in deterministic coverage | Local top-document replacement is not equivalent to provider nested-frame recovery | `NOT CLAIMED` |

## Headed browser gate

The requested headed D02/D03 run was attempted through the controlled Edge browser. Opening `edge://extensions` was rejected by the browser-control URL policy before any internal page was opened. No alternative or indirect browser automation was used. Consequently:

- the exact 0.2.4 candidate was not freshly loaded into the signed-in Edge profile;
- no protected provider page was driven with an unverified candidate;
- no live Crunchyroll failure was observed;
- no account, credential, DRM or provider-network cause was inferred;
- no claim was made for the top-document, origin-only iframe, generic nested embed or Qfilm headed rows.

This is an environment or control-surface gate, not an implementation failure. The next controlled experiment is to load the exact candidate directory `apps/extension/dist` into the signed-in Edge profile through an allowed browser UI action, then rerun the matrix with the state-only evidence rules above. The account is already available; no new account is requested.

## Decision and release boundary

| Decision | Status | Evidence |
| --- | --- | --- |
| Deterministic identity contract | **Accepted for source evidence** | 91 issue-specific tests plus full suite |
| Real local browser path | **Accepted for local fixture evidence** | Host-level two-profile E2E passed |
| Headed nested-frame provider matrix | **Pending** | Edge internal extension-management page blocked by browser-control policy |
| CR-A02 issue closure | **Not authorized** | Required headed rows remain unverified |
| Release authorization | **Not authorized** | Issue acceptance and coherent release-group evidence remain incomplete |

Issue #49 must remain open. This report records the exact remaining gate and does not label the Crunchyroll account as missing. A successful deterministic or local run does not authorize issue closure, merge of unrelated work, or a release.

## Operator confirmation

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files, protected screenshots or
screen recordings. I kept identity, native state, coordinator state and visible
motion as separate evidence classes.
```
