# SyncYourJoy v0.2.5 Controlled Test Session Kit

**Status:** Prepared runbook — not executed; records no results and implies no acceptance state for #30, #34 or #35.
**No provider, two-device, deployed-coordinator or user-acceptance gate has passed yet.** Merged PRs, unit tests, historical CI runs, local fixtures, moving counters and source inspection are not acceptance evidence for any of these gates.
**Prepared:** 2026-09-23 (+03:00). **Revised:** 2026-09-24 (same-candidate coordinator gate, result vocabulary, release-page SHA correction, harness status).
**Base commit:** `15680494f939bffbd84f4ab395dc70b8a2089a59`. This is `origin/main`; only `context-checkpoint.md` changed after the `v0.2.5` tag.
**Primary issue:** [#30](https://github.com/muaz978/sync-your-joy/issues/30)
**Reused for:** [#34](https://github.com/muaz978/sync-your-joy/issues/34), [#35](https://github.com/muaz978/sync-your-joy/issues/35)
**Related:** [#33](https://github.com/muaz978/sync-your-joy/issues/33), [#69](https://github.com/muaz978/sync-your-joy/issues/69)

This kit prepares one controlled two-device session using the published `v0.2.5` package. It records no results.

- It closes no issue.
- It does not authorize a coordinator deployment, a production smoke write, or a release.
- `1.0.0` stays reserved for the milestone-end gate in [`RELEASING.md`](RELEASING.md).

This kit points to the canonical sources below and does not replace them.

| Topic | Canonical source |
| --- | --- |
| #30 protocol and evidence fields | [#30 test plan comment](https://github.com/muaz978/sync-your-joy/issues/30#issuecomment-5768368434) |
| Installation, detailed report, fast recovery, release-blocking outcomes | [`TEST_GUIDE.md`](TEST_GUIDE.md) |
| #34 two-device network chaos | [`SYJ_TWO_DEVICE_NETWORK_CHAOS_REPORT_TEMPLATE.md`](SYJ_TWO_DEVICE_NETWORK_CHAOS_REPORT_TEMPLATE.md) |
| #35 headed and cross-platform checks | [`SYJ_HEADED_CROSS_PLATFORM_REPORT_TEMPLATE.md`](SYJ_HEADED_CROSS_PLATFORM_REPORT_TEMPLATE.md) |
| Evidence vocabulary (native, aggregate, visible) and result values | [`CRUNCHYROLL_CRD04_ACCEPTANCE_REPORT_TEMPLATE.md`](CRUNCHYROLL_CRD04_ACCEPTANCE_REPORT_TEMPLATE.md) |
| Diagnostic report fields and redaction | [`CR_C02_DIAGNOSTIC_REPORTS.md`](CR_C02_DIAGNOSTIC_REPORTS.md) |
| Legacy versus transactional room mode | [`CR_B07_MIXED_VERSION_MIGRATION_REPORT.md`](CR_B07_MIXED_VERSION_MIGRATION_REPORT.md) |
| Why browser offline emulation cannot close the service-worker socket | [`CR_D03_BROWSER_MATRIX.md`](CR_D03_BROWSER_MATRIX.md), [`TEST_GUIDE.md`](TEST_GUIDE.md) |
| Release and deployment policy | [`RELEASING.md`](RELEASING.md) |

If this kit disagrees with a canonical source, follow the stricter rule and record the conflict in the run notes.

### Evidence classes this session can earn

Evidence classes, from weakest to strongest: none < doc-only < source-review < unit < integration < e2e-headless < e2e-headed-fixture < real-provider-single < real-two-device < deployed-coordinator < user-acceptance.

- **real-two-device.** Earned only by a complete run on two physical devices with two independently authorized states. It covers only the recorded package, browsers, title and coordinator.
- **deployed-coordinator.** Earned only with Gate 0 outcome `G0-PASS` (section 1.4). Identifying a Worker version is not enough: the recorded `209278f7-…` version is identified but was built from `v0.2.4` source, and `G0-IDENTITY-ONLY` records identity without the transactional fingerprint.
- **user-acceptance.** Earned only after the user reviews the sanitized report and states acceptance in writing.
- **Counters are not playback proof.** A moving room clock or aggregate counter never proves native playback. If a counter advances while the video is black or frozen, record FAIL or UNRESOLVED.
- **The harness cannot substitute.** `tests/e2e/crunchyroll-two-profile.spec.ts` builds a test-mode extension against an in-process local room service on one machine. A harness pass is real-provider-single evidence at most. It cannot stand in for the release package, the deployed coordinator, or two devices.
- **The harness is not usable for acceptance yet.** `tests/e2e/extension-profile.ts` passes `storageState` to `chromium.launchPersistentContext`.
  - Confirmed on 2026-09-24 against the repository's Playwright 1.63.0: a persistent context silently ignores `storageState`. Dummy cookies and localStorage entries were absent from the persistent context, while a control `browser.newContext({ storageState })` applied the same file.
  - No saved Crunchyroll states are configured locally or in CI. The `e2e-crunchyroll.yml` workflow has never run, and its secrets do not exist. No protected state has ever been applied by this harness.
  - The supported path is `BrowserContext.setStorageState` on the persistent context. The fix is a separate PR that references #30.
  - Until that PR proves both protected states are actually applied, do not run the protected harness as provider evidence, and do not claim that it works.

### Result vocabulary

Use exactly these values. None of them except `PASS` counts toward acceptance, and `PASS` counts only for the evidence class the row actually demonstrates.

| Value | Meaning |
| --- | --- |
| `PASS` | The step or check was run and its written pass criteria were directly observed and recorded. |
| `FAIL` | The step was run and a pass criterion was contradicted, including any black, frozen or loading picture while a counter or native time advances. |
| `BLOCKED` | A required runtime, device, deployment, account state or control was genuinely unavailable, so the step could not be run. Name the missing prerequisite. |
| `NOT CLAIMED` | A scope item (for example Firefox or Safari in this session) is intentionally not tested and not claimed as supported. It is never a pass, and it is not `BLOCKED` when the runtime exists. |
| `UNRESOLVED` | The step was run but the evidence is insufficient or conflicting. |
| `NOT RUN` | A required step was not attempted (for example the session stopped early). |

### Preparation limitations

- No local tests were run while preparing this kit or the companion audit: dependencies were not installed in the preparation worktree and package installs are blocked by policy.
- Hosted CI results cited below (for example run `35662329637` and the push runs on `423b6f7`) are historical CI evidence for those exact commits. They are not new test results and prove nothing about provider playback, two devices, the deployed coordinator or user acceptance.

## 1. Candidate identity

| Field | Value | Source |
| --- | --- | --- |
| Release | `SyncYourJoy v0.2.5`. Published 2026-09-21T22:22:49Z; not a draft, not a prerelease, marked latest. | `gh release view v0.2.5` |
| Tag | `v0.2.5`. Annotated, message `SyncYourJoy v0.2.5`, tagged 2026-09-21T22:22:14Z. | `git cat-file -p v0.2.5` |
| Tag object | `2bf96211631b7f500dbce143876ce29bcf68df13` | `git rev-parse v0.2.5` |
| Tagged commit | `423b6f7c77dad2b4a14db6932711be025aac8163`. Merge of PR #99: head `b4c6546859ce2702ef39f57abdc380dbc2f9d91f`, base `da42aa14398dcd2a3c3fd4e2963ca55475408f4d`. | `git rev-parse 'v0.2.5^{commit}'`, `gh pr view 99` |
| Release-page provenance SHA | **Corrected on 2026-09-24.** The "Tagged merge commit" line previously showed `423b6f7c77dad2a3c3fd4e2963ca55475408f4d`, a malformed 39-character value that is not a git object. It now shows `423b6f7c77dad2b4a14db6932711be025aac8163`. Only the release-notes text changed: the tag, release ID, assets and digests were verified unchanged, and no new version was created. The ZIP digest `7fb39e25…b942` remains the install authority. | `gh release view v0.2.5`; `gh api repos/muaz978/sync-your-joy/releases/tags/v0.2.5` |
| Manifest version at tag | `0.2.5`. MV3, `minimum_chrome_version` 116. The root `package.json` and the extension `package.json` also say `0.2.5`. | `git show v0.2.5:apps/extension/static/manifest.json` |
| Release workflow | `Release extension` run `35662329637` succeeded. 36 test files and 319 tests passed. Production audit found 0 vulnerabilities. The Firefox package check passed. The Safari package check was **skipped** on the Linux runner. | `gh run view 35662329637` |
| Hosted CI on the tagged merge | Push runs on `423b6f7c77dad2b4a14db6932711be025aac8163` all succeeded: Continuous integration `35662187418`, DevSkim `35662187409`, CodeQL `35662187410`. The PR #99 checks (Analyze, CodeQL, DevSkim, devskim, Typecheck/test/build) are PR-head checks: they ran on `b4c6546`, not on the tagged merge. | `gh run list --commit 423b6f7c77dad2b4a14db6932711be025aac8163`; `gh pr view 99 --json statusCheckRollup` |
| ZIP | `sync-your-joy-extension.zip`, 66,849 bytes. SHA-256 `7fb39e25c8c96ae2987cd6eb5cf4d1cefb3ed10e6f98325b9652d3eeb586b942`. | GitHub asset digest; the release workflow's packaging log prints the same value |
| Checksum sidecar | `sync-your-joy-extension.zip.sha256`, 94 bytes, GitHub digest `sha256:c5e4fb429b7c9fbf92f62afa7ef79cbe79672a4b2c37a618ed57b9283d70b63d`. Expected content is one line: the ZIP hash, two spaces, then `sync-your-joy-extension.zip`. | GitHub asset metadata; release log |
| Download page | https://github.com/muaz978/sync-your-joy/releases/tag/v0.2.5 | — |
| Embedded coordinator endpoint | `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`. Label: `sync-your-joy-rooms.sync-your-joy.workers.dev`. | Section 1.1 |
| Last recorded coordinator identity | Worker `sync-your-joy-rooms`, Version ID `209278f7-9154-4ad0-974a-3ad565a67581`. Deployed 2026-09-18T19:45:23Z from `1ac5b1c13ba21d93823c43c3b33f354ba5a9ac68` (`v0.2.4`). **Not verified as the v0.2.5 coordinator.** | Section 1.2 |
| Test-day coordinator identity | Worker target ______ · deployed source commit ______ · Version ID ______ · run URL/result ______ (fill in from Gate 0) | Sections 1.3–1.4 |

### 1.1 How the package's endpoint is chosen

- **Release build.** `.github/workflows/release.yml` sets `SYNCYOURJOY_ROOM_SERVER_URL=wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms` for `npm run release:package`. `scripts/package-extension.sh` uses the same URL as its default.
- **Build step.** `scripts/build-extension.mjs` compiles that URL into `service-worker.js` as `__ROOM_SERVER_URL__`. It also adds the URL's origin to the CSP `connect-src` in the built `manifest.json`. If the variable is unset, the URL defaults to `ws://127.0.0.1:8787/rooms`.
- **Do not judge the endpoint from the source manifest.** At the tag, the source manifest lists only `ws://127.0.0.1:8787` and `ws://localhost:8787`. The production origin exists only in the built package, and the two localhost entries stay in it (#69).
- **Prior verification.** On 2026-09-22 the CSP of the extracted public ZIP contained the production origin (checkpoint and #30 comment). That check covered the CSP only. On test day, confirm the compiled URL with step 3.6.

### 1.2 Coordinator deployment identity: last record and gap

- **Last deployment on record.** The `Deploy room coordinator` workflow run `35387667519` ran on 2026-09-18T19:45Z from source commit `1ac5b1c` (which is `v0.2.4`). Its log reports `Current Version ID: 209278f7-9154-4ad0-974a-3ad565a67581`. This ID exists only in the Actions log; no repository doc records it.
- **Stale records in the docs.** The newest version ID in the repository docs is `11de04d9-f41d-4563-bdda-08136016777e`, from 2026-08-30 (`context-checkpoint.md`, Checkpoint 24). `TEST_GUIDE.md` still says the coordinator was "deployed and smoke-verified on 2026-08-30".
- **No later deployment.** No deploy workflow run exists after the `v0.2.5` tag. No local `npm run deploy:edge` after 2026-09-18 is recorded.
- **Coordinator code changed.** Between `1ac5b1c` and `423b6f7`, `apps/edge-service`, `packages/protocol` and `packages/sync-engine` changed substantially. The changes include #84 (coordinator prepare/commit), #82 (the operation contract), and alarm and health rehydration.
- **Risk.** If the running Worker still has the `v0.2.4` source, the 0.2.5 extension falls back to `legacy` room mode, because capability negotiation fails closed (see CR-B07). The session would then not exercise the 0.2.5 transactional behavior.
- **How to spot legacy mode in the panel.** After the controller presses Play or seeks, **Operation phase** stays `none` and the acknowledgement counters stay `—`.

### 1.3 Same-candidate coordinator deployment

**Rule (2026-09-24).** #30 must not run against the old coordinator deployment. The extension package and the coordinator must come from the same runtime candidate, `423b6f7c77dad2b4a14db6932711be025aac8163` (tag `v0.2.5`). Do not proceed with the provider session if the two come from different runtime candidates or if the deployment target is ambiguous.

**Deployment target**, from `apps/edge-service/wrangler.jsonc` and `.github/workflows/deploy-edge.yml` at `v0.2.5`:

| Field | Value |
| --- | --- |
| Worker name | `sync-your-joy-rooms` |
| Cloudflare account ID | `40ae5b90cfe7a505dd1acc3f845ef3af` (already public in `wrangler.jsonc`) |
| Environment | Top-level (default) only. The config defines no `env` blocks, and the workflow runs `npx wrangler deploy --config apps/edge-service/wrangler.jsonc` without `--env`. |
| Durable Object | Binding `ROOMS` → class `RoomDurableObject`, SQLite storage |
| Public host | `sync-your-joy-rooms.sync-your-joy.workers.dev` (workers.dev) |
| Workflow | `Deploy room coordinator` (`deploy-edge.yml`), `workflow_dispatch` only. It checks out the dispatched ref, runs `npm ci`, `npm run typecheck && npm test`, then `wrangler deploy` with the `CLOUDFLARE_API_TOKEN` repository secret. It has no post-deploy smoke step and no rollback job. |

**Preferred path: deploy from the candidate tag**, so the deployed source commit is exactly the extension's runtime candidate:

```bash
gh workflow run deploy-edge.yml --repo muaz978/sync-your-joy --ref v0.2.5
```

The resulting run's `headSha` must be `423b6f7c77dad2b4a14db6932711be025aac8163`.

**Fallback: deploy from `main`.** Only if the workflow must run from `main`, first prove that no runtime file differs, then record both identities (candidate commit and deployed `main` commit):

```bash
git diff --name-only 423b6f7c77dad2b4a14db6932711be025aac8163 <main-sha>
```

The output must contain no runtime files. At `15680494f939bffbd84f4ab395dc70b8a2089a59` it lists only `context-checkpoint.md`.

**Authorization and safety.**

- A deployment changes the production coordinator for every current user and room. It needs explicit user authorization for that specific run.
- Never paste, request or print a Cloudflare token. The workflow uses the repository secret.
- Before deploying, record the currently active Version ID (last recorded: `209278f7-9154-4ad0-974a-3ad565a67581`). There is no rollback workflow, so a rollback needs an operator with Cloudflare access running `npx wrangler rollback`.

### 1.4 Gate 0: identity verification before the session

Run these after the deployment and before the friend starts. Only the operator runs them.

- Never paste tokens, cookies or `.env` contents into notes.
- Commands 1–5 are read-only.
- Command 6 writes: it creates one short-lived synthetic room on the production coordinator. **Run command 6 only after the user explicitly authorizes one synthetic room write on the production coordinator for this session.** This kit does not grant that authorization.

1. **Liveness.** This shows the Worker is up; it carries no version.
   ```bash
   curl -s https://sync-your-joy-rooms.sync-your-joy.workers.dev/health
   ```
   Expected: `{"ok":true,"service":"sync-your-joy-rooms","region":"…"}`.
2. **Deployment run identity.** Replace `<RUN_ID>` with the deployment run.
   ```bash
   gh run list --repo muaz978/sync-your-joy --workflow deploy-edge.yml --limit 5 --json databaseId,headSha,headBranch,createdAt,conclusion
   gh run view <RUN_ID> --repo muaz978/sync-your-joy --json url,headSha,headBranch,event,conclusion
   gh run view <RUN_ID> --repo muaz978/sync-your-joy --log | grep 'Current Version ID'
   ```
   Record the run URL, result, deployed source commit (`headSha`) and Version ID. The run must be the newest deploy run.
3. **Authoritative current version.** Run from the operator's main checkout (the one with installed dependencies) with an existing Wrangler login. Use `npx wrangler login` if needed; never paste a token.
   ```bash
   npx wrangler deployments status --config apps/edge-service/wrangler.jsonc
   npx wrangler deployments list --config apps/edge-service/wrangler.jsonc
   ```
   - The active Version ID must equal the Version ID from command 2, with nothing newer.
   - If it differs, someone deployed outside the workflow. Stop: the deployed source is unknown.
4. **Source equivalence.** Needed only for the `main` fallback, with `<C>` = the deployed commit.
   ```bash
   git diff --quiet 423b6f7c77dad2b4a14db6932711be025aac8163 <C> -- apps/edge-service packages/protocol packages/sync-engine && echo SAME || echo DIFFERENT
   ```
5. **Endpoint used by the extension.** On both devices, step 3.6 must show `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms` in the installed `service-worker.js`. That is the same host as the deployed Worker.
6. **Functional fingerprint (authorized write only).** This writes a synthetic room. Skip it unless the user has explicitly authorized it for this session.
   - Run it from the operator's main checkout, whose `scripts/` match `v0.2.5`, using that checkout's existing dependencies. Do not install packages on test day.
   ```bash
   npm run smoke:edge -- wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms
   ```
   - A 0.2.5-compatible coordinator prints one JSON line containing `"ok":true` and `"transactionalContractVerified":true`.
   - The error `Expected transactional mode for play.` means the running coordinator predates the 0.2.5 transactional contract.

Record one Gate 0 outcome:

| Outcome | Condition | Action |
| --- | --- | --- |
| `G0-PASS` | The newest deploy run succeeded from `423b6f7` (or from runtime-identical `main`, with both commits recorded). Wrangler confirms that run's Version ID is active. Both devices show the production endpoint. The authorized smoke reports `transactionalContractVerified: true`. | Record the Worker target, deployed source commit, Version ID, endpoint, run URL and result in section 1, then proceed. |
| `G0-IDENTITY-ONLY` | Everything in `G0-PASS` except that the user did not authorize the smoke write. | Proceed only if the deployed source commit and the active Version ID are both proven. Mark the transactional fingerprint NOT RUN, and treat step 8's operation phase as the first functional check. The deployed-coordinator evidence class is not earned. |
| `G0-MISMATCH` | The active version was built from a different runtime candidate (for example `209278f7-…` from `1ac5b1c`), or the smoke fails the transactional check. | **Stop. Do not run #30.** Get explicit authorization to deploy from the candidate (section 1.3), then repeat Gate 0. |
| `G0-AMBIGUOUS` | The target, active version or deployed source cannot be determined unambiguously: Wrangler read access is unavailable, a newer out-of-band deployment exists, or the run log lacks the Version ID. | **Stop.** Proceed only if the user explicitly decides that the workflow-run identity plus an authorized smoke fingerprint is sufficient, and record that decision verbatim. |

## 2. Pre-test record (non-sensitive only)

| Field | Device A | Device B | Notes |
| --- | --- | --- | --- |
| Device label | `A` | `B` | Labels only |
| Role at start | Controller (suggested) | Participant | Confirm before start |
| Operating system | macOS 27.0 (build 26A428), Apple silicon arm64 |  |  |
| Browser claimed for this run | Edge 153.0.4234.48 **or** Chrome 153.0.8010.53 (circle one) |  | Needs Chromium 116 or later. The existing signed-in Crunchyroll session was verified in Edge on 2026-09-20 (#30 comment 5750113693). On 2026-09-21 the selected `/watch/` page in that session showed a login or trial surface instead of a player (#30 comment 5761714520), so entitlement must be re-confirmed at step 1. |
| Other browsers on the device | Safari 27.0; Firefox 156.0.1 installed |  | Firefox checked 2026-09-23; not part of this session (section 8) |
| Operator tooling | Node v26.9.0; Playwright 1.63.0 via npx cache; Xcode 27.0 (27A266a) | n/a | Worktrees have no `node_modules`; run Gate 0 in the operator's main checkout |
| Other extensions enabled |  |  | List them, or write "clean profile" |
| Release tag installed | `v0.2.5` |  |  |
| ZIP SHA-256 computed on this device |  |  | Must equal `7fb39e25…b942` |
| Sidecar check result (`OK` or mismatch) |  |  |  |
| Extension card version / older SyncYourJoy removed | / | / | Must be `0.2.5` / yes |
| Compiled endpoint found in `service-worker.js` |  |  | Step 3.6 |
| Coordinator endpoint label | `sync-your-joy-rooms.sync-your-joy.workers.dev` | same |  |
| Gate 0 outcome and Version ID |  | n/a | Section 1.4 |
| Smoke write authorized by the user (yes/no) |  | n/a | Command 5 runs only on yes |
| Test title and episode label |  |  | For example series, season, episode, and audio/subtitle edition |
| Watch-page URL: HTTPS `/watch/…` with no `?` query, no `#` fragment, no signed or token parameters |  |  | Same page on both devices |
| Native player usable before creating the room (not a login, trial or upsell page) |  |  | Yes/No |
| Authorized state type |  |  | `independent account` or `profile of the same account` |
| Declared convergence tolerance | ___ s paused / ___ s playing | same | The operator declares this before the run. It is not a product specification. |
| Network interruption method and duration | n/a (unless A is the faulted device) |  | Section 7.1 |
| Session mode |  |  | Friend follows the runbook, or operator assists by voice. Never screen-share the provider video. |

## 3. Per-device install procedure

Do this on each device. The #30 candidate is the published ZIP only; do not use a local build.

1. **Download.** From https://github.com/muaz978/sync-your-joy/releases/tag/v0.2.5, download `sync-your-joy-extension.zip` and `sync-your-joy-extension.zip.sha256` into the same folder.
   - The release page's "Tagged merge commit" line was corrected on 2026-09-24 and now shows `423b6f7c77dad2b4a14db6932711be025aac8163` (section 1). The ZIP digest is still the install authority.
2. **Verify.** Compare the ZIP against the published digest `7fb39e25c8c96ae2987cd6eb5cf4d1cefb3ed10e6f98325b9652d3eeb586b942`.
   - macOS: run `shasum -a 256 sync-your-joy-extension.zip`, then `shasum -a 256 -c sync-your-joy-extension.zip.sha256`. The second command must print `sync-your-joy-extension.zip: OK`.
   - Windows: run `certutil -hashfile sync-your-joy-extension.zip SHA256`, or in PowerShell `Get-FileHash .\sync-your-joy-extension.zip -Algorithm SHA256`. Compare the result, ignoring letter case, with the digest and with the first field of the `.sha256` file (open it in Notepad).
   - Linux: run `sha256sum sync-your-joy-extension.zip`, then `sha256sum -c sync-your-joy-extension.zip.sha256`.
   - Paste only the printed hash text into the pre-test record.
   - If anything mismatches, **stop**. Do not install, and record BLOCKED.
3. **Extract** to a permanent folder, not a temporary download location.
   - The archive contains one top-level folder, `sync-your-joy-extension/`.
   - Windows "Extract All" can nest it as `…\sync-your-joy-extension\sync-your-joy-extension\`. Pick the innermost folder that directly contains `manifest.json`.
4. **Remove older builds.** Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
   - Remove every older SyncYourJoy entry, or at least turn it off.
   - Exactly one SyncYourJoy card should remain.
5. **Load.** Turn on **Developer mode**, select **Load unpacked**, and choose the extracted folder. Never load the compressed ZIP.
6. **Confirm.**
   - The card reads **SyncYourJoy 0.2.5** and its source path is the extracted folder.
   - There is no **Errors** button and no second SyncYourJoy card.
   - Optional endpoint check (reads nothing sensitive):
     - macOS or Linux:
       - `grep -oE 'wss?://[^"]*' sync-your-joy-extension/service-worker.js | sort -u`
       - `grep -o 'ws://[^ "]*' sync-your-joy-extension/manifest.json`
       - `grep '"version"' sync-your-joy-extension/manifest.json`
     - Windows PowerShell:
       - `Select-String -Path .\sync-your-joy-extension\service-worker.js -Pattern 'wss?://[^"]*' -AllMatches | % { $_.Matches.Value } | Sort-Object -Unique`
       - `Select-String -Path .\sync-your-joy-extension\manifest.json -Pattern 'ws://[^ "]*' -AllMatches | % { $_.Matches.Value }`
     - Expected from `service-worker.js`: only `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms`. Any other value, especially `ws://127.0.0.1:8787/rooms`, means a mispackaged build: stop and record BLOCKED.
     - Expected from `manifest.json`: `ws://127.0.0.1:8787` and `ws://localhost:8787`. These are the known localhost CSP contamination tracked in #69, not the endpoint. Version is `0.2.5`.
7. **Prepare the browser.** Pin SyncYourJoy and refresh any Crunchyroll tab that was already open. Open the side panel once and accept the first-use privacy disclosure (see "Install the extension in Chrome" in [`TEST_GUIDE.md`](TEST_GUIDE.md)).
8. **Display name.** Use the role label, `A-controller` or `B-participant`, not a real name.

## 4. Privacy boundary

Never record, paste, upload, screenshot or share:

- Passwords, one-time codes or recovery codes.
- Cookies, Playwright storage-state files, or their contents. You may note only that a storage-state path "exists".
- Any session or access token: the SyncYourJoy session token, GitHub tokens, or Cloudflare/Wrangler tokens.
- `.env` files or dumps of extension storage.
- Signed media URLs, manifest or segment URLs (`.mpd`, `.m3u8`), licence requests, or any URL with a query string or fragment.
- DRM information: licence or key data, CDM or EME details.
- Protected media: frames, screenshots or recordings of the provider video, audio, HAR or Network exports, page HTML.
- Private account identifiers: email, username, profile name or avatar, account or subscription IDs, payment details, viewing history.
- Local file paths that contain an operating-system username.
- A room code that is still live, in any public place.

Do not screen-share or remote-desktop the provider video. Use a voice call and read values aloud or type them.

These are fine to share:

- The release tag, SHAs, checksum output text and extension version.
- OS and browser versions, device labels and role labels.
- The watch-page path without query or fragment, the title and episode label, and the duration.
- UTC timestamps and fault durations.
- SyncYourJoy panel labels and **Player diagnostics** values: Binding, Origin host, Source kind, Position, Paused, Buffering, Progress evidence, Rendered progress, Operation phase and acknowledgements, Ready state, Network state, Duration.
- The time shown by the native player.
- Gate 0 outputs: health JSON, Version ID, smoke JSON.
- The SyncYourJoy detailed-report JSON, **after review**. It removes query strings and fragments by design. It still contains the room code (in the file name and payload), display names, and the browser user agent. Redact the room code and names before any public post.

If a screenshot is unavoidable, capture only the SyncYourJoy side panel. Crop out the video and any account menu, and redact the room code.

## 5. Second authorized state requirements

- **Independently authorized.** The person entitled to the state signs in normally, on their own device and in their own browser profile.
  - It is either an independent Crunchyroll account, or a separate profile that the account holder legitimately provides on a plan that allows two concurrent streams. Record which one in section 2.
  - Only an independent account also satisfies the two-account wording of #33.
- **Credentials never pass through the operator.** The operator never types, receives or relays the second state's credentials.
- **Not derived from the daily-use state.**
  - Never copy cookies or storage state from Device A's Edge or Chrome profile.
  - Never export or import sessions between devices.
- **Stays on its own device.** The second state is used only in Device B's browser.
  - The automated harness must not be used for acceptance until the separate #30 harness PR proves both protected states are actually applied (see "Evidence classes" above). If it is used after that, keep storage-state files only in a protected local directory outside the repository. Refer to them only through the environment variable names `SYNCYOURJOY_CRUNCHYROLL_URL`, `SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_A` and `SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_B`.
  - For CI, the protected secrets would be `SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_A_B64` and `SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_B_B64`, with workflow input `provider_url`. As of 2026-09-23 neither secret is configured, and `e2e-crunchyroll.yml` has never run.
  - Never commit, paste or attach these files. Rotate or delete them after use.
  - Never move a friend's state onto Device A for a harness run.
- **Check entitlement before the session.**
  - Both states must open the chosen `/watch/` page and show a usable native player, not a login, trial or upsell page. The 2026-09-21 Edge observation landed on such a page.
  - Both must reach the same title, episode, and audio or subtitle edition, in the same region.
  - Do not use a VPN to force entitlement. Record BLOCKED instead.

## 6. Issue #30 run sheet

### 6.1 Conventions

- A means Device A and B means Device B. Put both values in each evidence cell, in the form `A: … / B: …`.
- Use UTC for times (`date -u`).
- Every retry gets a new row (`9r1`, `9r2`, …). Never overwrite a failed attempt.
- Verdicts use the result vocabulary defined near the top of this kit:
  - `PASS`.
  - `FAIL`.
  - `BLOCKED`: a required prerequisite was genuinely unavailable.
  - `UNRESOLVED`: evidence was insufficient or conflicting.
  - `NOT RUN`: the step was not attempted.
  - `NOT CLAIMED` applies only to scope items that are deliberately not tested, such as Firefox or Safari in this session. It is never a verdict for a required #30 step.
- What goes in each column:
  - **Room state & revision:** room paused or playing, room position in the panel, room revision (from the report), operation kind, phase and reason, and the mode. The mode is `transactional` when phases and acknowledgements appear, and `legacy` when Operation phase stays `none`.
  - **Connection:** the panel's connection label (`Good`, `Degraded`, `Offline` or `Reconnecting`), plus whether the participant row shows `Disconnected`.
  - **Participant/controller:** who is the controller, the participant rows, readiness, and the playback status label. Labels are `Preparing`, `Ready, not playing`, `Playing, confirmed`, `Seeking`, `Playback blocked`, `Buffering`, `No player report`, `Different episode`, `Needs recovery` and `Connection unclear`.
  - **Native player state:** paused or not, `readyState`, `seeking` (console only), Binding (`Top page` or `Embedded frame N`), Origin, and Source kind.
  - **Native currentTime:** the exact value from the report (`sample.positionSeconds`) or the operator console, plus the native player's own time display. The panel's **Position** is rounded down to whole seconds.
  - **Aggregate sync progress:** Progress evidence (`frames`, `clock` or `unknown`), Rendered progress, prepared and started acknowledgements, and whether the room timeline moves.
  - **Human-visible motion:** what a person actually sees, such as frames moving or the same frame held.
  - **Buffering/black/frozen/loading:** any spinner, black frame, frozen frame or provider error screen, with its duration.
  - **Recovery result:** the outcome of any recovery that happened in the row, automatic or manual: an autoplay block cleared, a seek-barrier timeout, a `Needs recovery` state resolved. Leave it blank only if no recovery occurred.
  - **Manual intervention:** every manual action, with its UTC time: **Sync me now**, **Redetect player**, **Lock selected player**, a page refresh, or a local gesture to clear an autoplay block. Write `none` otherwise. CR-D04 requires manual actions to be counted separately per run.

### 6.2 Capturing native currentTime and the selected player without exposing sensitive data

1. **Player diagnostics** (any participant). This panel appears only inside a room.
   - Expand **Player diagnostics** in the side panel and read Binding, Origin, Source, Position, Paused, Buffering, Progress evidence, Rendered progress, Operation phase, Prepared and Started acknowledgements, Operation reason, Ready state, Network state and Duration.
   - These values describe only the selected video element. They do not include the operation's target position.
   - Steps 2–3 happen before a room exists. Record what the native player shows at that point, then fill in the extension-side identity at step 7 from Player diagnostics and report R1.
2. **Detailed report** (controller only). Use **Beta diagnostics → Download detailed report**.
   - The controller collects data from every connected participant for up to about 8 s.
   - The file is saved to Downloads as `syncyourjoy-report-<ROOMCODE>-<timestamp>.json`.
   - Per participant it includes: `extensionVersion`, `connection`, `roomRevision`, `playbackStatus`, `playerFrameId`, `playerOrigin`, `playerReadyState`, `playerCurrentSrcKind`, `sample.positionSeconds` (exact native time), `sample.paused`, `sample.buffering`, `sample.progressEvidence`, `targetPositionSeconds`, `observedPositionSeconds`, `operationId`, `operationKind`, `operationPhase`, `mediaEpoch`, `bindingId`, `sourceGeneration`, `sampleSequence`, `mediaCanonicalId`, and `mediaPageUrl` (query removed).
   - Download only at these checkpoints:
     - R1 after step 7; R2a, R2b, R2c and R2d after steps 12a–12d; R3 after step 16; R4 after step 21; R5 after step 23.
     - Immediately after any FAIL or UNRESOLVED, **before refreshing** anything.
   - Let each download finish before the next action.
   - A report taken while B is offline includes only participants the room still counts as connected. Check `collection.expectedParticipants` and `missingParticipantIds`.
   - **If a download fails.** If the report does not download within about 15 s, record the Player diagnostics values and the native player time by hand in that row, mark report capture FAILED in Notes, retry once, and do not refresh before recording. No real-browser download of the current (post-CR-C02) report format has been recorded yet, and 10 local harness capture attempts timed out, so treat every R-checkpoint as at risk.
3. **Operator console** (optional, operator only). This is the only source for native `seeking`.
   - Open DevTools on the watch tab.
   - In the Console's context dropdown, pick the frame that matches the **Binding/Origin** shown in Player diagnostics.
   - Run only this read-only expression:
   ```js
   (() => { const v = [...document.querySelectorAll('video')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]; return v ? { t: Number(v.currentTime.toFixed(3)), paused: v.paused, seeking: v.seeking, readyState: v.readyState, duration: Number.isFinite(v.duration) ? Number(v.duration.toFixed(1)) : null } : 'no video element in this frame context' })()
   ```
   - Do not print `src` or `currentSrc`, do not open the Network or Application panels, and do not copy page HTML.
   - This expression cannot find a player inside a shadow root. In that case record "not available"; do not guess.
4. **What the extension does not expose.**
   - Native `seeking` is in neither the panel nor the report.
   - Room revision, the operation target (`targetPositionSeconds`) and exact `currentTime` appear only in the controller's report.
   - If neither the report nor the console was used, write "n/a (not exposed)".

### 6.3 Step actions and pass criteria

| # | Who | Action | PASS requires |
| ---: | --- | --- | --- |
| 1 | A, B | Open the agreed HTTPS `/watch/` page, typed by hand with no query string. | A usable native player on both devices, not a login, trial or upsell page. |
| 2 | A, B | Play and pause the native player for a few seconds, before any room exists. | Each device shows one intended native video, and it responds. The Binding, Origin and Source filled in at step 7 match on both devices. |
| 3 | A, B | Compare title, episode, edition and duration. | Same labels, and durations within 2 s. At step 7 neither device shows `Different episode`, and report R1 shows the same `mediaCanonicalId` for both. |
| 4 | A | Press **Start a synced room**. | A room code appears, A is the controller, and the connection shows `Good` or `Degraded`, not `Offline`. |
| 5 | B | Enter the room code and request to join. Share the code by voice; never post it. | B sees "you will join automatically once the host approves your request". |
| 6 | A | Approve B under **Waiting to join**. | B enters the room. There is one B row and no duplicate pending request. |
| 7 | A, B | Check **People**. Both press **I'm ready**. A downloads R1. | Two rows: A as controller, B as participant, both connected, both ready, both on the same media. R1 shows `complete: true`. |
| 8 | A | Press native Play, or Play in the panel. | B starts without a manual click. Operation phase moves toward `started`, with prepared and started acknowledgements at `2/2`. If the phase stays `none`, the room is in legacy mode, which contradicts Gate 0: record UNRESOLVED, download a report, and stop the run. |
| 9 | A, B | Watch for 30 s. | Neither native player is paused. Both show `Playing, confirmed`. |
| 10 | A, B | Compare the visible video with the counters. | On both devices, native time advanced about 30 s over 30 s of wall time, **and** the picture visibly moved. A moving counter with a black or frozen picture is FAIL; stop (section 11). |
| 11 | A | Pause natively, then wait 10 s. | Both native players pause within the declared tolerance and are still paused after 10 s. |
| 12a | A | While paused, seek forward about 60 s. A downloads R2a. | The seek reaches A's target on both devices with no refresh. The operation reaches `committed` with Prepared acknowledgements `2/2` and the room stays paused (a paused seek does not start). Record Operation phase, both acknowledgement counters and Operation reason from Player diagnostics, A's intended target, B's native time, and R2a `targetPositionSeconds`. |
| 12b | A | While still paused, seek back about 30 s. A downloads R2b. | Same as 12a, using R2b. |
| 12c | A | Press Play, then while playing seek forward about 60 s. A downloads R2c. | The seek reaches A's target on both devices with no refresh, and the operation reaches `started` with Prepared and Started acknowledgements at `2/2`. Record the same fields as 12a, using R2c. |
| 12d | A | While playing, seek back about 30 s. A downloads R2d. | Same as 12c, using R2d. |
| 13 | A, B | Review 12a–12d together, from R2a–R2d or the hand-recorded values if a download failed. | For every seek: the phase and acknowledgements match the paused or playing expectation above; `targetPositionSeconds` equals A's target; B's native time is at the target within tolerance; the room did not resume before B acknowledged; the visible picture matches the new position. If a target could not be read from a report, mark that check UNRESOLVED, not PASS. |
| 14 | B, then A | B, who is not the controller, pauses or seeks with the native controls. A then presses **Pass** on B's row, and B does one pause/play. A tries a native action. Finally B passes control back to A. | B's first action is reverted with the notice "The room controller owns playback.", and the room is unchanged. After Pass, B's actions control the room and A's actions are reverted. Both panels show the new controller. No stale or duplicate command occurs. |
| 15 | B | Reload B's watch tab while the room is paused. Optionally repeat while playing, as row `15r1`. | The reload type is recorded (section 7.2). |
| 16 | B | Wait up to 10 s for the player to be detected again. Press **Redetect player** once only if the panel asks. A downloads R3. | B is still in the same room. Player diagnostics fill in again (Binding, Origin, Source, Duration). The room position and paused state come back. Readiness is either kept or clearly requested again. |
| 17 | A | Watch B's row during and after the reload. | B never shows `Disconnected` while its socket is up. A brief `No player report` or `Preparing` is acceptable; record how long it lasted. The room never advances while B's player is missing. |
| 18 | B | Apply the controlled interruption during playback (section 7.1; default is Wi-Fi off for 20 s). Record the off time in UTC. | The fault is applied exactly as recorded. |
| 19 | B | Restore the network. Record the on time in UTC. | The network is back. |
| 20 | A, B | Watch A's row for B during the outage, then watch recovery for up to 30 s after the restore. | During the outage the room does not advance while B's native player is not progressing. Record exactly what A's row for B shows (`Disconnected`, `No player report`, `Connection unclear` or `Needs recovery`) and the UTC time it changed. If the room keeps playing on A during the outage, record FAIL. After the restore, B shows `Good` as the same participant, with no new join request or duplicate row. Nothing stays in `Seeking` or `Preparing` indefinitely. |
| 21 | A | Resume if the room is paused, then compare the devices. A downloads R4. | B resumes from the room's authoritative position, not its position before the outage and not an old target. Both native players visibly advance. Nothing resumed before A's command. |
| 22 | A or B | Replace the player (section 7.3: SPA replacement first, then source replacement; page lifecycle only as a fallback). Record the method used. | The method is applied as recorded, or the step is marked BLOCKED with a reason. |
| 23 | A, B | The controller plays and pauses after the change. A downloads R5. | **With SPA or source replacement (methods 1–2):** Player diagnostics describe the current player (Binding, Origin, Source and Duration refreshed, same episode). For a swap inside the same frame the Binding label can still read `Top page`, so also compare `bindingId` and `sourceGeneration` in R4 and R5 and record both. Commands act on the visible current player, and nothing targets the old element or frame. **With page lifecycle (method 3):** the same binding survives and commands still act on it; record the result under #34 scenario 6 and mark #30 gate 12 NOT RUN ("not exercised"). Any **Redetect player** press is recorded as a manual intervention. |
| 24 | B, then A | Press **Leave room** on B, then on A. | Each side panel returns to the start screen. |
| 25 | A, B | Verify cleanup (section 7.4). | No room, tab binding or diagnostic collection is still active on either device. |

### 6.4 Evidence record

Leave **Recovery result** blank unless a recovery occurred. Record every manual action in **Manual intervention**, separately from the verdict.

| # | UTC | Room state & revision | Connection | Participant/controller | Native player state | Native currentTime | Aggregate sync progress | Human-visible motion | Buffering/black/frozen/loading | Recovery result | Manual intervention | Verdict (PASS/FAIL/BLOCKED/UNRESOLVED/NOT RUN) | Notes |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 |  | no room | no room |  |  |  |  |  |  |  |  |  |  |
| 2 |  | no room | no room |  |  |  |  |  |  |  |  |  |  |
| 3 |  | no room | no room |  |  |  |  |  |  |  |  |  |  |
| 4 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 5 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 6 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 7 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 8 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 9 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 10 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 11 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 12a |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 12b |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 12c |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 12d |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 13 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 14 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 15 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 16 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 17 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 18 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 19 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 20 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 21 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 22 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 23 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 24 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 25 |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 15r1 (optional: reload while playing) |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 16b (optional: service-worker restart) |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 18b (optional: 5–8 s blip or silent loss) |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 18c (optional: 90–120 s outage) |  |  |  |  |  |  |  |  |  |  |  |  |  |

## 7. Procedures

### 7.1 Controlled network interruption (steps 18–20)

**Where the coordinator link lives.** `apps/extension/src/service-worker.ts` opens the room WebSocket (`new WebSocket(socketUrl)`, where `socketUrl` is `ROOM_SERVER_URL` with a `code` query parameter) inside the MV3 **service worker**. There is no offscreen document, and neither the content script nor the page ever holds the socket. This has several consequences:

- **Do not use DevTools offline mode for step 18.**
  - DevTools **Network → Offline** on the watch tab does **not** touch the coordinator socket.
  - It only blocks that page's own requests. The provider stream stops while the room link stays up, which is the wrong fault.
  - Browser offline emulation also does not reliably close a service-worker WebSocket that is already open. `CR_D03_BROWSER_MATRIX.md` and `TEST_GUIDE.md` document this.
- **Client-side detection.** The service worker pings every 5 s. It closes the socket after more than 15 s without a pong, with close code 4001 and reason `heartbeat_timeout`. If the OS drops the network interface, the socket may close sooner.
- **Reconnect.** Retries back off at 0.5 s × 2^n, capped at 15 s, plus up to 0.25 s of jitter, with a `chrome.alarms` fallback. Wait 30 s after restoring the network before judging.
- **Coordinator-side detection.** The coordinator has no server-side heartbeat. In `apps/edge-service/src/worker.ts`, `ping` is answered with `pong` and never timed (line 367), and `coordinator.disconnect()` is called only from `webSocketClose`/`webSocketError` (lines 192–226). The coordinator learns of a silent client outage only when the edge sees the socket close, or through the 0.2.5 health deadlines. B's `close(4001, 'heartbeat_timeout')` cannot reach the server while B is offline, and if B reconnects before the old socket's close is delivered, the `stillConnected` check (line 198) drops the disconnect entirely. A Wi-Fi drop may therefore never register as a coordinator-side disconnect, and the 10 s controller grace period starts only on a server-observed close.
- **Coordinator behavior.**
  - When the coordinator does observe a participant's socket close, it marks the participant disconnected (A's row shows `Disconnected`, status `Connection unclear`) and pauses the room.
  - On a 0.2.5 coordinator, if B's reports simply stop, the health evaluator (`evaluateHealth`, `packages/sync-engine/src/room.ts:662–705`) pauses the room instead. Depending on B's last sample, it marks B `recovery-required` (**Needs recovery**) after the 1.8 s progress deadline, or `silent` (**No player report**) after 5 s of report silence.
  - The recorded `1ac5b1c` coordinator has no health evaluator, so the room may keep playing during the outage. Step 20 records that as FAIL.
  - The 10 s controller grace applies only when the **controller**'s close is observed; that case belongs to #34 scenario 8, not #30 step 18.
- **Provider stream.** Turning off B's Wi-Fi also interrupts B's provider stream. Record the resulting buffering in the Buffering/black/frozen column, separately from room recovery.

**Participant method (non-technical, on Device B).**

1. The operator says "off", and B turns Wi-Fi off. On macOS, use the Wi-Fi switch in the menu bar. On Windows, use the Wi-Fi tile in Quick Settings, or Airplane mode. On a wired connection, unplug the cable.
2. The operator times **20 s** on a stopwatch and records the UTC off time.
3. The operator says "on", and B turns Wi-Fi back on. B says "back" once the OS shows it connected, and the operator records the UTC on time.

Do not toggle a VPN, restart the router, or do anything else that affects both devices.

**Operator method (precise, when the operator controls the faulted device).** These commands change a network setting briefly and restore it automatically. Run them only with the device owner's consent.

- macOS: find the Wi-Fi device name with `networksetup -listallhardwareports`, then run the command below, replacing `en0` with the device shown.
  ```bash
  date -u +%FT%TZ; networksetup -setairportpower en0 off; sleep 20; networksetup -setairportpower en0 on; date -u +%FT%TZ
  ```
- Linux: `date -u +%FT%TZ; nmcli radio wifi off; sleep 20; nmcli radio wifi on; date -u +%FT%TZ`
- Windows, from an elevated PowerShell. First run `Get-NetAdapter` and note the Wi-Fi adapter's exact **Name**; replace `"Wi-Fi"` below if it differs. The command avoids `Get-Date -AsUTC`, which does not exist in the default Windows PowerShell 5.1.
  ```powershell
  (Get-Date).ToUniversalTime().ToString('o'); Disable-NetAdapter -Name "Wi-Fi" -Confirm:$false; Start-Sleep 20; Enable-NetAdapter -Name "Wi-Fi" -Confirm:$false; (Get-Date).ToUniversalTime().ToString('o')
  ```
- Silent-loss variant: this exercises the heartbeat path without the interface going down. Use macOS Network Link Conditioner (from Xcode Additional Tools) with a 100%-loss profile for 30 s, and record it as a different fault type.

**Durations.**

- The primary run is **20 s** on Device B during playback. That is longer than the 15 s client heartbeat, so B's extension must detect it. The coordinator may not (see Coordinator-side detection).
- Optional row `18b` is a 5–8 s blip. It checks that a brief loss is absorbed without a false offline state or an unsafe resume.
- Optional row `18c` is a 90–120 s outage during playback, run after step 21 with a fresh baseline. It gives the platform more time to deliver a close for B's dead socket, which would exercise `webSocketClose`/`webSocketError` and the server-observed disconnect pause. The repository does not document when, or whether, the edge delivers that close, so record what A shows and when, rather than expecting a particular label. Step 20's criteria apply.
- Record the fault type (interface down or silent loss) and the exact duration.

Pass criteria are in steps 20–21 and in the recovery rules of the #34 template.

### 7.2 Reload and rehydration (steps 15–17)

- **Tab reload (required).** Press Cmd+R, Ctrl+R or F5 on B's watch tab.
  - The content script and player are created fresh.
  - The service-worker socket normally stays open, so do not expect a socket reconnect. Connection should stay `Good`, and B must not show `Disconnected`.
  - The player binding moves to the new document, and Player diagnostics fill in again.
  - Readiness may be kept or requested again. Either is acceptable only if the UI says so and the room stays paused or safe instead of advancing.
- **Service-worker restart (optional row `16b`, operator only).** This tests a true socket reconnect and state rehydration from session storage.
  - Open `chrome://serviceworker-internals` (in Edge, `edge://serviceworker-internals`).
  - Find the `chrome-extension://…` entry for SyncYourJoy and press **Stop**.
- **Do not reload the extension itself.** Do not press **Reload** on the extension card or turn the extension off and on. That invalidates the content scripts and clears session state, which is a different scenario: the page shows a "refresh this page" notice.
- If the player is not detected again within 10 s, press **Redetect player** once and record it as a manual intervention.

### 7.3 Player replacement or page lifecycle (steps 22–23)

#30 checklist item 12 (plan step 9) needs evidence that the extension rebinds to the current intended player. Choose one of the following, in this order of preference, and record which one you used:

1. **SPA replacement.** From the watch page, use the site's own links to go to the series page and back to the same episode, without a browser reload.
2. **Source replacement within the same episode.** If Crunchyroll offers it, change the audio version or subtitle track in the native player settings. The source may reload; record whether readiness resets.
3. **Page lifecycle (fallback only).** During playback, B switches to another tab or minimizes the window for 30 s, then returns. This replaces no player, element or frame, so it cannot show rebinding. Record the result under #34 scenario 6. If only this method was run, mark #30 gate 12 NOT RUN ("not exercised").

Do not use **Next Episode** or **Open link for everyone** here. Those are navigation transactions that change the media identity, which is #33 and CR-C04 scope.

Use **Lock selected player** only if Player diagnostics show competing videos, and record it as a manual intervention if you do.

Pass criteria, which depend on the method, are in step 23.

### 7.4 Cleanup verification (step 25)

- **Room, client side.**
  - Both side panels show the start/join screen: no room code, no People list, no `Reconnecting`.
  - Wait 60 s and confirm neither device rejoins on its own.
- **Room, coordinator side.**
  - The coordinator keeps an empty room for up to 30 min (`EMPTY_ROOM_TTL_MS`), then it expires. Rooms also have a 6 h maximum lifetime.
  - An **empty** room persisting on the server within that window is expected, not a failure.
  - Do not try to rejoin the old code to test deletion.
  - It is a failure if either device still lists a connected peer or an active room after both have left.
- **Tab binding.**
  - On both watch tabs, the in-page SyncYourJoy status pill is gone or shows no room.
  - Native play and pause work locally without being reverted, and without the notice "The room controller owns playback.".
  - A's local play or pause does not move B's video, and the reverse.
- **Diagnostic collection.**
  - The last report download (R5) finished before step 24.
  - The message "A detailed report is already being collected" does not appear.
  - No new `syncyourjoy-report-…` file appears after leaving, and the browser's downloads list shows nothing pending.
- **Optional operator checks.**
  - The extension card shows no new **Errors**.
  - In `serviceworker-internals`, the SyncYourJoy worker may go idle (Stopped) about 30 s after leaving. This is supporting evidence only.
  - Do **not** dump `chrome.storage`; it can contain a session token.

## 8. Reuse plan for #34 and #35

### #34 two-device network chaos ([template](SYJ_TWO_DEVICE_NETWORK_CHAOS_REPORT_TEMPLATE.md))

- **Baseline first.** Before each fault family, record a no-fault baseline with the same candidate, devices, browsers, room setup and media.
  - If the baseline fails, stop and mark the fault scenarios BLOCKED by the baseline.
  - #30 steps 1–13 can serve as the #34 baseline if they are copied into the template's Baseline table.
- **Can run in this session.** Record each of these in both reports, using the #34 fields:

  | #34 scenario | Source in this session |
  | --- | --- |
  | 2 (offline during an active room) | Steps 18–20 |
  | 4 (reconnect after an offline period) | Steps 19–21 |
  | 2 and 4, longer outage | Row `18c` |
  | 7 (tab refresh and normal reconnect) | Steps 15–17 |
  | 6 (background and return) | Step 22, only if method 3 (page lifecycle) is used |
  | Silent-loss variant | Row `18b` |

- **Needs a separate run, or a later block in the same sitting with a fresh room and a new baseline:**
  - Scenario 1, throttling, latency or jitter. This needs an OS-level tool, because DevTools throttling does not affect the service-worker socket.
  - Scenario 3, going offline during a pending play or seek.
  - Scenario 5, sleep and wake.
  - Scenario 8, controller disconnect and return. This exercises the 10 s grace period only if the coordinator observes the controller's socket close (section 7.1).
  - Role swaps. Every scenario has to be repeated with B as controller.
  - #34 user acceptance.

### #35 headed and cross-platform checks ([template](SYJ_HEADED_CROSS_PLATFORM_REPORT_TEMPLATE.md))

- **Local fixture before provider.** No authenticated-provider observation counts toward #35 until the generic fixture rows have run.
  - Do this on Device A before the session; it takes about 20 min.
  - In the operator's main checkout, run `node scripts/serve-fixture.mjs`. It needs no dependencies and listens on `127.0.0.1:8788`.
  - Open `http://127.0.0.1:8788/generic-player` in the same headed Edge or Chrome that has the 0.2.5 package installed.
  - The script serves `fixtures/generic-player.html` for every path, and that page has no iframe. It covers template rows 1–7, the open Shadow DOM half of row 8, and row 10.
  - The nested-frame half of row 8 cannot run on this page. Mark it NOT RUN, or record it as a separate row using the nested fixture named for #49: `fixtures/adaptive-player.html` and its **Open cross-origin nested frame** button (`#open-nested`). No repository script serves that page on its own; it is served only by `tests/e2e/adaptive-fixture-server.ts` inside Playwright, so a headed run with the 0.2.5 package needs a separate, recorded operator procedure.
  - Row 9 needs a room with a single participant on the same coordinator. See [`TEST_FIXTURE.md`](TEST_FIXTURE.md).
- **What this session adds.** #30 steps 22–23 add supplementary **provider** player-replacement evidence for the headed browsers on A and B, but only when method 1 (SPA replacement) or method 2 (source replacement) was used. Method 3 (page lifecycle) replaces nothing and counts only for #34 scenario 6.
  - Record it separately from the fixture rows.
  - If A and B use different Chromium browsers, note the Edge/Chrome pairing.
  - Device B only has provider observations; mark its fixture rows NOT RUN.
- **Firefox.** Firefox 156.0.1 is installed on Device A but is not part of this session.
  - Record it as NOT CLAIMED (deferred), with that reason, or schedule a separate #35 Firefox run.
  - A Firefox run, in a checkout with dependencies installed: `SYNCYOURJOY_ROOM_SERVER_URL=wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms npm run build:extension:firefox`. Record the package hash and commit, install it in a real Firefox profile, then complete the template's Firefox real-install section.
  - Without that variable, the build targets `ws://127.0.0.1:8787/rooms`.
  - The release ZIP is a Chrome/Edge package only. The Firefox build has its own hash and commit, so it must be a separate run.
  - Do not record BLOCKED: the template reserves BLOCKED for an unavailable runtime, and the runtime is installed.
- **Safari.** Safari 27.0 and Xcode 27.0 (27A266a) are installed.
  - A macOS `safari-web-extension-packager` package smoke test passed locally during 0.2.5 release preparation. The tag workflow skipped it.
  - Packaging or conversion is not runtime support. A Safari runtime claim needs an Xcode build with signing (or unsigned extensions enabled), a real Safari install, and a smoke test against the coordinator's origin.
  - Mark Safari **NOT CLAIMED** for this session because it is not being tested. Use `BLOCKED` only in a separate Safari run where a required element, such as a signing identity, is genuinely unavailable.

### #33 (CR-D04)

This session does not satisfy CR-D04. It lacks extension-disabled baselines, the four Edge/Chrome combinations, three editions, and 30 actions per combination. Only the setup can be reused.

## 9. Issue #30 closure gate checklist

Every gate must be PASS, with sanitized evidence, before closure is proposed. The user makes the decision. Status values are PASS, FAIL, BLOCKED, UNRESOLVED and NOT RUN.

**Rule.** Any FAIL, BLOCKED, UNRESOLVED or NOT RUN verdict on a required step (1–11, 12a–12d, 13–25) keeps #30 open. Optional rows 15r1, 16b, 18b and 18c are exempt only when marked NOT RUN; if run, their verdicts count. This follows the #30 plan comment: "Any failed or skipped applicable gate keeps the issue open".

| # | Gate | Run-sheet evidence | Status | Evidence reference |
| ---: | --- | --- | --- | --- |
| 1 | Two independently authorized states | Section 2 (state type) and section 5 |  |  |
| 2 | User's existing signed-in account was usable | Steps 1–2 on A |  |  |
| 3 | Second authorized state was usable | Steps 1–2 on B |  |  |
| 4 | Intended native player detected, with the same title, episode and media identity | Steps 2–3 and 7; R1 `mediaCanonicalId` for both |  |  |
| 5 | Roles, identity, connection and readiness correct | Steps 6–7 |  |  |
| 6 | Two-device playback was tested | Steps 8–13 on two physical devices |  |  |
| 7 | Actual visible native playback confirmed | Steps 9–10, 21 and 23 (visible-motion column) |  |  |
| 8 | Play, pause and seek confirmed | Steps 8–11, 12a–12d and 13 |  |  |
| 9 | Participant-control ownership confirmed | Step 14 |  |  |
| 10 | Reload and reconnect confirmed | Steps 15–17, plus optional row 16b |  |  |
| 11 | Controlled network interruption confirmed | Steps 18–21, plus optional rows 18b and 18c |  |  |
| 12 | Player replacement or rebinding confirmed | Steps 22–23 using method 1 or 2 of section 7.3. Method 3 alone leaves this gate NOT RUN. |  |  |
| 13 | Cleanup confirmed | Steps 24–25 |  |  |
| 14 | Evidence classes reported separately | All ten evidence columns of section 6.4 filled separately for every row |  |  |
| 15 | Exact extension candidate recorded | Sections 1 and 2, with checksums from both devices |  |  |
| 16 | Coordinator deployment identity recorded, from the same runtime candidate as the extension | Gate 0 `G0-PASS`, or `G0-IDENTITY-ONLY` with the deployed source commit and active Version ID both proven (section 1.4) |  |  |
| 17 | Failure documentation complete | A sanitized failure record for every FAIL, BLOCKED, UNRESOLVED or NOT RUN row. This is a documentation requirement only: its PASS never makes closure eligible while any other gate is not PASS. |  |  |
| 18 | User accepted the tested result | Written statement from the user |  |  |

The closure comment must also reconcile the issue body. The body still describes a harness and CI-job scope: `e2e-crunchyroll.yml` exists but has never run. Record whether that work is still required or has been superseded.

None of these counts as acceptance: a merged PR, passing unit tests, a green harness skip, or this template filled in.

## 10. What to send back after the session

Send everything to the operator privately first, never straight to a public issue:

1. The completed section 2 pre-test record, including the checksum command output from **both** devices.
2. The Gate 0 record: the outcome, the Worker target (account, name, environment), the deploy run URL and result, the deployed source commit, the health JSON, the active Version ID and its creation time, the `deployments status` text with no tokens, the endpoint found on both devices, whether the user authorized the smoke write, and the smoke JSON line, its exact error, or `NOT RUN`.
3. The completed section 6.4 evidence record, with a verdict for every required step (1–11, 12a–12d, 13–25) plus any optional or retry rows.
4. Detailed reports R1, R2a–R2d, R3, R4, R5 and any failure reports, reviewed first. Redact room codes and display names before anything is posted publicly. For any download that failed, send the hand-recorded values and the FAILED note instead.
5. The fault record: method, device, UTC off and on times, and fault type.
6. A sanitized failure record for every FAIL, BLOCKED, UNRESOLVED or NOT RUN row, using the fields from the CR-D04 and #34 templates.
7. Any #34 and #35 template rows produced in this session, labeled with this session's report IDs.
8. The operator privacy confirmation text from the templates.
9. The user's written statement accepting or not accepting the result, quoted verbatim.

The maintainer then posts one sanitized summary comment on #30. #34 and #35 are updated only with rows that were actually produced.

## 11. Stop conditions

When any of the following happens, stop the current step. The controller downloads a report **before refreshing** anything. Then record the verdict shown.

- **Wrong package.** The checksum does not match, the card version is not `0.2.5`, the compiled endpoint is not the production `wss://` URL, or two SyncYourJoy builds are loaded. Stop before starting and record BLOCKED.
- **Coordinator not from the same candidate.** Gate 0 is `G0-MISMATCH`, or `G0-AMBIGUOUS` without a recorded user decision. Stop before starting. Never run #30 against the old coordinator deployment.
- **Provider page not usable.** Either device shows a login, trial, upsell or provider error page instead of a usable native player. Record BLOCKED at the provider gate. Never convert this into a pass.
- **Frozen or black picture with moving time.** The visible video is black, frozen or loading while the room clock, the aggregate counter or native `currentTime` advances. Record **FAIL**, or UNRESOLVED if the evidence conflicts. Run the fast-recovery path from [`TEST_GUIDE.md`](TEST_GUIDE.md) once, as a new row.
- **Room runs ahead.** The room timeline advances while a participant's native video is paused or stopped, including during the step 18 outage. Record FAIL.
- **Wrong media matched.** A different title or episode shows as matched. Record FAIL and stop the run.
- **Unsafe control.** Any of: an unsafe resume, a stale seek target that wins, a lost pause, a duplicate command, or a control from a player that has lost its lease. Record FAIL.
- **Stuck operation.** `Seeking`, `Preparing` or a barrier lasts more than 60 s with no visible recovery state. Record FAIL or UNRESOLVED.
- **Privacy risk.** Anything asks for credentials in an unexpected place, or a report or screenshot would contain data listed in section 4. Stop and discard that artifact.
- **Provider licence, concurrency or region error.** Record it as a provider observation and mark the affected steps BLOCKED. Do not blame synchronization.
- **Participant stops or time runs out.** A participant wants to stop, or the time budget is exceeded. Record the remaining steps as NOT RUN.

## 12. Open questions for the operator

1. What OS and version, browser (Chrome or Edge) and exact browser version will Device B use?
2. Will Device A use Edge, which holds the existing signed-in session, or Chrome? The 2026-09-21 Edge observation hit a login or trial page, so entitlement must be re-checked either way.
3. Is the second authorized state an independent account or a profile on the same account? Does the plan allow two concurrent streams?
4. Which HTTPS `/watch/` URL can both states open? It must be checked in advance to show a native player (not a login or trial page), with the same edition and region on both.
5. Can the network interruption be applied on Device B, over Wi-Fi or Ethernet? Who times it? Should the optional 90–120 s outage (row 18c) be run?
6. Will the friend follow this runbook over voice, or will the operator assist remotely? The provider video must not be screen-shared either way.
7. For Gate 0, who has Wrangler read access on test day? Does the user authorize the coordinator deployment from `v0.2.5` (section 1.3) and one synthetic room write (`npm run smoke:edge`) on the production coordinator?
8. What are the initial roles (default: A is controller)? Should a role-swapped repeat be added for #34?
9. Should the #34 add-ons (throttling, offline during a pending operation, sleep/wake, controller disconnect) run after #30 in the same sitting, or separately?
10. For #35: will the fixture pre-check run on Device A, and will the nested-frame half of row 8 be marked NOT RUN or run separately? Firefox 156.0.1 is installed: record it NOT CLAIMED (deferred), or schedule a separate Firefox run with an endpoint-explicit build? Is Safari NOT CLAIMED?
11. What convergence tolerance is declared for the paused and playing states?
12. Where does the friend send evidence, and who redacts it before anything is posted to #30?