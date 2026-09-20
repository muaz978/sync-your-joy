# CR-A02 Player Identity Acceptance Report

Issue: [#49](https://github.com/muaz978/sync-your-joy/issues/49)

This report verifies that one identity decision protects every player layout and every state path. It is an evidence template, not a completed result or release approval. The deterministic matrix in `apps/extension/src/content-script.test.ts` is supporting evidence. A real headed nested-frame run is still required before this issue can be accepted for release.

## Privacy and state-only boundary

Record only candidate identity, browser/runtime version, layout label, frame relationship, sanitized media identity, room revision, player binding, native state, bounded positions, visible motion and error category.

Do not record passwords, cookies, storage-state contents, signed URLs, source URLs with tokens, media bytes, provider HAR files, protected screenshots, screen recordings, license traffic or DRM data. Each participant uses their own authorized provider account when a live provider run is approved.

## Candidate and environment

| Field | Value |
| --- | --- |
| Report ID | `SYJ-CR-A02-YYYYMMDD-###` |
| Candidate commit SHA |  |
| Extension package name and SHA-256 |  |
| Coordinator deployment identity |  |
| Browser and version |  |
| Operating system |  |
| Role | Controller or member |
| Fixture/provider label |  |
| Protected-data handling | `Confirmed: no secrets or protected media attached` |

Required evidence:

- The exact candidate and coordinator identity are recorded.
- The extension is freshly loaded in the headed browser used for the claim.
- A generic fixture is used before any commercial provider.
- Any provider, browser or frame layout not directly tested is marked `NOT CLAIMED` or `BLOCKED`.

## Identity layout matrix

Run the full state-path matrix for each layout that is claimed.

| Layout | Local identity source | Worker binding required | Expected decision | Result | Evidence |
| --- | --- | --- | --- | --- | --- |
| Top-document Crunchyroll | Stable `crunchyroll:<episode>` identity | No, but binding must remain same tab/frame | `match` for the same episode, `mismatch` for another episode |  |  |
| Origin-only Crunchyroll iframe | Referrer exposes only provider origin | Yes, matching outer-tab binding | `match` only after acknowledged binding |  |  |
| Generic nested embed | Wrapper URL is unresolved | Yes, matching outer-tab binding | `match` only after acknowledged binding |  |  |
| Qfilm nested/player variant | Stable `qfilm:<vid>` identity from page identity | No for stable matching ID; binding still scopes delivery | `match` for same `vid`, `mismatch` for another `vid` |  |  |

An unresolved frame is not an unconditional match. A worker binding for a different room identity is a known mismatch. A frame from another tab or an unrelated frame must not inherit authority from the selected player.

## State-path matrix

Record separate evidence for every row. A room counter or sample timestamp without the native and visible player result is insufficient.

| Layout | Incoming command | Outgoing controller intent | Player sample | Seek acknowledgement | Unrelated frame rejected | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Top-document Crunchyroll | Play/pause/position applied to selected video | Play, pause and seek emitted from selected video | Current position and buffering/progress state | Only after matching native target is ready |  |  |
| Origin-only Crunchyroll iframe | Play/pause/position applied to selected video | Play, pause and seek emitted from selected video | Current position and buffering/progress state | Only after matching native target is ready |  |  |
| Generic nested embed | Play/pause/position applied to selected video | Play, pause and seek emitted from selected video | Current position and buffering/progress state | Only after matching native target is ready |  |  |
| Qfilm nested/player variant | Play/pause/position applied to selected video | Play, pause and seek emitted from selected video | Current position and buffering/progress state | Only after matching native target is ready |  |  |

For every `match` row, capture:

1. the room revision and sanitized identity;
2. the selected tab/frame binding and player-lock state;
3. the incoming command and native result;
4. the outgoing intent or sample and its revision;
5. the seek target, native readiness and `SEEK_APPLIED` result;
6. visible motion separately from the aggregate sample.

For every `mismatch`, `unknown` or rejection, record the same identity and binding evidence plus the reason the command, intent, sample or acknowledgement was withheld.

## Deterministic evidence already covered by the repository

The issue-specific test matrix must remain green:

- `apps/extension/src/player-identity.test.ts` covers strong provider identity, unresolved nested identity, worker-bound authority, strong mismatch and top-document mismatch.
- `apps/extension/src/content-script.test.ts` covers the four layouts for incoming playback, samples, controller play/pause/seek intents and seek acknowledgement.
- `apps/extension/src/player-tab.test.ts` covers same-tab/frame binding, stale replacement, wrong-media rejection, larger replacement behavior and navigation identity reuse.
- `apps/extension/src/service-worker.test.ts` covers observed episode identity, old-room protection, stale same-tab context and player binding generation.
- `apps/extension/src/media-fingerprint.test.ts` covers Crunchyroll episode IDs, Qfilm page/embed variants and shared-page rebinding.

These tests establish source and deterministic evidence only. They do not establish real browser injection, real nested frame lifecycle, provider playback, cross-origin behavior or release readiness.

## Headed browser gate

Use a fresh extension package in a real headed browser and complete the following:

| Check | Result | Evidence |
| --- | --- | --- |
| Top-document Crunchyroll identity and command path |  |  |
| Origin-only Crunchyroll iframe identity and command path |  |  |
| Generic nested embed identity and command path |  |  |
| Qfilm page/embed identity if claimed |  |  |
| Same-tab unrelated frame cannot replace selected player |  |  |
| Wrong episode cannot receive old room commands |  |  |
| Matching native seek produces one acknowledgement |  |  |
| Unready or mismatching player produces no acknowledgement |  |  |
| Visible video movement agrees with the reported sample |  |  |
| Recovery after frame replacement or navigation |  |  |

Do not infer a real nested-frame pass from headless Chrome, a unit test, a package build or a source-level `all_frames` setting.

## Sanitized failure or blocker record

For every `FAIL`, `BLOCKED`, `NOT CLAIMED` or `UNRESOLVED` result, record:

- report ID, candidate SHA, package hash, browser and operating system;
- layout, outer page label and frame relationship without signed URLs;
- selected and reported identity, worker binding and lock state;
- last command or intent, room revision and native state;
- whether room position, native position and visible motion agreed;
- exact user-visible error or sanitized diagnostic category;
- whether the cause is source, browser lifecycle, provider, deployment or environment;
- the next controlled experiment or support decision.

Do not assign a DRM, provider or network cause without direct evidence.

## Decision and release boundary

| Decision | Select one | Evidence |
| --- | --- | --- |
| Deterministic identity contract accepted, headed gate pending |  |  |
| Accepted for the explicitly tested headed layout matrix |  |  |
| Blocked by missing browser, deployment or authorized provider environment |  |  |
| Failed and requires implementation work |  |  |

Issue #49 remains open until the required headed nested-frame case and all explicitly claimed state paths pass. Even a successful issue run does not authorize a release by itself. Release publication follows the repository release gate: a verified group of changes may receive the next compatible semantic version, while the end of the milestone is the separately authorized `1.0.0` release gate.

Operator confirmation:

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files, protected screenshots or
screen recordings. I kept identity, native state, coordinator state and visible
motion as separate evidence classes.
```
