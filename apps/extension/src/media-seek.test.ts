import { describe, expect, it } from 'vitest'
import { resolveSeekTarget } from './media-seek.ts'

describe('media seek target resolution', () => {
  it('clamps a VOD target to its duration', () => {
    expect(resolveSeekTarget(500, 120, [])).toBeCloseTo(119.95)
    expect(resolveSeekTarget(-5, 120, [])).toBe(0)
    expect(resolveSeekTarget(80, 120, [{ start: 0, end: 20 }])).toBe(80)
  })

  it('uses the nearest available seekable range for streams and gaps', () => {
    expect(resolveSeekTarget(80, null, [{ start: 100, end: 160 }])).toBe(100)
    expect(resolveSeekTarget(170, null, [{ start: 100, end: 160 }])).toBeCloseTo(159.95)
    expect(resolveSeekTarget(30, null, [{ start: 0, end: 20 }, { start: 50, end: 100 }])).toBeCloseTo(19.95)
  })

  it('rejects non-finite targets', () => {
    expect(resolveSeekTarget(Number.NaN, 100, [])).toBeNull()
  })
})
