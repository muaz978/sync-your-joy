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

  it('clears progress signals on a reset but keeps a permission failure until it is explicitly cleared', () => {
    let state = createPlayerHealthState(baseline)
    state = markPlayerHealthBuffering(state)
    state = markPlaybackStartFailed(state)
    expect(state.buffering).toBe(true)
    expect(state.playbackStartFailed).toBe(true)

    // A command reset, such as the room's own pause after the rejection,
    // must not erase the fault that caused it (#68).
    state = resetPlayerHealthBaseline(state, { nowMs: 1_000, positionSeconds: 0, frames: null })
    expect(state.buffering).toBe(false)
    expect(state.playbackStartFailed).toBe(true)

    state = resetPlayerHealthBaseline(state, { nowMs: 2_000, positionSeconds: 0, frames: null }, true)
    expect(state.playbackStartFailed).toBe(true)

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

  it('keeps reporting buffering after the element said it is waiting, until frames advance again (#141)', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    expect(state.progressed).toBe(true)

    // The element fires `waiting`; the heartbeat that follows has no new frames
    // and carries no explicit flag, but the coordinator must keep hearing
    // `buffering`, otherwise it classifies the same stall as a no-progress failure.
    state = markPlayerHealthBuffering(state)
    state = playing(state, { nowMs: 2_000, positionSeconds: 1, frames: 10 })
    expect(state.buffering).toBe(true)
    state = playing(state, { nowMs: 2_400, positionSeconds: 1, frames: 10 })
    expect(state.buffering).toBe(true)

    state = playing(state, { nowMs: 3_000, positionSeconds: 2, frames: 20 })
    expect(state.buffering).toBe(false)
    expect(state.progressed).toBe(true)
  })

  it('does not call a short pause in frames buffering when the element reported nothing', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = playing(state, { nowMs: 2_000, positionSeconds: 1, frames: 10 })

    expect(state.buffering).toBe(false)
  })

  it('keeps the waiting latch when the element drops below current data, until frames advance (#141)', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = markPlayerHealthBuffering(state)
    // readyState fell below HAVE_CURRENT_DATA: the first 1.5 s of that used to clear the flag.
    state = playing(state, { nowMs: 1_500, positionSeconds: 1, frames: 10, lacksPlayableData: true })
    expect(state.buffering).toBe(true)
    state = playing(state, { nowMs: 2_000, positionSeconds: 1, frames: 10, lacksPlayableData: true })
    expect(state.buffering).toBe(true)

    state = playing(state, { nowMs: 3_000, positionSeconds: 2, frames: 20 })
    expect(state.buffering).toBe(false)
  })

  it('keeps the waiting latch through a frame counter reset', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = markPlayerHealthBuffering(state)
    state = playing(state, { nowMs: 1_500, positionSeconds: 1, frames: 2 })

    expect(state.buffering).toBe(true)
  })

  it('keeps the waiting latch across the startup grace window', () => {
    let state = createPlayerHealthState(baseline)
    state = markPlayerHealthBuffering(state)
    state = playing(state, { nowMs: 1_000, positionSeconds: 0, frames: 0, playShouldHaveStarted: false })
    expect(state.buffering).toBe(true)
    // Grace is over and frames are still stalled.
    state = playing(state, { nowMs: 3_000, positionSeconds: 0, frames: 0, playShouldHaveStarted: true })
    expect(state.buffering).toBe(true)
  })
})

