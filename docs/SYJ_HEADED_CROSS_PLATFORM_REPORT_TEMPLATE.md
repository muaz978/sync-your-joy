# Headed Browser and Cross-Platform Verification Report

Issue: [#35](https://github.com/muaz978/sync-your-joy/issues/35)

This template records the headed-browser and package-runtime acceptance gate. Headless Chromium CI, source inspection, package builds and unit tests are supporting evidence only. They do not prove a real headed page, Firefox installation or Safari runtime.

This is a runbook, not a result or release approval. Complete each browser section only when the exact runtime and candidate are available.

## Evidence and privacy boundary

Record candidate identity, package hash, browser/runtime version, operating system, fixture label, player identity decision, lock state, native media state, diagnostics, visible motion, SPA/navigation result and error category.

Do not record passwords, cookies, storage-state files, signed URLs, source URLs with tokens, media bytes, provider HAR files, protected screenshots, screen recordings or DRM data. Use the local generic fixture for lifecycle checks and record commercial-provider behavior separately when authorized.

## Run identity and prerequisites

| Field | Value |
| --- | --- |
| Report ID | `SYJ-BROWSER-YYYYMMDD-###` |
| Date and timezone |  |
| Operator |  |
| Candidate commit SHA |  |
| Chrome/Edge package name and SHA-256 |  |
| Firefox package name and SHA-256 |  |
| Safari conversion/build identity |  |
| Coordinator deployment identity |  |
| macOS version |  |
| Windows/Linux version if used |  |
| Browser versions | Record separately per runtime |
| Fixture or provider label |  |
| Other extensions | Fixed list or clean profile |
| Protected data handling confirmation | `Confirmed: no secrets or protected media attached` |

Required prerequisites:

- The exact candidate commit and package hashes are recorded.
- The local fixture is available for open Shadow DOM, SPA route/player replacement and multiple-player lock checks.
- The browser is running in a real headed window. A headless pass cannot fill a headed evidence row.
- Firefox uses the output of `npm run build:extension:firefox` installed in a real Firefox profile.
- Safari is marked `BLOCKED` or `NOT CLAIMED` unless conversion, Xcode build and Safari runtime are available.
- Any browser or platform not directly tested is listed as not claimed.

## Browser and package matrix

| Runtime | Package/build identity | Install method | Headed | Baseline | Candidate | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Chrome |  | Load unpacked Chrome output |  |  |  |  |  |
| Edge |  | Load unpacked Chrome output |  |  |  |  |  |
| Firefox |  | Install Firefox output |  |  |  |  |  |
| Safari |  | Converted Xcode app/extension |  |  |  |  |  |

Use `NOT CLAIMED` when support is intentionally deferred. Use `BLOCKED` when the required runtime or packaging environment is unavailable. Neither is a pass.

## Local lifecycle matrix

Run each applicable row in every claimed headed runtime. Use the generic fixture before attempting an authenticated provider.

| # | Browser/runtime | Scenario | Baseline | Candidate | Visible motion | Diagnostics/lock evidence | Result |
| ---: | --- | --- | --- | --- | --- | --- | --- |
| 1 |  | Open Shadow DOM player discovery |  |  |  |  |  |
| 2 |  | Open Shadow DOM play/pause/seek |  |  |  |  |  |
| 3 |  | Same-element SPA URL change |  |  |  |  |  |
| 4 |  | SPA player replacement |  |  |  |  |  |
| 5 |  | Multiple competing video elements |  |  |  |  |  |
| 6 |  | Lock selected player |  |  |  |  |  |
| 7 |  | Unlock and choose replacement player |  |  |  |  |  |
| 8 |  | Nested frame or open Shadow DOM combination |  |  |  |  |  |
| 9 |  | Ready, play, pause and forward/backward seek |  |  |  |  |  |
| 10 |  | Player reload or source replacement |  |  |  |  |  |

The selected player must remain authoritative when unrelated videos, ads or background elements appear. A changing room position without native visible progress is not a pass.

## Firefox real-install section

Complete this section only after installing the Firefox package in a real profile.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run build:extension:firefox` completed |  |  |
| Firefox manifest and package hash recorded |  |  |
| Extension installed in a real Firefox profile |  |  |
| Room creation and join |  |  |
| Coordinator connection accepted with the actual Firefox origin |  |  |
| Open Shadow DOM detection |  |  |
| SPA/player replacement |  |  |
| Player-lock UI |  |  |
| Play, pause and seek visible progress |  |  |
| Reconnect and readiness behavior |  |  |
| Two-person smoke if claimed |  |  |

Do not mark Firefox supported based on package creation or a source-level origin allowlist alone. The actual installed package and coordinator connection must be observed.

## Safari conversion and runtime section

Safari requires its own macOS/Xcode workflow. If the converter or Xcode environment is unavailable, record the exact limitation and leave Safari `NOT CLAIMED` or `BLOCKED`.

| Check | Result | Evidence |
| --- | --- | --- |
| Safari conversion command and version |  |  |
| Conversion staging path accepted |  |  |
| Generated Xcode project identity |  |  |
| Xcode build/signing environment |  |  |
| Safari extension installed or enabled |  |  |
| Coordinator connection with actual Safari origin |  |  |
| Open Shadow DOM and SPA lifecycle |  |  |
| Player-lock UI |  |  |
| Play, pause, seek and visible progress |  |  |
| Reconnect/readiness behavior |  |  |

Do not describe Safari as supported until the converted package has passed the real Safari smoke test. A converter error is an environment or packaging blocker until its cause is established.

## Evidence rules

Keep the following evidence classes separate:

- Source/package: commands, hashes, manifest and build identity.
- Browser lifecycle: headed DOM/player/SPA and frame behavior.
- Native player: paused, seeking, ready state, current time and visible motion.
- Extension diagnostics: selected binding, origin/frame, source kind, lock state and sanitized error category.
- Coordinator: connection, room revision, participant and readiness state.
- Human observation: moving output, frozen output, black loader, buffering or inaccessible UI.

Use these outcomes:

- `PASS`: the exact runtime and candidate passed the applicable row with direct headed evidence.
- `FAIL`: a required behavior failed or visible output was black/frozen while counters advanced.
- `BLOCKED`: the runtime, packaging tool, device, deployment or required fixture was unavailable.
- `NOT CLAIMED`: the project intentionally does not advertise that browser/runtime.
- `UNRESOLVED`: evidence conflicts or needs a controlled repeat.

## Sanitized failure record

For every `FAIL`, `BLOCKED`, `NOT CLAIMED` or `UNRESOLVED` row, record:

- report ID, candidate SHA, package hash, browser/runtime and operating system;
- exact command or manual action;
- last known player identity, lock state and native state;
- whether room and visible player evidence agreed;
- exact user-visible error or packaging message;
- whether the result is environment, packaging, browser lifecycle or product behavior;
- the next experiment or support decision.

Do not infer DRM, provider, network or browser causes without direct evidence.

## Completion checklist

The issue remains open unless every claimed runtime has direct evidence and every unclaimed runtime is explicitly documented.

- [ ] Real headed Chrome or Edge lifecycle pass completed.
- [ ] Open Shadow DOM player discovery and control tested.
- [ ] Same-element SPA URL change tested.
- [ ] Player replacement and multiple-player lock UI tested.
- [ ] Package hash and candidate identity recorded.
- [ ] Real Firefox package installation and smoke completed, or Firefox explicitly deferred.
- [ ] Firefox coordinator connection and native playback tested if claimed.
- [ ] Safari conversion, Xcode build and Safari runtime completed, or Safari explicitly deferred.
- [ ] Safari coordinator connection and native playback tested if claimed.
- [ ] Visible motion was checked separately from counters and room labels.
- [ ] Every failure or blocker has sanitized evidence and a follow-up decision.
- [ ] User acceptance recorded for every claimed runtime.

## Final decision

| Decision | Select one | Evidence |
| --- | --- | --- |
| Accepted for the explicitly claimed browser/runtime matrix |  |  |
| Partially accepted with browsers explicitly deferred |  |  |
| Blocked by runtime, packaging, device or deployment availability |  |  |
| Failed and requires implementation work |  |  |

Operator confirmation:

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files, protected screenshots or
screen recordings. I have not treated headless CI or package creation as headed
browser or cross-platform runtime acceptance.
```
