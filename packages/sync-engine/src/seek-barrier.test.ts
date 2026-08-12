import { describe, expect, it } from 'vitest'
import { isSeekAligned } from './seek-barrier.ts'

describe('seek barrier alignment', () => {
  it('accepts positions close enough for rate correction after resume', () => {
    expect(isSeekAligned(120.4, 120)).toBe(true)
    expect(isSeekAligned(119.5, 120)).toBe(true)
  })

  it('rejects a visible or non-finite position mismatch', () => {
    expect(isSeekAligned(120.6, 120)).toBe(false)
    expect(isSeekAligned(Number.NaN, 120)).toBe(false)
  })
})
