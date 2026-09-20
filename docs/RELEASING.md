# Releasing SyncYourJoy

SyncYourJoy uses an automated, tag-driven GitHub Release workflow. Every release publishes the same stable asset names:

- `sync-your-joy-extension.zip`
- `sync-your-joy-extension.zip.sha256`

This makes the README's latest-download link remain valid across versions.

## Deploy the room coordinator

The Worker is deployed separately from extension releases. Add a GitHub Actions repository secret named `CLOUDFLARE_API_TOKEN` with permission to deploy the `sync-your-joy-rooms` Worker, then run the **Deploy room coordinator** workflow manually from the verified `main` commit. The workflow runs the typecheck and test suite before invoking Wrangler and never prints the token.

Local deployment requires an authenticated Wrangler session (`npx wrangler login`) or a `CLOUDFLARE_API_TOKEN` environment variable. The account must own the Cloudflare Worker configured in `apps/edge-service/wrangler.jsonc`.

## What the workflow verifies

When a tag matching `vMAJOR.MINOR.PATCH` is pushed, `.github/workflows/release.yml`:

1. validates the semantic-version tag;
2. installs the exact locked dependency tree with `npm ci`;
3. runs TypeScript checks, the complete test suite, and production builds;
4. audits production dependencies at high severity;
5. confirms the tag version matches the root package, extension package, and extension manifest;
6. builds the extension against the deployed WSS coordinator;
7. creates and tests the ZIP archive;
8. creates and verifies a SHA-256 checksum;
9. creates the GitHub Release and marks it as latest.

The release fails before publication if any check fails.

## Prepare a version

Update these three files to the same semantic version:

- `package.json`
- `apps/extension/package.json`
- `apps/extension/static/manifest.json`

Run:

```bash
npm ci
npm run release:check-version
npm run check
npm audit --omit=dev --audit-level=high
RELEASE_VERSION=0.1.22 npm run release:package
```

The local packaging command writes ignored artifacts under `release/`. Inspect the ZIP and checksum before tagging.

Update `CHANGELOG.md` with only completed and verified behavior. Commit and push the version and documentation changes to `main`, then wait for continuous integration to pass.

## Publish the GitHub Release

Create an annotated tag on the verified commit and push only that tag:

```bash
git tag -a v0.1.22 -m "SyncYourJoy v0.1.22"
git push origin v0.1.22
```

The release workflow creates the GitHub Release. Do not upload a different hand-built ZIP under the same version. After it completes:

1. open the release page;
2. verify that both assets are present;
3. download the ZIP through the stable latest-download link;
4. verify the checksum;
5. extract it and confirm that Chrome can load the folder as an unpacked extension;
6. confirm that `manifest.json` reports the tagged version and the production room endpoint.

If a tag was pushed from the wrong commit, do not silently replace an already distributed release. Correct the source and publish the next patch version.

## What users install

GitHub distributes the ZIP, but Chrome cannot run it while compressed. Users extract it and select the extracted folder through `chrome://extensions` and **Load unpacked**. This works for testing and public beta distribution, but it does not auto-update.

For normal one-click installation and automatic updates on Windows and macOS, publish the production ZIP through the Chrome Web Store. That is a separate process requiring a Chrome Web Store developer account, a completed listing and privacy disclosure, submission for review, and store-managed releases. The GitHub workflow is designed so its verified ZIP can become the source artifact for that future submission.

## Versioning guidance

- Patch: compatible bug fixes, adapter fixes, diagnostics, or small UI improvements.
- Minor: backward-compatible user-facing capability or protocol evolution.
- Major: incompatible protocol, stored-state, or installation changes.

Because streaming platforms change outside this repository, compatibility statements must remain precise and evidence-based even when the extension version does not change.

## Milestone release policy

Issue and pull-request completion does not automatically authorize a release. Use the public delivery project to show which work is complete, which evidence is partial, and which runtime or deployment gates remain blocked.

### Release after a verified issue group

After a coherent group of issues is fixed and its required source, test, browser, deployment and user-acceptance gates are verified, publish the next compatible semantic version. Starting from the current `0.2.4` line, a compatible bug-fix group should use `0.2.5`; a backward-compatible user-facing capability may use the next minor version instead. The exact version must be chosen in the release PR and recorded in `CHANGELOG.md`.

Before tagging the group release:

1. Confirm every included issue and PR has a documented acceptance result and no unresolved blocker.
2. Update `package.json`, `apps/extension/package.json` and `apps/extension/static/manifest.json` to the same version.
3. Add only verified behavior to `CHANGELOG.md`, including the exact commit and known compatibility limits.
4. Run `npm run release:check-version`, `npm run check`, `npm run verify:browser-packages`, the production dependency audit and the release package checksum verification.
5. Merge the version and changelog PR, wait for required checks, then create the annotated `vMAJOR.MINOR.PATCH` tag from the verified `main` commit.
6. Verify the GitHub Release assets, checksum, manifest version, coordinator endpoint and extracted extension smoke result.

Do not publish a group release while an included issue is only source-reviewed, only headless-tested, or explicitly blocked on deployment, a real device, a provider account or user acceptance.

### Milestone-end `1.0.0` gate

At the end of the current milestone, `1.0.0` is a separate release gate, not an automatic consequence of a patch release. Tag `v1.0.0` only after the milestone acceptance record confirms that the approved scope is complete, all required external gates are either passed or explicitly removed from the claimed scope, deployment identity is verified, rollback is understood, and the release artifacts have passed the same workflow above. The `1.0.0` release PR must link the milestone evidence and must not claim support for browsers, providers or deployments that were not directly tested.
