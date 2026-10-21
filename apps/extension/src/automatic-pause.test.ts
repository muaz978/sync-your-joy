import { describe, expect, it } from 'vitest'
import { AUTOMATIC_PAUSE_WINDOW_MS, isAutomaticPause, isPauseWhileAway } from './automatic-pause.ts'

const base = { roomPlaying: true, visibilityState: 'visible', focused: false, msSinceAway: 100 }

describe('automatic pause', () => {
  it('is a pause right after the page was left, while it is still left', () => {
    expect(isAutomaticPause(base)).toBe(true)
    expect(isAutomaticPause({ ...base, visibilityState: 'hidden', focused: true })).toBe(true)
    expect(isAutomaticPause({ ...base, msSinceAway: AUTOMATIC_PAUSE_WINDOW_MS })).toBe(true)
  })

  it('is not a pause made with the page in front', () => {
    expect(isAutomaticPause({ ...base, focused: true })).toBe(false)
  })

  it('is not a pause long after the page was left, or one with no leaving on record', () => {
    expect(isAutomaticPause({ ...base, msSinceAway: AUTOMATIC_PAUSE_WINDOW_MS + 1 })).toBe(false)
    expect(isAutomaticPause({ ...base, msSinceAway: null })).toBe(false)
    expect(isAutomaticPause({ ...base, msSinceAway: -5 })).toBe(false)
  })

  it('is only about a room that is playing', () => {
    expect(isAutomaticPause({ ...base, roomPlaying: false })).toBe(false)
    expect(isPauseWhileAway({ ...base, roomPlaying: false })).toBe(false)
  })

  it('reports every pause made while the page was not in front', () => {
    expect(isPauseWhileAway({ ...base, msSinceAway: 60_000 })).toBe(true)
    expect(isPauseWhileAway({ ...base, focused: true })).toBe(false)
  })
})
