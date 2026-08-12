import { describe, expect, it } from 'vitest'
import { shouldAcceptPlayerContext } from './player-tab.ts'

const base = {
  hasRoom: false,
  boundTabId: null,
  boundFrameId: null,
  boundAreaPixels: 0,
  participantReady: false,
  senderTabId: 12,
  senderFrameId: 0,
  senderIsActive: false,
  senderAreaPixels: 100,
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
})
