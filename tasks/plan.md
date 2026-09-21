# Implementation Plan: CR-D01 isolated E2E build and failure artifacts

## Overview

Issue #66 hardens the real two-profile browser test so every run uses an isolated extension build, records enough provenance to identify the exact source and configuration, and preserves sanitized per-profile diagnostics without overwriting a release build. The task is tracked in GitHub issue [#66](https://github.com/muaz978/sync-your-joy/issues/66); this file is the local implementation plan and checkpoint index, not a replacement for the issue tracker.

## Architecture Decisions

- Playwright receives a unique run output directory. The E2E build is placed below that directory, while the normal `apps/extension/dist` release or development output remains untouched.
- The build script accepts an explicit output directory but keeps `apps/extension/dist` as the default for normal commands.
- Global setup writes a provenance manifest containing the source commit, a deterministic tracked-source hash, lockfile hash, E2E/build configuration hash, room-service endpoint identity and extension-output identity. It does not store credentials, cookies, protected provider state or media data.
- Each persistent profile records sanitized lifecycle events and safe panel-state booleans. URLs lose query strings and fragments before being written. Room codes, account data and page content are never recorded.
- Tracing is explicit and opt-in through `SYNCYOURJOY_E2E_TRACE=1`. It is disabled for protected provider runs unless the operator deliberately enables it in a safe environment. The sanitized event/state logs remain available without tracing.
- A small reporter writes a sanitized run summary and classifies failures as browser-launch/setup failures or product-test failures. This keeps a failed browser launch from being mistaken for a product assertion failure.
- Existing test behavior remains the same for the local fixture and opt-in provider paths except for the isolated output and additional diagnostics.

## Task List

### Phase 1: Provenance and isolated build

- [x] Add an explicit extension output-directory override to `scripts/build-extension.mjs`.
- [x] Make Playwright allocate a unique run output directory and make global setup build into an isolated child directory.
- [x] Write source, lockfile and configuration hashes plus endpoint and output provenance.

### Phase 2: Profile diagnostics

- [x] Add sanitized per-profile event and state logging.
- [x] Add explicit opt-in trace start and stop with a per-profile trace path.
- [x] Add launch-failure classification and a sanitized run summary reporter.
- [x] Record state checkpoints in the local fixture and protected provider specs.

### Checkpoint: deterministic artifact behavior

- [x] Existing unit and typecheck suites pass.
- [x] A normal local E2E run uses a unique output directory and produces provenance and profile logs.
- [x] A controlled failure distinguishes browser launch/setup from a product assertion and retains diagnostics.
- [x] `apps/extension/dist` is unchanged by E2E setup.

### Phase 3: Documentation and handoff

- [x] Document artifact locations, trace privacy, provenance fields and failure categories in the test guide and a CR-D01 report.
- [x] Run the complete repository checks and browser package checks.
- [ ] Commit, push, open a metadata-complete PR, review the exact final head, merge only after review, and update issue #66 without closing it until all applicable gates are evidenced.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A stale endpoint or previous run is reused | High | Unique run directory and unconditional isolated build |
| Diagnostic artifacts expose provider data | High | Sanitized URL handling, selector-based state only, opt-in traces, no page content or storage state |
| A launch failure is reported as a product bug | Medium | Explicit browser-launch error marker and run-summary classification |
| E2E build overwrites release output | High | Build override points only at `test-results` run output |
| A failed test leaves profile artifacts unwritten | Medium | `afterAll` closes profiles and close writes logs in a finally-style path |

## Open Questions

- The later protected Crunchyroll gate still requires secure storage-state inputs and is not proven by the deterministic fixture run. This issue only improves its build and diagnostic boundary.
- Video recording remains optional and is not enabled by default because screenshots or recordings may expose protected provider content.

---

# Implementation Plan: CR-D02 controlled adaptive loading and lifecycle fixtures

## Overview

Issue #67 is the controlled-fixture dependency after CR-D01. It supplies owned browser evidence for long loading, segment starvation, disjoint buffers, playback-rate resets and player lifecycle changes before any failure is attributed to Crunchyroll, DRM, account state or deployment. The issue tracker remains authoritative; this section records the local plan and the evidence boundary.

## Architecture decisions

- Use a generated, test-owned fragmented MP4 rather than a remote provider asset.
- Serve the initialization section and media fragments from a dedicated ephemeral test server so delay and missing-data behavior are explicit and bounded.
- Keep the fixture page self-contained and expose only a page-owned event snapshot for assertions.
- Use a path-based autostart entry point for the extension test because `normalizeMediaPageUrl()` intentionally removes unknown query parameters from shared media links.
- Exercise native MSE first, then the real unpacked extension readiness path.
- Keep browser/adaptive evidence separate from authenticated Crunchyroll, DRM, visible-motion, two-account, two-device and deployment gates.

