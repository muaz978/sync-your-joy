import type { MediaFingerprint } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'
import { ROOM_TIMELINE_LIMIT, safeCloseReason, timelineStateKey } from './room-timeline.ts'

const media: MediaFingerprint = {
  service: 'youtube',
  canonicalId: 'youtube:abc123',
  title: 'A useful test video',
  durationSeconds: 600,
}

function createPair(clock: { now: number }): RoomCoordinator {
  const room = new RoomCoordinator(
    { roomId: 'room_timeline', code: 'TIMELINE' },
    { id: 'participant_host', name: 'Muaz', media },
    () => clock.now,
  )
  room.join({ id: 'participant_friend', name: 'Rana', media })
  room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
  room.setReady('participant_host', true, media)
  room.setReady('participant_friend', true, media)
  return room
}

function play(room: RoomCoordinator, positionSeconds: number, actionId: string) {
  const snapshot = room.snapshot()
  return room.control('participant_host', {
    actionId,
    basedOnRevision: snapshot.revision,
    leaseEpoch: snapshot.controller.leaseEpoch,
    kind: 'play',
    positionSeconds,
  })
}

describe('safeCloseReason', () => {
  it('keeps a short code of lower-case words and nothing else a client could write', () => {
    expect(safeCloseReason('left_room')).toBe('left_room')
    expect(safeCloseReason('heartbeat-timeout')).toBe('heartbeat-timeout')
    expect(safeCloseReason('Closed by https://example.com/watch?token=abc')).toBe('other')
    expect(safeCloseReason('x'.repeat(200))).toBe('other')
    expect(safeCloseReason('')).toBe('none')
    expect(safeCloseReason(undefined)).toBe('none')
    expect(safeCloseReason(null)).toBe('none')
  })
})

describe('timelineStateKey', () => {
  const base = {
    playbackStatus: 'playing' as const,
    positionSeconds: 10,
    controllerId: 'participant_host',
    operation: null,
    participants: [{ id: 'participant_host', connected: true, ready: true, mediaMatches: true, status: 'playing' as const }],
  }

  it('ignores a playing room\'s position, which moves on its own, but not a paused room\'s', () => {
    expect(timelineStateKey({ ...base, positionSeconds: 99 })).toBe(timelineStateKey(base))
    const paused = { ...base, playbackStatus: 'paused' as const }
    expect(timelineStateKey({ ...paused, positionSeconds: 99 })).not.toBe(timelineStateKey(paused))
    expect(timelineStateKey({ ...paused, positionSeconds: 10.04 })).toBe(timelineStateKey(paused))
  })

  it('tells apart a participant that went away, lost its readiness or reports another status', () => {
    const key = timelineStateKey(base)
    const only = base.participants[0]!
    expect(timelineStateKey({ ...base, participants: [{ ...only, connected: false }] })).not.toBe(key)
    expect(timelineStateKey({ ...base, participants: [{ ...only, ready: false }] })).not.toBe(key)
    expect(timelineStateKey({ ...base, participants: [{ ...only, status: 'buffering' }] })).not.toBe(key)
  })
})

