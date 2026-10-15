import type { RoomSnapshot } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { AWAITING_APPROVAL_PILL, isAwaitingApproval } from './room-membership.ts'

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: 'room_123456', code: 'ABCDEFGH', revision: 3,
    controller: { participantId: 'participant_host', leaseEpoch: 1 },
    media: null,
    playback: { status: 'paused', positionSeconds: 0, effectiveAtServerMs: 0, playbackRate: 1 },
    seek: null, navigation: null,
    participants: [{ id: 'participant_host', name: 'Host', role: 'controller', ready: false, connected: true, mediaMatches: false, latencyMs: null }],
    pendingJoinRequests: [],
    policy: { buffering: 'pause-all' },
    ...overrides,
  }
}

const me = 'participant_friend'
const request = { id: me, name: 'Rana', requestedAtMs: 1 }
const member = { id: me, name: 'Rana', role: 'member' as const, ready: false, connected: true, mediaMatches: false, latencyMs: null }

describe('isAwaitingApproval', () => {
  it('is true only while the own id is pending and not a participant', () => {
    expect(isAwaitingApproval({ participantId: me, snapshot: snapshot({ pendingJoinRequests: [request] }) })).toBe(true)
  })

  it('is false for an approved member, even if a stale pending entry is still listed', () => {
    expect(isAwaitingApproval({ participantId: me, snapshot: snapshot({ participants: [member] }) })).toBe(false)
    expect(isAwaitingApproval({ participantId: me, snapshot: snapshot({ participants: [member], pendingJoinRequests: [request] }) })).toBe(false)
  })

  it('is false for someone else\'s pending request, with no room, or from an older coordinator that sends no pending list', () => {
    expect(isAwaitingApproval({ participantId: me, snapshot: snapshot({ pendingJoinRequests: [{ ...request, id: 'participant_other' }] }) })).toBe(false)
    expect(isAwaitingApproval({ participantId: me, snapshot: null })).toBe(false)
    const legacy = snapshot() as unknown as Record<string, unknown>
    delete legacy.pendingJoinRequests
    expect(isAwaitingApproval({ participantId: me, snapshot: legacy as unknown as RoomSnapshot })).toBe(false)
  })
})

describe('the pending pill copy', () => {
  it('says what is happening and does not borrow member wording', () => {
    expect(AWAITING_APPROVAL_PILL.status).toMatch(/waiting for the host/i)
    expect(AWAITING_APPROVAL_PILL.detail).toMatch(/pending/i)
    expect(`${AWAITING_APPROVAL_PILL.status} ${AWAITING_APPROVAL_PILL.detail}`).not.toMatch(/member|connected|episode/i)
  })
})
