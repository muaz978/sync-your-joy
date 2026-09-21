import type { PlaybackState, PlayerSample } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { PLAYBACK_PROGRESS_TIMEOUT_MS, PLAYBACK_REPORT_SILENCE_TIMEOUT_MS, PLAYBACK_STARTUP_TIMEOUT_MS } from './playback-health.ts'
import { participantPlaybackStatus } from './participant-status.ts'

const paused: PlaybackState = {
  status: 'paused',
  positionSeconds: 20,
  effectiveAtServerMs: 1_000,
  playbackRate: 1,
}

const playing: PlaybackState = {
  ...paused,
  status: 'playing',
  effectiveAtServerMs: 1_000,
}

function sample(overrides: Partial<PlayerSample> = {}): PlayerSample {
  return {
    positionSeconds: 20,
    durationSeconds: 600,
    paused: false,
    buffering: false,
    sampledAtLocalMs: 2_000,
    progressed: true,
    playbackStarted: true,
    ...overrides,
  }
}

function base(overrides: Partial<Parameters<typeof participantPlaybackStatus>[0]> = {}) {
  return {
    connected: true,
    ready: true,
    mediaMatches: true,
    playback: paused,
    operation: null,
    pendingSeek: false,
    sample: null,
    lastSampleReceivedAtMs: undefined,
    lastProgressAtServerMs: undefined,
    nowMs: 2_000,
    ...overrides,
  }
}

describe('public participant playback statuses', () => {
  it('keeps readiness distinct from confirmed playing progress', () => {
    expect(participantPlaybackStatus(base())).toBe('ready')
    expect(participantPlaybackStatus(base({ playback: playing, sample: sample() }))).toBe('playing')
  })

  it('explains media mismatch, preparation and seeking before raw health details', () => {
    expect(participantPlaybackStatus(base({ mediaMatches: false }))).toBe('wrong-media')
    expect(participantPlaybackStatus(base({ ready: false }))).toBe('preparing')
    expect(participantPlaybackStatus(base({ pendingSeek: true, playback: playing, sample: sample() }))).toBe('seeking')
  })

  it('distinguishes blocked, buffering and local recovery states', () => {
    expect(participantPlaybackStatus(base({ playback: playing, sample: sample({ playbackStartFailed: true }) }))).toBe('blocked')
    expect(participantPlaybackStatus(base({ playback: playing, sample: sample({ buffering: true, progressed: false }) }))).toBe('buffering')
    expect(participantPlaybackStatus(base({ playback: playing, sample: sample({ paused: true, progressed: false }) }))).toBe('recovery-required')
  })

  it('reports silent startup and silent status streams without exposing raw samples', () => {
    expect(participantPlaybackStatus(base({
      playback: playing,
      nowMs: playing.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS,
    }))).toBe('silent')
    expect(participantPlaybackStatus(base({
      playback: playing,
      sample: sample({ progressed: false }),
      lastSampleReceivedAtMs: 2_000,
      nowMs: 2_000 + PLAYBACK_REPORT_SILENCE_TIMEOUT_MS,
    }))).toBe('silent')
    expect(participantPlaybackStatus(base({
      playback: playing,
      sample: sample({ progressed: false }),
      lastSampleReceivedAtMs: 2_000,
      lastProgressAtServerMs: 2_000,
      nowMs: 2_000 + PLAYBACK_PROGRESS_TIMEOUT_MS,
    }))).toBe('recovery-required')
  })
})
