import type { RoomSnapshot } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { playbackStatusCopy } from './playback-status.ts'
import { AWAITING_APPROVAL_PILL, isAwaitingApproval, pendingPillCopy } from './room-membership.ts'

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

  it('does not throw for a pending list that is null or missing, for a member or for someone not in the room', () => {
    for (const withList of [(raw: Record<string, unknown>) => { raw.pendingJoinRequests = null }, (raw: Record<string, unknown>) => { delete raw.pendingJoinRequests }]) {
      for (const participants of [[member], []]) {
        const raw = snapshot({ participants }) as unknown as Record<string, unknown>
        withList(raw)
        expect(() => isAwaitingApproval({ participantId: me, snapshot: raw as unknown as RoomSnapshot })).not.toThrow()
        expect(isAwaitingApproval({ participantId: me, snapshot: raw as unknown as RoomSnapshot })).toBe(false)
      }
    }
  })
})

describe('the pending pill copy', () => {
  it('says what is happening and does not borrow member wording', () => {
    expect(AWAITING_APPROVAL_PILL.status).toMatch(/waiting for the host/i)
    expect(AWAITING_APPROVAL_PILL.detail).toMatch(/pending/i)
    expect(`${AWAITING_APPROVAL_PILL.status} ${AWAITING_APPROVAL_PILL.detail}`).not.toMatch(/member|connected|episode/i)
  })
})

describe('the pending pill copy for a connection state', () => {
  it('blames the host only while the connection is up', () => {
    expect(pendingPillCopy('connected')).toEqual(AWAITING_APPROVAL_PILL)
  })

  it('shows the same status as a member would while the connection is down, not "waiting for the host"', () => {
    // The member path shows exactly this for these two connection states.
    expect(pendingPillCopy('reconnecting').status).toBe('Reconnecting')
    expect(pendingPillCopy('disconnected').status).toBe(playbackStatusCopy('unknown', false).label)
    for (const connection of ['reconnecting', 'disconnected'] as const)
      expect(pendingPillCopy(connection).status).not.toMatch(/waiting for the host/i)
  })

  it('says the request is pending, and that nothing on the page changes, while the connection is up, without member wording', () => {
    const copy = pendingPillCopy('connected')
    expect(copy.detail).toMatch(/pending/i)
    expect(copy.detail).toMatch(/nothing on this page changes/i)
    expect(`${copy.status} ${copy.detail}`).not.toMatch(/member|connected\.|episode/i)
  })

  it('does not call the request pending while this browser is not connected: the coordinator withdraws it then', () => {
    for (const connection of ['reconnecting', 'disconnected'] as const) {
      const copy = pendingPillCopy(connection)
      expect(copy.detail).toBe('This browser is not connected to the room right now. It will ask to join again when the connection is back.')
      expect(copy.detail).not.toMatch(/pending/i)
      expect(`${copy.status} ${copy.detail}`).not.toMatch(/member|episode|waiting for the host/i)
    }
  })
})
