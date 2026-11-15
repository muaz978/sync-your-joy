# CR-A04 Player Binding Acceptance Report

Issue: [#51](https://github.com/muaz978/sync-your-joy/issues/51)

This report records the deterministic worker evidence for CR-A04 against the template in [`CR_A04_PLAYER_BINDING_ACCEPTANCE_REPORT_TEMPLATE.md`](CR_A04_PLAYER_BINDING_ACCEPTANCE_REPORT_TEMPLATE.md). It does not close the issue and does not authorize a release.

Evidence class for every `PASS` below: unit and worker tests in `apps/extension/src/service-worker.test.ts` against a mocked `chrome` API, a fake `WebSocket` and fake senders. Nothing was observed in a real browser, on Crunchyroll, in Firefox or Safari, on two profiles, on a second device or on a deployed coordinator.

## Scope decisions recorded on the issue

Owner decisions on #51 (2026-10-31):

- The provider, two-account, two-device, deployment and acceptance gates are carried by #30, #33, #34, #35 and #69 and are not required on this card. The card is judged on its own acceptance criteria and local evidence.
- #49 does not need to be accepted before this card.

Not decided, and therefore not changed or pinned by a test: whether a current binding token may stand in for a document ID that is present but different (`isBoundPlayerSender` accepts a matching document ID or a matching token). Two limits recorded earlier on the issue (a token can be lost without a document ID during a re-bind; a replaced page stays refused until the worker asks it to report) are also unchanged.

## Candidate and environment

| Field | Value |
| --- | --- |
| Source | `main` at `257afb6` (extension 0.2.12) plus the pull request that adds this report; record its merge commit when it lands |
| Extension package SHA-256 | `NOT RECORDED`: no package was built for this report |
| Coordinator deployment identity | `NOT APPLICABLE`: no coordinator was involved |
| Browser and version | `NOT APPLICABLE`: mocked `chrome` API |
| Document identity source | Both paths are exercised by fake senders: `sender.documentId` present, and absent with the worker-issued token |
| Protected-data handling | Confirmed: no secrets or protected media were involved |

## Defect found and fixed by this change

`MEDIA_DETECTED` bound the player, which waits on the tab to detach the previous page, and then wrote the report's media and diagnostics and answered with `playerBinding?.id`, the binding that was current when the answer was built. A report that another report, a page load or an unbind overtook during either of its two awaits (the detach, and publishing the state) therefore overwrote the newer report's media and diagnostics, wrote media into a worker with no bound frame, and was handed the newer page's binding ID. When the two reports came from different frames, the page holding the wrong token was still refused by the frame check, so the exposure was wrong state. When they came from the same frame (a page replaced in a frame that keeps its number), the earlier document held the newer document's token, and `isBoundPlayerSender` accepts a matching token from the bound frame, so that document's later messages would have been accepted as the bound player's. The earlier document is normally being destroyed, and this was not observed in a browser: the hand-over of the token is shown by the failing test, and the acceptance of its later messages follows from reading `isBoundPlayerSender`, not from a test.

`bindPlayerContext` now returns the binding its own call established. `MEDIA_DETECTED` checks that it is still the bound one after the detach (and returns without writing anything if not) and again after publishing (and answers without a binding ID if not).

Four tests fail against `main` without the fix: `lets the report that bound last keep the binding, the media and the diagnostics when the earlier one was in another frame`, the same title ending `in the same frame after the page was replaced`, `writes nothing for a report whose page started loading again while the previous player was being detached` and `does not hand its token to a page whose report was superseded while the new state was being stored`.

## Deterministic lifecycle matrix

Test titles are in `apps/extension/src/service-worker.test.ts`. "Overlap" is the describe block `two media reports that overlap while the first one detaches the previous player`, "No document ID" is `on a browser that gives frames no document ID`, and "Detached" is `what a page is told when the worker stops binding it`.

| Transition | Result | Evidence |
| --- | --- | --- |
| First media report from a document with no binding token | `PASS` | `rejects stale same-frame status, loss, seek acknowledgement and intent messages after document replacement` (binding ID returned); No document ID: `gives a second frame no binding while the bound frame holds one, with no token or a forged one` for the refused case |
| Routine media heartbeat from the same document with the current token | `PASS` | Overlap: `keeps the replacement binding through routine heartbeats, and does not give it back to the page it replaced` (document ID path, with and without the token); `keeps a fallback binding stable for heartbeats and rotates it after loading without documentId` (token path) |
| Same tab/frame with a new Chromium document ID | `PASS` | `rejects stale same-frame status, loss, seek acknowledgement and intent messages after document replacement`; Detached: `does not release a page that another document replaced`; Overlap: `... in the same frame after the page was replaced` |
| Old document status after replacement | `PASS` | `rejects stale same-frame status, loss, seek acknowledgement and intent messages after document replacement` asserts the sample and media stay as they were; the last-seen timestamp is not asserted by any test |
| Old document media-loss after replacement | `PASS` | same test |
| Old document seek acknowledgement after replacement | `PASS` | same test (`SEEK_APPLIED` and `OPERATION_ACK`); nothing reaches the socket |
| Old document player intent after replacement | `PASS` | same test; nothing reaches the socket |
| Outbound command after Chromium document binding | `PASS` | same test ends with `LOCK_PLAYER` delivered with `{ documentId: 'document-new' }` |
| Browser without `sender.documentId`, first report | `PASS` | `keeps a fallback binding stable for heartbeats and rotates it after loading without documentId` |
| Browser without `sender.documentId`, same-document heartbeat | `PASS` | same test; No document ID: `gives a second frame no binding while the bound frame holds one, with no token or a forged one` (the bound frame's heartbeat keeps its token) |
| Browser without `sender.documentId`, tab loading | `PASS` | `keeps a fallback binding stable for heartbeats and rotates it after loading without documentId` (frame cleared) |
| Browser without `sender.documentId`, stale old token after loading | `PASS` | same test for status; No document ID: `ignores the messages of a page whose token was rotated, whichever message it sends` for status, seek, acknowledgement, intent and loss |
| Browser without `sender.documentId`, new document report without token after loading | `PASS` | `keeps a fallback binding stable for heartbeats and rotates it after loading without documentId` (new, different token) |
| Delayed `GET_PLAYER_CONTEXT` result after loading | `PASS` | `does not restore a delayed context after the bound tab starts a new navigation`; `does not clear a replacement binding when an old context read returns no media` |
| Delayed outbound delivery failure after replacement | `PASS` | `ignores an old document delivery failure after a replacement binds the same tab and frame` |
| Frame replacement with a different frame ID | `PASS` | Overlap: `... in another frame` (the previous frame is detached by frame; the later report keeps the binding, media and diagnostics) |

Rows added by this change:

| Transition | Result | Evidence |
| --- | --- | --- |
| Two reports overlap while the first detaches the previous page: the later one keeps the binding, media and diagnostics, the earlier one is answered without a binding ID | `PASS`, red before the fix | Overlap: both `lets the report that bound last keep ...` titles |
| A page starts loading while its report waits to detach: the report writes nothing | `PASS`, red before the fix | Overlap: `writes nothing for a report whose page started loading again while the previous player was being detached` |
| A report is superseded while its state is being stored: it is not handed the newer binding ID | `PASS`, red before the fix | Overlap: `does not hand its token to a page whose report was superseded while the new state was being stored` |
| A replacement binds while the previous page is still being released | `PASS` (also passes against `main`) | Overlap: `keeps a replacement that binds while the previous player is still being released` |
| The replaced page's heartbeats cannot take the binding back | `PASS` | Overlap: `keeps the replacement binding through routine heartbeats, and does not give it back to the page it replaced` |
| Forged token on status, seek, acknowledgement, intent and loss | `PASS` | No document ID: `ignores status, seek, acknowledgement, intent and loss messages that carry a forged token` |
| A second frame with no token or a forged one while a binding exists | `PASS` | No document ID: `gives a second frame no binding while the bound frame holds one, with no token or a forged one` |

Messages from a frame other than the bound one, and from another tab, are covered by pull request #175 (describe block `frames of the player tab that are not the bound frame`); they are not repeated here.

## Mutation checks

Each production line below was changed in place, the worker tests were run, and the file was restored with `git checkout`.

| Change | Tests that failed |
| --- | --- |
| No ownership check after the detach | 3 (both `lets the report that bound last keep ...` titles and `writes nothing for a report whose page started loading ...`) |
| The answer carries whatever binding is current after publishing | 1 (`does not hand its token to a page whose report was superseded ...`) |
| The ownership check compares the tab only | 3 (the same three) |
| `isBoundPlayerSender` accepts any token from the bound frame | 3 (`rejects stale same-frame ...`, both new token tests) |
| A forged token is not refused when a frame reports media | 1 (`gives a second frame no binding ...`) |
| A token-less second frame is accepted while a binding exists | 1 (same) |
| A same-token heartbeat no longer keeps the binding | 3 (`ignores an old document delivery failure ...`, `keeps a fallback binding stable ...`, `gives a second frame no binding ...`) |

## Browser and provider gate

| Check | Result |
| --- | --- |
| Generic HTML5 fixture: same-document status path, frame or route replacement, stale old-document report, visible progressing video | `NOT RUN`. A binding-replacement spec beside `tests/e2e/rejoin-after-leaving.spec.ts` was not written in this change; a real browser cannot deliver a late message from a destroyed document, so the stale-message rows stay with the worker tests |
| Firefox and Safari runs of the no-document-ID path | `NOT RUN` (owner's machine) |
| Authenticated Crunchyroll rows | `NOT CLAIMED`; carried by #30, #33 and #35 |
| Two-profile or two-account run, two-device run, deployment smoke, user acceptance | `NOT CLAIMED`; carried by #30, #33, #34, #35 and #69 |

## Decision and release boundary

| Decision | Status |
| --- | --- |
| Deterministic binding contract accepted for unit and worker evidence | Recorded here; acceptance is the owner's |
| Accepted for a headed lifecycle matrix | Not applicable: none was run |
| Issue closure | Not authorized. #51 stays open until the owner accepts the card on its own criteria |
| Release | Not authorized |

Operator confirmation:

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files, protected screenshots or
screen recordings. I kept document identity, binding identity, native player state,
room state and visible motion as separate evidence classes.
```
