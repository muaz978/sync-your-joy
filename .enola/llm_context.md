# Architecture Snapshot

## Repository Map

| Module | Language | Symbols | Exported |
|--------|----------|---------|----------|
| `.` | typescript | 2 | 2 |
| `apps/edge-service/src` | typescript | 43 | 15 |
| `apps/extension/src` | typescript | 465 | 101 |
| `apps/room-service/src` | typescript | 20 | 2 |
| `packages/protocol/src` | typescript | 104 | 68 |
| `packages/sync-engine/src` | typescript | 113 | 69 |
| `scripts` | python | 91 | 0 |
| `test-results/adaptive-after/extension` | typescript | 0 | 0 |
| `test-results/adaptive-before/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-01/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-02/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-03/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-04/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-05/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-06/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-07/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-08/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-09/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-change/run-10/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-01/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-02/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-03/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-04/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-05/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-06/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-07/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-08/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-09/out/extension` | typescript | 0 | 0 |
| `test-results/batch-stall-final/run-10/out/extension` | typescript | 0 | 0 |
| `test-results/full-e2e-1/extension` | typescript | 0 | 0 |
| `test-results/full-e2e-final/extension` | typescript | 0 | 0 |
| `test-results/twoprofile-fixed/extension` | typescript | 0 | 0 |
| `test-results/twoprofile-fixed2/extension` | typescript | 0 | 0 |
| `test-results/twoprofile-main/extension` | typescript | 0 | 0 |
| `test-results/twoprofile-retire/extension` | typescript | 0 | 0 |
| `test-results/twoprofile-unfixed/extension` | typescript | 0 | 0 |
| `tests/e2e` | typescript | 85 | 44 |

## Extraction Quality

- Files parsed: **176** / 703 seen (45 file(s) + 3 directory tree(s) skipped by ignore globs)
- Parse errors: 0

## Architecture Pattern

_No specific architecture pattern detected._

## Entry Points

- **handler**: `apps/edge-service/src.persistThenObserve` (apps/edge-service/src/alarm.ts)
- **handler**: `apps/extension/src.observePlayerHealth` (apps/extension/src/player-health.ts)
- **handler**: `tests/e2e.createAdaptiveFixtureServer` (tests/e2e/adaptive-fixture-server.ts)
- **route** GET `/json/list` (scripts/verify-sidepanel-interaction.mjs)
- **route** PUT `/json/new` (scripts/capture-cdp.mjs)

## Routes

| Method | Path | File | Type |
|--------|------|------|------|
| GET | `/json/list` | `scripts/verify-sidepanel-interaction.mjs` |  |
| PUT | `/json/new` | `scripts/capture-cdp.mjs` |  |

## Dependency Rules

_No internal dependency rules detected._

## Critical Modules

_No cross-module dependencies detected._

---

*Generated at 2026-09-29T19:13:13Z in 321.561ms. 3428 facts, 56 insights.*