## Task list

### Phase 1: owned asset and server

- [x] Add deterministic fragmented-MP4 generation command and generated 120-second asset.
- [x] Parse the asset into initialization and media fragments without relying on a remote source.
- [x] Add manifest, segment, bounded-delay and controlled-missing routes.
- [x] Add Vitest coverage for duration, fragment structure and fault controls.

### Phase 2: native browser behavior

- [x] Add native MSE loading with delay, missing segment, disjoint timestamp offset and rate-reset controls.
- [x] Add native event and fixture-state recording.
- [x] Cover top document, open shadow root, SPA transition, same-node replacement and cross-origin nested frame.
- [x] Verify native tests against the actual browser rather than a mocked media clock.

### Phase 3: extension integration

- [x] Open the fixture through the real side-panel room and shared-link flow.
- [x] Verify the real extension readiness button after native MSE discovery.
- [x] Preserve the production URL-normalization behavior and avoid passing test-only query data through the shared-link protocol.

### Phase 4: documentation and handoff

- [x] Document the fixture, controls, file ownership, evidence classes and privacy boundary in `docs/CR_D02_ADAPTIVE_FIXTURES.md`.
- [x] Link the record from `docs/TEST_GUIDE.md`.
- [x] Preserve the issue and release boundaries. Do not close #67 until every applicable external gate is evidenced.
- [ ] Commit, push, open a metadata-complete PR, review the exact final head, merge only after review and fresh checks, then move #67 to Verification with a detailed evidence comment.

## Verification gates

| Gate | Evidence | Status |
| --- | --- | --- |
| Source review | Fixture page, server, generator and tests reviewed together | Pending final PR review |
| Typecheck and unit tests | `npm run check` and fixture server Vitest tests | Pending final run |
| Browser test | Native MSE and lifecycle Playwright tests | Passed in focused run |
| Extension integration | Real side-panel `OPEN_LINK` and readiness path | Passed in focused run |
| Provider acceptance | Authenticated Crunchyroll visible playback | Separate, not claimed by CR-D02 |
| User acceptance | Controlled headed/browser and physical-device reports | Separate, not claimed by CR-D02 |

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Query-only autostart is removed by media URL normalization | Medium | Use `/adaptive-autostart.html` as a path-based fixture entry point and test the real sanitized flow. |
| Missing fragment is mistaken for a successful load | High | Assert the 404, record `segment-missing`, and require later segments plus `load-complete`. |
| Synthetic media is treated as provider proof | High | Label the page and documentation as owned, unencrypted and non-provider evidence. |
| A media clock advances without visible output | High | Keep visible-motion and native frame evidence as separate acceptance gates. |
| Generated asset differs between FFmpeg versions | Low | Assert duration and fragment structure, not a toolchain-specific byte hash. |

---

# Implementation Plan: CR-D03 complete local three-profile browser matrix

## Overview

Issue #68 is the local browser evidence task after the CR-D01 artifact and CR-D02 adaptive-fixture work. It uses three isolated Chromium profiles, the real unpacked extension, the in-process room service and an owned local media fixture. The issue tracker remains authoritative. This section records the implementation sequence, evidence boundaries and remaining gates.

## Architecture decisions

- Use three persistent Chromium profiles to require a real fixed quorum rather than relying on two-member behavior.
- Use the generated 120-second adaptive fixture so the 30-second sustained window cannot mistake the short fixture's loop boundary for a controller correction.
- Observe native frame progress, native paused state, exact seek destinations and bounded hard current-time writes separately from room-clock convergence.
- Exercise source replacement, controlled `NotAllowedError`, local gesture recovery, in-panel Sync, explicit readiness re-admission, controller transfer, reconnect and native scrubbing as separate lifecycle gates.
- Keep navigation scenarios out of the CR-D03 claim until CR-C04 issue #65 is complete.
- Use a token-gated local room-service disconnect control only in the E2E harness because browser-context offline emulation cannot reliably close an MV3 service-worker WebSocket. Do not expose the route in production or edge service construction.
- Treat reconnect as membership restoration followed by explicit controller resume because the coordinator pauses safely when a participant disconnects.
- Serialize overlapping MV3 timeout and alarm reconnect callbacks with a single-flight promise so duplicate join handshakes cannot race on one socket.

## Task list

### Phase 1: three-profile scenario

- [x] Add a real three-profile Playwright spec with host approval and fixed quorum.
- [x] Add a 30-second sustained window with paired drift, frame-progress and hard-write metrics.
- [x] Assert exact seek destinations and native scrub convergence.
- [x] Cover source replacement, readiness re-detection and one-shot playback rejection recovery.
- [x] Cover controller transfer to B and back to A.

