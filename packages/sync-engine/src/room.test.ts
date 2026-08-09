import type { MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'

const media: MediaFingerprint = {
  service: 'youtube',
  canonicalId: 'youtube:abc123',
  title: 'A useful test video',
  durationSeconds: 600,
}

function createRoom(now: () => number = () => 10_000): RoomCoordinator {
  return new RoomCoordinator(
    { roomId: 'room_123456', code: 'ABCDEFGH', inviteToken: 'token_123456' },
    { id: 'participant_host', name: 'Muaz', media },
    now,
  )
}

describe('RoomCoordinator', () => {
  it('requires every connected participant to be ready before play', () => {
    const room = createRoom()
    const joined = room.join({ id: 'participant_friend', name: 'Rana', media })
    expect(joined.ok).toBe(true)

    const rejected = room.control('participant_host', {
      actionId: 'action_123456',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 12,
    })
    expect(rejected).toMatchObject({ ok: false, code: 'participants_not_ready' })

    room.setReady('participant_friend', true, media)
    const accepted = room.control('participant_host', {
      actionId: 'action_234567',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 12,
    })
    expect(accepted.ok).toBe(true)
    expect(accepted.snapshot.playback).toMatchObject({ status: 'playing', positionSeconds: 12 })
    expect(accepted.snapshot.playback.effectiveAtServerMs).toBeGreaterThan(10_000)
  })

  it('orders actions and applies duplicate action IDs at most once', () => {
    const room = createRoom()
    const intent = {
      actionId: 'action_unique1',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'pause' as const,
      positionSeconds: 30,
    }
    const first = room.control('participant_host', intent)
    const revision = first.snapshot.revision
    const duplicate = room.control('participant_host', intent)

    expect(first.ok).toBe(true)
    expect(duplicate).toMatchObject({ ok: true, reason: 'duplicate_action' })
    expect(duplicate.snapshot.revision).toBe(revision)
  })

  it('rejects member controls and stale controller leases', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })

    const memberResult = room.control('participant_friend', {
      actionId: 'action_member1',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'pause',
      positionSeconds: 4,
    })
    expect(memberResult).toMatchObject({ ok: false, code: 'controller_only' })

    room.transferControl('participant_host', 'participant_friend', room.snapshot().controller.leaseEpoch)
    const stale = room.control('participant_host', {
      actionId: 'action_stale12',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: 1,
      kind: 'pause',
      positionSeconds: 4,
    })
    expect(stale).toMatchObject({ ok: false, code: 'controller_only' })
  })

  it('blocks readiness when media does not match', () => {
    const room = createRoom()
    const otherMedia = { ...media, canonicalId: 'youtube:different' }
    room.join({ id: 'participant_friend', name: 'Rana', media: otherMedia })
    const result = room.setReady('participant_friend', true, otherMedia)
    const friend = result.snapshot.participants.find(participant => participant.id === 'participant_friend')

    expect(friend).toMatchObject({ ready: false, mediaMatches: false })
  })

  it('pauses the room when a connected participant buffers', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.control('participant_host', {
      actionId: 'action_play123',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    nowMs = 12_000
    const sample: PlayerSample = {
      positionSeconds: 21.8,
      durationSeconds: 600,
      paused: false,
      buffering: true,
      sampledAtLocalMs: nowMs,
    }
    const result = room.updatePlayerStatus('participant_host', sample)

    expect(result?.snapshot.playback.status).toBe('paused')
    expect(result?.snapshot.playback.positionSeconds).toBeGreaterThan(21)
  })

  it('restores the authoritative state after hibernation', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_before_sleep',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 90,
    })

    const restored = RoomCoordinator.fromState(room.exportState())
    expect(restored.snapshot()).toEqual(room.snapshot())

    const paused = restored.control('participant_host', {
      actionId: 'action_after_sleep',
      basedOnRevision: restored.snapshot().revision,
      leaseEpoch: restored.snapshot().controller.leaseEpoch,
      kind: 'pause',
      positionSeconds: 91,
    })
    expect(paused).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })
  })
})