describe('rendered-frame evidence', () => {
  it('is set only by a frame counter that advanced, not by the media clock', () => {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: null })
    expect(state.hasRealPlaybackProgress).toBe(true)
    expect(state.hasRenderedFrameProgress).toBe(false)

    state = resetPlayerHealthBaseline(state, { nowMs: 1_500, positionSeconds: 1, frames: 5 }, true)
    state = playing(state, { nowMs: 2_000, positionSeconds: 2, frames: 5 })
    expect(state.progressEvidence).toBe('frames')
    expect(state.hasRenderedFrameProgress).toBe(false)

    state = playing(state, { nowMs: 3_000, positionSeconds: 3, frames: 29 })
    expect(state.hasRenderedFrameProgress).toBe(true)
  })

  it('is set by frames that advanced during the startup grace window', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 0.5, frames: 12, playShouldHaveStarted: false })

    expect(state.hasRenderedFrameProgress).toBe(true)
  })

  it('is kept through a visibility rebase and cleared by a command or source reset', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    expect(state.hasRenderedFrameProgress).toBe(true)

    state = resetPlayerHealthBaseline(state, { nowMs: 2_000, positionSeconds: 1, frames: 10 }, true)
    expect(state.hasRenderedFrameProgress).toBe(true)

    state = resetPlayerHealthBaseline(state, { nowMs: 3_000, positionSeconds: 0, frames: 0 })
    expect(state.hasRenderedFrameProgress).toBe(false)
    expect(state.hasRealPlaybackProgress).toBe(false)
  })

  it('is not set by a counter that was reset', () => {
    let state = createPlayerHealthState({ ...baseline, frames: 30 })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 20 })

    expect(state.hasRenderedFrameProgress).toBe(false)
  })
})

describe('progress that media events report between periodic samples', () => {
  const event = (previous: ReturnType<typeof createPlayerHealthState>, overrides: Partial<Parameters<typeof observePlayerHealth>[1]> = {}) =>
    playing(previous, { periodic: false, ...overrides })

  it('is not reported as no progress when the report falls between two frames', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    expect(state.progressed).toBe(true)

    state = event(state, { nowMs: 1_020, positionSeconds: 1.02, frames: 10 })
    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('frames')
    state = event(state, { nowMs: 1_400, positionSeconds: 1.4, frames: 10 })
    expect(state.progressed).toBe(true)
  })

  it('does not carry a verdict that is older than the periodic interval, so a freeze is still reported', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })

    state = event(state, { nowMs: 2_499, positionSeconds: 2.5, frames: 10 })
    expect(state.progressed).toBe(true)
    state = event(state, { nowMs: 2_500, positionSeconds: 2.5, frames: 10 })
    expect(state.progressed).toBe(false)
  })

  it('does not carry the verdict of a periodic sample that saw no progress', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 0 })
    expect(state.progressed).toBe(false)

    state = event(state, { nowMs: 1_020, positionSeconds: 1.02, frames: 0 })
    expect(state.progressed).toBe(false)
  })

  it('leaves the cursor of the periodic sample alone, so the next sample still sees what the event saw', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })

    state = event(state, { nowMs: 1_600, positionSeconds: 1.6, frames: 20 })
    expect(state.progressed).toBe(true)
    expect(state.observedFrames).toBe(10)
    expect(state.observedAtMs).toBe(1_600)

    state = playing(state, { nowMs: 2_000, positionSeconds: 2, frames: 20 })
    expect(state.progressed).toBe(true)

    // Nothing new since that sample: now it is a real absence of progress.
    state = playing(state, { nowMs: 3_000, positionSeconds: 3, frames: 20 })
    expect(state.progressed).toBe(false)
  })

  it('records the time of progress an event saw', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = event(state, { nowMs: 1_600, positionSeconds: 1.6, frames: 20 })

    expect(state.lastProgressAtMs).toBe(1_600)
  })

  it('never carries progress into a pause, a seek, a counter reset or a known stall', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })

    expect(event(state, { nowMs: 1_100, paused: true }).progressed).toBe(false)
    expect(event(state, { nowMs: 1_100, seeking: true }).progressed).toBe(false)
    expect(event(state, { nowMs: 1_100, localSeeking: true }).progressed).toBe(false)
    expect(event(state, { nowMs: 1_100, frames: 3 }).progressed).toBe(false)
    expect(event(markPlayerHealthBuffering(state), { nowMs: 1_100, frames: 10 }).progressed).toBe(false)
    expect(event(state, { nowMs: 1_100, explicitlyBuffering: true, frames: 10 }).progressed).toBe(false)
  })

  it('does not carry a verdict across a reset', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = resetPlayerHealthBaseline(state, { nowMs: 1_100, positionSeconds: 1, frames: 10 }, true)

    expect(event(state, { nowMs: 1_200, positionSeconds: 1.2, frames: 10 }).progressed).toBe(false)
  })

  it('treats an observation without the flag as a periodic one', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = playing(state, { nowMs: 1_020, positionSeconds: 1.02, frames: 10 })

    expect(state.progressed).toBe(false)
    expect(state.observedAtMs).toBe(1_020)
  })
})

