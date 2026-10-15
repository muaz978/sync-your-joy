import type { ParticipantPlaybackStatus, RoomSnapshot } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'
import { describe, expect, it } from 'vitest'
import { formatPillTime, pillView, roomlessNoticeView, type PillViewInput } from './pill-view.ts'
import { AWAITING_APPROVAL_PILL } from './room-membership.ts'

const media = { service: 'youtube', canonicalId: 'youtube:abc', title: 'A title', durationSeconds: 600 }

function room() {
  const coordinator = new RoomCoordinator(
    { roomId: 'room_pill', code: 'ABCDEFGH' },
    { id: 'participant_host', name: 'Muaz', media },
    () => 10_000,
  )
  coordinator.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })
  return coordinator
}

// What each participant is sent, from the real coordinator.
function pendingSnapshot(): RoomSnapshot {
  return room().pendingSnapshot('participant_friend')
}
function leakedFullSnapshot(): RoomSnapshot {
  return room().snapshot()
}
function memberSnapshot(): RoomSnapshot {
  const coordinator = room()
  coordinator.respondToJoin('participant_host', coordinator.snapshot().controller.leaseEpoch, 'participant_friend', true)
  return coordinator.snapshot()
}

function input(overrides: Partial<PillViewInput['state']> & { hasVideo?: boolean, localStatus?: ParticipantPlaybackStatus } = {}): PillViewInput {
  const { hasVideo = true, localStatus = 'ready', ...state } = overrides
  return {
    state: {
      connection: 'connected',
      participantId: 'participant_friend',
      lastError: null,
      snapshot: memberSnapshot(),
      ...state,
    },
    hasVideo,
    localStatus,
  }
}

describe('the on-page pill for a pending join request', () => {
  it('says it is waiting for the host, hides the playback button and disables Sync', () => {
    const view = pillView(input({ snapshot: pendingSnapshot() }))
    expect(view.status).toBe(AWAITING_APPROVAL_PILL.status)
    expect(view.meta).toBe(AWAITING_APPROVAL_PILL.detail)
    expect(view.playbackHidden).toBe(true)
    expect(view.syncDisabled).toBe(true)
  })

  it('does not use member wording or the room\'s state, whatever the local player is doing', () => {
    for (const localStatus of ['preparing', 'ready', 'playing', 'wrong-media', 'blocked'] as const) {
      const view = pillView(input({ snapshot: pendingSnapshot(), localStatus, hasVideo: true }))
      expect(`${view.status} ${view.meta}`).not.toMatch(/member|controller|connected\.|episode|ready|playing/i)
      expect(view.playbackHidden).toBe(true)
      expect(view.syncDisabled).toBe(true)
    }
  })

  it('treats the full room an older coordinator leaks to a requester the same way', () => {
    const leaked = leakedFullSnapshot()
    expect(leaked.pendingJoinRequests.map(request => request.id)).toEqual(['participant_friend'])
    const view = pillView(input({ snapshot: leaked }))
    expect(view.status).toBe(AWAITING_APPROVAL_PILL.status)
    expect(view.playbackHidden).toBe(true)
    expect(view.syncDisabled).toBe(true)
  })

  it('shows the connection, not the host, when the requester\'s own connection is down', () => {
    const reconnecting = pillView(input({ snapshot: pendingSnapshot(), connection: 'reconnecting' }))
    expect(reconnecting.status).toBe('Reconnecting')
    // The coordinator withdrew the request when this socket closed, and the
    // browser asks again when it is back: it is not pending in the meantime.
    expect(reconnecting.meta).not.toMatch(/pending/i)
    expect(reconnecting.meta).toMatch(/not connected/i)
    expect(reconnecting.meta).toMatch(/ask to join again/i)
    expect(reconnecting.playbackHidden).toBe(true)
    expect(reconnecting.syncDisabled).toBe(true)

    const disconnected = pillView(input({ snapshot: pendingSnapshot(), connection: 'disconnected' }))
    expect(disconnected.status).toBe('Connection unclear')
    expect(disconnected.status).not.toMatch(/waiting for the host/i)
    expect(disconnected.playbackHidden).toBe(true)
  })

  it('carries the last error as the notice, and no notice when there is none', () => {
    expect(pillView(input({ snapshot: pendingSnapshot(), lastError: 'Could not reach the room.' })).notice).toBe('Could not reach the room.')
    expect(pillView(input({ snapshot: pendingSnapshot() })).notice).toBeNull()
  })
})

