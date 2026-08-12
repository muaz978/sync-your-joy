import { describe, expect, it } from 'vitest'
import { shouldAcceptPlayerTab } from './player-tab.ts'

describe('room player tab binding', () => {
  it('ignores supported background tabs before a room starts', () => {
    expect(shouldAcceptPlayerTab({ hasRoom: false, boundTabId: null, senderTabId: 12, senderIsActive: false })).toBe(false)
    expect(shouldAcceptPlayerTab({ hasRoom: false, boundTabId: null, senderTabId: 13, senderIsActive: true })).toBe(true)
  })

  it('accepts only the bound tab during a room', () => {
    expect(shouldAcceptPlayerTab({ hasRoom: true, boundTabId: 13, senderTabId: 13, senderIsActive: false })).toBe(true)
    expect(shouldAcceptPlayerTab({ hasRoom: true, boundTabId: 13, senderTabId: 12, senderIsActive: true })).toBe(false)
  })

  it('lets the active tab become the replacement when the bound tab is gone', () => {
    expect(shouldAcceptPlayerTab({ hasRoom: true, boundTabId: null, senderTabId: 14, senderIsActive: true })).toBe(true)
  })
})
