import type { PlaybackState } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { isPlaybackPastStartupGrace, PLAYBACK_STARTUP_GRACE_MS } from './playback-health.ts'

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
})
