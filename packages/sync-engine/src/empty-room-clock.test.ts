import { describe, expect, it } from 'vitest'
import { isEmptyRoomExpired, reconcileEmptyClock } from './empty-room-clock.ts'

describe('empty room clock', () => {
  it('has no clock while anyone is connected, even a stale one', () => {
    expect(reconcileEmptyClock({ emptySinceMs: 1_000, hasConnectedParticipants: true, nowMs: 5_000 })).toBeNull()
    expect(reconcileEmptyClock({ emptySinceMs: null, hasConnectedParticipants: true, nowMs: 5_000 })).toBeNull()
  })

  it('keeps the original start while the room stays empty', () => {
    expect(reconcileEmptyClock({ emptySinceMs: 1_000, hasConnectedParticipants: false, nowMs: 5_000 })).toBe(1_000)
  })

  it('starts a missing clock when the room is empty', () => {
    expect(reconcileEmptyClock({ emptySinceMs: null, hasConnectedParticipants: false, nowMs: 5_000 })).toBe(5_000)
  })

  it('never moves a running clock forward, however often it is reconciled', () => {
    let clock: number | null = null
    for (const nowMs of [1_000, 2_000, 3_000, 4_000])
      clock = reconcileEmptyClock({ emptySinceMs: clock, hasConnectedParticipants: false, nowMs })
    expect(clock).toBe(1_000)
  })

  it('expires exactly at the TTL and not before', () => {
    expect(isEmptyRoomExpired(1_000, 1_000 + 29_999, 30_000)).toBe(false)
    expect(isEmptyRoomExpired(1_000, 1_000 + 30_000, 30_000)).toBe(true)
    expect(isEmptyRoomExpired(null, 1_000_000, 30_000)).toBe(false)
  })
})
