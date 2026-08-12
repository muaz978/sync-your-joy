import { describe, expect, it } from 'vitest'
import { LOCAL_INTENT_HOLD_MS, shouldDeferAuthoritativeSync } from './player-intent.ts'

describe('native controller intent handling', () => {
  it('does not correct the controller while the progress thumb is being dragged', () => {
    expect(shouldDeferAuthoritativeSync({ isController: true, isSeeking: true, holdUntil: 0, now: 1_000 })).toBe(true)
  })

  it('holds the controller position while a play, pause, or seek is in flight', () => {
    expect(shouldDeferAuthoritativeSync({ isController: true, isSeeking: false, holdUntil: 1_000 + LOCAL_INTENT_HOLD_MS, now: 2_000 })).toBe(true)
    expect(shouldDeferAuthoritativeSync({ isController: true, isSeeking: false, holdUntil: 1_000, now: 2_000 })).toBe(false)
  })

  it('never defers correction for a member', () => {
    expect(shouldDeferAuthoritativeSync({ isController: false, isSeeking: true, holdUntil: 9_000, now: 1_000 })).toBe(false)
  })
})
