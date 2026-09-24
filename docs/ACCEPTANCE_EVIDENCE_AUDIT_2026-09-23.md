# SyncYourJoy Acceptance Evidence Audit — 2026-09-23

- **Date:** 2026-09-23 (+03:00)
- **Base commit:** `15680494f939bffbd84f4ab395dc70b8a2089a59` (HEAD = origin/main)
- **Candidate under discussion:** v0.2.5. Annotated tag object `2bf96211631b7f500dbce143876ce29bcf68df13` points to commit `423b6f7c77dad2b4a14db6932711be025aac8163`. Released 2026-09-21T22:22:49Z. `sync-your-joy-extension.zip` is 66849 bytes, sha256 `7fb39e25c8c96ae2987cd6eb5cf4d1cefb3ed10e6f98325b9652d3eeb586b942`, with a `.sha256` sidecar of 94 bytes. The only commits after the tag are docs (a1533c1, merge 1568049).
- **Status: Audit snapshot — no issue is closed or accepted by this document.**
- **No provider, two-device, deployed-coordinator or user-acceptance gate has passed for any issue.**
- **Revised:** 2026-09-24 (review-history wording, result vocabulary, historical-CI wording, follow-up decisions in §8).

## 1. Method

- **Read-only two-pass audit.** Each issue group was audited, then independently re-checked. The re-check verified every claim against git, the GitHub CLI and local artifacts, then raised or lowered states and evidence classes (see §7). Every verified group result is included. No group is missing ("not audited" list: none).
- **Completeness review.** A second read-only review on 2026-09-23 corrected the Firefox finding, added the coordinator-side heartbeat gap, and fixed several state, class and reference mismatches. Those corrections are folded into the sections below and listed at the end of §7.
- **No local test runs.** Dependencies (`node_modules`) are not installed in the audit worktree, and org policy blocks package installs. Test evidence therefore comes from hosted CI: `gh pr view --json statusCheckRollup` and `gh run view`. These are historical CI results for the exact commits they ran on, not new local test results, and they prove nothing about provider playback, two devices, the deployed coordinator or user acceptance. The main HEAD CI run is 35663363774 (36 files, 319 tests). Local Playwright artifacts under the main checkout's `test-results/` were read in sanitized form only. Storage-state files, cookies, tokens, `.env` files and signed URLs were not opened.
- **Project fields.** The gh token lacks `read:project`, so ProjectV2 fields cannot be read. Where a status is given, it comes from comments, checkpoints or readable timeline status events.
- **Acceptance philosophy.** A merged PR, green unit tests or a filled template is not acceptance. A moving room clock or an advancing aggregate counter does not prove native playback. Dry-run or local results do not prove a remote deployment. 1.0.0 is reserved for the end-of-milestone gate.

**Evidence-class legend (weakest → strongest):** none < doc-only < source-review < unit < integration < e2e-headless < e2e-headed-fixture < real-provider-single < real-two-device < deployed-coordinator < user-acceptance.

**Gap-need codes used in tables:** 2D second device · 2A second authorized account/state · PP provider page · DEP deployment · HB headed browser · NET network control · LA local-automatable · UA user acceptance · FF Firefox runtime run (local work on Device A: Firefox 156.0.1 is installed; needs a separate `build:extension:firefox` package with an explicit endpoint, run headed) · SX Safari/Xcode · OT other.

**Status vocabulary.** "Complete" in a criterion row means that criterion is met at the stated evidence class, nothing more. No issue is "passed", "accepted" or "closed". "External acceptance pending" would apply to an issue whose only remaining gates are external. **No issue qualifies today**, because every issue still has local-automatable or local headed work.

**Result vocabulary** (for criterion rows and future reports):

| Value | Meaning |
| --- | --- |
| `PASS` | Run, and the written pass criteria were directly observed and recorded, at the stated evidence class only. |
| `FAIL` | Run, and a pass criterion was contradicted (including black, frozen or loading video while counters advance). |
| `BLOCKED` | A required runtime, device, deployment, account state or control is genuinely unavailable. Name it. |
| `NOT CLAIMED` | Intentionally not tested and not claimed as supported (for example Firefox in the v0.2.5 session). Never a pass, and not `BLOCKED` when the runtime exists. |
| `UNRESOLVED` | Run, but the evidence is insufficient or conflicting. |
| `NOT RUN` | A required check was not attempted. |

## 2. Candidate and coordinator identity (verified)

