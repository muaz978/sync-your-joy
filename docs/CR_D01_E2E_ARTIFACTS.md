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
  - the generated extension manifest SHA-256;
  - `extensionSource`: the tree the extension build was run in (its path relative to the checkout, whether it is the checkout, its commit and Git tree, the same source, lockfile and configuration hashes computed from that tree, its own `workingTree`, and `workspacePackages`: where `@syncyourjoy/protocol` and `@syncyourjoy/sync-engine` resolved to from it, relative to it);
  - `workingTree`: whether the checkout differed from its commit when the run was recorded, as `{ dirty, modifiedTrackedCount, untrackedCount, untrackedHash }`. `modifiedTrackedCount` counts tracked files that are modified, staged, added or deleted; `untrackedCount` counts files git does not track and `.gitignore` does not hide; `untrackedHash` is a SHA-256 over the sorted names and contents of those files, or `null` when there are none. `dirty` is true when either count is not zero. Only counts and a hash are written, never a file name or content. A modified tracked file already changes `source.trackedSourceSha256`, because the hash is of the working-tree files; the flag says so without comparing hashes, and the untracked fields cover a new file that no hash above sees. A tracked file deleted from the working tree is counted and left out of the hash instead of stopping the run.

The first group of fields (`source`, `lock`, `config`) describes the checkout that supplies the room coordinator and the specs. The extension is built from that same checkout unless `SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT` names another one, for example a worktree of a release tag with its own `node_modules`, which is how a shipped extension is checked against the current coordinator. In that case `extensionSource` identifies the release tree and the other fields keep identifying the checkout, so evidence for a run against a release build is not attributed to the current checkout. Without the variable `extensionSource` repeats the checkout's values. Whether the two are the same tree is decided by real path, so a symlinked spelling of the checkout is the checkout. A configuration file that a release tree does not have is listed under `extensionSource.config.missing`.

The other checkout needs its dependencies installed in it (`npm ci --ignore-scripts`) and a `scripts/build-extension.mjs` that honors `SYNCYOURJOY_EXTENSION_OUTPUT_DIR`, which releases from v0.2.5 on do. A path that does not exist, that has no build script, that is not a git checkout or worktree (an export of a tag has the files and no history, and the provenance is read from git), or whose `@syncyourjoy/protocol` or `@syncyourjoy/sync-engine` does not resolve to a directory inside it stops the run with a message that names the variable, before anything is built. The last check is there because the bundle is built from those packages as Node resolves them from the tree: a worktree with no `node_modules` of its own below a directory that has one would otherwise be built from that directory's packages and still be recorded as the release tree. Only those two packages are checked; third-party packages are resolved by Node from the tree and are not checked one by one. A build that ignores the output directory (v0.2.4 and earlier build into their own `apps/extension/dist`) stops the run with a message saying so, instead of failing later on a missing `manifest.json`.

The provenance file contains hashes, counts and bounded local endpoint identity only. It does not contain storage state, cookies, credentials, signed URLs, media bytes, page content, or the names or contents of working-tree files.

### Output directory guard

`SYNCYOURJOY_E2E_OUTPUT_DIR` can name the directory a run writes to. Playwright empties its output directory when a run starts and the build removes `<output>/extension`, so `scripts/output-directory-guard.mjs` checks the value in `tests/e2e/playwright.config.ts`, `tests/e2e/global-setup.ts` and, when it has to read the variable itself, the reporter, before anything is written. An override is accepted only when it is a directory below the repository's `test-results` or below the system temporary directory. It is refused, with a message that names the variable and the reason, when it is the release output (`apps/extension/dist`) or inside it, the repository root, an ancestor of the repository, the home directory or an ancestor of it, the filesystem root, `test-results` itself or the temporary directory itself, anything else inside the repository, or anything outside those two locations. Symbolic links are followed before the check. An empty value is refused instead of being read as the working directory. A relative value is resolved against the working directory and exported in absolute form. With no override nothing changes: every run still gets a new `test-results/e2e-<timestamp>-<pid>-<uuid>` directory.

`scripts/build-extension.mjs` has a narrower guard of its own, because the release is built with it into `apps/extension/dist`. It stops with the same kind of message, before deleting anything, when `SYNCYOURJOY_EXTENSION_OUTPUT_DIR` is the filesystem root, the home directory or an ancestor of it, the repository root or an ancestor of it, `.git` or `node_modules` or anything inside them, `apps`, `packages`, or the extension's own `src` and `static` directories (or a parent or child of them). The default `apps/extension/dist`, the Firefox build and an ordinary scratch directory are unaffected. `scripts/package-extension.sh` uses the default output and is unchanged.