describe('the on-page pill for a member', () => {
  it('shows the local playback status and member wording, and no playback button, for an approved member', () => {
    const view = pillView(input({ localStatus: 'ready' }))
    expect(view.status).toBe('Ready, not playing')
    expect(view.meta).toBe('The player is ready but has not confirmed native progress. Member, 2 connected.')
    expect(view.playbackHidden).toBe(true)
    expect(view.syncDisabled).toBe(false)
    expect(view.notice).toBeNull()
  })

  it('is unchanged by a stale pending entry once the participant is a member', () => {
    const snapshot = memberSnapshot()
    snapshot.pendingJoinRequests = [{ id: 'participant_friend', name: 'Rana', requestedAtMs: 1 }]
    const view = pillView(input({ snapshot }))
    expect(view.status).toBe('Ready, not playing')
    expect(view.meta).toMatch(/Member, 2 connected\.$/)
  })

  it('shows the controller its playback button, with Play disabled until everyone is ready', () => {
    const snapshot = memberSnapshot()
    const view = pillView(input({ snapshot, participantId: 'participant_host' }))
    expect(view.meta).toMatch(/Controller, 2 connected\.$/)
    expect(view.playbackHidden).toBe(false)
    expect(view.playbackLabel).toBe('Play')
    // Nobody has reported ready or a matching player yet.
    expect(view.playbackDisabled).toBe(true)

    snapshot.participants = snapshot.participants.map(participant => ({ ...participant, ready: true, mediaMatches: true }))
    const ready = pillView(input({ snapshot, participantId: 'participant_host' }))
    expect(ready.playbackDisabled).toBe(false)
  })

  it('offers Pause while the room is playing and hides the button when there is no player', () => {
    const snapshot = memberSnapshot()
    snapshot.playback = { ...snapshot.playback, status: 'playing' }
    expect(pillView(input({ snapshot, participantId: 'participant_host' })).playbackLabel).toBe('Pause')
    const noPlayer = pillView(input({ snapshot, participantId: 'participant_host', hasVideo: false }))
    expect(noPlayer.playbackHidden).toBe(true)
    expect(noPlayer.syncDisabled).toBe(true)
  })

  it('reports reconnecting before anything else', () => {
    expect(pillView(input({ connection: 'reconnecting' })).status).toBe('Reconnecting')
  })

  describe('while the room aligns on a seek', () => {
    // Everyone is ready with the right media and the room is playing, so the
    // only thing that can lock the controller's playback button is the seek.
    const alignedRoom = (seek: RoomSnapshot['seek']) => {
      const snapshot = memberSnapshot()
      snapshot.participants = snapshot.participants.map(participant => ({ ...participant, ready: true, mediaMatches: true }))
      snapshot.playback = { ...snapshot.playback, status: 'playing' }
      snapshot.seek = seek
      return snapshot
    }
    const seeking = {
      revision: 2, positionSeconds: 65, requestedByParticipantId: 'participant_host',
      acknowledgedParticipantIds: ['participant_host'], deadlineAtServerMs: 0,
    } as unknown as RoomSnapshot['seek']

    it('reports seek progress and locks the playback button', () => {
      const view = pillView(input({ snapshot: alignedRoom(seeking), participantId: 'participant_host' }))
      expect(view.status).toBe('Seeking 1/2')
      expect(view.meta).toBe('Moving everyone to 1:05')
      expect(view.playbackLabel).toBe('Aligning')
      expect(view.playbackDisabled).toBe(true)
    })

    it('leaves the playback button available once there is no seek', () => {
      const view = pillView(input({ snapshot: alignedRoom(null), participantId: 'participant_host' }))
      expect(view.playbackLabel).toBe('Pause')
      expect(view.playbackDisabled).toBe(false)
    })
  })

  it('disables Sync for a different episode', () => {
    expect(pillView(input({ localStatus: 'wrong-media' })).syncDisabled).toBe(true)
  })
})

describe('a room without pending requests listed', () => {
  it('does not throw for a null or missing pendingJoinRequests and shows a member as a member', () => {
    for (const pendingJoinRequests of [null, undefined]) {
      const snapshot = memberSnapshot() as unknown as Record<string, unknown>
      if (pendingJoinRequests === undefined)
        delete snapshot.pendingJoinRequests
      else
        snapshot.pendingJoinRequests = pendingJoinRequests
      const view = pillView(input({ snapshot: snapshot as unknown as RoomSnapshot }))
      expect(view.status).toBe('Ready, not playing')
      expect(view.meta).toMatch(/Member/)
    }
  })

  it('does not throw for a requester\'s placeholder whose pending list is null', () => {
    const snapshot = pendingSnapshot() as unknown as Record<string, unknown>
    snapshot.pendingJoinRequests = null
    expect(() => pillView(input({ snapshot: snapshot as unknown as RoomSnapshot }))).not.toThrow()
  })
})

describe('the notice about a room that has ended', () => {
  it('names the product and carries the message, with nothing else to act on', () => {
    expect(roomlessNoticeView('This room has expired.')).toEqual({ status: 'SyncYourJoy', meta: 'This room has expired.' })
  })
})

describe('formatPillTime', () => {
  it('formats whole minutes and zero-padded seconds', () => {
    expect(formatPillTime(0)).toBe('0:00')
    expect(formatPillTime(65.9)).toBe('1:05')
    expect(formatPillTime(-3)).toBe('0:00')
  })
})
