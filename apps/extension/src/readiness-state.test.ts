import { describe, expect, it } from 'vitest'
import { shouldPublishMediaMatchChange } from './readiness-state.ts'

describe('shouldPublishMediaMatchChange', () => {
  it('does not send a not-ready update for an unchanged matching media heartbeat', () => {
    expect(shouldPublishMediaMatchChange(true, true)).toBe(false)
  })

  it('publishes actual transitions between matching and mismatching media', () => {
    expect(shouldPublishMediaMatchChange(true, false)).toBe(true)
    expect(shouldPublishMediaMatchChange(false, true)).toBe(true)
  })

  it('waits for the participant to appear in the room snapshot', () => {
    expect(shouldPublishMediaMatchChange(undefined, true)).toBe(false)
  })
})