describe('a stall after progress that an event report already saw', () => {
  const event = (previous: ReturnType<typeof createPlayerHealthState>, overrides: Partial<Parameters<typeof observePlayerHealth>[1]> = {}) =>
    playing(previous, { periodic: false, ...overrides })

  /** A periodic sample sees frame 24, a media event sees frame 26, and then the element says it is waiting. */
  function stalledAfterEventSawFrames() {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 24 })
    state = event(state, { nowMs: 1_500, positionSeconds: 1.5, frames: 26 })
    expect(state.progressed).toBe(true)
    return markPlayerHealthBuffering(state)
  }

  it('is not cleared by a delayed buffering report that sees the same frames again', () => {
    let state = stalledAfterEventSawFrames()
    state = event(state, { nowMs: 2_200, positionSeconds: 1.5, frames: 26, explicitlyBuffering: true })

    expect(state.buffering).toBe(true)
    expect(state.progressed).toBe(false)
  })

  it('is not cleared by an event report without the explicit flag either', () => {
    let state = stalledAfterEventSawFrames()
    state = event(state, { nowMs: 2_200, positionSeconds: 1.5, frames: 26 })

    expect(state.buffering).toBe(true)
    expect(state.progressed).toBe(false)
  })

  it('is not cleared by the next periodic sample, which sees no frame that no report has seen', () => {
    let state = stalledAfterEventSawFrames()
    state = event(state, { nowMs: 2_200, positionSeconds: 1.5, frames: 26, explicitlyBuffering: true })
    state = playing(state, { nowMs: 3_000, positionSeconds: 1.5, frames: 26 })

    expect(state.buffering).toBe(true)
    expect(state.progressed).toBe(false)
  })

  it('is cleared by a frame that no earlier report has seen, from an event or the periodic sample', () => {
    let state = stalledAfterEventSawFrames()
    state = event(state, { nowMs: 2_200, positionSeconds: 1.6, frames: 27 })
    expect(state.buffering).toBe(false)
    expect(state.progressed).toBe(true)

    state = stalledAfterEventSawFrames()
    state = playing(state, { nowMs: 3_000, positionSeconds: 2, frames: 30 })
    expect(state.buffering).toBe(false)
    expect(state.progressed).toBe(true)
  })

  it('still counts progress that an event saw towards the next periodic sample when nothing stalled', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 24 })
    state = event(state, { nowMs: 1_600, positionSeconds: 1.6, frames: 26 })
    state = playing(state, { nowMs: 2_000, positionSeconds: 2, frames: 26 })

    expect(state.progressed).toBe(true)
    expect(state.buffering).toBe(false)
  })
})

