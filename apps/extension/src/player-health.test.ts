import { describe, expect, it } from 'vitest'
import { clearPlaybackStartFailed, createPlayerHealthState, markPlaybackStartFailed, markPlayerHealthBuffering, observePlayerHealth, resetPlayerHealthBaseline } from './player-health.ts'

const baseline = { nowMs: 0, positionSeconds: 0, frames: 0 }

function playing(previous: ReturnType<typeof createPlayerHealthState>, overrides: Partial<Parameters<typeof observePlayerHealth>[1]> = {}) {
  return observePlayerHealth(previous, {
    nowMs: 1_000,
    positionSeconds: 1,
    frames: 10,
    paused: false,
    seeking: false,
    localSeeking: false,
    roomPlaying: true,
    playShouldHaveStarted: true,
    lacksPlayableData: false,
    explicitlyBuffering: false,
    localIntentHold: false,
    ...overrides,
  })
}

describe('player health evidence', () => {
  it('uses explicit clock evidence when frame counters are absent or unavailable', () => {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { frames: null, positionSeconds: 1 })

    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('clock')
    expect(state.hasRealPlaybackProgress).toBe(true)
  })

  it('accepts zero as a real frame counter baseline and only advances on a larger count', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 0.05, frames: 0 })
    expect(state.progressed).toBe(false)
    expect(state.progressEvidence).toBe('frames')

    state = playing(state, { nowMs: 2_000, positionSeconds: 1, frames: 4 })
    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('frames')
  })

  it('retains native progress observed during transactional startup grace', () => {
    let state = createPlayerHealthState(baseline)
    state = observePlayerHealth(state, {
      nowMs: 500,
      positionSeconds: 0,
      frames: 0,
      paused: false,
      seeking: false,
      localSeeking: false,
      roomPlaying: true,
      playShouldHaveStarted: false,
      lacksPlayableData: false,
      explicitlyBuffering: false,
      localIntentHold: false,
    })
    state = observePlayerHealth(state, {
      nowMs: 1_000,
      positionSeconds: 0.5,
      frames: 12,
      paused: false,
      seeking: false,
      localSeeking: false,
      roomPlaying: true,
      playShouldHaveStarted: false,
      lacksPlayableData: false,
      explicitlyBuffering: false,
      localIntentHold: false,
    })

    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('frames')
    expect(state.hasRealPlaybackProgress).toBe(true)
  })

  it('does not treat a reset frame counter as progress', () => {
    let state = createPlayerHealthState({ ...baseline, frames: 30 })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 20 })

    expect(state.progressed).toBe(false)
    expect(state.progressEvidence).toBe('unknown')
  })

  it('excludes native and local seeks from progress evidence', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { seeking: true, positionSeconds: 10, frames: 100 })
    expect(state.progressed).toBe(false)
    expect(state.progressEvidence).toBe('unknown')

    state = playing(state, { nowMs: 2_000, localSeeking: true, positionSeconds: 20, frames: 200 })
    expect(state.progressed).toBe(false)
    expect(state.progressEvidence).toBe('unknown')
  })

  it('preserves a known buffering signal while rebasing visibility or context observations', () => {
    let state = createPlayerHealthState(baseline)
    state = markPlayerHealthBuffering(state)
    state = resetPlayerHealthBaseline(state, { nowMs: 1_000, positionSeconds: 2, frames: null }, true)

    expect(state.buffering).toBe(true)
    expect(state.progressEvidence).toBe('unknown')
  })

  it('re-establishes frame evidence after visibility restoration without claiming the reset as progress', () => {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { frames: null, positionSeconds: 1 })
    expect(state.progressEvidence).toBe('clock')

    state = resetPlayerHealthBaseline(state, { nowMs: 2_000, positionSeconds: 1, frames: 20 }, true)
    state = playing(state, { nowMs: 3_000, positionSeconds: 2, frames: 21 })

    expect(state.progressEvidence).toBe('frames')
    expect(state.progressed).toBe(true)
  })

  it('clears signals on a new source and keeps permission failure until a successful start or reset', () => {
    let state = createPlayerHealthState(baseline)
    state = markPlayerHealthBuffering(state)
    state = markPlaybackStartFailed(state)
    expect(state.buffering).toBe(true)
    expect(state.playbackStartFailed).toBe(true)

    state = resetPlayerHealthBaseline(state, { nowMs: 1_000, positionSeconds: 0, frames: null })
    expect(state.buffering).toBe(false)
    expect(state.playbackStartFailed).toBe(false)

    state = markPlaybackStartFailed(state)
    expect(clearPlaybackStartFailed(state).playbackStartFailed).toBe(false)
  })

  it('reports a stalled playing state after the bounded no-progress interval', () => {
    let state = createPlayerHealthState({ ...baseline, frames: 5 })
    state = observePlayerHealth(state, {
      nowMs: 1_000,
      positionSeconds: 0,
      frames: 5,
      paused: false,
      seeking: false,
      localSeeking: false,
      roomPlaying: true,
      playShouldHaveStarted: true,
      lacksPlayableData: false,
      explicitlyBuffering: false,
      localIntentHold: false,
    })
    state = observePlayerHealth(state, {
      nowMs: 3_500,
      positionSeconds: 0,
      frames: 5,
      paused: false,
      seeking: false,
      localSeeking: false,
      roomPlaying: true,
      playShouldHaveStarted: true,
      lacksPlayableData: false,
      explicitlyBuffering: false,
      localIntentHold: false,
    })

    expect(state.buffering).toBe(true)
    expect(state.progressed).toBe(false)
  })
})
