# Broad compatibility task list

- [x] Add recursive light-DOM and open-Shadow-DOM video discovery with unit tests.
- [x] Expand media source readiness checks for MSE/blob/MediaStream players.
- [x] Observe dynamic open Shadow DOM roots without unbounded observers.
- [x] Detect SPA history and same-element media identity changes immediately.
- [x] Update compatibility documentation and explicit unsupported cases.
- [ ] Verify the generic adapter in a real browser fixture. Headless Chrome in this environment did not inject MV3 content scripts, so this requires a headed/manual browser pass.
- [x] Run the production-connected smoke before packaging and package the versioned extension.

## Checkpoint

- [ ] Focused adapter tests pass.
- [ ] Full typecheck, tests, and builds pass.
- [ ] Real headed-browser fixture confirms Shadow DOM and SPA lifecycle behavior.

## Follow-up milestone

- [x] Player provenance and health diagnostics in the side panel and sanitized detailed reports.
- [x] Redetect player action in all room states.
- [x] Local generic-player fixture and server.
- [x] YouTube and Disney Plus identity regression coverage.
- [ ] Headed Chrome fixture run and authenticated provider regression pass.