### Phase 2: evidence-driven runtime corrections

- [x] Preserve native frame progress during the transactional startup grace window.
- [x] Rebase steady-play health timing when delayed started acknowledgements arrive.
- [x] Do not expire an operation after every required participant has confirmed start.
- [x] Increase the bounded seek barrier ceiling to the required three-profile scheduling window and retain the corresponding unit assertion.
- [x] Add `requestVideoFrameCallback` observation with lifecycle attach and detach handling.
- [x] Add a loopback-only playback rejection hook that is unavailable on provider pages.
- [x] Use the long adaptive fixture for the sustained window rather than the short looping fixture.
- [x] Add bounded operation diagnostics to the side panel.
- [x] Make the reconnect handshake single-flight across timeout and alarm wakeups.

### Phase 3: deterministic reconnect harness

- [x] Add an ephemeral token to the E2E room-service setup.
- [x] Add a local-only participant disconnect route, absent unless the token is supplied.
- [x] Add direct room-service coverage for wrong tokens, exact participant closure and participant-disconnected publication.
- [x] Verify the extension enters reconnecting, rejoins the same room and preserves readiness.
- [x] Verify the coordinator safety pause and explicit post-reconnect controller resume.

### Phase 4: documentation and delivery

- [x] Add [`docs/CR_D03_BROWSER_MATRIX.md`](../docs/CR_D03_BROWSER_MATRIX.md) with scope, metrics, privacy boundary, route boundary and limitations.
- [x] Link CR-D03 from [`docs/TEST_GUIDE.md`](../docs/TEST_GUIDE.md).
- [x] Record the CR-D03 plan and evidence boundary in this file.
- [x] Pass the focused three-profile matrix.
- [x] Run `npm run check` against the final working tree: 36 Vitest files and 319 tests passed, followed by successful server and extension builds.
- [x] Run the complete `npm run test:e2e` suite: 5 passed and the opt-in authenticated Crunchyroll test skipped because protected storage-state inputs were not supplied.
- [x] Run `SYNCYOURJOY_E2E_HEADED=1 npm run test:e2e`: 5 passed and the same opt-in provider test skipped; the three-profile matrix passed in headed Chromium in 44.4 seconds.
- [ ] Commit atomically, push the branch and verify the remote SHA.
- [ ] Open a metadata-complete PR for #68, review the exact final head and fresh hosted checks, then merge only after review.
- [ ] Add the merge evidence to issue #68 while retaining the issue until remaining dependency, deployment and user-acceptance gates are complete.

## Verification gates

| Gate | Evidence | Status |
| --- | --- | --- |
| Source review | Matrix, fixture, room service, service worker, health and coordinator changes reviewed together | Pending final PR review |
| Typecheck | `npm run typecheck` | Passed in final `npm run check` |
| Unit tests | `npm run check`, 36 files and 319 tests | Passed |
| Browser test | Three-profile local matrix and complete `npm run test:e2e` | Passed, 5 tests passed and 1 opt-in provider test skipped |
| Headed browser test | `SYNCYOURJOY_E2E_HEADED=1 npm run test:e2e` | Passed, 5 tests passed and 1 opt-in provider test skipped |
| Navigation | CR-C04 scenarios | Not claimed, blocked by issue #65 |
| Crunchyroll provider acceptance | Authenticated provider run | Separate, not claimed by CR-D03 |
| Physical-device acceptance | Two-device network and sleep/wake run | Separate, not claimed by CR-D03 |
| User acceptance | Controlled headed and live-provider reports | Pending separate evidence |

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Three participants are treated as a two-member shortcut | High | Fixed quorum and three isolated profiles |
| A room clock advances while native media is frozen | High | Presented-frame and native paused assertions |
| A short fixture loops during the sustained window | Medium | Use the 120-second adaptive fixture |
| Context offline does not close an MV3 worker socket | High | Token-gated local server-side disconnect control |
| Disconnect recovery resumes stale playback silently | High | Coordinator safety pause plus explicit post-reconnect controller resume |
| Timeout and alarm send duplicate reconnect joins | High | Single-flight reconnect promise |
| Test controls leak into production | High | Route requires an ephemeral option that normal and deployed constructors never pass |
| Local fixture success is mistaken for Crunchyroll proof | High | Separate provider, physical-device, deployment and user-acceptance gates |

## Open questions

- Issue #65 navigation coverage remains outstanding.
- Hosted PR checks and the exact final-head review must be completed before merge.
- Authenticated Crunchyroll, deployment, two-account, two-device and user-acceptance gates remain separate and must not be inferred from this deterministic fixture.
