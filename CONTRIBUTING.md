# Contributing to SyncYourJoy

Thank you for helping improve reliable synchronized playback.

## Product boundary

Contributions must preserve the project's privacy and legal boundary. SyncYourJoy synchronizes playback state between participants who use their own authorized accounts. It must not capture or retransmit protected media, share accounts, extract credentials or DRM material, bypass access controls, or inspect unrelated browsing data.

## Report a problem

Use the repository's [bug report form](https://github.com/muaz978/sync-your-joy/issues/new?template=bug_report.yml). Include:

- the SyncYourJoy version;
- the website and video-page URL, without private query parameters;
- Chrome and operating-system versions;
- controller or guest role;
- exact reproduction steps;
- whether play, pause, forward seek, or backward seek failed;
- the downloaded detailed report, after checking it for anything you do not want to share.

Never post passwords, cookies, account details, payment information, protected media, screenshots containing sensitive data, or private room codes.

## Local setup

Use Node.js 22 or newer.

```bash
npm ci
npm run check
```

For a local room coordinator:

```bash
npm run dev:server
```

Load `apps/extension/dist` through `chrome://extensions` after running the build. The local test player is available at `http://127.0.0.1:8787/test-player`.

## Changes and pull requests

1. Keep changes focused on one bug or feature.
2. Add or update automated tests for protocol, synchronization, adapter, UI-state, or permission behavior.
3. Run `npm run check` and `npm audit --omit=dev --audit-level=high`.
4. Explain the user-visible behavior, test evidence, privacy impact, and any platform-specific uncertainty in the pull request.
5. Do not include generated `dist`, `release`, secrets, captured media, or account data.

Compatibility claims should name the exact page and behavior tested. A unit test or successful build does not prove live compatibility with a commercial streaming service.

## Releases

Only maintainers create release tags. See [Releasing](docs/RELEASING.md) for versioning, packaging, and GitHub Release instructions.

The repository does not currently include an open-source license. Submitting a contribution does not by itself change the repository's licensing terms.
