# CR-A03 Operation Ownership Acceptance Report

Issue: [#50](https://github.com/muaz978/sync-your-joy/issues/50)

This report verifies that asynchronous player operations retain explicit ownership through command replacement, source replacement, cancellation, timeout and late native completion. It is an evidence template, not a completed result or release approval. Deterministic tests establish the source contract; a headed browser run is separate evidence for the provider lifecycle claimed by the operator.

## Privacy and state-only boundary

Record only candidate identity, browser/runtime version, sanitized media identity, operation kind, operation token or generation, room revision, bounded positions, native readiness, visible motion and error category.

Do not record passwords, cookies, storage-state contents, signed URLs, source URLs with tokens, media bytes, provider HAR files, protected screenshots, screen recordings, license traffic or DRM data. A provider run uses the operator's own authorized account and records only the state needed to prove the operation lifecycle.

## Candidate and environment

| Field | Value |
| --- | --- |
| Report ID | `SYJ-CR-A03-YYYYMMDD-###` |
| Candidate commit SHA |  |
| Extension package name and SHA-256 |  |
| Coordinator deployment identity |  |
| Browser and version |  |
| Operating system |  |
| Provider or fixture label |  |
| Room role | Controller or member |
| Protected-data handling | `Confirmed: no secrets or protected media attached` |

Required evidence:

- The exact candidate and coordinator identity are recorded.
- The extension is freshly loaded in the headed browser used for the claim.
- A deterministic fixture is used before any commercial provider.
- Any browser, provider or player lifecycle not directly tested is marked `NOT CLAIMED` or `BLOCKED`.

## Operation ownership contract

Every asynchronous operation must carry an identity that is checked before its completion can change room state or become local controller intent.

| Operation | Owner identity | One-in-flight rule | Retired by | Valid completion |
| --- | --- | --- | --- | --- |
| Programmatic seek | Operation token plus command and source generations, target and room revision | Repeated same-target state does not write again | Newer room target, timeout retry boundary, pause, media/source change, room exit, controller/lease change | Native position is ready and matches the active target, or late completion is observed read-only after timeout |
| Programmatic play | Operation token plus command and source generations, player element and source | A second play promise is not started while one is pending | Pause, command change, media/source change, room exit, controller/lease change | Promise settles while its token, element and source remain current |
| Debounced controller seek intent | Captured command and source generation plus current player identity | One debounced intent per genuine user target | New room command, source change, pause, controller/lease change, room exit | Timer still owns the current generation and the player is still the local controller |

An operation completion must never be interpreted as fresh user intent solely because the room command, source, player binding or controller lease changed while the browser was working.

## Lifecycle transition matrix

Run or reproduce each transition with the exact candidate. Record native state and visible motion separately from room state.

| Transition | Expected operation result | Expected room effect | Result | Evidence |
| --- | --- | --- | --- | --- |
| Same target applied repeatedly while seek is in flight | One native write, one owner | No repeated seek restart |  |  |
| New room target while old seek is in flight | Old owner retired, new target may start once | Newer controller intent wins |  |  |
| Timeout before `seeked` | Owner remains attributable and no same-target retry loop | Status may report buffering/recovery, but no unsafe resume |  |  |
| Late `seeked` after timeout | Read-only completion observation | No new controller seek intent |  |  |
| Late `canplay`, `loadeddata` or `playing` after timeout | Read-only completion observation may settle the owner | No duplicate native write |  |  |
| `PAUSE_LOCAL` during pending seek or play | Old owners retired | Late success or rejection is ignored |  |  |
| Media `emptied`, `loadstart`, `error` or source replacement | Source generation changes and old owners retire | Old media cannot update the new player state |  |  |
| Same-element route or page-identity change | Source generation changes | Old room command cannot control the new episode |  |  |
| Controller or lease change | Command generation changes and local callbacks retire | Former controller cannot continue issuing intent |  |  |
| Room detach or exit | All local owners retire | No stale operation can mutate the departed room |  |  |
| Genuine different-target Skip Intro or scrub | Old expectation is superseded, one new intent is debounced | New target propagates exactly once |  |  |
| Stale play resolve or rejection | Token, element and source check fails | No stale success, autoplay error or status mutation |  |  |

## Deterministic evidence required

The following tests must remain green and must be named in the PR evidence record:

- `apps/extension/src/player-operations.test.ts` covers one in-flight seek ownership, timed-out attribution, cancelled late completion, stale play callbacks and generation invalidation.
- `apps/extension/src/content-script.test.ts` covers late readiness after timeout without another native write, cancelled debounced controller intent, local pause retirement, stale play rejection, different-target Skip Intro, source replacement, room-barrier expiry and controller play/pause/seek behavior.
- Existing `apps/extension/src/player-identity.test.ts`, `apps/extension/src/player-tab.test.ts`, `apps/extension/src/service-worker.test.ts` and `apps/extension/src/media-fingerprint.test.ts` remain green because operation ownership depends on the selected player and room binding.

These tests establish source and deterministic evidence only. They do not establish commercial-provider playback, headed browser injection, visible frame output, deployment behavior or user acceptance.

## Headed browser and provider gate

Use a fresh package in a real headed browser when claiming the following. Use the operator's current authorized provider session only after confirming the exact test scope. Do not copy daily-use cookies or storage state.

| Check | Result | Evidence |
| --- | --- | --- |
| Generic fixture, same-target command does not restart a slow seek |  |  |
| Generic fixture, timeout followed by `seeked` produces no local seek intent |  |  |
| Generic fixture, timeout followed by readiness completes without another write |  |  |
| Pause during pending play ignores late resolve and rejection |  |  |
| Same-element source replacement retires old callback |  |  |
| Player replacement or route change retires old operation |  |  |
| Controller transfer retires former-controller callbacks |  |  |
| Genuine different-target Skip Intro or scrub emits one intent |  |  |
| Visible video motion agrees with native and room state |  |  |
| Authenticated Crunchyroll run, if claimed |  |  |

Do not infer a headed or provider pass from a unit test, mocked promise, advancing media counter, package build or source inspection.

## Sanitized failure or blocker record

For every `FAIL`, `BLOCKED`, `NOT CLAIMED` or `UNRESOLVED` result, record:

- report ID, candidate SHA, package hash, browser and operating system;
- operation kind, token/generation class, sanitized media identity and room revision;
- command or lifecycle transition that retired the operation;
- native target, actual position, readiness, seeking state and visible-motion result;
- whether a duplicate native write, stale intent, unsafe resume or stale play error occurred;
- exact user-visible error or sanitized diagnostic category;
- whether the cause is source, browser lifecycle, provider, deployment or environment;
- the next controlled experiment or support decision.

Do not assign a provider, DRM or network cause without direct evidence.

## Decision and release boundary

| Decision | Select one | Evidence |
| --- | --- | --- |
| Deterministic operation contract accepted, headed/provider gate pending |  |  |
| Accepted for the explicitly tested headed lifecycle matrix |  |  |
| Blocked by missing device, deployment or authorized test environment |  |  |
| Failed and requires additional implementation work |  |  |

Issue #50 remains open until every applicable acceptance gate is directly evidenced. A successful deterministic test suite does not authorize a release by itself. Release publication follows the repository release gate: a verified coherent group may receive the next compatible semantic version, while the end of the milestone remains the separate `1.0.0` release gate.

Operator confirmation:

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files, protected screenshots or
screen recordings. I kept operation identity, native state, coordinator state and
visible motion as separate evidence classes.
```
