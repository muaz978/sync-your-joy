import { describe, expect, it } from 'vitest'
import { canConfirmSeek, isDuplicateSeekIntent, isSeekAligned, LOCAL_SEEK_MAX_WAIT_MS, SEEK_ACK_RETRY_MS, SEEK_BARRIER_MAX_WAIT_MS, SEEK_COMPLETION_PROBE_MS, SEEK_INTENT_DEBOUNCE_MS, SEEK_RETRY_INTERVAL_MS } from './seek-barrier.ts'

describe('seek barrier alignment', () => {
  it('accepts positions close enough for rate correction after resume', () => {
    expect(isSeekAligned(120.4, 120)).toBe(true)
    expect(isSeekAligned(119.5, 120)).toBe(true)
  })

  it('rejects a visible or non-finite position mismatch', () => {
    expect(isSeekAligned(120.6, 120)).toBe(false)
    expect(isSeekAligned(Number.NaN, 120)).toBe(false)
  })

  it('confirms completion as soon as seeking ends at the target', () => {
    expect(canConfirmSeek({ currentSeconds: 120.2, targetSeconds: 120, seeking: false })).toBe(true)
    expect(canConfirmSeek({ currentSeconds: 120, targetSeconds: 120, seeking: true })).toBe(false)
  })

  it('uses sub-frame-like probes and prompt acknowledgement retries', () => {
    expect(SEEK_INTENT_DEBOUNCE_MS).toBeLessThan(100)
    expect(SEEK_COMPLETION_PROBE_MS).toBeLessThan(100)
    expect(SEEK_ACK_RETRY_MS).toBeLessThanOrEqual(250)
    expect(SEEK_RETRY_INTERVAL_MS).toBeLessThanOrEqual(150)
    expect(SEEK_BARRIER_MAX_WAIT_MS).toBeLessThanOrEqual(2_000)
    expect(SEEK_BARRIER_MAX_WAIT_MS).toBeGreaterThan(LOCAL_SEEK_MAX_WAIT_MS)
  })

  it('deduplicates the seeked event after an early scrub broadcast', () => {
    expect(isDuplicateSeekIntent({ positionSeconds: 120.2, lastPositionSeconds: 120, nowMs: 1_500, lastSentAtMs: 1_000 })).toBe(true)
    expect(isDuplicateSeekIntent({ positionSeconds: 180, lastPositionSeconds: 120, nowMs: 1_500, lastSentAtMs: 1_000 })).toBe(false)
  })
})
