import { describe, expect, it } from 'vitest'
import { CLOCK_ONLY_PLAYBACK_COPY, classifyLocalPlayback, localPlaybackStatus, playbackStatusCopy, withClockOnlyPillText } from './playback-status.ts'

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

  it('does not call a paused player ready while it still waits for data', () => {
    expect(localPlaybackStatus(base({ roomPlaying: false, buffering: true, progressed: false }))).toBe('buffering')
    expect(localPlaybackStatus(base({ roomPlaying: false, ready: false, buffering: true }))).toBe('preparing')
    expect(playbackStatusCopy('buffering', false).detail).toBe('The player is waiting for data before it can play.')
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

describe('what confirms that a player is playing (#53)', () => {
  it('needs rendered-frame evidence for "Playing, confirmed"', () => {
    expect(classifyLocalPlayback(base({ progressEvidence: 'frames' }))).toEqual({ status: 'playing', clockOnly: false })
    expect(playbackStatusCopy('playing', false).label).toBe('Playing, confirmed')
  })

  it('does not confirm progress that only the media clock shows', () => {
    expect(classifyLocalPlayback(base({ progressEvidence: 'clock' }))).toEqual({ status: 'preparing', clockOnly: true })
    expect(localPlaybackStatus(base({ progressEvidence: 'clock' }))).toBe('preparing')
  })

  it('does not confirm progress of unknown quality either', () => {
    expect(localPlaybackStatus(base({ progressEvidence: 'unknown' }))).toBe('preparing')
  })

  it('keeps the earlier behaviour for a caller that does not say what the progress was measured with', () => {
    expect(localPlaybackStatus(base())).toBe('playing')
  })

  it('does not call a state other than steady progress clock-only', () => {
    expect(classifyLocalPlayback(base({ progressEvidence: 'clock', paused: true }))).toEqual({ status: 'recovery-required', clockOnly: false })
    expect(classifyLocalPlayback(base({ progressEvidence: 'clock', buffering: true }))).toEqual({ status: 'buffering', clockOnly: false })
    expect(classifyLocalPlayback(base({ progressEvidence: 'clock', progressed: false }))).toEqual({ status: 'preparing', clockOnly: false })
    expect(classifyLocalPlayback(base({ progressEvidence: 'clock', roomPlaying: false }))).toEqual({ status: 'ready', clockOnly: false })
    expect(classifyLocalPlayback(base({ progressEvidence: 'clock', progressAgeMs: 1_800 }))).toEqual({ status: 'recovery-required', clockOnly: false })
  })

  it('has a label of its own, different from every protocol status label', () => {
    const labels = (['preparing', 'ready', 'playing', 'seeking', 'blocked', 'buffering', 'silent', 'wrong-media', 'recovery-required', 'unknown'] as const)
      .map(status => playbackStatusCopy(status, false).label)

    expect(CLOCK_ONLY_PLAYBACK_COPY.label).toBe('Playing, not frame-confirmed')
    expect(labels).not.toContain(CLOCK_ONLY_PLAYBACK_COPY.label)
    expect(CLOCK_ONLY_PLAYBACK_COPY.detail).toMatch(/media clock/)
  })

  it('replaces the generic preparing text of a pill and nothing else', () => {
    const preparing = playbackStatusCopy('preparing', false)
    const pill = { status: preparing.label, meta: `${preparing.detail} Member, 2 connected.` }

    expect(withClockOnlyPillText(pill, false)).toEqual({
      status: CLOCK_ONLY_PLAYBACK_COPY.label,
      meta: `${CLOCK_ONLY_PLAYBACK_COPY.detail} Member, 2 connected.`,
    })
    expect(withClockOnlyPillText({ status: 'Seeking 1/2', meta: 'Moving everyone to 1:00' }, false)).toEqual({ status: 'Seeking 1/2', meta: 'Moving everyone to 1:00' })
    expect(withClockOnlyPillText({ status: 'Reconnecting', meta: 'x' }, true)).toEqual({ status: 'Reconnecting', meta: 'x' })
  })
})
