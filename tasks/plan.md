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