describe('the evidence quality of a carried verdict', () => {
  const event = (previous: ReturnType<typeof createPlayerHealthState>, overrides: Partial<Parameters<typeof observePlayerHealth>[1]> = {}) =>
    playing(previous, { periodic: false, ...overrides })

  /** The frame counter was unavailable and has just come back: the periodic sample that sees its first value still reports clock progress. */
  function counterJustRecovered() {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: null })
    state = playing(state, { nowMs: 2_000, positionSeconds: 2, frames: 10 })
    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('clock')
    return state
  }

  it('is not promoted to frames by an event that sees the first counter value again', () => {
    const state = event(counterJustRecovered(), { nowMs: 2_020, positionSeconds: 2.02, frames: 10 })

    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('clock')
    expect(state.hasRenderedFrameProgress).toBe(false)
  })

  it('keeps the evidence of the verdict through a chain of events, until a frame advances', () => {
    let state = event(counterJustRecovered(), { nowMs: 2_020, positionSeconds: 2.02, frames: 10 })
    state = event(state, { nowMs: 2_400, positionSeconds: 2.4, frames: 10 })
    expect(state.progressEvidence).toBe('clock')
    expect(state.hasRenderedFrameProgress).toBe(false)

    state = event(state, { nowMs: 2_600, positionSeconds: 2.6, frames: 14 })
    expect(state.progressEvidence).toBe('frames')
    expect(state.hasRenderedFrameProgress).toBe(true)
  })

  it('carries frames evidence when the periodic verdict was made with frames', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = event(state, { nowMs: 1_020, positionSeconds: 1.02, frames: 10 })

    expect(state.progressEvidence).toBe('frames')
    expect(state.hasRenderedFrameProgress).toBe(true)
  })

  it('is not frame-confirmed by the next periodic sample either, as long as no frame has advanced', () => {
    let state = event(counterJustRecovered(), { nowMs: 2_020, positionSeconds: 2.02, frames: 10 })
    state = playing(state, { nowMs: 3_000, positionSeconds: 3, frames: 10 })

    expect(state.progressed).toBe(false)
    expect(state.hasRenderedFrameProgress).toBe(false)
  })

  it('judges a counter reset against the latest observation, not an older sample', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 24 })
    state = event(state, { nowMs: 1_400, positionSeconds: 1.4, frames: 40 })
    state = event(state, { nowMs: 1_600, positionSeconds: 1.6, frames: 30 })

    expect(state.progressEvidence).toBe('unknown')
    expect(state.progressed).toBe(false)
  })

  it('clears a waiting latch inside the startup grace window only with a frame no report has seen', () => {
    let state = createPlayerHealthState(baseline)
    state = event(state, { nowMs: 500, positionSeconds: 0.5, frames: 12, playShouldHaveStarted: false })
    state = markPlayerHealthBuffering(state)
    state = event(state, { nowMs: 900, positionSeconds: 0.5, frames: 12, playShouldHaveStarted: false })
    expect(state.buffering).toBe(true)

    state = event(state, { nowMs: 1_200, positionSeconds: 0.7, frames: 13, playShouldHaveStarted: false })
    expect(state.buffering).toBe(false)
  })

  it('moves the latest cursor with a rebase, so the first value after a visibility change is not read as new progress', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = markPlayerHealthBuffering(state)
    state = resetPlayerHealthBaseline(state, { nowMs: 1_500, positionSeconds: 1, frames: 400 }, true)
    state = event(state, { nowMs: 1_600, positionSeconds: 1, frames: 400, explicitlyBuffering: true })

    expect(state.buffering).toBe(true)
    expect(state.progressed).toBe(false)
  })
})

describe('clearing a waiting latch with and without a frame counter', () => {
  it('is not done by the media clock while a frame counter is available and shows no new frame', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 24 })
    state = markPlayerHealthBuffering(state)
    state = playing(state, { nowMs: 2_000, positionSeconds: 1.5, frames: 24 })

    expect(state.buffering).toBe(true)
    expect(state.progressed).toBe(false)
  })

  it('is done by the media clock only when there is no frame counter at all, which is then the only evidence', () => {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: null })
    state = markPlayerHealthBuffering(state)
    // A stalled element's clock does not move.
    state = playing(state, { nowMs: 2_000, positionSeconds: 1, frames: null })
    expect(state.buffering).toBe(true)

    state = playing(state, { nowMs: 3_000, positionSeconds: 1.12, frames: null })
    expect(state.buffering).toBe(false)
    expect(state.progressEvidence).toBe('clock')
    // Cleared by the clock, so it is still not rendered-frame evidence.
    expect(state.hasRenderedFrameProgress).toBe(false)
  })
})