The Playwright `--output` command-line option replaces the configured output directory and is not covered by this guard.

### Sanitized profile artifacts

`tests/e2e/extension-profile.ts` now records one JSON log per persistent profile. The log contains only:

- lifecycle events such as browser launch, service-worker readiness, panel readiness and profile close;
- URLs reduced to scheme, host and path, with query strings and fragments removed;
- extension ID and isolated-run classification;
- safe side-panel booleans for create/join forms, room visibility, shared-link visibility, readiness and primary-control availability;
- for a profile given a storage state, one `storage-state-applied` event with cookie, localStorage and declared session-cookie counts only;
- named state checkpoints from the test flow.

Room codes, account names, page text, cookies, storage-state contents, provider media data and token-bearing URL components are not recorded by the event and checkpoint code.

Failure text is different: an error message or stack comes from Node, Playwright or the browser, and its content is not chosen by this code. Before any error text is written (`setup-failure.json`, the `browser-launch-failure` and `trace-stop-failure` events, and the errors in `run-summary.json`) `sanitizeDiagnosticText` in `tests/e2e/artifact-utils.ts`:

- strips ANSI escape sequences (colors, cursor moves, hyperlinks);
- reduces `http(s)` URLs to scheme, host and path;
- shows the repository root as `<repo>` and the home directory as `<home>`;
- masks any other absolute POSIX or Windows path (including the path in a `file://` stack frame) as `<path>` followed by at most its last two segments, never the first two, which is where a user name sits, so `/home/someone/work/repo/tests/e2e/x.ts:10` becomes `<path>/e2e/x.ts:10`;
- redacts `password=`, `passwd=`, `token=`, `cookie=`, `secret=` and `authorization=` values.

What this does not do: a path with a space in it is recognized only up to the space unless it is the repository root or the home directory; a UNC path (`\\server\share\...`) is not recognized; a name in the last two segments of a path is kept as written, so a secret that is the name of a file or its directory is not removed unless it has the `key=value` form; and a credential in free text without one of the keywords above is not recognized. These are limits of pattern masking, not guarantees. Do not put secrets in error messages.

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

`tests/e2e/artifact-reporter.ts` writes `run-summary.json` with every test result. The rules are in `tests/e2e/artifact-classify.ts`, which `tests/artifact-reporter.test.ts` covers. A result that is neither passed nor skipped always gets one `failureClass`:

- `browser-launch/setup`: a failed test whose error text carries the `[browser-launch]` marker, or says "browser launch" or "service worker startup";
- `product-assertion`: any other failed test, one that reached the product scenario and failed an assertion;
- `timeout`: a test that timed out. The status decides and the text is not read, because a timeout does not say whether a hung launch or a hung product step caused it;
- `interrupted`: a test that was stopped before it finished (for example by `maxFailures` or Ctrl+C). It is not evidence about the product or the browser.

Passed and skipped tests have no class. `failureClasses` in the summary counts `browserLaunchOrSetup`, `productAssertions`, `timeouts` and `interrupted`, plus `unclassified` for any other non-passing status (expected to stay zero), so no non-passing result is left out of the counts.

Global setup failures are written as `setup-failure.json`. The intentional local diagnostic switch below verifies the product-assertion path without changing normal test behavior:

```bash
SYNCYOURJOY_E2E_INJECT_FAILURE=1 npm run test:e2e
```

This switch is test-only and must never be used as a product result. It is an artifact-pipeline check.

## Verification record

The following checks were performed in September 2026 against the CR-D01 branch, at repository version `0.2.4`. They are a historical record of that branch. They have not been repeated on the current code (see "What is not evidenced" below):

