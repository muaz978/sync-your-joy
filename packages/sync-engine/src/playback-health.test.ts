import type { PlaybackState } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { hasPlaybackApplicationFailed, hasPlaybackProgressStalled, isPlaybackPastStartupGrace, PLAYBACK_APPLICATION_GRACE_MS, PLAYBACK_PROGRESS_TIMEOUT_MS, PLAYBACK_STARTUP_GRACE_MS } from './playback-health.ts'

const playback: PlaybackState = {
  status: 'playing',
  positionSeconds: 7,
  effectiveAtServerMs: 10_000,
  playbackRate: 1,
}

describe('playback health timing', () => {
  it('does not judge buffering before scheduled playback and startup settle time', () => {
    expect(isPlaybackPastStartupGrace(playback, 9_999)).toBe(false)
    expect(isPlaybackPastStartupGrace(playback, 10_000 + PLAYBACK_STARTUP_GRACE_MS - 1)).toBe(false)
  })

  it('allows real stall detection after the startup window', () => {
    expect(isPlaybackPastStartupGrace(playback, 10_000 + PLAYBACK_STARTUP_GRACE_MS)).toBe(true)
  })

  it('never judges paused playback as a startup failure', () => {
    expect(isPlaybackPastStartupGrace({ ...playback, status: 'paused' }, 99_999)).toBe(false)
  })

  it('detects a player that remains paused shortly after the scheduled start', () => {
    expect(hasPlaybackApplicationFailed(playback, true, playback.effectiveAtServerMs + PLAYBACK_APPLICATION_GRACE_MS - 1)).toBe(false)
    expect(hasPlaybackApplicationFailed(playback, true, playback.effectiveAtServerMs + PLAYBACK_APPLICATION_GRACE_MS)).toBe(true)
    expect(hasPlaybackApplicationFailed(playback, false, 99_999)).toBe(false)
  })

  it('detects a player whose real position stops advancing', () => {
    const deadline = playback.effectiveAtServerMs + PLAYBACK_PROGRESS_TIMEOUT_MS
    expect(hasPlaybackProgressStalled(playback, playback.effectiveAtServerMs, deadline - 1)).toBe(false)
    expect(hasPlaybackProgressStalled(playback, playback.effectiveAtServerMs, deadline)).toBe(true)
  })
})
