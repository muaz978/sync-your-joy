import type { PlaybackState, PlayerSample, RoomOperation } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { PLAYBACK_PROGRESS_TIMEOUT_MS, PLAYBACK_REPORT_SILENCE_TIMEOUT_MS, PLAYBACK_STARTUP_TIMEOUT_MS } from './playback-health.ts'
import { isSettledPausedSeek } from './operation-state.ts'
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

  it('reports a committed paused seek as settled, not as still seeking', () => {
    const seek: RoomOperation = {
      mediaEpoch: 1,
      operationId: 'operation_settledpausedseek',
      kind: 'seek',
      phase: 'committed',
      requiredParticipantIds: ['participant_host'],
      preparedParticipantIds: ['participant_host'],
      startedParticipantIds: [],
      targetPositionSeconds: 20,
      resumeWhenReady: false,
      effectiveAtServerMs: 1_000,
      deadlineAtServerMs: 1_500,
    }
    expect(isSettledPausedSeek(seek)).toBe(true)
    expect(participantPlaybackStatus(base({ operation: seek }))).toBe('ready')

    // Only a paused seek is settled at `committed`: a resuming seek and a play
    // still owe a start, and an operation that has not committed is preparing.
    expect(isSettledPausedSeek({ ...seek, resumeWhenReady: true })).toBe(false)
    expect(isSettledPausedSeek({ ...seek, kind: 'play' })).toBe(false)
    expect(isSettledPausedSeek({ ...seek, phase: 'prepared' })).toBe(false)
    expect(isSettledPausedSeek(null)).toBe(false)
    expect(participantPlaybackStatus(base({ operation: { ...seek, resumeWhenReady: true } }))).toBe('seeking')
    expect(participantPlaybackStatus(base({ operation: { ...seek, phase: 'preparing' } }))).toBe('seeking')
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
