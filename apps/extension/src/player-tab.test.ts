import { describe, expect, it } from 'vitest'
import { shouldAcceptPlayerContext, shouldReusePlayerTabForNavigation } from './player-tab.ts'

const base = {
  hasRoom: false,
  boundTabId: null,
  boundFrameId: null,
  boundAreaPixels: 0,
  boundLastSeenAtMs: 1_000,
  participantReady: false,
  senderTabId: 12,
  senderFrameId: 0,
  senderIsActive: false,
  senderAreaPixels: 100,
  senderMediaMatchesRoom: false,
  nowMs: 2_000,
}

describe('room player tab binding', () => {
  it('ignores supported background tabs before a room starts', () => {
    expect(shouldAcceptPlayerContext(base)).toBe(false)
    expect(shouldAcceptPlayerContext({ ...base, senderTabId: 13, senderIsActive: true })).toBe(true)
  })

  it('accepts only the bound tab during a room', () => {
    expect(shouldAcceptPlayerContext({ ...base, hasRoom: true, boundTabId: 13, boundFrameId: 4, senderTabId: 13, senderFrameId: 4 })).toBe(true)
    expect(shouldAcceptPlayerContext({ ...base, hasRoom: true, boundTabId: 13, boundFrameId: 4, senderTabId: 12, senderFrameId: 4, senderIsActive: true })).toBe(false)
  })

  it('lets the active tab become the replacement when the bound tab is gone', () => {
    expect(shouldAcceptPlayerContext({ ...base, hasRoom: true, senderTabId: 14, senderIsActive: true })).toBe(true)
  })

  it('selects a larger embedded player until the participant becomes ready', () => {
    const candidate = { ...base, hasRoom: true, boundTabId: 13, boundFrameId: 2, boundAreaPixels: 20_000, senderTabId: 13, senderFrameId: 7, senderAreaPixels: 500_000 }
    expect(shouldAcceptPlayerContext(candidate)).toBe(true)
    expect(shouldAcceptPlayerContext({ ...candidate, participantReady: true })).toBe(false)
  })

  it('replaces a stale player frame even while the participant remains ready', () => {
    expect(shouldAcceptPlayerContext({
      ...base,
      hasRoom: true,
      boundTabId: 13,
      boundFrameId: 2,
      boundAreaPixels: 500_000,
      boundLastSeenAtMs: 1_000,
      participantReady: true,
      senderTabId: 13,
      senderFrameId: 7,
      senderAreaPixels: 500_000,
      senderMediaMatchesRoom: true,
      nowMs: 4_000,
    })).toBe(true)
  })

  it('does not let a stale mismatching or tiny embedded video replace a ready player', () => {
    const staleCandidate = {
      ...base,
      hasRoom: true,
      boundTabId: 13,
      boundFrameId: 2,
      boundAreaPixels: 500_000,
      boundLastSeenAtMs: 1_000,
      participantReady: true,
      senderTabId: 13,
      senderFrameId: 7,
      senderAreaPixels: 500_000,
      nowMs: 4_000,
    }
    expect(shouldAcceptPlayerContext(staleCandidate)).toBe(false)
    expect(shouldAcceptPlayerContext({
      ...staleCandidate,
      senderMediaMatchesRoom: true,
      senderAreaPixels: 20_000,
    })).toBe(false)
  })
})

describe('shared navigation tab reuse', () => {
  it('reuses a bound tab that already has the normalized shared page', () => {
    expect(shouldReusePlayerTabForNavigation(
      12,
      'https://video.example/watch/42?utm_source=room#player',
      'https://video.example/watch/42',
    )).toBe(true)
  })

  it('opens a new tab when there is no bound tab or the video page differs', () => {
    expect(shouldReusePlayerTabForNavigation(null, 'https://video.example/watch/42', 'https://video.example/watch/42')).toBe(false)
    expect(shouldReusePlayerTabForNavigation(12, 'https://video.example/watch/41', 'https://video.example/watch/42')).toBe(false)
  })
})
