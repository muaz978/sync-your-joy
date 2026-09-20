# CR-A04 Player Binding Acceptance Report

Issue: [#51](https://github.com/muaz978/sync-your-joy/issues/51)

This report verifies that asynchronous player discovery, context refresh, detach, media-loss, status, seek-acknowledgement and local-intent messages remain owned by the current player document and binding incarnation. It is an evidence template, not a completed result or release approval. The deterministic tests establish the worker identity contract. A headed browser run, an authenticated provider run, deployment verification, device coverage and user acceptance are separate evidence classes.

## Scope and privacy boundary

CR-A04 protects the state-only synchronization boundary. The extension synchronizes room state and player control intent. It does not share video, audio, passwords, cookies, storage state, signed stream URLs, license traffic, DRM keys or protected-media bytes.

Record only:

- candidate commit SHA, extension package hash, coordinator deployment identity and browser/runtime versions;
- sanitized media identity, room revision, tab/frame identity and bounded player diagnostics;
- whether Chromium supplied a document ID or the browser-compatible opaque binding handshake was used;
- binding lifecycle events such as `created`, `retained`, `rotated`, `invalidated` or `rejected`;
- native current time, readiness, seeking state, visible motion and user-visible error category.

Never record:

- passwords, cookies, storage-state files, account names, viewing history or private profile details;
- signed URLs, authorization headers, provider HAR files, media bytes, screenshots containing protected video or DRM traffic;
- a claim that deterministic worker tests prove commercial-provider playback or two-device acceptance.

## Candidate and environment

| Field | Value |
| --- | --- |
| Report ID | `SYJ-CR-A04-YYYYMMDD-###` |
| Candidate commit SHA |  |
| Extension package name and SHA-256 |  |
| Coordinator deployment identity |  |
| Browser and version |  |
| Operating system |  |
| Provider or fixture label |  |
| Room role | Controller or member |
| Document identity source | Chromium `sender.documentId`, opaque fallback token, or both |
| Protected-data handling | `Confirmed: no secrets or protected media attached` |

Required evidence:

- The exact candidate and coordinator identity are recorded.
- The extension is freshly loaded in the browser used for the claim.
- A deterministic fixture is used before any commercial provider.
- Every lifecycle or browser behavior not directly exercised is marked `NOT CLAIMED` or `BLOCKED`.

## Binding contract

The worker must validate both the physical target and the logical binding before accepting a sender-bound message.

| Identity component | Purpose | Required behavior |
| --- | --- | --- |
| Tab ID | Selects the browser tab containing the player | Must match the current selected player tab |
| Frame ID | Selects the frame in that tab | Must match the current selected player frame |
| Chromium document ID | Distinguishes documents that reuse a tab/frame identity | Must match when present in the current binding and sender |
| Worker-issued binding ID | Browser-compatible fallback and binding incarnation | Must match after the initial handshake; it is rotated for replacement documents |
| Context generation | Invalidates delayed worker operations | A late refresh, delivery failure or detach result must not mutate a newer binding |

The worker-issued binding ID is persisted separately from public room state. It must not be copied into extension-view state, room messages, diagnostics reports or public issue comments. A content script receives it only in a successful `MEDIA_DETECTED` response and attaches it automatically to later sender-bound messages.

## Deterministic lifecycle matrix

Run the focused service-worker suite and record the exact test name and result for every row.

| Transition | Expected result | Result | Evidence |
| --- | --- | --- | --- |
| First media report from a document with no binding token | Worker accepts the candidate only when normal player-selection rules pass and returns a fresh binding ID |  |  |
| Routine media heartbeat from the same document with the current token | Same binding ID is retained; no binding churn or spurious detach occurs |  |  |
| Same tab/frame with a new Chromium document ID | New document can replace the candidate according to normal selection rules and receives a new binding ID |  |  |
| Old document status after replacement | Ignored; current sample, last-seen timestamp and diagnostics remain unchanged |  |  |
| Old document media-loss after replacement | Ignored; current media and readiness remain owned by the replacement |  |  |
| Old document seek acknowledgement after replacement | Ignored; no stale acknowledgement reaches the room server |  |  |
| Old document player intent after replacement | Ignored; no stale play, pause or seek control reaches the room |  |  |
| Outbound command after Chromium document binding | Uses document-targeted delivery rather than frame-only delivery |  |  |
| Browser without `sender.documentId`, first report | Worker-issued token establishes the fallback binding |  |  |
| Browser without `sender.documentId`, same-document heartbeat | Matching token retains the existing binding |  |  |
| Browser without `sender.documentId`, tab loading | Worker invalidates frame and token before accepting the new document |  |  |
| Browser without `sender.documentId`, stale old token after loading | Ignored and unable to restore the retired binding |  |  |
| Browser without `sender.documentId`, new document report without token after loading | Normal candidate rules establish a new binding and return a new token |  |  |
| Delayed `GET_PLAYER_CONTEXT` result after loading | Result cannot restore the retired frame or media |  |  |
| Delayed outbound delivery failure after replacement | Failure cannot clear or downgrade the replacement binding |  |  |
| Frame replacement with a different frame ID | Previous frame is detached when it can be targeted safely; new frame owns subsequent messages |  |  |

## Required source and test evidence

The PR evidence record must name these paths and the relevant test output:

- `apps/extension/src/internal.ts` - sender-bound request contracts and optional response binding identity.
- `apps/extension/src/service-worker.ts` - binding persistence, sender validation, document-aware delivery, loading invalidation and delayed-operation guards.
- `apps/extension/src/content-script.ts` - local binding-token retention and automatic propagation on media, status, seek acknowledgement, loss and player-intent messages.
- `apps/extension/src/service-worker.test.ts` - same-frame document replacement, stale message rejection, exact document targeting, fallback token stability and token rotation after loading.
- `docs/CRUNCHYROLL_REMEDIATION_PLAN.md` and `docs/CRUNCHYROLL_HANDOFF.md` - the prior partial state and the G07/CR-A04 identity contract.

The full repository check must be recorded separately from the focused suite:

```text
npm run typecheck
npm test
npm run build
npm run check
npm audit --audit-level=high
git diff --check
```

The result must include test-file count, test count, typecheck result, edge-service result, room-service build result, extension build result and audit result. A package build or green unit suite proves source and deterministic behavior only. It does not prove provider playback, visible frame motion, deployment or user acceptance.

## Browser and provider gate

Use a fresh package in a headed browser when claiming browser or provider behavior. The operator may use an already authenticated Crunchyroll session, but account availability is not the same as two-profile, two-account, two-device, deployment or user-acceptance evidence.

| Check | Result | Evidence |
| --- | --- | --- |
| Generic HTML5 fixture, same-document play/pause/status path |  |  |
| Generic HTML5 fixture, frame replacement or route replacement |  |  |
| Generic HTML5 fixture, stale old-document report is rejected |  |  |
| Generic HTML5 fixture, native video remains visible and progressing |  |  |
| Authenticated Crunchyroll page, current signed-in session confirmed |  |  |
| Authenticated Crunchyroll page, same-document heartbeat remains bound |  |  |
| Authenticated Crunchyroll page, SPA or full navigation replacement |  |  |
| Authenticated Crunchyroll page, old-frame status/loss/intent cannot mutate current state |  |  |
| Two-profile or two-account room run |  |  |
| Two-device run |  |  |
| Deployment smoke and exact endpoint identity |  |  |
| Explicit user acceptance |  |  |

Do not infer any row from source inspection, a mocked sender, a deterministic unit test, a package build, a signed-in menu, an advancing synthetic counter or a green CI check.

## Failure and blocker record

For every `FAIL`, `BLOCKED`, `NOT CLAIMED` or `UNRESOLVED` row, record:

- report ID, candidate SHA, package hash, browser and operating system;
- whether the sender exposed `documentId`, whether the binding token was present and whether the worker rejected it;
- sanitized tab/frame/document identity class, media identity and room revision;
- the lifecycle event that preceded the message or delayed completion;
- native position, readiness, seeking state, visible-motion result and room-state result;
- whether a stale sample, loss, acknowledgement, control intent or outbound failure mutated state;
- exact user-visible error or bounded diagnostic category;
- whether the cause is source, browser lifecycle, provider, deployment or environment;
- the next controlled experiment and the prerequisite, if any.

Do not classify an issue as Missing account when the known signed-in session is available. Record Missing account or Missing profile only when the selected acceptance gate genuinely needs an additional identity. Record Missing device, Missing deployment or User acceptance separately when those are the actual outstanding gates.

## Decision and release boundary

| Decision | Select one | Evidence |
| --- | --- | --- |
| Deterministic binding contract accepted; headed/provider gate pending |  |  |
| Accepted for the explicitly tested headed lifecycle matrix |  |  |
| Blocked by a specific missing device, deployment, profile/account or user-acceptance gate |  |  |
| Failed and requires additional implementation work |  |  |

Issue #51 remains open until every applicable acceptance gate is directly evidenced. A deterministic binding pass does not authorize issue closure or release publication. A compatible interim release requires a complete coherent issue group with its source, test, browser/provider and deployment gates identified. The milestone-end `1.0.0` release remains a separate final gate.

Operator confirmation:

```text
I confirm that this report contains no credentials, cookies, storage-state contents,
signed URLs, protected-media bytes, provider HAR files, protected screenshots or
screen recordings. I kept document identity, binding identity, native player state,
room state and visible motion as separate evidence classes.
```
