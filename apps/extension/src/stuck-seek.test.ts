import { describe, expect, it } from 'vitest'
import { mayAutoReload, nearestBufferedPoint, nextStuckSeekAction, STUCK_SEEK_AUTO_RELOAD_COOLDOWN_MS, STUCK_SEEK_RELOAD_COUNTDOWN_MS, STUCK_SEEK_RELOAD_DELAY_MS, STUCK_SEEK_STEP_MS } from './stuck-seek.ts'

const fresh = { reissues: 0, lastActionAt: 1_000, reloadAt: null, reloadCancelled: false }

describe('the stuck seek ladder', () => {
  it('waits a full step before the first and the second action', () => {
    expect(nextStuckSeekAction(fresh, 1_000 + STUCK_SEEK_STEP_MS - 1)).toEqual({ kind: 'none' })
    expect(nextStuckSeekAction(fresh, 1_000 + STUCK_SEEK_STEP_MS)).toEqual({ kind: 'reissue' })
    const afterReissue = { ...fresh, reissues: 1, lastActionAt: 7_000 }
    expect(nextStuckSeekAction(afterReissue, 7_000 + STUCK_SEEK_STEP_MS - 1)).toEqual({ kind: 'none' })
    expect(nextStuckSeekAction(afterReissue, 7_000 + STUCK_SEEK_STEP_MS)).toEqual({ kind: 'nudge' })
  })

  it('starts the reload countdown only after both steps and an idle delay', () => {
    const exhausted = { ...fresh, reissues: 2, lastActionAt: 13_000 }
    expect(nextStuckSeekAction(exhausted, 13_000 + STUCK_SEEK_RELOAD_DELAY_MS - 1)).toEqual({ kind: 'none' })
    expect(nextStuckSeekAction(exhausted, 13_000 + STUCK_SEEK_RELOAD_DELAY_MS)).toEqual({ kind: 'start_reload' })
  })

  it('counts down in whole seconds and reloads at zero', () => {
    const counting = { ...fresh, reissues: 2, reloadAt: 50_000 }
    expect(nextStuckSeekAction(counting, 50_000 - STUCK_SEEK_RELOAD_COUNTDOWN_MS)).toEqual({ kind: 'countdown', remainingSeconds: 20 })
    expect(nextStuckSeekAction(counting, 49_001)).toEqual({ kind: 'countdown', remainingSeconds: 1 })
    expect(nextStuckSeekAction(counting, 50_000)).toEqual({ kind: 'reload' })
  })

  it('never starts a countdown once the participant cancelled it', () => {
    expect(nextStuckSeekAction({ ...fresh, reissues: 2, lastActionAt: 0, reloadCancelled: true }, 10 * 60_000)).toEqual({ kind: 'none' })
  })
})

describe('the automatic reload cooldown', () => {
  it('allows a first reload, refuses a second inside ten minutes and allows one after', () => {
    expect(mayAutoReload(null, 5_000)).toBe(true)
    expect(mayAutoReload(Number.NaN, 5_000)).toBe(true)
    expect(mayAutoReload(5_000, 5_000 + STUCK_SEEK_AUTO_RELOAD_COOLDOWN_MS - 1)).toBe(false)
    expect(mayAutoReload(5_000, 5_000 + STUCK_SEEK_AUTO_RELOAD_COOLDOWN_MS)).toBe(true)
  })
})

describe('the buffered point to seek to first', () => {
  it('picks the range nearest the target and a point half a second inside it', () => {
    const ranges = [{ start: 672.7, end: 736 }]
    expect(nearestBufferedPoint(ranges, 395.6)).toBe(673.2)
    expect(nearestBufferedPoint([{ start: 10, end: 20 }, { start: 100, end: 110 }], 95)).toBe(100.5)
    expect(nearestBufferedPoint([{ start: 10, end: 20 }, { start: 100, end: 110 }], 25)).toBe(19.5)
  })

  it('uses the middle of a very short range and nothing when nothing is buffered', () => {
    expect(nearestBufferedPoint([{ start: 50, end: 50.6 }], 10)).toBeCloseTo(50.3)
    expect(nearestBufferedPoint([], 10)).toBeNull()
    expect(nearestBufferedPoint([{ start: 5, end: 5 }], 10)).toBeNull()
  })

  it('never picks a point within a second of the target, which would show the player nothing', () => {
    expect(nearestBufferedPoint([{ start: 0, end: 60 }], 59.5)).toBe(0.5)
    expect(nearestBufferedPoint([{ start: 0, end: 60 }], 0.2)).toBe(59.5)
    expect(nearestBufferedPoint([{ start: 10, end: 11.6 }], 10.8)).toBeNull()
    expect(nearestBufferedPoint([{ start: 50, end: 50.6 }], 50.3)).toBeNull()
  })

  it('treats a target inside a range as nearest to that range', () => {
    expect(nearestBufferedPoint([{ start: 0, end: 60 }, { start: 90, end: 100 }], 30)).toBe(59.5)
  })
})
