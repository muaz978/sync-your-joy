import type { PlaybackState } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { canApplySoftDriftCorrection, ClockSynchronizer, chooseDriftCorrection, expectedPosition, isPlaybackRateAccepted } from './clock.ts'

describe('ClockSynchronizer', () => {
  it('prefers low round-trip samples when estimating offset', () => {
    const clock = new ClockSynchronizer()
    clock.addSample(1_000, 1_200, 1_610)
    clock.addSample(2_000, 2_040, 2_520)
    clock.addSample(3_000, 3_050, 3_525)

    const estimate = clock.estimate()
    expect(estimate.samples).toBe(3)
    expect(estimate.offsetMs).toBeCloseTo(503.3, 1)
    expect(estimate.roundTripMs).toBeLessThan(100)
  })
})

describe('expectedPosition', () => {
  it('advances a playing timeline using server time', () => {
    const playback: PlaybackState = {
      status: 'playing',
      positionSeconds: 42,
      effectiveAtServerMs: 5_000,
      playbackRate: 1,
    }
    expect(expectedPosition(playback, 7_500)).toBe(44.5)
  })

  it('keeps a paused timeline fixed', () => {
    const playback: PlaybackState = {
      status: 'paused',
      positionSeconds: 18,
      effectiveAtServerMs: 5_000,
      playbackRate: 1,
    }
    expect(expectedPosition(playback, 99_000)).toBe(18)
  })

  it('clamps a playing timeline to the known media duration', () => {
    const playback: PlaybackState = {
      status: 'playing',
      positionSeconds: 595,
      effectiveAtServerMs: 5_000,
      playbackRate: 1,
    }
    expect(expectedPosition(playback, 25_000, 600)).toBe(600)
    expect(expectedPosition(playback, 25_000)).toBeGreaterThan(600)
  })
})

describe('chooseDriftCorrection', () => {
  it('ignores drift below the tolerance', () => {
    expect(chooseDriftCorrection(10, 10.08, true).kind).toBe('none')
  })

  it('uses a small rate correction for moderate drift', () => {
    expect(chooseDriftCorrection(10, 10.4, true)).toMatchObject({ kind: 'rate', playbackRate: 1.02 })
    expect(chooseDriftCorrection(10.4, 10, true)).toMatchObject({ kind: 'rate', playbackRate: 0.98 })
  })

  it('seeks for large drift or when rate control is unavailable', () => {
    expect(chooseDriftCorrection(10, 11, true)).toMatchObject({ kind: 'seek', positionSeconds: 11 })
    expect(chooseDriftCorrection(10, 10.3, false)).toMatchObject({ kind: 'seek', positionSeconds: 10.3 })
  })
})

describe('soft drift correction policy', () => {
  it('requires playback, healthy progress and no active operation', () => {
    expect(canApplySoftDriftCorrection({
      playing: true,
      buffering: false,
      seeking: false,
      hasPendingOperation: false,
      hasRecentProgress: true,
    })).toBe(true)

    expect(canApplySoftDriftCorrection({
      playing: true,
      buffering: true,
      seeking: false,
      hasPendingOperation: false,
      hasRecentProgress: true,
    })).toBe(false)
    expect(canApplySoftDriftCorrection({
      playing: true,
      buffering: false,
      seeking: true,
      hasPendingOperation: false,
      hasRecentProgress: true,
    })).toBe(false)
    expect(canApplySoftDriftCorrection({
      playing: true,
      buffering: false,
      seeking: false,
      hasPendingOperation: true,
      hasRecentProgress: true,
    })).toBe(false)
    expect(canApplySoftDriftCorrection({
      playing: true,
      buffering: false,
      seeking: false,
      hasPendingOperation: false,
      hasRecentProgress: false,
    })).toBe(false)
  })

  it('accepts only a finite rate assignment within tolerance', () => {
    expect(isPlaybackRateAccepted(1.02, 1.02)).toBe(true)
    expect(isPlaybackRateAccepted(1.02, 1.023)).toBe(true)
    expect(isPlaybackRateAccepted(1.02, 1)).toBe(false)
    expect(isPlaybackRateAccepted(1.02, Number.NaN)).toBe(false)
  })
})