describe('the coordinator\'s timeline', () => {
  it('records what changed, in order, with where the room was and who was in it', () => {
    const clock = { now: 10_000 }
    const room = createPair(clock)
    clock.now = 11_000
    const started = play(room, 12, 'action_timeline_play')
    expect(started.ok).toBe(true)

    const diagnostics = room.roomDiagnostics()
    const last = diagnostics.entries.at(-1)!
    expect(last).toMatchObject({
      kind: 'change',
      event: started.ok ? started.reason : '',
      atServerMs: 11_000,
      playbackStatus: 'playing',
      positionSeconds: 12,
      controllerId: 'participant_host',
    })
    expect(last.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'participant_host', connected: true, ready: true, mediaMatches: true }),
      expect.objectContaining({ id: 'participant_friend', connected: true, ready: true, mediaMatches: true }),
    ]))
    const times = diagnostics.entries.map(entry => entry.atServerMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(diagnostics.coverageStartedAtServerMs).toBe(10_000)
    expect(diagnostics.entriesDropped).toBe(0)
  })

  it('records a refusal with its code even though nothing moved, and not the same change twice', () => {
    const clock = { now: 10_000 }
    const room = new RoomCoordinator(
      { roomId: 'room_refusal', code: 'REFUSAL1' },
      { id: 'participant_host', name: 'Muaz', media },
      () => clock.now,
    )
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
    const refused = play(room, 12, 'action_refused_play')
    expect(refused).toMatchObject({ ok: false, code: 'participants_not_ready' })

    const entries = room.roomDiagnostics().entries
    expect(entries.at(-1)).toMatchObject({ kind: 'refused', event: 'participants_not_ready' })
    expect(entries.at(-1)!.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'participant_friend', ready: false }),
    ]))

    const count = entries.length
    room.setReady('participant_host', true, media)
    room.setReady('participant_host', true, media)
    expect(room.roomDiagnostics().entries.length).toBe(count + 1)
  })

  it('keeps a refusal every time it happens, however alike', () => {
    const clock = { now: 10_000 }
    const room = new RoomCoordinator(
      { roomId: 'room_refusals', code: 'REFUSAL2' },
      { id: 'participant_host', name: 'Muaz', media },
      () => clock.now,
    )
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
    play(room, 12, 'action_refused_a')
    play(room, 12, 'action_refused_b')
    const refusals = room.roomDiagnostics().entries.filter(entry => entry.kind === 'refused')
    expect(refusals).toHaveLength(2)
  })

  it('records a connection event the transport reports, with its detail', () => {
    const clock = { now: 10_000 }
    const room = createPair(clock)
    clock.now = 12_500
    room.recordTransportEvent('participant_friend', 'socket_closed', { code: 1006, reason: 'none', participantStillConnected: false })
    expect(room.roomDiagnostics().entries.at(-1)).toMatchObject({
      kind: 'transport',
      event: 'socket_closed',
      atServerMs: 12_500,
      detail: { participantId: 'participant_friend', code: 1006, reason: 'none', participantStillConnected: false },
    })
  })

  it('shows the coordinator pausing a playing room for a disconnect, after the close that caused it', () => {
    const clock = { now: 10_000 }
    const room = createPair(clock)
    clock.now = 11_000
    play(room, 12, 'action_disconnect_play')
    clock.now = 20_000
    room.recordTransportEvent('participant_friend', 'socket_closed', { code: 1006 })
    const result = room.disconnect('participant_friend')
    expect(result?.ok).toBe(true)

    const tail = room.roomDiagnostics().entries.slice(-2)
    expect(tail.map(entry => entry.kind)).toEqual(['transport', 'change'])
    expect(tail[1]).toMatchObject({ playbackStatus: 'paused' })
    expect(tail[1]!.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'participant_friend', connected: false }),
    ]))
  })

  it('drops the oldest entries past its bound and says how many', () => {
    const clock = { now: 10_000 }
    const room = createPair(clock)
    for (let index = 0; index < ROOM_TIMELINE_LIMIT + 25; index += 1) {
      clock.now += 10
      room.recordTransportEvent(null, 'probe', { index })
    }
    const diagnostics = room.roomDiagnostics()
    expect(diagnostics.entries).toHaveLength(ROOM_TIMELINE_LIMIT)
    expect(diagnostics.entriesDropped).toBeGreaterThanOrEqual(25)
    expect(diagnostics.entries.at(-1)!.detail).toMatchObject({ index: ROOM_TIMELINE_LIMIT + 24 })
  })

  it('hands out a copy: changing the report does not change the timeline', () => {
    const clock = { now: 10_000 }
    const room = createPair(clock)
    const first = room.roomDiagnostics()
    first.entries.length = 0
    first.entries.push({ ...room.roomDiagnostics().entries[0]!, event: 'tampered' })
    expect(room.roomDiagnostics().entries.some(entry => entry.event === 'tampered')).toBe(false)
  })
})
