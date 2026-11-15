# CR-A03 Operation Ownership Acceptance Report

Issue: [#50](https://github.com/muaz978/sync-your-joy/issues/50)

This report fills the deterministic rows of [the acceptance template](CR_A03_OPERATION_OWNERSHIP_ACCEPTANCE_REPORT_TEMPLATE.md). It records unit-test evidence only: a fake video element driven by Vitest fake timers. Nothing was loaded in a browser, nothing was observed on a provider page, and no row that needs a headed browser, a provider session, a second account, a second device or a deployment has been run. Those rows are marked `NOT RUN`. This report is not a release approval and does not close the issue.

Per the owner decision of 2026-10-31 on #50, the provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69. This card is judged on its own acceptance criteria and local evidence.

## Privacy and state-only boundary

Nothing in this report is a credential, cookie, storage state, signed URL, media byte or provider capture. The tests use a synthetic fake element and a synthetic room snapshot. The extension remains state-only: no private provider API and no media access.

## Candidate and environment

| Field | Value |
| --- | --- |
| Report ID | `SYJ-CR-A03-20261115-001` |
| Candidate commit SHA | Base `257afb6` (main, extension 0.2.12) plus the pull request that adds this report. The head SHA of that pull request is the candidate; a file cannot name the commit that contains it. |
| Extension package name and SHA-256 | No package was built or loaded. For the bundle only: `npm run build:extension` at the code commit gives `apps/extension/dist/content-script.js` SHA-256 `6851586494ec1bea10f2e26617cb15ee9111c61ba82a73131ea02f802b9a4aed` (the test and documentation commits do not change it). This is a hash of one built file, not of a release archive, and was not loaded into a browser. |
| Coordinator deployment identity | NOT RUN. No coordinator was involved. |
| Browser and version | NOT RUN. Vitest 5.1.0 on Node, with a fake `HTMLVideoElement`. |
| Operating system | macOS (Darwin), the development machine. |
| Provider or fixture label | None. Unit-level fake element only. |
| Room role | Controller and member, both simulated by changing `participantId` and `controller` in the synthetic snapshot. |
| Protected-data handling | `Confirmed: no secrets or protected media attached` |

## Operation ownership contract

The contract in the template holds in the code as follows. Each row names the unit tests that pin it. A test is named here only if a mutation of the production line it pins makes it fail (see [Mutation checks](#mutation-checks)).

| Operation | Owner identity | Evidence |
| --- | --- | --- |
| Programmatic seek | Operation token with command and source generations, target and room revision (`player-operations.ts`) | `player-operations.test.ts`: one owner per same target; retirement on `invalidateCommand` and on `invalidateSource`; the retired list holds the eight most recent and forgets the oldest; attribution window of exactly five seconds; one-second match tolerance. `content-script.test.ts`: "the 1,500 ms local seek timeout". |
| Programmatic play | Operation token, element and source, checked by `isCurrent()` in `requestVideoPlay` | `content-script.test.ts`: "a play() that settles after the room has moved on", for a room pause, a source reset, the room being left, a controller change and a higher lease epoch; success and rejection separately. |
| Debounced controller seek intent | Captured generation, local-controller check and the timer itself | `content-script.test.ts`: "a controller scrub whose debounce is still running". |

## Lifecycle transition matrix (deterministic rows)

`UNIT` means the row is covered by a deterministic unit test and by nothing else.

| Transition | Result | Evidence |
| --- | --- | --- |
| Same target applied repeatedly while seek is in flight | UNIT | `player-operations.test.ts` "keeps one in-flight seek owner for the same target"; `content-script.test.ts` "does not repeatedly restart an in-flight seek as the room clock advances". |
| New room target while old seek is in flight | UNIT | `content-script.test.ts` "supersedes a pending seek when a newer room target arrives"; `player-operations.test.ts` "retires a seek that a newer target replaced". |
| Timeout before `seeked` | UNIT | "keeps adopting the seek at 1,499 ms ..." and "treats the seek as timed out at 1,500 ms ..."; "does not rewrite a timed-out seek on a heartbeat once the element stopped seeking short of the target, and Sync writes it once". The stuck-seek ladder reissues the target once after six idle seconds (existing tests under "and nobody presses Sync"); the new test stays inside those six seconds. |
| Late `seeked` after timeout | UNIT | `content-script.test.ts` "keeps late correction completion from becoming a controller seek" and "does not turn a late native completion into a new seek after the room barrier expires" (existing). |
| Late `canplay`, `loadeddata` or `playing` after timeout | UNIT | "finishes a timed-out seek from late readiness without another native write" (existing). |
| Seek the page saw complete (readiness, probe or room update) before the element's own `seeked` | UNIT | "a seek the room started, finished by readiness before the native seeked arrives": readiness event, completion probe and next room update, each as the controller. This row found a defect, see [Defect found and fixed](#defect-found-and-fixed). |
| `PAUSE_LOCAL` during pending seek or play | UNIT | "does not turn a late seek completion into intent after local pause retires it" and "ignores pending play failure after immediate local pause before a server reply" (existing). |
| Media `emptied`, `loadstart`, `error` or source replacement | UNIT | "does not act on a success that arrives after a source reset" and "does not report a refused start for a rejection that arrives after a source reset"; `player-operations.test.ts` retirement on `invalidateSource`. |
| Same-element route or page-identity change | UNIT, partly | Page identity calls the same `resetPlayerOperations()` as a source reset; the source-reset tests cover that function. No test changes the page URL. |
| Controller or lease change | UNIT | "does not act on a success that arrives after a controller change to another participant" and "... a higher lease epoch for the same controller"; the matching rejection tests; "is dropped when another participant becomes the controller" and "... takes the lease again with a higher epoch". |
| Room detach or exit | UNIT | "does not act on a success that arrives after the room being left", the matching rejection test, "is dropped when the room is left". |
| Genuine different-target Skip Intro or scrub | UNIT | "Skip Intro as the controller": once through scrub, room barrier and element finishing; once when the element finishes after the local barrier timed out; once when the element finishes inside the duplicate window. |
| Stale play resolve or rejection | UNIT | "a play() that settles after the room has moved on" (success, `NotAllowedError` rejection) and "leaves the deadline of a retry in place when the play it replaced settles late". |

## Defect found and fixed

A seek that the page itself saw finish (the `canplay`/`loadeddata` readiness handlers, the 80 ms completion probe, or a room update that finds the player already on target) cleared the active seek without recording its target. If the element's own `seeked` event arrived afterwards, `handleSeeked` found no active seek, no retired seek and no expectation, classified the event as `user`, and, for the controller, sent it to the room as a new seek intent (`PLAYER_INTENT` `seek` for the room's own target). The new tests "is not sent as the controller's own seek when a readiness event completes it first" and "... when the completion probe finishes it first" failed with exactly that `PLAYER_INTENT` before the fix.

The fix is `PlayerOperations.completeSeek(token, nativeEventStillDueAtMs?)`: when the page decided the completion itself, the completed target is retired for the same five-second attribution window as a cancelled seek. A completion that the `seeked` event itself delivered retires nothing. This was a risk named in the 2026-10-16 status check, not confirmed in a browser; it is confirmed at unit level only. Cost: for five seconds after such a completion, a native scrub of the controller to within one second of the same target is attributed to the old seek and not sent to the room.

## Mutation checks

Each production line was changed in place, the two test files run, and the file restored with `git checkout`. `KILLED` means at least one test failed.

| Mutation | Result |
| --- | --- |
| Drop `controllerChanged` from the invalidation condition | KILLED (5 tests: success, rejection and the higher-epoch debounce case) |
| Drop `roomDetached` from the condition | SURVIVED: a room exit is also a command change and a controller change, so two other terms still invalidate. The room-exit tests are killed when all three terms are removed for a null snapshot. |
| Play success always treated as current | KILLED (6 tests) |
| Play rejection always treated as current | KILLED (8 tests, three of them existing) |
| Stale success clears the retry's deadline timer | KILLED (the retry-deadline test) |
| Remove the timed-out no-rewrite guard | KILLED |
| Timeout comparison `>=` becomes `>`, or fires 1 ms early | KILLED, KILLED |
| Probe or readiness completion no longer attributes the late `seeked` | KILLED (2 tests) |
| Room-update completion no longer attributes the late `seeked` | KILLED (1 test, after the test was moved to a room seek barrier; the first version of that test never reached the path and the mutation survived) |
| Duplicate controller seek intents no longer suppressed | KILLED |
| Retired list cap 7 or 9, never trimmed, newest kept | KILLED (each) |
| Attribution window 4 s or 6 s, inclusive expiry, tolerance 0.5 s or 2 s | KILLED (each) |
| Source change no longer retires the active seek | KILLED |
| Debounced intent ignores only the generation, or only the generation and controller check | SURVIVED: `invalidateRoomOperations()` also cancels the timer, which is a third guard. Removed together with the `controllerChanged` term the tests are KILLED (6 tests). |

Consequences for the named requirement that each controller-change test must fail without the controller-change term: the late-play success, late-play rejection and "same participant, higher epoch" debounced-intent tests do. The "other participant" debounced-intent test does not fail on that single edit, because the timer cancellation, the generation check and the controller check each also stop it. The late-`seeked` tests after a controller change are green with and without the term, because a programmatic completion is attributed whether the seek is still active or retired; they pin the behaviour and do not distinguish the two.

## Headed browser and provider gate

| Check | Result | Evidence |
| --- | --- | --- |
| Generic fixture, same-target command does not restart a slow seek | NOT RUN | |
| Generic fixture, timeout followed by `seeked` produces no local seek intent | NOT RUN | |
| Generic fixture, timeout followed by readiness completes without another write | NOT RUN | |
| Pause during pending play ignores late resolve and rejection | NOT RUN | |
| Same-element source replacement retires old callback | NOT RUN | |
| Player replacement or route change retires old operation | NOT RUN | |
| Controller transfer retires former-controller callbacks | NOT RUN | |
| Genuine different-target Skip Intro or scrub emits one intent | NOT RUN | |
| Visible video motion agrees with native and room state | NOT RUN | |
| Authenticated Crunchyroll run, if claimed | NOT RUN, not claimed | |

A browser spec for these rows (an adaptive fixture with a segment delay) is not part of this change.

## Verification record

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run apps/extension/src/content-script.test.ts apps/extension/src/player-operations.test.ts` | 2 files, 184 tests passed, three runs in a row |
| `npm test` | 50 files, 1,077 tests passed |
| `npm run build:extension` | built |

## Evidence not obtained

No browser, provider, two-account, two-device, deployment or user-acceptance evidence exists for this card in this report. Counters or media time advancing in a fake element are not proof of visible output.

## Decision and release boundary

| Decision | Select one | Evidence |
| --- | --- | --- |
| Deterministic operation contract accepted, headed/provider gate pending | Owner decides | This report |
| Accepted for the explicitly tested headed lifecycle matrix | Not selected | NOT RUN |
| Blocked by missing device, deployment or authorized test environment | Not selected | |
| Failed and requires additional implementation work | Not selected | |

Issue #50 remains open. No release, tag or deployment is authorized by this report.
