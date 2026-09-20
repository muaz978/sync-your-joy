# Crunchyroll remediation GitHub issue map

Prepared: 2026-09-20. This file is a durable index, not a second task tracker. GitHub issue state, labels, dependencies, and acceptance checkboxes are authoritative.

## Canonical tracker

- Milestone: [M3/M5: reliability and real-device validation](https://github.com/muaz978/sync-your-joy/milestone/1)
- Initiative filter: [`initiative: crunchyroll-sync`](https://github.com/muaz978/sync-your-joy/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22initiative%3A%20crunchyroll-sync%22)
- Design: [Crunchyroll synchronization remediation plan](CRUNCHYROLL_REMEDIATION_PLAN.md)
- Investigation and continuation details: [Crunchyroll handoff](CRUNCHYROLL_HANDOFF.md)

The tracker publication audit found 23 unique open tasks, 69 acceptance checkboxes, the intended milestone on every issue, all required labels, and all dependency links. Twenty-two issues were created. Existing issue 33 was expanded and reused for CR-D04 so the repository would not have competing live-provider acceptance trackers.

## Stage A: stabilize the candidate

| Task | GitHub issue | Purpose |
| --- | --- | --- |
| CR-A01 | [#48](https://github.com/muaz978/sync-your-joy/issues/48) | Preserve the candidate and reproduce the uncovered failures. |
| CR-A02 | [#49](https://github.com/muaz978/sync-your-joy/issues/49) | Give top-document and embedded player layouts one authoritative identity decision. |
| CR-A03 | [#50](https://github.com/muaz978/sync-your-joy/issues/50) | Preserve local operation ownership through cancellation, timeout, and late native completion. |
| CR-A04 | [#51](https://github.com/muaz978/sync-your-joy/issues/51) | Make player binding atomic across asynchronous worker work. |
| CR-A05 | [#52](https://github.com/muaz978/sync-your-joy/issues/52) | Bound drift correction and prove convergence or explicit recovery. |
| CR-A06 | [#53](https://github.com/muaz978/sync-your-joy/issues/53) | Make health evidence stable across events, reports, refresh, and diagnostics. |
| CR-A07 | [#54](https://github.com/muaz978/sync-your-joy/issues/54) | Close seek-barrier deadline and fixed-quorum holes. |

## Stage B: complete room transactions

| Task | GitHub issue | Purpose |
| --- | --- | --- |
| CR-B01 | [#55](https://github.com/muaz978/sync-your-joy/issues/55) | Define media, operation, binding, sample, phase, and capability contracts. |
| CR-B02 | [#56](https://github.com/muaz978/sync-your-joy/issues/56) | Prepare and commit playback in the coordinator with fixed required participants. |
| CR-B03 | [#57](https://github.com/muaz978/sync-your-joy/issues/57) | Apply preparation and observed-start confirmation through the extension. |
| CR-B04 | [#58](https://github.com/muaz978/sync-your-joy/issues/58) | Evaluate missing reports and health deadlines without needing another message. |
| CR-B05 | [#59](https://github.com/muaz978/sync-your-joy/issues/59) | Apply operation and health deadlines in the local room service. |
| CR-B06 | [#60](https://github.com/muaz978/sync-your-joy/issues/60) | Preserve health semantics through edge alarms and durable-object rehydration. |
| CR-B07 | [#61](https://github.com/muaz978/sync-your-joy/issues/61) | Verify mixed versions, capability policy, stored-state migration, and rollback. |

## Stage C: recovery, diagnosis, and navigation

| Task | GitHub issue | Purpose |
| --- | --- | --- |
| CR-C01 | [#62](https://github.com/muaz978/sync-your-joy/issues/62) | Let explicit Sync recover never-settling or failed play attempts safely. |
| CR-C02 | [#63](https://github.com/muaz978/sync-your-joy/issues/63) | Make bounded, sanitized diagnostics reconstruct operation failures. |
| CR-C03 | [#64](https://github.com/muaz978/sync-your-joy/issues/64) | Explain preparation, blocking, silence, mismatch, and recovery in the UI. |
| CR-C04 | [#65](https://github.com/muaz978/sync-your-joy/issues/65) | Make episode changes a coordinated navigation transaction. |

## Stage D: evidence and release preparation

| Task | GitHub issue | Purpose |
| --- | --- | --- |
| CR-D01 | [#66](https://github.com/muaz978/sync-your-joy/issues/66) | Isolate E2E builds and collect exact-source failure artifacts. |
| CR-D02 | [#67](https://github.com/muaz978/sync-your-joy/issues/67) | Add controlled adaptive-loading and player-lifecycle fixtures. |
| CR-D03 | [#68](https://github.com/muaz978/sync-your-joy/issues/68) | Execute the complete local browser, fault, role, and quorum matrix. |
| CR-D04 | [#33](https://github.com/muaz978/sync-your-joy/issues/33) | Execute two-account Crunchyroll and cross-provider acceptance. |
| CR-D05 | [#69](https://github.com/muaz978/sync-your-joy/issues/69) | Package, stage, roll back, canary, and release an approved candidate. |

## Related umbrella issues

- [#30](https://github.com/muaz978/sync-your-joy/issues/30) covers commercial-provider two-profile E2E.
- [#34](https://github.com/muaz978/sync-your-joy/issues/34) covers real two-device network chaos and reconnect behavior.
- [#35](https://github.com/muaz978/sync-your-joy/issues/35) covers headed cross-platform verification.

These broader issues remain open and are linked from the relevant CR-D tasks. They are not replacements for the narrower remediation contracts.

## Source-of-truth rule

Do not copy live issue state back into this file. Update scope, acceptance, dependencies, labels, and completion on GitHub. Change this index only when a task ID is added, removed, renumbered, or assigned a different canonical issue.