| Item | Value | Source / caveat |
|---|---|---|
| Endpoint | `wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms` | release.yml sets `SYNCYOURJOY_ROOM_SERVER_URL` (run 35662329637), and `build-extension.mjs` compiles it in. If the variable is unset, the build falls back to `ws://127.0.0.1:8787/rooms`. The compiled service-worker URL has not been re-checked for 0.2.5. |
| Source manifest CSP | only `ws://127.0.0.1:8787` and `ws://localhost:8787` | The build appends the production origin and never removes these, so they persist in every production package (#69). |
| Last recorded coordinator | Worker `sync-your-joy-rooms`, version `209278f7-9154-4ad0-974a-3ad565a67581`, deployed 2026-09-18T19:45:23Z from `1ac5b1c` (v0.2.4) | Deploy run 35387667519, the latest of 5. Nothing is recorded after the v0.2.5 tag. `/health` is liveness only (live on 2026-09-23: `{ok:true, region:"IST"}`). **Not verified as a 0.2.5 coordinator.** Since 1ac5b1c, the edge-service, protocol and sync-engine have changed across 17 files, +2998/−120. |
| Newest identity in repo docs | `11de04d9-f41d-4563-bdda-08136016777e` (2026-08-30) | Stale. docs/TEST_GUIDE.md still says test build 0.1.22. |

## 3. Summary table (all issues)

| # | Code | Implementation merged (PRs) | Report doc state | Highest evidence | Remaining gates | Closure eligible | Next action |
|---|---|---|---|---|---|---|---|
| 30 | none (SYJ-AUD-009 follow-up) | #71 adc74cf; docs #72, #98; related #99, #100 | Plan (c5768368434) + blank templates | e2e-headed-fixture | 2A, PP, 2D, DEP, NET, HB, UA, LA | No | Fix the storageState defect; verify or redeploy the coordinator before the second-device run |
| 34 | none (SYJ-CHAOS) | #74 8a1b405 (docs); supporting #96, #17 | Blank template | integration | 2D, NET, DEP, HB, UA | No | Record coordinator identity; rehearse an OS-level fault on Device A |
| 35 | none | #75 6d0d009 (docs); supporting #96 | Blank template | e2e-headed-fixture (Playwright bundled Chromium only) | HB, FF, SX, DEP, UA, LA | No | Human-operated headed Chrome/Edge fixture run of rows 1–10 |
| 49 | CR-A02 | #70 7451307, #76 d497473, #83 c3fc7bc | Partial report, stale 0.2.4 candidate | e2e-headed-fixture | HB, PP, LA, UA | No | Extension-driven run of the nested fixture `adaptive-player.html` (the `#open-nested` button) |
| 50 | CR-A03 | #70, #77 ff30dfb | Blank template | e2e-headed-fixture | LA, HB, PP, 2A, 2D, DEP, UA | No | Tests for controller-change and room-detach retirement |
| 51 | CR-A04 | #70, #78 8532c96 | Blank template (labelled "detailed") | e2e-headed-fixture | LA, HB, PP, FF, SX, 2A, 2D, DEP, UA | No | Different-frameId worker tests; Safari (and Firefox) fallback runs |
| 52 | CR-A05 | #79 f03f4c4 (+ #70) | Blank template | e2e-headed-fixture | LA, HB, PP, 2A, 2D, DEP, UA | No | Advancing-player convergence test with seek latency |
| 53 | CR-A06 | #80 5830121 (+ #86, #87, #96 supporting) | Blank template | e2e-headed-fixture | LA, HB, PP, 2A, 2D, DEP, NET, UA | No | rVFC tests; stop clock-only progress from showing "confirmed" |
| 54 | CR-A07 | #81 43a5557 (+ #70, #84, #96) | Filled for deterministic evidence only; stale | e2e-headed-fixture | LA, HB, DEP, 2A, 2D, NET, UA | No | Regressions for disconnect, unready and auto-transfer during a pending seek |
| 55 | CR-B01 | #82 d3053f2 (+ #89) | Contract doc, stale | integration | LA, DEP, 2D, PP, HB, UA, OT (independent review) | No | Tests for a legacy peer joining mid-operation; independent contract review |
| 56 | CR-B02 | #84 f540b41 (+ #85, #86, #96) | Report, stale | e2e-headed-fixture | LA, DEP, PP, 2A, 2D, UA | No | Test for controller-pause cancellation of an active operation |
| 57 | CR-B03 | #85 b36d33d (+ #96) | Report, stale | e2e-headed-fixture | LA, HB, PP, DEP, 2A, 2D, UA | No | Transactional gesture/cancel tests; decide whether the started ACK must require frame evidence |
| 58 | CR-B04 | #86 c914922 (+ #70) | Report, stale | integration | LA, HB, PP, DEP, 2D, UA | No | Pings-only and duplicate-status tests |
| 59 | CR-B05 | #87 c2ea547 | Report, stale | integration | LA, UA | No | Socket tests for seek and operation expiry |
| 60 | CR-B06 | #88 53046e4 | Report, stale | unit | LA, DEP, UA | No | Miniflare/workerd tests for the Durable Object |
| 61 | CR-B07 | #89 94924c5 | Report, stale | integration | LA, DEP, UA | No | Old-server/new-client fixture built from 1ac5b1c |
| 62 | CR-C01 | #90 b5e7c5d | Report, stale | e2e-headed-fixture | LA, HB, PP, 2A, 2D, DEP, UA | No | "Hang next play" fixture scenario |
| 63 | CR-C02 | #91 a9e8b08 | Report, stale | unit | LA, HB, PP, DEP, UA | No | Find why the 12 s harness download wait (three-profile-browser-matrix.spec.ts:344) expired; emit the dead reasons |
| 64 | CR-C03 | #92 a07a31d | Report, stale | e2e-headed-fixture | LA, HB, PP, 2A, 2D, DEP, NET, UA | No | Manual check in the docked side panel; require frames for "confirmed" |
| 65 | CR-C04 | #93 6667128 | Report, stale | unit | LA, HB, PP, 2A, 2D, DEP, UA | No | Add navigation scenarios to the matrix; break the #65/#68 circular gating |
| 66 | CR-D01 | #94 74b6018 | Filled narrative | e2e-headed-fixture | LA, UA | No | Dirty flag and browser identity in provenance; sanitize run-summary |
| 67 | CR-D02 | #95 950d641 | Filled | e2e-headed-fixture | LA, UA | No | Same-element src replacement; playback-starvation test |
| 68 | CR-D03 | #96 1d22c5b, #97 f3215c4 | Filled (thresholds only) | e2e-headed-fixture | LA, PP, 2A, 2D, DEP, NET, UA, OT (open deps) | No | Rerun on a clean HEAD; add the missing browser scenarios |
| 33 | CR-D04 | #73 a011230 (template) | Blank template | e2e-headed-fixture (borrowed from #68) | PP, 2A, 2D, HB, DEP, NET, UA, LA | No | Fix the template's missing fields; add partial Device A rows |
| 69 | CR-D05 | None in scope (v0.2.5 #99/#100 is out of scope) | No report; RELEASING.md only | integration (pipeline only) | DEP, UA, LA, HB, 2D, 2A, PP, OT | No | Localhost-CSP check; authorized production smoke / identity read-back |

## 4. Dependency and execution order

**Intended order:** #30 first, on a controlled v0.2.5 session. #34 reuses that setup but gets a separate SYJ-CHAOS report. #35 runs the local fixture before the provider. CR-A (#49→#54) is audited before CR-B (#55→#61), then CR-C (#62→#65), then CR-D (#66→#68). #68 needs navigation coverage through #65. #33 depends on #68. #69 is the final release gate.

**Where the verified evidence contradicts this order:**
1. **#30 cannot validly go first as things stand.** The v0.2.5 package targets a coordinator last deployed from 1ac5b1c. Under CR_B07's mixed-version policy, the room would negotiate legacy mode, so a #30 run would not exercise #55–#61 behavior. Recording coordinator identity, or a user-authorized redeploy from 423b6f7 or later, is effectively a step 0.
2. **#35's fixture-before-provider rule was broken for #49.** The 2026-09-21 Crunchyroll attempt (c5761713725) came before any generic nested-fixture run. No nested run has been recorded since the fixture landed (PR #95).
3. **Groups were implemented out of order.** CR-A03 and CR-A04 merged while #49 was open. CR-B01 merged while #49–#54 were open. The #68 matrix ran with #54, #61, #62, #63, #64, #65 and #67 all open.
4. **PR #96 (#68) changed accepted-group code.** It changed the CR-A06 health observer (rVFC), the CR-A07 seek barrier (1.8 s → 3.0 s), CR-B02 operation expiry, and reconnect code. The CR-A06 and CR-A07 reports were not updated.
5. **#65 and #68 each wait on the other.** The #65 report waits for the D03 SPA scenario, while D03 docs and tasks/plan.md exclude navigation "while #65 remains open". The #68 body only needs CR-C04 implemented, and PR #93 merged before #96.
6. **#69 was pre-empted.** v0.2.5 was published as a non-prerelease "latest" before any backend-first deploy, used the 0.2.5 number that RELEASING.md:94 had reserved for the verified group, and conflicts with RELEASING.md:105.

## 5. Device A work vs external blockers

Test runs need a checkout where `npm ci` is allowed; this audit worktree has no dependencies. Device A host values: macOS 27.0 (26A428) arm64, Chrome 153.0.8010.53, Edge 153.0.4234.48, Safari 27.0, Xcode 27.0, **Firefox 156.0.1**. Firefox presence is settled: `/Applications/Firefox.app` reports `CFBundleShortVersionString` 156.0.1 (re-checked 2026-09-23), matching the #33 and #51 re-checks. The #35 re-check's "absent" reading was wrong. Firefox rows are local work, not an unavailable runtime.

### Can be done now on Device A, without the second device
- **Coordinator identity, read-only:** `gh run list/view` for deploy-edge.yml, and `npx wrangler deployments status/list` with the user's login. `npm run smoke:edge` creates a synthetic room and needs user authorization. (#30, #34, #35, #49–#65, #69)
- **ZIP verification** (needs download permission): `shasum -c`, grep the extracted package for localhost/127.0.0.1, confirm the compiled `__ROOM_SERVER_URL__`, and do a Load-unpacked smoke in Chrome and Edge. (#69, #30, #34, #35)
- **Harness auth fix:** `context.setStorageState()` plus a dummy-cookie self-test. (#30)
- **Deterministic test gaps:**
  - leaveRoom cleanup (#30)
  - silent client outage in room-service or edge: socket left open, no pings and no reports (#34)
  - controller change and room detach (#50); exact 1,500 ms timeout boundary (#50)
  - different-frameId senders (#51); advancing-player convergence (#52)
  - rVFC and throwing counters (#53); seek-barrier holes and transferDisconnectedController (#54)
  - legacy peer mid-operation, binding-change and sequence guards (#55); controller-pause cancel (#56)
  - transactional gesture recovery and cancellation (#57); pings-only and duplicate status (#58)
  - socket expiry tests (#59); stateVersion validation (#61)
  - reason normalization (#63); navigation edge cases (#65)
- **Workerd/Miniflare Durable Object tests and a local mixed-version rehearsal** against a room-service built from 1ac5b1c. (#55, #60, #61, #69)
- **Headed fixture runs on a clean HEAD, with artifacts retained:**
  - the #68 matrix plus its missing scenarios
  - the nested fixture (#49); CR-A03 and CR-A04 template rows (#50, #51)
  - induced drift (#52); hidden, PiP and frozen output (#53); barrier holes (#54)
  - a hang fixture (#62); diagnostics download (#63); docked panel (#64); navigation (#65)
- **Provenance and artifact fixes:** concurrency test, dirty flag, sanitization (#66). Same-element replacement and starvation fixtures (#67).
- **Safari packager build and enable, plus a Firefox 156.0.1 real-install run:** the Firefox run needs a separate package built with `SYNCYOURJOY_ROOM_SERVER_URL=wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms npm run build:extension:firefox`, with its hash and commit recorded. Lifecycle and fallback rows. (#35, #51, #57)
- **OS-level fault rehearsal** (Network Link Conditioner, Wi-Fi toggle, `pmset sleepnow`), labelled as rehearsal only. Include an outage of 90–120 s so the server-side close path can be observed, not only the client heartbeat. (#34)
- **Single-account Crunchyroll observations with the existing session.** These are supporting evidence, not acceptance. No credentials are entered and no challenge is bypassed. (#49, #52, #53, #56, #57, #62, #64, #65)
- **Docs PRs** covering:
  - invalid SHAs (checkpoint lines 8107, 8108, 8123, 8171, 8199): done with the user's authorization on 2026-09-24, together with the release-notes correction (§8)
  - stale report status lines and versions; TEST_GUIDE staleness
  - merging the branch-only checkpoints 73, 74 and 78 into main
  - #33 and #34 template gaps

### Blocked on external prerequisites
- **Device B:** #30, #33, #34, #50–#57, #62, #64, #65, #68.
- **Second authorized Crunchyroll state, plus the `SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_A/B_B64` secrets:** #30, #33, #50–#53, #56, #57, #65, #68.
- **A /watch/ URL entitled for both states:** #30, #33, #49. The page selected on 2026-09-21 showed a login/trial surface.
- **Coordinator deployment from v0.2.5 or later with recorded identity** (user-authorized deploy-edge.yml): #30, #34, #35, #49–#65, #69.
- **Staging environment:** none exists (#60, #61, #69).
- **Second-person review:** contract review for #55. No PR in scope has an approving review from someone other than the author. For PRs #71–#100, the exact final head received a detailed owner review comment, hosted checks passed, GitHub continued to require an approval the author could not provide, and the authorized administrative merge path was used (details in §7 item 13).
- **Publication authorization and an approved rollback policy:** #69. Further edits to the release notes also need user authorization (#30, #61, #69); the malformed SHA was corrected with authorization on 2026-09-24 (§8).
- **Apple signing identity** if Safari is claimed (#35).
- **`read:project` token scope** to verify project fields (all issues).
- **User acceptance** (all issues).

## 6. Per-issue detail

### #30 — Extend the real two-profile E2E to Crunchyroll (no CR code)
**Summary:** OPEN; auto-closed by the PR #71 merge and reopened at 11:42:17Z. The opt-in harness and the manual `e2e-crunchyroll.yml` are merged but have only ever safe-skipped: 22 local skip records, 0 workflow runs, secrets absent.

**PRs:**
- #71 adc74cf (2026-09-20), 5/5 green, run 35507931919.
- Docs-only: #72 46632dd, #98 da42aa1, #100 1568049.
- Release metadata: #99 423b6f7.
- All 5/5 green. Hosted CI never runs Playwright.

**Reports:** plan c5768368434 (not executed); blank CR-D04 and #34 templates; CR_D03 headed local run (pre-HEAD d5ceef7); research notes (a 2026-09-19 single-session snapshot showing a ready native video).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| 1 Same page on both devices | missing | none | c5761714520 | 2A, PP, 2D | Never opened with two states |
| 2 Native player detected | partial | e2e-headed-fixture | CR_D03:121 | PP, 2A, 2D, HB | Fixture only; Crunchyroll snapshot is context only |
| 3 Same media identity | partial | unit | player-identity.test.ts | PP, 2A, 2D, LA | No E2E identity assertion |
| 4 Create/join/approve | partial | e2e-headed-fixture | matrix spec:92-107 | 2D, 2A, DEP | Local test-mode coordinator |
| 5 Role/identity/connection/readiness | partial | e2e-headed-fixture | spec:214-221, 294-306 | 2D, 2A, PP, LA | Provider harness asserts none of these |
| 6 Visible native playback on both | partial | e2e-headed-fixture | spec:122-149 | PP, 2A, 2D, HB, UA | Frame counters only; no human observation |
| 7 Pause | partial | e2e-headed-fixture | spec:416-425 | PP, 2A, 2D | Fixture only |
| 8 Seek barrier/acks | partial | e2e-headed-fixture | spec:156-166 | PP, 2A, 2D, LA | Provider backward seek is a direct currentTime write |
| 9 Participant control | partial | e2e-headed-fixture | spec:214-231 | 2D, 2A, PP, LA | Lease transfer only |
| 10 Reload/rehydration | partial | e2e-headed-fixture | spec:236-256 | 2D, PP, 2A, LA | No E2E reloads a page |
| 11 Network interruption | partial | e2e-headed-fixture | spec:236-256 | NET, 2D, PP | A test-route close is not a network fault |
| 12 Player replacement | partial | e2e-headed-fixture | spec:170-183 | PP, HB, 2D | Element/frame/document rebinding is unit-only |
| 13 Leave cleanup | partial | source-review | service-worker.ts:904-931 | 2D, LA | No leave test exists (re-check lowered from unit) |
| 14 Evidence classes separated | missing | doc-only | templates | 2D, PP, UA | The plan's field list omits several classes |
| 15 Two authorized states | partial | doc-only | research notes:3-16 | 2A, PP, LA | No second state; storageState dropped |
| 16 Candidate and coordinator identity | partial | doc-only | run 35387667519 | DEP, 2D | Coordinator predates 0.2.5 |
| 17 User acceptance | missing | none | — | UA | |
| Extra: extend test:e2e to the provider | partial | source-review | PR #71 | 2A, PP, LA | Likely cannot pass as written |
| Extra: dedicated CI job | partial | source-review | e2e-crunchyroll.yml | 2A, PP, LA | 0 runs; headless bundled Chromium |
| Extra: SYJ-AUD-009 closed | missing | none | CODE_AUDIT.md:119 | PP, 2A, 2D, UA | |

**Closure blockers:**
- Harness never executed with provider inputs.
- storageState is dropped (confirmed by reading Playwright 1.63.0 source).
- No second state; no confirmed entitled URL.
- DRM/Widevine and Cloudflare-challenge risks (plausible).
- Checklist items 3, 5, 8–14 are not covered by the harness.
- No two-device run, no coordinator identity, no separated report, no user acceptance.

**Next actions:**
- Local: add `setStorageState` with a dummy-state test; add a channel option and headed mode; extend the spec (identity, barrier/ack, reload, leave); fill a separated report; make artifact-reporter report "skipped" when every test skipped.
- External: second state and secrets; entitled URL; coordinator identity or redeploy; the 10-step two-device run; user acceptance.

**Discrepancies:**
- storageState is silently ignored, although PR #71 claims "protected storage-state injection".
- `global-setup` always uses a local coordinator; TEST_GUIDE:290 does not say so.
- The safe-skip run-summary reports outcome "passed".
- The issue title and body still describe only the harness; the stricter closure rule lives only in comments.
- The plan asks for `seeking`, which the extension does not expose; panel Position is floored to whole seconds.

### #34 — Real two-device network-chaos and reconnect testing
**Summary:** OPEN. Last recorded blocker "Missing device" (unverified). Only a docs template exists.

**PRs:**
- #74 8a1b405 (2026-09-20), 5/5 green.
- Supporting: #96 1d22c5b and #17 74609be, both 5/5 green.

**Reports:** blank template; TEST_GUIDE Test D/G (weaker pass bar); CR_D03 local reconnect claim.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| 1 Clean baseline first | missing | doc-only | template:44-59 | 2D, DEP, UA | |
| 2 Throttling/latency | partial | unit | network-chaos.test.ts; connection-quality.test.ts:9 | 2D, NET, DEP, UA | Simulated only |
| 3 Offline during playback | partial | unit | room.test.ts:375 | 2D, NET, DEP, UA | DevTools offline is not a valid fault (CR_D03:68). An OS-level drop may never reach the coordinator as a disconnect (§7 item 9) |
| 4 Offline during pending play | partial | unit | room.test.ts:1397 | 2D, NET, DEP, UA | No explicit disconnect-while-pending test; coordinator may not see the drop (§7 item 9) |
| 5 Offline during pending seek | partial | unit | network-chaos.test.ts:70 | 2D, NET, DEP, UA | Coordinator may not see the drop (§7 item 9) |
| 6 Sleep/wake | missing | doc-only | TEST_GUIDE:121 | 2D, DEP, UA | Template allows "blocked"; the issue does not |
| 7 Background/return | partial | unit | content-script.test.ts:526, 720 | HB, 2D, DEP, UA | |
| 8 Refresh/reconnect | partial | integration | server.test.ts:414 | 2D, DEP, UA | No real tab refresh anywhere |
| 9 Controller disconnect | partial | unit | room.test.ts:375 | 2D, NET, DEP, UA | No test disconnects the host. A network drop starts the 10 s controller grace only if the edge observes the close (worker.ts:192-226) |
| 10 Role swap | partial | unit | room.test.ts:590, 1487 | 2D, DEP, UA | Template has a role column (line 65) |
| 11 Same package on both | missing | doc-only | template:23 | 2D | Only one SHA field |
| 12 Same coordinator endpoint | missing | doc-only | run 35387667519 | DEP | 15 coordinator commits since the deploy |
| 13 No stale resurrection | partial | integration | server.test.ts:453 | 2D, NET, DEP, UA | |
| 14 Pass bar | partial | integration | server.test.ts:307 | 2D, NET, DEP, UA | Native/visible recovery unevidenced |
| 15 Report completed | missing | doc-only | template:142-164 | 2D, DEP, UA | |
| Body: real hardware fault recovery | missing | none | checkpoint:6452 | 2D, NET, DEP, UA | Re-check lowered from partial/unit |
| User acceptance | missing | none | — | UA | |

**Closure blockers:** no device run; Device B unavailable; no OS-level fault method chosen; coordinator identity unproven; coordinator-side disconnect detection for silent outages is unverified and has no server-side deadline; no role-swap, sleep/wake or pending-op fault runs; no native/visible recovery evidence; no user acceptance.

**Next actions:**
- Local: coordinator identity read-back; verify the ZIP and draft SYJ-CHAOS-20260923-001; rehearse an OS-level fault; add template fields (per-device SHA, split row 3, identity-method field); add controller-disconnect and pending-op disconnect tests; add a room-service or edge test for a silent client outage (socket left open, no pings, no reports); plan fault rows long enough (at least 90–120 s) to exercise the server close path.
- External: Device B; deploy or record the coordinator; run the full matrix with role swaps; user acceptance.

**Discrepancies:**
- Checkpoint 8208 treats the endpoint as the candidate without recording identity.
- TEST_GUIDE D/G use a weaker pass bar.
- The "documentation" label is applied to a manual acceptance issue.
- Invalid SHAs, cross-cutting (§7).

### #35 — Headed-browser cross-platform verification pass
**Summary:** OPEN, last recorded as Blocked. Only a template exists.

**PRs:**
- #75 6d0d009 (2026-09-20), 5/5 green. Author-only reviews; admin merge.
- Supporting: #96, 5/5 green.

**Reports:** blank template; TEST_FIXTURE; CR_A02 (headed Edge attempt BLOCKED by the browser-control policy); `verify-browser-packages` (Safari skipped in CI because xcrun is unavailable).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| 1 Shadow DOM discovery | partial | unit | video-discovery.test.ts:26 | HB | E2E shadow test runs without the extension |
| 2 Shadow play/pause/seek | partial | source-review | content-script.ts:474 | HB | |
| 3 SPA URL change | partial | unit | content-script.test.ts:731 | HB | Raised from source-review |
| 4 SPA replacement | partial | unit | player-tab.test.ts:30 | HB | |
| 5 Competing videos | partial | unit | player-tab.test.ts:34, 57 | HB | videoCandidateScore untested |
| 6 Lock UI | partial | unit | service-worker.test.ts:555 | HB | Toggle only, no picker |
| 7 Nested frame | partial | unit | content-script.test.ts:104-186 | HB | Edge attempt blocked by policy |
| 8 Ready/play/pause/seek | partial | e2e-headed-fixture | two-profile-sync.spec.ts:160-175; runs e2e-1790023961882 (headless) and e2e-1790024025583 (headed), both passed, both dirty trees | HB | Backward seek is asserted (the initial audit was wrong). Playwright bundled Chromium, not a human-operated branded browser |
| 9 Reload/source replace | partial | unit | content-script.test.ts:761 | HB | |
| 10 Visible playback | missing | doc-only | CR_D03:58 | HB, UA | |
| 11 Diagnostics identity | partial | unit | sidepanel.ts:553-583 | HB | |
| 12 Reconnect/readiness | partial | integration | server.test.ts | HB, DEP | Template has no Chrome/Edge row for it |
| 13 Fixture before provider | missing | doc-only | template:13 | HB | |
| 14 Firefox | partial | unit | protocol index.test.ts:332 | FF, HB, DEP, UA | Package build only. Firefox 156.0.1 is installed on Device A, so a real-install run is local work |
| 15 Safari | partial | unit | index.test.ts:333 | SX, HB, UA | No Xcode build or runtime |
| 16 Not completed from packaging alone | complete | source-review | issue OPEN | — | Guard holds |
| Extra: filled report identities | missing | doc-only | template:15-32 | LA, HB | |
| Extra: deferral records | missing | none | template:131-143 | LA, UA | |
| Extra: deployment gate | missing | none | run 35387667519 | DEP | |
| Extra: user acceptance | missing | none | — | UA | |

**Closure blockers:** no headed branded Chrome/Edge rows; no visible-motion observation; no Firefox or Safari runtime or deferral; no filled report; deployment gate open; no user acceptance.

**Next actions:**
- Local: human-operated headed Chrome/Edge rows 1–10; add a reconnect row; extension-loaded lifecycle spec; Safari packager run into a retained directory; Firefox: build a separate package with `SYNCYOURJOY_ROOM_SERVER_URL=wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms npm run build:extension:firefox`, record its hash and commit, and complete the template's Firefox real-install section in Firefox 156.0.1, or record Firefox NOT CLAIMED (deferred). BLOCKED does not apply, because the runtime is installed.
- External: Firefox support decision; coordinator identity; Safari signing if claimed; user acceptance.

**Discrepancies:**
- The "Missing device" blocker is imprecise; the recorded Edge block came from the control surface.
- `adaptive-fixture.spec.ts:52` runs without the extension.
- The generic fixture streams from MDN.
- The release notes' Safari verification claim is not backed by the tag CI run.

### #49 — CR-A02: One identity decision for all player layouts
**Summary:** OPEN; project status last recorded 2026-09-20 as In Progress. Identity logic is unit-proven; there is no nested-frame real-browser run.

**PRs:** #70 7451307, #76 d497473, #83 c3fc7bc, each 5/5 green.

**Reports:** CR_A02 report (partial; candidate 0.2.4 d3053f2, sha 205d1233…; says "release not authorized"); CR_D03; CR_D02.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Strong identity matches | partial | e2e-headed-fixture | CR_D03:121 | PP, HB | Generic top document only |
| Strong mismatches | partial | unit | player-identity.test.ts:49-77 | HB, PP | Test reaches the worker-binding branch |
| Unresolved identities | partial | unit | player-identity.test.ts:31-47 | LA, HB | |
| Top-document players | partial | e2e-headed-fixture | CR_A02:84 | PP, HB | |
| Origin-only iframe | partial | unit | content-script.test.ts:126-145 | HB, PP | |
| Generic nested embeds | partial | unit | content-script.test.ts:146-165 | LA, HB | Nested fixture exists since #95; never run |
| Qfilm nested | partial | unit | content-script.test.ts:166-178 | PP, HB | |
| Selected-frame binding | partial | e2e-headed-fixture | run e2e-1790024025583 (headed, dirty tree; top document only); player-tab.test.ts (unit) | HB, LA, PP | Frame 0 only in E2E; embedded-frame selection is unit-only |
| Unrelated-frame rejection | partial | unit | player-tab.test.ts:57-78 | LA, HB | |
| Episode-change protection | partial | unit | content-script.test.ts:731-759 | PP, HB | |
| No stale-frame authority | partial | unit | service-worker.test.ts:454-666 | HB, LA | |
| Headed observation with a usable player | missing | none | c5761713725 | HB, PP, LA | Two failed attempts |
| AC2: four layouts consistent | partial | unit | content-script.test.ts:346-392 | HB, PP | |
| Verification: focused tests | complete | unit | CI 35663363774 | — | |
| Verification: D02/D03 nested case | missing | none | CR_A02:131 | LA, HB | The gate named in the issue |
| User acceptance | missing | none | — | UA | |

**Closure blockers:** nested real-browser case missing; headed rows BLOCKED or NOT CLAIMED; stale candidate; no user acceptance.

**Next actions:**
- Local: extension spec for the nested fixture (`adaptive-player.html`, `#open-nested` button) run headed; strong-provider "match" tests.
- External: user loads the verified ZIP in Edge; find an entitled URL; coordinator identity; user acceptance.

**Discrepancies:**
- v0.2.5 shipped CR-A02 code despite the report's "Not authorized" line (RELEASING.md:105).
- The BLOCKED cause is misattributed; the real gap was the missing fixture.
- E2E runs used rebuilt packages, not the recorded one.
- The issue body still says "not started".

### #50 — CR-A03: Operation ownership through cancellation and timeout
**Summary:** OPEN; project status last recorded 2026-09-20 as Verification.

**PRs:** #70, #77 ff30dfb, each 5/5 green.

**Reports:** blank template.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| One in-flight write | partial | unit | player-operations.test.ts:5-13 | HB, PP | |
| Command/source generation | partial | unit | content-script.test.ts:205 | LA, HB | Re-check lowered from complete |
| Late seeked | partial | unit | content-script.test.ts:773-805 | HB, PP | |
| Late play resolution | partial | unit | content-script.test.ts:422-460 | HB | |
| Late play rejection | partial | unit | content-script.test.ts:411-420 | HB | |
| Timeout behavior | partial | unit | seek-barrier.ts:12 | HB, PP, LA | No test at the 1,500 ms boundary |
| Cancel after pause | partial | unit | content-script.test.ts:829-839 | HB | |
| Cancel after media change | partial | unit | content-script.test.ts:731-771 | HB, PP | |
| Cancel after room exit | partial | source-review | content-script.ts:317 | LA, HB | |
| Cancel after controller change | partial | source-review | content-script.ts:315-316 | LA, HB | |
| No stale callback becomes intent | partial | unit | content-script.test.ts:773-805 | HB, PP | |
| Genuine Skip Intro/seek propagates | partial | e2e-headed-fixture | CR_D03:22 | PP, HB | |
| Verification: Vitest cases | partial | unit | CI 35663363774 | LA | At-timeout case missing |
| Headed rows / filled report | missing | none | template:79-90 | LA, HB, PP | |
| 2A/2D/DEP/UA | missing | none | c5750269842 | 2A, 2D, DEP, UA | |

**Closure blockers:** blank report; controller and detach retirement untested; no headed rows; #49 open; no deployment; external gates open.

**Next actions:**
- Local: controller-change and null-snapshot tests; boundary test; headed template rows 81–89.
- External: provider pass, 2A/2D, coordinator, user acceptance.

**Discrepancies:** comments 5750269842 and 5761728488 claim controller/detach test coverage that does not exist; merged before #49 was accepted.

### #51 — CR-A04: Atomic player binding across async work
**Summary:** OPEN; project status last recorded as Verification.

**PRs:** #70, #78 8532c96, each 5/5 green.

**Reports:** blank template that PR #78 and the comments call "detailed".

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| No replacement mid-async | partial | unit | service-worker.test.ts:454-666 | LA, HB | Lowered from complete; row 82 has no test |
| Old events cannot update new binding | partial | unit | service-worker.test.ts:479-600 | HB, SX, FF, PP | Fallback path tested only with mocks |
| Selected player authoritative | partial | e2e-headed-fixture | CR_D03:18, 21 | PP, HB | |
| Unrelated frames rejected | partial | unit | player-tab.test.ts:57-78 | LA, HB | |
| Binding and operation change together | partial | unit | service-worker.ts:1117-1206 | LA, HB | |
| Verification: reordered-promise tests | complete | unit | CI 35663363774 | — | |
| Verification: typecheck | complete | source-review | CI 35663363774 | — | Checks types, not runtime behavior |
| Headed/provider gate | missing | none | template:111-124 | LA, HB, PP | |
| 2A/2D/DEP/UA | missing | none | template:121-124 | 2A, 2D, DEP, UA | |

**Closure blockers:** blank matrix; no different-frameId test; no non-Chromium runtime; #49 open; no deployment; external gates.

**Next actions:**
- Local: forged-token and different-frameId tests; headed replace/route fixture run; Safari fallback run; Firefox fallback run in the installed Firefox 156.0.1 with a separate endpoint-explicit `build:extension:firefox` package.
- External: provider SPA replacement; 2A/2D; coordinator; user acceptance.

**Discrepancies:** "detailed report" is a blank template; the local 0.2.4 hash is superseded; shipped in v0.2.5 with deterministic evidence only.

### #52 — CR-A05: Bounded drift correction and convergence
**Summary:** OPEN; status Verification (inferred from comment and timeline).

**PRs:**
- #79 f03f4c4, 5/5 green.
- #70 partial evidence.
- #96 supporting.
- All REVIEW_REQUIRED at merge; admin merges.

**Reports:** blank template.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Bounded policy | complete | integration | content-script.test.ts:618-660 (source content-script.ts:656-702) | — | Budget is per command |
| No indefinite writes | partial | integration | content-script.test.ts:612-660 | HB, PP, 2D | D03 induces no drift |
| Converge within tolerance | missing | source-review | content-script.ts:1003, 1087-1092 | LA, HB, PP, 2D | Source trace suggests slow seeks end in paused recovery |
| No oscillation | partial | integration | content-script.test.ts:612-660 | LA, HB, PP | |
| Stable pause/seek/resume | partial | integration | content-script.test.ts:573-610 | LA, HB, PP | |
| Visible progress matches | missing | none | template:37-42 | HB, PP, 2D, UA | |
| Body: stop hard-seek cycling | partial | integration | content-script.ts:691-702 | HB, PP | |
| Body: soft-rate gating | partial | integration | clock.test.ts:68-113 | LA, HB, PP | Throwing setter untested |
| Body: 30 s simulations | complete | integration | CI 35663363774 | — | Only the "end paused" branch is exercised |
| Verification: D03 plus template gates | partial | e2e-headed-fixture | test-results e2e-1790024025583 | HB, PP, 2A, 2D, DEP, UA | |

**Closure blockers:** convergence not demonstrated; no induced-drift browser run; no provider rate evidence; untested claims from PR #79; external gates; #50 open.

**Next actions:**
- Local: advancing fake-player latency test; decide on a latency-compensated seek target and budget re-arm; induced-drift fixture run.
- External: 2A/2D/DEP/UA.

**Discrepancies:** soft rate removes only about 50 ms; hard seek has no latency lead; "rendered progress" is in fact clock-capable.

### #53 — CR-A06: Stable and consistent health evidence
**Summary:** OPEN; status Verification (inferred).

**PRs:**
- #80 5830121, 5/5 green.
- Supporting: #86 c914922, #87 c2ea547, #96. #96 changed the health code.

**Reports:** blank template.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Healthy playback with reports | partial | e2e-headed-fixture | spec:143-149 | HB, PP | |
| Missing reports | partial | integration | server.test.ts:307-359 | HB, DEP, NET | Evidence comes from B04/B05 |
| Silent or frozen playback | partial | integration | content-script.test.ts:488-496 | LA, HB, PP | rVFC path untested |
| Delayed reports | partial | unit | room-streaming-regressions:182 | NET, HB, DEP | |
| Reconnect during evaluation | partial | integration | content-script.test.ts:498-524 | LA, NET, HB | |
| Coordinator vs native health | partial | integration | playback-status.ts:35-63 | LA, HB, PP | progressEvidence is ignored |
| No false healthy when frozen | partial | integration | player-health.ts:202-206 | LA, HB, PP, 2D | Clock-only progress yields "confirmed" |
| Body: independent accumulation | partial | integration | content-script.ts:885-972 | LA | Lowered from complete |
| Body: counter cases | partial | unit | player-health.test.ts:24-131 | LA | Throwing counter untested |
| Body: hidden/PiP/stalled | partial | integration | content-script.test.ts:526 | LA, HB | No PiP or hidden-iframe coverage |
| Verification: real browser plus gates | partial | e2e-headed-fixture | CR_D03:117-121 | HB, PP, 2A, 2D, DEP, UA | |

**Closure blockers:** false-healthy path; untested rVFC bypass; no PiP; no provider or visible evidence; external gates; #50 and #51 open.

**Next actions:**
- Local: fake-rVFC tests; make "confirmed" require frame evidence; hidden/PiP fixture run.
- External: DRM black-output case; 2D; coordinator redeploy; user acceptance.

**Discrepancies:** PR #80 overclaims PiP and throwing-counter coverage; test 526's title contradicts its assertion; the CHANGELOG lists fixes that are not deployed.

### #54 — CR-A07: Seek barrier deadline and quorum holes
**Summary:** OPEN; status Verification (inferred).

**PRs:**
- #81 43a5557, 5/5 green.
- #70, #84 f540b41, #96 supporting.
- REVIEW_REQUIRED at merge; admin merges.

**Reports:** CR_A07 report (deterministic evidence only; stale head, version, repeated-ACK claim, and does not reflect the 3 s window).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Late acks | complete | unit | room-streaming-regressions:50-73 | DEP | Not live |
| Missing acks | complete | unit | room.test.ts:299-324 | DEP | |
| Disconnect during seek | partial | source-review | room.ts:955-968 | LA, NET, HB | |
| Controller change during seek | partial | unit | room-streaming-regressions:112-141 | LA, HB | transferDisconnectedController untested (lowered) |
| Deadline expiry | complete | unit | room.test.ts:299-324 (releaseExpiredSeek at the deadline; constant seek-barrier.ts:11) | DEP | |
| Quorum changes | partial | unit | room.ts:599-602 | LA | Legacy quorum is recomputed |
| No indefinite barrier | partial | unit | alarm.ts:30-44 | DEP, HB, 2D | Deployed 1ac5b1c lacks receipt-time checks |
| Safe pause after incomplete seek | partial | unit | room.ts:623-638 | HB, PP, UA | |
| No stale result applied | complete | integration | room.test.ts:254-279 | — | |
| Body: receipt-time expiry | complete | unit | room-streaming-regressions:50-73 (ACK received at the deadline; source room.ts:578-587) | DEP | |
| Body: never resume after member fails | partial | unit | room-streaming-regressions:75-141 | LA | |
| Body: fixed target, deduplication | partial | unit | network-chaos.test.ts:70-92 | LA | Duplicate legacy ACK untested |
| Verification: fuzz / red-before-green | partial | unit | room.fuzz.test.ts | LA | No barrier invariants |
| Project gates | partial | e2e-headed-fixture | spec:152-168 | HB, DEP, 2A, 2D, UA | Happy path only |

**Closure blockers:** not deployed; hole regressions missing; dynamic quorum; no browser test of the holes; stale report.

**Next actions:**
- Local: regressions and fuzz invariants; room-service expiry test; correct the report; headed mid-seek transfer run.
- External: deploy; 2D run; 2A; user acceptance.

**Discrepancies:** "fixed quorum" claim is inaccurate for the legacy path; the 21b5308 self-reference; PR #96 changed the window after acceptance.

### #55 — CR-B01: Operation identity and compatibility contracts
**Summary:** OPEN; status Verification per comment (unverifiable).

**PRs:**
- #82 d3053f2, 5/5 green, author review only.
- #89 94924c5 supporting, 5/5 green.

**Reports:** CR_B01 contract (stale: says "ready for review"; line 75 overclaims coverage).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Stable operation identity | complete | integration | server.test.ts:132 | — | Durable Object path untested |
| Idempotent repeats | complete | unit | room.test.ts:175, 1146, 1309 | — | |
| Stale operations rejected | partial | unit | room.test.ts:1302, 1343, 1397 | LA | Operation-id and epoch rejection tested; binding and sequence guards untested (class lowered) |
| Mixed-version explicit | partial | integration | server.test.ts:239 | LA, DEP, 2D | No real old builds |
| Incompatible capabilities fail safe | partial | integration | index.test.ts:409, 426 | LA | "unsupported-peer" never assigned |
| Identity across boundaries | partial | integration | server.test.ts:132 | LA, DEP, PP | Edge Durable Object path is source-review only |
| AC: fields and bounds | complete | unit | index.test.ts:174, 361, 383 | — | |
| AC: ordering vs validity, defaults | complete | unit | room.test.ts:889, 919, 948 | — | |
| AC: no implicit ack or downgrade | partial | integration | room.ts:442-445 | LA | Downgrade half is source-review only |
| Verification: tests plus contract review | partial | unit | PR #82 reviews | OT | Lowered; self-review only |
| Browser/UA gates | missing | none | c5751320979 | HB, DEP, UA | |

**Closure blockers:** no real mixed-version builds; mid-operation legacy peer untested; binding and sequence guards untested; Durable Object path untested; no deployment; no independent review; #49–#54 open.

**Next actions:**
- Local: the tests above; v0.2.4/v0.2.5 two-profile run; run against a 1ac5b1c room-service; fix the doc.
- External: deploy; mixed-version 2D run; independent review; user acceptance.

### #56 — CR-B02: Prepare and commit playback in the coordinator
**Summary:** OPEN; status Verification per comment.

**PRs:**
- #84 f540b41, 5/5 green.
- #85 b36d33d, #86 c914922 and #96 carry required fixes, all 5/5 green.
- Admin merges.

**Reports:** CR_B02 report (stale lines 6 and 41); TEST_GUIDE:59 production-smoke claim is stale.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Prepare distinct from commit | complete | integration | server.test.ts:132 | — | |
| Required participants | complete | integration | server.test.ts:207-208 | — | |
| Controller ownership | partial | e2e-headed-fixture (positive half); unit (rejection half) | matrix spec:214-231 (run e2e-1790024025583); room.test.ts:590, 1397 | LA | Positive half (lease transfer and control by the new controller) only in E2E; rejection of member and stale-lease controls is unit-only |
| No commit from stale prepare | complete | unit | room.test.ts:1302, 1397 | — | |
| Failed prepare does not partially apply | complete | unit | room.test.ts:1397-1414 (deadline in prepare fails closed, paused at target); room.test.ts:1343-1369 (source room.ts:550-567) | — | |
| Commit visible to extension | partial | e2e-headed-fixture | sidepanel.ts:554-573 | DEP, PP | Production would run legacy |
| AC: paused until all prepared | complete | unit | room.test.ts:1120 | — | |
| AC: commit once, cancel on pause etc. | partial | integration | room.ts:1074-1085 | LA | Controller-pause cancel untested (lowered) |
| AC: explicit recovery target | complete | unit | room.test.ts:1371 | — | |
| Verification list | complete | unit | room.test.ts:1119-1426 | — | Depends on #96 tests |
| Downstream gates | missing | none | c5752016512 | PP, 2A, 2D, DEP, UA | |

**Closure blockers:** not deployed; pause-cancel untested; controller-ownership rejection not exercised in a browser; no provider, 2A/2D or user acceptance; #55 open.

**Next actions:**
- Local: pause-cancel test; headed matrix asserting `contract.mode==='transactional'` and a rejected member control; fix docs.
- External: deploy plus smoke:edge; two-device run; user acceptance.

**Discrepancies:** the smoke script now requires transactional mode, so it cannot pass against the recorded coordinator.

### #57 — CR-B03: Preparation and start confirmation in the extension
**Summary:** OPEN; status Verification per comment.

**PRs:** #85 b36d33d, 5/5 green; #96 supporting (changes started evidence).

**Reports:** CR_B03 report (stale pre-merge sections).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Receives preparation | partial | unit | content-script.test.ts:271 | PP, DEP, HB | Implied, not asserted, in E2E |
| Native player prepared | partial | e2e-headed-fixture | content-script.ts:1309-1320 | PP, HB | Fixture player only |
| Start confirmation timing | partial | unit | player-health.ts:187-207 | PP, HB, LA | Started ACK can rest on clock-only progress |
| Autoplay rejection clears readiness | partial | unit | room.test.ts:779 | HB, PP | Lowered from E2E |
| Failed start visible to room | partial | unit | room.test.ts:1343 | LA, PP, 2D | Lowered |
| No repeated identical failure | partial | unit | room.test.ts:779 | LA, PP | Lowered; only NotAllowedError is guarded |
| Readiness not falsely positive | partial | unit | room.ts:934-937 | LA, PP, HB | |
| AC: forward and align identity | partial | integration | server.ts:435-439 | PP, DEP, LA | Rejected ACKs never retried |
| AC: started only from useful progress | partial | unit | content-script.ts:1396-1426 | PP, HB | |
| AC: gesture recovery and cancellation | partial | source-review | content-script.ts:704-719 | LA, HB, PP | |
| Verification: suites | complete | unit/integration | CI 35663363774 | — | ci.yml runs only `npm run check` (typecheck, Vitest, build), `verify:browser-packages` and `npm audit`; hosted CI never runs Playwright |
| Verification: local scenario | partial | e2e-headless | CR_B03_EXTENSION_ACK_REPORT.md:253-257 (`npm run test:e2e -- --grep "profile A creates a room"`, pass) | LA | Pre-merge branch run; no retained run directory and tree state unrecorded; transactional mode not asserted |
| Remaining gates | missing | none | c5752504185 | PP, 2A, 2D, DEP, UA | |

**Closure blockers:** no real autoplay or provider run; clock-only started ACK; untested gesture and cancel paths; no ACK retry; not deployed; external gates; six dependencies open.

**Next actions:**
- Local: transactional unit tests; frames-only decision; ACK rejection feedback; matrix assertions; fresh-profile autoplay run in Chrome, Edge and Safari.
- External: deploy; two-device protocol; user acceptance.

### #58 — CR-B04: Health evaluation without incoming reports
**Summary:** OPEN; status Verification, corroborated by a timeline event at 2026-09-20T21:20:14Z.

**PRs:**
- #86 c914922, 5/5 green (280 tests); owner review on final head 7145d88, then the authorized administrative merge path.
- #70 7451307 (no reviews).

**Reports:** CR_B04 report (stale status); Checkpoint 73 exists only on a branch.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Evaluable without reports | partial | integration | server.test.ts:307 | DEP, LA | Lowered; deployed 1ac5b1c has no evaluator |
| Silent player detected | partial | integration | room-streaming-regressions:242 | LA, HB, PP, DEP, 2D | |
| No-progress vs paused | partial | unit | player-health.test.ts:24 | LA, HB, PP | Clock-only counts as progress |
| Missing evidence not success | partial | unit | room.ts:852-861 | LA, HB, PP | Equal-timestamp duplicates accepted |
| Visible and recoverable | partial | integration | participant-status.test.ts:66 | HB, UA | |
| Body: deterministic deadlines | complete | unit | room-streaming-regressions:242-337 | — | |
| Body: sample identity validation | partial | unit | room.ts:434-475 | LA | player_status not validated server-side |
| Body: one pause per episode | complete | integration | server.test.ts:354-358 | — | |
| Verification: injected-clock list | partial | unit | — | LA | Pings-only and duplicate-status tests missing |

**Closure blockers:** no server-side sample validation; clock-only progress accepted; two tests missing; no browser, provider or deployment evidence; no user acceptance.

**Next actions:**
- Local: add the missing tests; frozen-frame fixture; merge Checkpoint 73.
- External: deploy and record the Worker version; stalled-player provider run; Device B; user acceptance.

### #59 — CR-B05: Health deadlines in the local server
**Summary:** OPEN; status Verification (timeline-corroborated).

**PRs:** #87 c2ea547, 5/5 green (server.test.ts 14 tests); owner reviews on 5c1e382 and final head d2c1f5f, then the authorized administrative merge path.

**Reports:** CR_B05 report (stale). Checkpoint 74 exists only on a branch, yet context-checkpoint.md:5105 claims it is preserved on main.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Timer deadlines applied | complete | integration | server.test.ts:307-360 | — | |
| Deterministic expiry | partial | integration | server.ts:502-506 | LA | Only the health path is socket-tested |
| No duplicate transitions | complete | integration | server.test.ts:354-358 | — | |
| Disconnected participants | partial | integration | server.test.ts:65, 414, 453 | LA | No test combines disconnect with a pending deadline |
| Transport and state machine agree | partial | integration | server.test.ts:132, 354 | LA | Lowered from complete |
| Body: negotiated dispatch | partial | integration | server.test.ts:132 | LA | |
| Verification: socket tests | complete | integration | CI 35539684400 | — | Raised |

**Closure blockers:** no socket tests for seek/op expiry or multi-participant silence; no browser evidence; no user acceptance.

**Next actions:** WebSocket tests; injectable clock; fix the checkpoint note.

### #60 — CR-B06: Edge alarms and rehydration preserve health semantics
**Summary:** OPEN. The project move to Verification never happened (no status event after 2026-09-20T22:31:41Z).

**PRs:** #88 53046e4, 5/5 green (alarm.test.ts 7 tests).

**Merge history:**
- Owner review comments were submitted on e1e7d65 and on the exact final head ca17d4b, and all five hosted checks passed.
- ca17d4b (Checkpoint 75, 2026-09-21) records that GitHub's approval rule refused a normal merge because the author cannot approve their own PR, and that the administrative merge was withheld pending explicit user authorization for that exact action.
- After that authorization, the authorized administrative merge path was used. The approval requirement itself was never satisfied by a second reviewer.

**Reports:** CR_B06 report (stale; omits the per-ping write cadence).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Survives alarms/rehydration | partial | unit | alarm.test.ts:124 | LA, DEP | Durable Object never instantiated |
| Expiry does not regress | partial | unit | alarm.test.ts:45, 173 | LA, DEP | |
| Operation/readiness preserved | partial | unit | room.test.ts:948, 1397 | LA, DEP | |
| Edge identity recorded | missing | none | run 35387667519 | DEP | |
| Dry run not presented as deployment | partial | doc-only | CHANGELOG.md:21, :26; v0.2.5 release notes | DEP | Edge fixes are listed as release content (line 21) without an undeployed caveat; line 26 disclaims only "production deployment acceptance"; coordinator still 1ac5b1c |
| Body: schedule, persist | partial | unit | alarm.test.ts:68-110 | LA, DEP | |
| Body: write cost documented | partial | source-review | worker.ts:412-425 | LA | |
| Verification: Cloudflare harness plus staging | partial | unit | alarm.test.ts | LA, DEP | |

**Closure blockers:** no workerd or staging run; no Worker id; production not redeployed; release text lists edge fixes without an undeployed caveat; status move pending; no user acceptance.

**Next actions:**
- Local: vitest-pool-workers tests; document the cadence.
- External: staging deploy; production version check; project status move in the UI (user action).

### #61 — CR-B07: Mixed versions and stored-state migration
**Summary:** OPEN; project status never set beyond the automation default.

**PRs:** #89 94924c5, 5/5 green (292 tests); admin merge. No edge-service files changed.

**Reports:** CR_B07 report (stale; no rollback section). Checkpoint 78 exists only on a branch; main line 4577 still says "not merged".

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Old/new versions interact | partial | integration | server.test.ts:239 | LA, DEP | Old-server/new-client untested |
| Stored state migrates | partial | unit | room.test.ts:889, 919 | LA, DEP | |
| Unsupported state rejected | partial | unit | room.ts:62, 203 | LA | stateVersion never validated |
| No stale resurrection | partial | unit | room.test.ts:889-946 | LA, DEP | Lowered; fixtures are synthetic |
| Rollback understood | partial | integration | REMEDIATION_PLAN:248 | LA, DEP | Coordinator rollback not analyzed |
| Versions recorded separately | missing | none | release notes | DEP | Provenance SHA invalid |
| Body: negotiation, upgrade-required | partial | integration | server.test.ts:239 | LA | |
| Verification: retained fixtures, staging | partial | integration | smoke-room-service.mjs:249 | LA, DEP | Smoke cannot target the old coordinator |

**Closure blockers:** likely live combination (old server, new client) untested; no edge tests; no rollback fixtures; no stateVersion check; no identity; no staging; no user acceptance.

**Next actions:**
- Local: 1ac5b1c room-service fixture; retained old-shape records; Miniflare tests; stateVersion validation.
- External: staging smoke; release-note SHA correction (user authorization).

### #62 — CR-C01: Explicit Sync recovers stalled play attempts
**Summary:** OPEN.

**PRs:** #90 b5e7c5d, 5/5 green (run 35603029217).

**Reports:** CR_C01 report (stale pre-PR state).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Stalled attempt detected | partial | unit | content-script.test.ts:422-457 | LA, HB, PP | No fixture can hang play() |
| Recovery bounded | partial | unit | content-script.test.ts:436-446 | HB, PP | |
| Room not permanently waiting | partial | unit | room.test.ts:1174-1175 | HB, PP, DEP | |
| Recovery explained | partial | source-review | content-script.ts:1204 | LA, HB, UA | |
| Retry creates no stale op | partial | unit | content-script.test.ts:447-457 | HB, PP | |
| Waiting vs failed vs recovering | partial | unit | playback-status.test.ts:31-39 | LA, HB, UA | Card shows "Buffering" |
| Body: classify failure causes | partial | e2e-headed-fixture | spec:171-200 | LA, HB, PP | Synthetic NotAllowedError |
| Body: late callbacks, no loops | partial | unit | content-script.test.ts:447-457 | LA, PP | |
| Provider rate via A05/D04 | missing | none | #52, #33 | PP, 2A, 2D | |
| Boundary gates | missing | none | c5761018036 | PP, 2A, 2D, DEP, UA | |

**Closure blockers:** no hang fixture; recovery status indistinct; MediaError unclassified; no genuine NotAllowedError; no provider run; not deployed.

**Next actions:**
- Local: add a hang control to test-player.html plus a matrix scenario; map timeouts to recovery-required; emit provider-error.
- External: deploy; D04 run; user acceptance.

### #63 — CR-C02: Diagnostic reports explain operation failures
**Summary:** OPEN.

**PRs:** #91 a9e8b08, 5/5 green.

**Reports:** CR_C02 doc (stale; test count mismatch, 107 vs 102).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Identify failed operation | partial | unit | service-worker.test.ts:689-790 | LA, PP | |
| Distinguish failure types | partial | unit | service-worker.ts:771, 1321-1350 | LA | Snapshot reason mapping never matches |
| No credentials in reports | partial | unit | service-worker.test.ts:763-790 | LA, PP | |
| Useful next action | missing | none | protocol index.ts:315-351 | LA | |
| Sanitized and reproducible | partial | unit | diagnostics-budget.test.ts | LA, HB | 10 local capture attempts timed out |
| Body: critical transitions kept | partial | unit | diagnostics-budget.test.ts:54-67 | LA | |
| Body: same health interpretation | partial | source-review | service-worker.ts:1391 | LA | |
| Verification: two-profile reports | missing | none | test-results | LA, HB | |
| Gates | missing | none | c5761592474 | PP, DEP, UA | |

**Closure blockers:** dead reason codes; no next action; no browser-captured report; no provider inspection or deployment.

**Next actions:**
- Find why the harness download wait expired. The timeout that fired is Playwright's 12 s `waitForEvent('download', { timeout: 12_000 })` at three-profile-browser-matrix.spec.ts:344, not a product timeout. The product collects for up to 8 s (`DIAGNOSTIC_COLLECTION_TIMEOUT_MS`, service-worker.ts:25) and then hands the file to `chrome.downloads`.
- Emit the reasons and normalize snake_case; add a next-action mapping; capture two-profile reports.
- Risk: no real-browser download of the current (post-PR #91) report has been recorded. Pre-remediation 0.1.x builds did download reports in August 2026 (context-checkpoint.md:410, 649). This puts the session kit's R1–R5 capture at risk.

### #64 — CR-C03: Waiting and recovery explained in player and panel
**Summary:** OPEN.

**PRs:** #92 a07a31d, 5/5 green.

**Reports:** CR_C03 report (stale; its fullscreen-coverage claim is false).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Waiting explained | partial | unit | playback-status.test.ts:26-39 | HB, PP, UA | |
| Recovery visible | partial | unit | participant-status.ts:49-55 | HB, PP | |
| Autoplay blocks understandable | partial | e2e-headed-fixture | spec:185-200 | HB, PP, UA | Synthetic block; panel shown as a tab |
| Who is waiting and why | partial | unit | room.test.ts:697, 723 | LA, HB, 2D, UA | |
| No false "sync" when unhealthy | partial | unit | content-script.ts:1645-1646 | LA, HB, PP | Hidden tab yields "confirmed" |
| State survives reconnect | partial | source-review | room.ts:248-250 | LA, HB, NET | Reason is dropped on reconnect |
| Body: action matches reason | partial | unit | playback-status.ts:65-90 | LA | No provider-error action |
| Body: fullscreen and restored tabs | partial | source-review | content-script.ts:402-403 | LA, HB | |
| Verification: docked panel | missing | none | extension-profile.ts:118-119 | HB, PP, UA | |
| Gates | missing | none | c5762391438 | PP, 2A, 2D, DEP, UA | |

**Closure blockers:** docked panel unchecked; false-confirmed path; reconnect drops the reason; not deployed; external gates.

**Next actions:**
- Local: manual docked-panel pass on Device A; sidepanel tests; frames-only "confirmed".
- External: deploy; D04 run; user acceptance.

### #65 — CR-C04: Episode changes as a coordinated navigation transaction
**Summary:** OPEN; comment claims Verification (unverifiable).

**PRs:** #93 6667128, 5/5 green (navigation tests pass in CI 35617350001).

**Reports:** CR_C04 report (stale; lines 7 and 39 overclaim).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Manual link creates new epoch | partial | unit | room.test.ts:536-557 | LA, HB, PP, 2D | |
| Old operations cancelled | partial | unit | room.test.ts:1415-1423 | LA, HB, PP | |
| Fresh readiness required | partial | unit | room.test.ts:556 | LA, HB, PP | |
| Localized URLs don't restart | partial | unit | protocol index.test.ts:39 | LA, PP | Weak identity after a transition |
| Guest cannot change content | partial | unit | room.test.ts:493-499 | HB, 2D, PP | |
| Login/unavailable not media | partial | unit | navigation-transaction.test.ts:20-34 | LA, PP | openLink accepts login pages |
| Audio editions not silently accepted | partial | source-review | protocol index.ts:717-739 | LA, PP | |
| No stale consent on rapid nav | partial | source-review | room.ts:786-848 | LA, HB, PP | |
| Controller-follow stays disabled | complete | source-review | navigation-transaction.ts:9 (flag false at the v0.2.5 tag); service-worker.ts:262 (flag wired into the policy) | — | The policy's enabled:false/true guard is unit-tested (navigation-transaction.test.ts:38-47); the flag value itself is source-review |
| Verification: D03 SPA scenario | missing | none | CR_D03:24 | LA, HB | |
| Verification: D04 live path | missing | none | #33 | PP, 2A, 2D, DEP, UA | |

**Closure blockers:** circular gating with #68; weak identity; login pages accepted; missing tests; not deployed.

**Next actions:** navigation matrix scenarios; edge-case unit tests; strong re-key after a transition; real current-lease check; resolve the gating docs.

### #66 — CR-D01: Isolated E2E builds and real failure artifacts
**Summary:** OPEN; status Verification (verified timeline event 2026-09-21T17:18:25Z).

**PRs:** #94 74b6018, 5/5 green (unit only); owner review on final head 3642c06, then the authorized administrative merge path.

**Reports:** CR_D01 doc (narrative; stale 0.2.4).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| E2E builds isolated | complete | e2e-headed-fixture | 72 run dirs | — | Build is test-mode, not the release artifact |
| Parallel runs don't collide | partial | source-review | 0 of 72 runs overlapped | LA | |
| Artifacts identify exact candidate | partial | e2e-headless | global-setup.ts:99-123 | LA | Dirty trees mislabelled |
| Temp outputs separated | partial | e2e-headless | extension-profile.ts:53 | LA | |
| Failure reports sanitized | partial | e2e-headless | 17 error-context.md files | LA | Room codes, local paths, ANSI codes |
| Reproducible from artifact | partial | e2e-headless | e2e-1790010439867 | LA | |
| AC2: trace plus sanitized logs | partial | e2e-headless | e2e-1790016226805 | LA | Lowered; paths and username leak |
| AC3b: launch vs product failure | partial | e2e-headless | artifact-reporter.ts:40-44 | LA | Timeouts unclassified |
| User acceptance | missing | none | — | UA | |

**Closure blockers:** no concurrency proof; provenance gaps; artifact leaks; unclassified timeouts; no replay procedure; no user acceptance.

**Next actions:** concurrent-run test; dirty flag and browser/OS/Node versions in provenance; redaction; timeout classification; demonstrated replay.

### #67 — CR-D02: Controlled adaptive loading and lifecycle fixtures
**Summary:** OPEN; status Verification (verified timeline event). Dependency #66 is open.

**PRs:** #95 950d641, 5/5 green; owner review on final head 44b5692, then the authorized administrative merge path.

**Reports:** CR_D02 doc (line 87 overclaims server-observed delay; stale 0.2.4).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| Controlled delays | partial | e2e-headless | adaptive-fixture-server.test.ts | LA | Server delay proven in Vitest only |
| Lifecycle changes | partial | e2e-headless | adaptive-fixture.spec.ts:52-80 | LA | Extension top-document only |
| Source replacement | partial | e2e-headless | adaptive-player.html:233-237 | LA | No same-element src swap |
| Visibility changes | missing | unit | content-script.test.ts:526 | LA | |
| Permission recovery | partial | e2e-headed-fixture | test-player.html:46 | LA | Delivered by #96; synthetic |
| Fault injection | partial | e2e-headless | adaptive-player.html:137-170 | LA | No playback-time faults |
| Adaptive loading | partial | e2e-headless | adaptive-fixture.spec.ts:29-50 | LA | No starvation |
| Serves #68 without private APIs | partial | e2e-headless | matrix spec:20, 117 | LA | #68 does not use the fixture |
| AC3: deterministic timing, boundary | complete | e2e-headless | adaptive-fixture.spec.ts:29-50 (asserts the 120 ms segment delay and fault events; recorder at adaptive-player.html:61-66) | — | Events not persisted |
| User acceptance | missing | none | — | UA | |

**Closure blockers:** no same-element src swap or starvation test; no extension-driven nested run; fault events not persisted; dependency #66 open; no user acceptance.

**Next actions:** same-element src control; starvation playback test; extension runs on shadow, nested, SPA and replacement; persist fault events.

### #68 — CR-D03: Complete local browser matrix
**Summary:** OPEN; project item **In Progress** (the "Done" belongs to PR #96's own item). Dependencies #54, #61–#65 and #67 are all open.

**PRs:**
- #96 1d22c5b, 5/5 green (unit only); body edited after merge.
- #97 f3215c4 (docs), 5/5 green.
- Both: owner review on the exact final head (73536d0 and 282a784), then the authorized administrative merge path.

**Reports:** CR_D03 doc (thresholds only; 45 red runs unreported; 1.8 s barrier docs are stale).

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| npm run test:e2e executed | partial | e2e-headless | e2e-1790023961882 | LA | Run labelled commit d5ceef7 but its provenance trackedSourceSha256 prefix is af627916 (clean d5ceef7 hashes to 773c452b), so the tree was dirty. No matrix run at the merged head: merge 1d22c5b (PR head 73536d0, tree 847b90a3) hashes to prefix a93f90b2, and the only a93f90b2 run (e2e-1790026537617, labelled 282a784) is a Crunchyroll safe-skip |
| Headed variant | partial | e2e-headed-fixture | e2e-1790024025583 | LA | Pre-final tree |
| Both controller roles | partial | e2e-headed-fixture | spec:214-231 | LA | Faults only with A as controller |
| 2- and 3-member quorum | partial | e2e-headed-fixture | spec:92-125 | LA | Positive paths only |
| Late/missing acks | missing | unit | room.test.ts:299 | LA | |
| Missing status | missing | unit | participant-status.test.ts:66 | LA | |
| Permission recovery | partial | e2e-headed-fixture | spec:185-212 | LA | Synthetic |
| Pending play and pause | missing | unit | content-script.test.ts:761, 829 | LA | |
| Source reset | partial | e2e-headed-fixture | spec:171-183 | LA | |
| Native scrubbing | partial | e2e-headed-fixture | spec:259-273 | LA | Single scrub |
| Visibility | missing | unit | content-script.test.ts:526 | LA, 2D | |
| Reconnect | partial | e2e-headed-fixture | spec:233-257 | 2D, NET | Server-side close |
| Navigation via #65 | missing | unit | navigation-transaction.test.ts | LA, PP | |
| Sustained paired progress | partial | e2e-headed-fixture | spec:127-150 | LA | Samples not timestamp-paired |
| 30 s recovery windows | missing | none | spec:355-374 | LA | |
| Repeated runs, exact identity | missing | e2e-headless | 51 runs | LA | |
| Report proves listed properties | partial | e2e-headed-fixture | CR_D03:48-64 | LA | Up to 8 corrective writes allowed |
| Not synthetic-only | partial | e2e-headed-fixture | global-setup.ts:41 | PP, 2A, 2D, DEP, UA | |
| Dependencies satisfied first | missing | none | #54–#67 open | OT | |
| User acceptance | missing | none | — | UA | |

**Closure blockers:** no run on the merged or release candidate; missing scenarios; no windows, repeats or soak; open dependencies; no provider, 2D or deployment evidence.

**Next actions:** clean-HEAD headless and headed runs with hash verification; 20+ consecutive runs, 10× per fault, 30-minute soak; add the missing scenarios; drive the matrix through the D02 fixture; fix the barrier docs.

**Discrepancies:**
- c81dfb1 (Checkpoint 94, 2026-09-22) records that the stored PR #96 body was stale after merge (it still cited head d5ceef7 and a 44.4 s headed run) and was rewritten with `gh pr edit`; that the "Done" project status shown there is PR #96's own item; and that the Verification owner custom field did not persist after several UI attempts.
- 282a784 (the follow-up checkpoint) records the PR #97 reconciliation state and again leaves the Verification owner field blank and unclaimed.
- The 1.8 s barrier text in CR_D03 predates the 3.0 s window from PR #96.

### #33 — CR-D04: Two-account Crunchyroll and cross-provider acceptance
**Summary:** OPEN; last recorded Blocked / Missing device. Not started.

**PRs:**
- #73 a011230, 5/5 green.
- Supporting: #96 1d22c5b, #93 6667128.

**Reports:** blank template; no filled report.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| 1 Dependency #68 satisfied | missing | none | #68 OPEN | PP, 2A, 2D, DEP, UA | Binary dependency; unmet |
| 2 Extension-disabled baseline | missing | doc-only | template:48 | HB, PP, 2A, 2D | |
| 3 Candidate runs | missing | doc-only | run 35387667519 | DEP, 2D, 2A, PP, HB | |
| 4 Role swaps | partial | e2e-headed-fixture | CR_D03:18 | 2A, 2D, PP, HB | |
| 5 Chrome and Edge | missing | e2e-headed-fixture | extension-profile.ts:80 | HB, 2D, 2A, PP | Bundled Chromium, not branded browsers |
| 6 Three episodes | missing | doc-only | template:63-72 | PP, 2A, 2D | |
| 7 Cold seek | partial | e2e-headed-fixture | spec:259-274 | PP, 2D, 2A | |
| 8 Warm seek | partial | e2e-headed-fixture | spec:151-168 | PP, 2D, 2A | Forward only |
| 9 Skip Intro | partial | unit | content-script.test.ts:807 | PP, 2D, 2A | |
| 10 Audio/source change | partial | e2e-headed-fixture | CR_D03:17 | PP, 2D, 2A | |
| 11 Episode transition | partial | unit | CR_C04:67 | PP, 2D, 2A, HB | |
| 12 YouTube/generic | partial | e2e-headed-fixture | CR_D02:106-128 | HB, PP, LA | |
| 13 30 actions per combination | missing | doc-only | template:97-101 | 2D, 2A, PP, HB | |
| 14 ≥95% without manual Sync | missing | doc-only | template:105 | 2D, 2A, PP, HB | PASS definition allows manual Sync |
| 15 Zero unsafe resumes | partial | e2e-headed-fixture | CR_D03:19-20 | PP, 2D, 2A | |
| 16 Per-run separation | missing | doc-only | template:97 | LA, 2D, PP, 2A | Lowered from partial |
| Extra: 30-min soak | missing | none | REMEDIATION_PLAN:225 | 2D, PP, 2A, HB | |
| Extra: pause/drift statistics | missing | doc-only | REMEDIATION_PLAN:238 | 2D, PP, NET | |
| Extra: dated report plus acceptance | missing | none | template:162 | DEP, UA | |
| Extra: Firefox/Safari if claimed | unclear | integration | README.md:94 | FF, SX | |

**Closure blockers:** #68 open; nothing run; Device B and a second account missing; Edge entitlement contradicted (c5750113796 vs c5761714520); coordinator not deployed; template fields missing.

**Next actions:**
- Local: extend the template (manual-Sync exclusion, revision/readiness/identity columns, soak, p95, Gate C scenarios); run branded-channel fixture runs.
- External: Device B; second account; deploy; full matrix; user acceptance.

### #69 — CR-D05: Package, stage and release the approved candidate
**Summary:** OPEN, not started (no comments or assignee). v0.2.5 is **out of scope**: it is a self-described test release that never references #69. 21 of 22 dependencies are open.

**PRs:** none in scope. Related: #99 423b6f7 and #100 1568049, both 5/5 green; their own checklists are left unchecked.

**Reports:** RELEASING.md (no staging, canary or rollback steps); remediation plan Gate D.

| Criterion | State | Class | Refs | Gaps | Notes |
|---|---|---|---|---|---|
| 1 Dependency acceptance | missing | doc-only | 21 of 22 open | PP, 2D, 2A, DEP, UA | |
| 2 No blockers | missing | none | #33 Blocked | 2D, 2A, DEP, UA | |
| 3 Accepted commit | missing | integration | run 35662329637 | UA | Pipeline only |
| 4 Coordinator identity | missing | none | Worker 209278f7 (1ac5b1c) | DEP | |
| 5 Artifact hash | missing | integration | 151126d6 vs 7fb39e25 | UA | Same tree 48517c46; not byte-reproducible |
| 6 Endpoint embedded | partial | source-review | build-extension.mjs:39 | LA | |
| 7 No localhost contamination | missing | source-review | manifest.json:54 | LA | Persists deterministically |
| 8 Backend tested first | missing | integration | CR_B07:72-77 | DEP | |
| 9 Migration/rollback | partial | integration | CR_B07:76 | DEP | |
| 10 Full checks and install | missing | integration | checkpoint:8145-8154 | LA, HB | No Load-unpacked smoke |
| 11 Staging smoke | missing | none | wrangler.jsonc | DEP | No staging environment |
| 12 Remote identity verified | missing | none | checkpoint:2422 | DEP | |
| 13 Canary | missing | none | REMEDIATION_PLAN:246 | DEP, 2D, UA | |
| 14 Rollout decision | missing | doc-only | release.yml:77 | UA | v0.2.5 published as "latest" |
| 15 Version selected last | missing | doc-only | RELEASING.md:94 | UA | 0.2.5 already used; 1.0.0 reserved |
| Extra: authorization and rollback policy | missing | none | — | UA, OT | |
| Extra: production smoke | missing | none | checkpoint:2419, 2624 | DEP | Pre-remediation only |

**Closure blockers:** 21 of 22 dependencies open; no staging environment or staging smoke; no canary; localhost CSP persists in every production package; no publication authorization or approved rollback policy; no user acceptance.

**Next actions:**
- Local: localhost-CSP check and strip; ZIP inspection (needs permission); SHA corrections (authorization); local mixed-version rehearsal; draft staging, canary and rollback steps.
- External: dependency acceptance; publication authorization; staged backend deploy with identity; canary; version ≥0.2.6.

## 7. Cross-cutting discrepancies

**Provenance**
1. **Invalid SHAs.**
   - Transposition: context-checkpoint.md lines 8107, 8108, 8123 and 8171 give `423b6f7c77dad2a4b14d…` (b4a1 recorded as a4b1).
   - Spliced value: line 8199 and the public v0.2.5 release note ("Tagged merge commit") give `423b6f7c77dad2a3c3fd4e2963ca55475408f4d`. It is 39 characters, not a git object, and splices the real prefix onto the tail of base da42aa1.
   - The operator note repeats the wrong value, and CHANGELOG 0.2.5 points readers to the release provenance.
   - Correct value: `423b6f7c77dad2b4a14db6932711be025aac8163` (#30 comment 5768368434 has it right).
2. **Coordinator deployment gap.** The last deploy is v0.2.4 source (1ac5b1c, Worker 209278f7…). The 0.2.5 contract changes are not live, so the 0.2.5 extension would run legacy mode and the v0.2.5 smoke would fail with "Expected transactional mode for play." The precedent at checkpoint 2613 shows this failure mode has happened before. The CHANGELOG (line 21) and release notes list coordinator fixes but do not say they are undeployed.
3. **Stale identity and unsafe advice in TEST_GUIDE.** TEST_GUIDE still says test build 0.1.22 and "production coordinator deployed 2026-08-30". Its "Production preflight" runs `npm run deploy:edge`, which needs separate authorization under RELEASING.md and #69. None of the four 2026-09-18 deployments is recorded in docs.
4. **Release notes overstate verification.** They claim Chrome, Firefox and macOS Safari package verification, but the tag run skipped Safari (xcrun unavailable). The only Safari package evidence is a local release-prep run, and it covers packaging only. The 0.2.5 verification checked the extracted CSP but not the compiled service-worker URL.
5. **Firefox build hazard.** `build:extension:firefox` without `SYNCYOURJOY_ROOM_SERVER_URL` silently targets localhost. No Firefox artifact is published; the ZIP is Chrome/Edge only.
6. **#30 plan asks for fields that don't exist.** It asks for `seeking`, which no player sample exposes. Panel Position is floored to whole seconds, and room revision appears only in the report the controller downloads.
7. **The Crunchyroll harness proves little even when it passes.** It uses a test-mode build and an in-process coordinator on one machine, and needs both storage states on that machine. It cannot provide release-package, deployed-coordinator or two-device evidence. Its storageState injection is also dropped.
8. **#30's closure rule lives only in comments.** The title and body still describe the harness.
9. **Network fault duration and coordinator-side detection.** Test D's 5–15 s network drop may never register as offline on the client, because the client heartbeat timeout needs more than 15 s. DevTools offline does not reliably close the service-worker socket. Use an OS-level interruption of 20 s or more.
   The coordinator has a separate gap: it has **no server-side heartbeat**. `apps/edge-service/src/worker.ts` answers `ping` with `pong` without timing it (line 367). It calls `coordinator.disconnect()`, and starts `CONTROLLER_GRACE_MS` (10 s), only from `webSocketClose`/`webSocketError` (lines 192–226). A client's `close(4001, 'heartbeat_timeout')` cannot reach the server while the client is offline, and if the client reconnects before the old socket's close is delivered, the `stillConnected` check (line 198) suppresses the disconnect. An OS-level drop of 20 s or more may therefore never register as a coordinator-side disconnect. On a 0.2.5 coordinator the health evaluator (`evaluateHealth`, packages/sync-engine/src/room.ts:662–705) still pauses the room after the 1.8 s progress deadline or the 5 s report-silence deadline. The deployed 1ac5b1c coordinator has no such evaluator, so the room may keep playing. This bears directly on the #34 pass bar (the room must not silently continue while a participant is unhealthy) and on #34 criterion 9 (controller disconnect).

**Evidence quality**

10. **Headed fixture evidence comes from unverified local trees.** All e2e-headed-fixture evidence (#30, #33, #49–#57, #62, #64, #66–#68) comes from local runs labelled d5ceef7/950d641. The eight-character values below are provenance `trackedSourceSha256` prefixes written by `writeProvenance` in tests/e2e/global-setup.ts, not git objects. Recomputed from git with the same algorithm: a clean d5ceef7 hashes to 773c452b and a clean 950d641 to d183e506, while the retained runs labelled with those commits record af627916, d909996b, 39bb82a8 and others, so those trees were dirty. No retained matrix or headed run matches the merged #96 head (merge 1d22c5b, PR head 73536d0, tree 847b90a3; prefix a93f90b2) or the release source (tag commit 423b6f7, tree 48517c46; prefix 51963471). The only a93f90b2 run, e2e-1790026537617 (labelled 282a784, whose tracked source equals 1d22c5b), is a Crunchyroll safe-skip with no executed test. Several records say d5ceef7 is "same as HEAD" apart from test hooks; treat that as unverified until a clean run is done.
11. **Clock-only progress counts as real progress.** It drives "Playing, confirmed", the transactional started ACK, and coordinator health (#52, #53, #57, #58, #64). PR #96's rVFC counter bypasses the hidden-tab fallback and has no tests.
12. **Firefox presence on Device A (resolved).** `/Applications/Firefox.app` reports 156.0.1 (re-checked 2026-09-23), as the #33 and #51 records said. The "absent" finding in the #35 record came from a faulty initial host check supplied to the audit, and was wrong. Firefox rows for #35 and #51 are local work that needs a separate `build:extension:firefox` package with an explicit `SYNCYOURJOY_ROOM_SERVER_URL`, run headed. They are not blocked by an unavailable runtime.

**Process**

13. **Merge path and review history (corrected 2026-09-24).** Checked against GitHub's review records for PRs #70–#100:
    - For PRs #71–#100 (except #81), the exact final head received a detailed owner review comment, hosted checks passed, GitHub continued to require an approval the author could not provide, and the authorized administrative merge path was used.
    - #81: the owner review comment was submitted on 7c84be9, not on the final head dd702d4. All five hosted checks passed on the final head.
    - #70: there is no GitHub review object. The approval attempt was rejected because the account owns the PR, and the review is recorded in the checkpoint instead.
    - Every PR still shows `REVIEW_REQUIRED`, because repository ruleset 23670565 requires a code-owner approval and the code owner is the author. The ruleset grants the Admin role an "always" bypass allowance, which is the authorized administrative merge path.
    - No second-person review exists for any of these PRs, including the #55 contract review.
14. **Stale records.**
    - Checkpoints 73, 74 and 78 exist only on branches; main contains false claims at 5105 and 4577.
    - Most issue bodies still say "planned and not started".
    - Most reports still say 0.2.4 and pre-merge status.
15. **Project fields.** They cannot be verified without `read:project`. #68's item is In Progress, not Done, and #60's move to Verification never happened.

### Re-check corrections summary
The re-check logged **about 180 correction entries** (178 by this document's count) across all 25 issues. None marked an issue closable.

**Raises.** Mostly to e2e-headed-fixture on the strength of local headed artifacts (#30 criteria 2, 4–12; #52, #53, #54, #62, #64, #66), plus unit or integration upgrades where CI-run tests were overlooked (#34 criteria 8, 13, 14; #35 criteria 3–5, 15; #59 verification; #61 rollback).

**Notable lowers:**
- #30 criterion 13: no leave test exists.
- #34 body criterion: missing.
- #50 generation tracking and #51 replacement: complete → partial.
- #52 convergence: missing.
- #53 accumulation, #54 controller change, #55 contract review, #56 commit/cancel: complete → partial.
- #57 fixture-E2E classes: lowered to unit.
- #58 evaluability, #59 agreement, #61 migration, #66 AC2: complete → partial.
- #68 late ACK, missing status, pending play and visibility: partial → missing.
- #69 criteria 5 and 10: missing.
- #33 criterion 16: missing.

**Factual fixes:**
- The backward seek is asserted (#35).
- Firefox presence: 156.0.1 is installed (#33, #51 records were right); the #35 re-check's "absent" finding is corrected (re-checked 2026-09-23).
- #68's "Done" project status belongs to PR #96's item.
- #67 is a dependency of #68.
- #88 (#60): the approval requirement was not satisfied by a second reviewer. After the owner's final-head review and explicit user authorization, the authorized administrative merge path was used.
- Coverage claims were overstated in #50 comments and in the PR #79, #80 and #82 docs.

**Completeness review (2026-09-23):**
- States lowered: #55 stale-operation rejection and #56 controller ownership (complete → partial); #60 criterion 5 (complete → partial); #33 criterion 1 (partial → missing).
- Classes and references aligned: #52 bounded policy, #54 deadline and receipt-time expiry, #56 failed prepare and #67 AC3 now cite the tests that exercise them; #65 controller-follow lowered to source-review; #57 verification split into suites (unit/integration) and local scenario (partial, e2e-headless); #35 row 8, #49 selected-frame binding and #57 receives-preparation relabelled to match the cited evidence.
- Added: the coordinator-side heartbeat gap (item 9), closure blockers for #67 and #69, the merge-history commits for #60 and #68, and provenance labels (item 10).

## 8. Follow-up decisions and corrections (2026-09-24)

These record decisions made after the snapshot. They change no criterion state above.

- **Issue status frozen.** No issue is closed or marked complete from merged PRs, unit tests, historical CI, local fixtures, counters or source inspection. Real-provider playback, two-device testing, deployed-coordinator verification and user acceptance stay separate evidence classes.
- **Same-candidate coordinator rule.** #30 must not run against the old coordinator deployment (`209278f7-…`, built from `1ac5b1c`). The coordinator must be deployed from the extension's runtime candidate `423b6f7c77dad2b4a14db6932711be025aac8163` (tag `v0.2.5`), or from a `main` commit proven runtime-identical with both identities recorded. At `15680494f939bffbd84f4ab395dc70b8a2089a59`, the only file differing from the tag is `context-checkpoint.md`. Gate 0 in [`V0_2_5_CONTROLLED_TEST_SESSION.md`](V0_2_5_CONTROLLED_TEST_SESSION.md) records the Worker target, deployed source commit, Version ID, endpoint, and workflow run URL and result. A deployment still needs explicit user authorization for that run.
- **Release-notes SHA corrected.** The public v0.2.5 release notes' "Tagged merge commit" line was corrected from the malformed `423b6f7c77dad2a3c3fd4e2963ca55475408f4d` to `423b6f7c77dad2b4a14db6932711be025aac8163`. Only the notes text changed. The release ID, tag refs (`2bf96211…` → `423b6f7…`), latest flag, assets and digests (ZIP `7fb39e25…b942`, sidecar `c5e4fb42…b63d`) were verified unchanged, and no new version or tag was created. The release notes' Safari overstatement (§7) is unchanged.
- **Checkpoint SHAs corrected.** The transposed `423b6f7c77dad2a4b14d…` in the v0.2.5 checkpoint entries and the malformed 39-character value in the "Tag target" line are corrected in `context-checkpoint.md` by the same documentation PR as this file.
- **Harness defect confirmed; handled separately.** On 2026-09-24, against the repository's Playwright 1.63.0, `launchPersistentContext` was shown to silently ignore `storageState`: dummy cookie and localStorage entries were absent, while a `browser.newContext` control applied the same file. No saved Crunchyroll states are configured locally or in CI (`e2e-crunchyroll.yml` has 0 runs, and its secrets are absent), so no protected state has ever been applied. The fix, using `BrowserContext.setStorageState`, is a separate implementation PR that references #30. Until it proves both protected states are applied, the protected harness must not be used as provider evidence. Merging it does not close #30.
- **#54 report correction handled separately.** PR #96 changed `SEEK_BARRIER_MAX_WAIT_MS` from 1,800 ms to 3,000 ms (commit d5ceef7). The CR-A07 report does not document that change, so a separate documentation correction brings it in line with the merged implementation.
- **Firefox classification.** Firefox 156.0.1 is installed, so it is never recorded as `BLOCKED` for a missing browser. For the v0.2.5 session it is `NOT CLAIMED` unless a separate Firefox run is executed and recorded.
- **No release.** No version bump, no new tag, and no `1.0.0`. The next release decision comes only after a coherent issue group passes its complete acceptance matrix.
