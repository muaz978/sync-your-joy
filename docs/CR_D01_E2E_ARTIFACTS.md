# CR-D01 E2E build isolation and failure artifacts

Issue: [#66](https://github.com/muaz978/sync-your-joy/issues/66)

CR-D01 hardens the real two-profile browser test boundary. It does not add provider access, copy browser credentials or claim live Crunchyroll acceptance. It makes every E2E run identifiable, prevents it from overwriting the canonical extension output, and preserves enough sanitized evidence to distinguish a browser-launch problem from a product assertion.

## Problem

The earlier E2E setup built into `apps/extension/dist` and decided whether to rebuild by searching the manifest for the current room-service origin. That endpoint-only check could reuse an output directory from a previous run and did not record the source, lockfile or configuration identity that produced it. Profile shutdown did not produce a deterministic per-profile state or event record, and a failed persistent-browser launch was represented only by the generic Playwright error.

## Implemented behavior

### Isolated build and provenance

- `tests/e2e/playwright.config.ts` allocates a unique `test-results/e2e-<timestamp>-<pid>-<uuid>` output directory for every run.
- `tests/e2e/global-setup.ts` starts the room service on an ephemeral port and always builds a fresh extension into the run's `extension/` child directory.
- `scripts/build-extension.mjs` accepts `SYNCYOURJOY_EXTENSION_OUTPUT_DIR` while retaining `apps/extension/dist` as the default for ordinary development, packaging and release commands.
- The canonical `apps/extension/dist` directory is not the E2E build target.
- `provenance.json` records:
  - source commit and Git tree;
  - deterministic SHA-256 over tracked source files in the application, package, script, test and fixture roots;
  - `package-lock.json` SHA-256;
  - a SHA-256 over the build and E2E configuration files;
  - the room-service origin;
  - the isolated extension output path;
  - the generated extension manifest SHA-256.

The provenance file contains hashes and bounded local endpoint identity only. It does not contain storage state, cookies, credentials, signed URLs, media bytes or page content.

### Sanitized profile artifacts

`tests/e2e/extension-profile.ts` now records one JSON log per persistent profile. The log contains only:

- lifecycle events such as browser launch, service-worker readiness, panel readiness and profile close;
- URLs reduced to scheme, host and path, with query strings and fragments removed;
- extension ID and isolated-run classification;
- safe side-panel booleans for create/join forms, room visibility, shared-link visibility, readiness and primary-control availability;
- for a profile given a storage state, one `storage-state-applied` event with cookie, localStorage and declared session-cookie counts only;
- named state checkpoints from the test flow.

Room codes, account names, page text, cookies, storage-state contents, provider media data and token-bearing URL components are not recorded.

The local fixture and opt-in provider specs record checkpoints at initial load, room creation or join, readiness, play request and pause request. The profile cleanup path writes the logs even when the browser launch or test fails.

### Explicit trace lifecycle

Traces are disabled by default. This protects authenticated provider runs from accidentally collecting more browser information than the sanitized JSON logs require. For a controlled local fixture diagnostic, set:

```bash
SYNCYOURJOY_E2E_TRACE=1 npm run test:e2e
```

The profile helper explicitly calls `context.tracing.start()` and `context.tracing.stop()` with screenshots, page snapshots and sources disabled. It starts this trace only after any storage state has been applied and checked, so the trace does not contain the state. It writes one trace archive per profile under the unique run directory. Do not enable this for protected provider runs unless the operator has reviewed the environment and accepted the trace's diagnostic scope. The default provider workflow does not enable it.

The Playwright runner's own `trace`, `screenshot` and `video` options are a separate path. The runner starts its trace as soon as a browser context exists, which is before a storage state is applied, so `--trace on` would put every saved cookie and localStorage value into the runner's `trace.zip`. The authenticated provider spec sets all three to `off` for its file, which outranks `--trace` and UI mode, and checks the resolved values before launching. The profile helper also refuses to apply a storage state while `PWDEBUG`, `PWPAUSE` or Playwright protocol or channel `DEBUG` logging is on.

Video recording is also disabled by default. It can be explicitly enabled with `SYNCYOURJOY_E2E_VIDEO=1`, but protected provider runs should use the sanitized state logs instead.

### Failure classification

`tests/e2e/artifact-reporter.ts` writes `run-summary.json` with every test result and classifies failed results as either:

- `browser-launch/setup`, for persistent-browser, service-worker startup or setup failures;
- `product-assertion`, for a test that reached the product scenario and failed an assertion.

Global setup failures are written as `setup-failure.json`. The intentional local diagnostic switch below verifies the product-assertion path without changing normal test behavior:

```bash
SYNCYOURJOY_E2E_INJECT_FAILURE=1 npm run test:e2e
```

This switch is test-only and must never be used as a product result. It is an artifact-pipeline check.

## Verification record

The following checks were performed against the CR-D01 branch:

- `npm run typecheck` passed.
- The first run without an installed Playwright browser produced a per-profile `browser-launch-failure` event and a run summary classified as `browser-launch/setup`.
- After installing the repository-pinned Chromium runtime, the sandboxed run reached Chromium but terminated with `SIGABRT` and cleanup `EPERM`. The run was retained as environment evidence, not a product failure.
- A host-level run passed the generic two-profile fixture with one authenticated Crunchyroll test safely skipped. It produced a unique extension output, provenance manifest, two profile logs and a passing run summary.
- The controlled `SYNCYOURJOY_E2E_INJECT_FAILURE=1` run completed the real fixture flow and then failed intentionally. Its run summary reported one `product-assertion` failure and zero browser-launch failures, and both profile logs were retained.
- The opt-in trace run passed the generic fixture and both profile logs recorded `trace-started` and `trace-stopped` events with one archive per profile.
- The repository version remains `0.2.4`. This diagnostic hardening does not authorize a release bump or live-provider acceptance.

## Scope boundary

CR-D01 improves diagnostic reliability for the existing local and protected E2E harness. It does not prove authenticated Crunchyroll playback, two-account acceptance, two-device recovery, deployment identity or visible provider output. Those remain separate evidence gates tracked by issues #30, #33, #34, #35 and #69.