describe('the evidence a verdict claims comes from the comparison that made it', () => {
  const event = (previous: ReturnType<typeof createPlayerHealthState>, overrides: Partial<Parameters<typeof observePlayerHealth>[1]> = {}) =>
    playing(previous, { periodic: false, ...overrides })

  it('is clock when a counter that went missing between two reports comes back and only the clock moved', () => {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = event(state, { nowMs: 1_100, positionSeconds: 1.1, frames: null })
    state = event(state, { nowMs: 1_400, positionSeconds: 1.4, frames: 10 })

    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('clock')
    expect(state.hasRenderedFrameProgress).toBe(false)
  })

  it('is clock in the same sequence during the startup grace window', () => {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10, playShouldHaveStarted: false })
    state = event(state, { nowMs: 1_100, positionSeconds: 1.1, frames: null, playShouldHaveStarted: false })
    state = event(state, { nowMs: 1_400, positionSeconds: 1.4, frames: 10, playShouldHaveStarted: false })

    expect(state.progressEvidence).toBe('clock')
    expect(state.hasRenderedFrameProgress).toBe(false)
  })

  it('is frames when the counter itself advanced, even across a report that could not read it', () => {
    let state = createPlayerHealthState(baseline)
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = event(state, { nowMs: 1_100, positionSeconds: 1.1, frames: null })
    state = playing(state, { nowMs: 2_000, positionSeconds: 2, frames: 40 })

    expect(state.progressed).toBe(true)
    expect(state.progressEvidence).toBe('frames')
    expect(state.hasRenderedFrameProgress).toBe(true)
  })

  it('does not end a waiting latch with clock progress while the counter is readable', () => {
    let state = createPlayerHealthState({ ...baseline, frames: null })
    state = playing(state, { nowMs: 1_000, positionSeconds: 1, frames: 10 })
    state = markPlayerHealthBuffering(state)
    state = event(state, { nowMs: 1_100, positionSeconds: 1.1, frames: null, explicitlyBuffering: true })
    state = event(state, { nowMs: 1_400, positionSeconds: 1.4, frames: 10, explicitlyBuffering: true })

    expect(state.buffering).toBe(true)
    expect(state.progressed).toBe(false)
  })

  function mulberry32(seed: number): () => number {
    let value = seed
    return () => {
      value = (value + 0x6D2B79F5) | 0
      let t = Math.imul(value ^ (value >>> 15), 1 | value)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('never claims frames, or a rendered frame, without a frame counter that advanced (random sequences of periodic and event observations)', () => {
    let claims = 0
    for (let seed = 1; seed <= 3_000; seed += 1) {
      const random = mulberry32(seed)
      let frames: number | null = random() < 0.4 ? null : 0
      let state = createPlayerHealthState({ nowMs: 0, positionSeconds: 0, frames })
      const seen: Array<number | null> = [frames]
      let nowMs = 0
      let positionSeconds = 0
      for (let step = 0; step < 16; step += 1) {
        nowMs += 20 + Math.floor(random() * 900)
        positionSeconds += random() < 0.3 ? 0 : random() * 0.8
        const mode = random()
        if (mode < 0.2)
          frames = null
        else if (mode < 0.28)
          frames = Math.floor(random() * 20)
        else
          frames = (frames ?? Math.floor(random() * 30)) + (random() < 0.5 ? 0 : Math.floor(random() * 30))
        seen.push(frames)
        state = observePlayerHealth(state, {
          nowMs,
          positionSeconds,
          frames,
          periodic: random() < 0.4,
          paused: random() < 0.05,
          seeking: random() < 0.03,
          localSeeking: false,
          roomPlaying: random() < 0.95,
          playShouldHaveStarted: random() < 0.9,
          lacksPlayableData: random() < 0.03,
          explicitlyBuffering: random() < 0.1,
          localIntentHold: false,
        })

        // A frame counter advanced somewhere in the sequence: some value is larger than an earlier one.
        let counterAdvanced = false
        let lowest = Number.POSITIVE_INFINITY
        for (const value of seen) {
          if (value === null)
            continue
          if (value > lowest)
            counterAdvanced = true
          lowest = Math.min(lowest, value)
        }
        if (state.progressed && state.progressEvidence === 'frames') {
          claims += 1
          expect(counterAdvanced, `seed ${seed} step ${step}: progress claimed as frames without an advanced counter`).toBe(true)
        }
        if (state.hasRenderedFrameProgress)
          expect(counterAdvanced, `seed ${seed} step ${step}: rendered frame claimed without an advanced counter`).toBe(true)
        expect(state.progressed && state.buffering, `seed ${seed} step ${step}: progressed while waiting`).toBe(false)
      }
    }
    // The run is not vacuous: frames were claimed many times.
    expect(claims).toBeGreaterThan(1_000)
  })
})
