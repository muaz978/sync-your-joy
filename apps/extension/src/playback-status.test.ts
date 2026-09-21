import { describe, expect, it } from 'vitest'
import { localPlaybackStatus, playbackStatusCopy } from './playback-status.ts'

function base(overrides: Partial<Parameters<typeof localPlaybackStatus>[0]> = {}) {
  return {
    connected: true,
    hasVideo: true,
    mediaMatches: true,
    ready: true,
    roomPlaying: true,
    pendingSeek: false,
    operationKind: null,
    paused: false,
    buffering: false,
    playbackStartFailed: false,
    playbackStarted: true,
    progressed: true,
    progressAgeMs: 0,
    statusAgeMs: 0,
    nowMs: 10_000,
    ...overrides,
  }
}

describe('extension playback status copy', () => {
  it('keeps readiness separate from confirmed progress', () => {
    expect(localPlaybackStatus(base({ roomPlaying: false }))).toBe('ready')
    expect(localPlaybackStatus(base())).toBe('playing')
  })

  it('maps each recovery reason to the bounded status vocabulary', () => {
    expect(localPlaybackStatus(base({ hasVideo: false }))).toBe('preparing')
    expect(localPlaybackStatus(base({ mediaMatches: false }))).toBe('wrong-media')
    expect(localPlaybackStatus(base({ pendingSeek: true }))).toBe('seeking')
    expect(localPlaybackStatus(base({ playbackStartFailed: true }))).toBe('blocked')
    expect(localPlaybackStatus(base({ buffering: true, progressed: false }))).toBe('buffering')
    expect(localPlaybackStatus(base({ statusAgeMs: 5_000, progressed: false }))).toBe('silent')
    expect(localPlaybackStatus(base({ progressAgeMs: 1_800, progressed: false }))).toBe('recovery-required')
  })

  it('uses different mismatch action copy for the controller and a member', () => {
    expect(playbackStatusCopy('wrong-media', true).action).toContain('Open')
    expect(playbackStatusCopy('wrong-media', false).action).toContain('Ask the host')
    expect(playbackStatusCopy('blocked', false).action).toBe('Sync me now')
  })
})