- `npm run typecheck` passed.
- The first run without an installed Playwright browser produced a per-profile `browser-launch-failure` event and a run summary classified as `browser-launch/setup`.
- After installing the repository-pinned Chromium runtime, the sandboxed run reached Chromium but terminated with `SIGABRT` and cleanup `EPERM`. The run was retained as environment evidence, not a product failure.
- A host-level run passed the generic two-profile fixture with one authenticated Crunchyroll test safely skipped. It produced a unique extension output, provenance manifest, two profile logs and a passing run summary.
- The controlled `SYNCYOURJOY_E2E_INJECT_FAILURE=1` run completed the real fixture flow and then failed intentionally. Its run summary reported one `product-assertion` failure and zero browser-launch failures, and both profile logs were retained.
- The opt-in trace run passed the generic fixture and both profile logs recorded `trace-started` and `trace-stopped` events with one archive per profile.
- The repository version was `0.2.4` when these runs were made. It is `0.2.12` in `package.json` now. This diagnostic hardening does not authorize a release bump or live-provider acceptance.

### Checked by unit tests

These run under `npm test` with no browser (`tests/artifact-utils.test.ts`, `tests/artifact-reporter.test.ts`, `tests/provenance.test.ts`, `tests/output-directory-guard.test.ts`). They check:

- the failure classes and counts, including timed-out and interrupted results, and the reporter's `run-summary.json` written from fake results;
- the masking of paths, ANSI sequences and credential pairs, including a path after a colon, a path of one or two segments, and the unchanged URLs (also with a bracketed IPv6 host, with or without a port);
- the working-tree flag for a clean tree, a modified tracked file, a deleted one and an untracked file, in temporary Git repositories;
- the output directory guard, including that two default runs get different directories, its wiring in the Playwright configuration, the setup and the reporter, and that `scripts/build-extension.mjs` stops, in a throwaway copy, before deleting the repository it is pointed at.

### What is not evidenced

- The September 2026 browser runs (normal fixture, controlled `SYNCYOURJOY_E2E_INJECT_FAILURE=1` failure, opt-in trace, launch failure, profile cleanup) were not run again for this change. Chromium cannot launch where this change was made, so nothing here shows that those runs still behave as recorded on the current code.
- No acceptance row is ticked by this change. It adds no provider, account, two-device or deployment evidence.
- `tests/e2e/playwright.config.ts` and `tests/e2e/global-setup.ts` are not executed by any test, because Playwright cannot start here. The tests read their source and check that both call the output directory guard with the repository root (two levels above `tests/e2e`), and that `global-setup.ts` passes that root to the error sanitizer. They do not show that Playwright accepts the resulting configuration.
- The trace lifecycle (`context.tracing.start()` and `stop()`) and the profile cleanup path can only be exercised with a browser and are not covered by the unit tests.

### Replaying the artifact checks

On a machine where Playwright's Chromium launches (`npx playwright install chromium` once):

1. `npm run test:e2e -- tests/e2e/two-profile-sync.spec.ts`, or the whole suite. Expect a new `test-results/e2e-<timestamp>-<pid>-<uuid>/` with `provenance.json` (check `workingTree.dirty` is `false` on a clean checkout and `true` after editing or adding a file), `run-summary.json` with `failureClasses` all zero, one `<profile>.events.json` per profile, and an `extension/` directory. `apps/extension/dist` must be unchanged.
2. `SYNCYOURJOY_E2E_INJECT_FAILURE=1 npm run test:e2e -- tests/e2e/two-profile-sync.spec.ts`. Expect `failureClasses.productAssertions` of 1 and `browserLaunchOrSetup` of 0.
3. Make the browser unable to start (for example rename the Chromium directory under Playwright's cache, then restore it). Expect a `browser-launch-failure` event in the profile log and `failureClasses.browserLaunchOrSetup` of at least 1.
4. `SYNCYOURJOY_E2E_TRACE=1 npm run test:e2e -- tests/e2e/two-profile-sync.spec.ts`. Expect `trace-started` and `trace-stopped` in both profile logs and one archive per profile.
5. `SYNCYOURJOY_E2E_OUTPUT_DIR=$PWD/apps/extension/dist npm run test:e2e` must stop at once with a message that names the variable, and `apps/extension/dist` must be untouched.
6. Read the written `*.json` files for a home directory, a user name, an ANSI sequence or a URL query string. None should appear. After the run, no `syncyourjoy-e2e-*` profile directory should remain in the system temporary directory.

## Scope boundary

CR-D01 improves diagnostic reliability for the existing local and protected E2E harness. It does not prove authenticated Crunchyroll playback, two-account acceptance, two-device recovery, deployment identity or visible provider output. Those remain separate evidence gates tracked by issues #30, #33, #34, #35 and #69.
