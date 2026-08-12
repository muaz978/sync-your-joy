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
  it('lets participants gather before the host chooses a video page', () => {
    const room = new RoomCoordinator(
      { roomId: 'room_empty12', code: 'EMPTY123', inviteToken: 'token_empty12' },
      { id: 'participant_host', name: 'Muaz', media: null },
      () => 10_000,
    )
    const joined = room.join({ id: 'participant_friend', name: 'Rana', media: null })

    expect(joined.ok).toBe(true)
    expect(joined.snapshot.media).toBeNull()
    expect(joined.snapshot.participants.every(participant => !participant.ready && !participant.mediaMatches)).toBe(true)

    const opened = room.openLink('participant_host', {
      actionId: 'action_empty_room_link',
      basedOnRevision: joined.snapshot.revision,
      leaseEpoch: joined.snapshot.controller.leaseEpoch,
      url: 'https://video.example/watch/42',
    })
    expect(opened).toMatchObject({ ok: true, snapshot: { navigation: { url: 'https://video.example/watch/42' } } })
  })

  it('requires every connected participant to be ready before play', () => {
    const room = createRoom()
    const joined = room.join({ id: 'participant_friend', name: 'Rana', media })
    expect(joined.ok).toBe(true)
    expect(room.snapshot().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'participant_host', ready: false }),
      expect.objectContaining({ id: 'participant_friend', ready: false }),
    ]))

    const rejected = room.control('participant_host', {
      actionId: 'action_123456',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 12,
    })
    expect(rejected).toMatchObject({ ok: false, code: 'participants_not_ready' })

    room.setReady('participant_friend', true, media)
    const stillRejected = room.control('participant_host', {
      actionId: 'action_host_not_ready',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 12,
    })
    expect(stillRejected).toMatchObject({ ok: false, code: 'participants_not_ready' })

    room.setReady('participant_host', true, media)
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

  it('accepts rapid ordered controls based on an older revision from the current lease', () => {
    const room = createRoom()
    room.setReady('participant_host', true, media)
    const basedOnRevision = room.snapshot().revision
    const leaseEpoch = room.snapshot().controller.leaseEpoch

    const play = room.control('participant_host', {
      actionId: 'action_rapid_play', basedOnRevision, leaseEpoch, kind: 'play', positionSeconds: 10,
    })
    const seek = room.control('participant_host', {
      actionId: 'action_rapid_seek', basedOnRevision, leaseEpoch, kind: 'seek', positionSeconds: 120,
    })
    const pause = room.control('participant_host', {
      actionId: 'action_rapid_pause', basedOnRevision, leaseEpoch, kind: 'pause', positionSeconds: 120,
    })

    expect(play.ok).toBe(true)
    expect(seek).toMatchObject({ ok: true, snapshot: { playback: { positionSeconds: 120 } } })
    expect(pause).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused', positionSeconds: 120 } } })
  })

  it('rejects a delayed control after a readiness or membership barrier', () => {
    const room = createRoom()
    const obsoleteRevision = room.snapshot().revision
    room.join({ id: 'participant_friend', name: 'Rana', media })

    const delayed = room.control('participant_host', {
      actionId: 'action_delayed_seek',
      basedOnRevision: obsoleteRevision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 400,
    })
    expect(delayed).toMatchObject({ ok: false, code: 'stale_context' })
  })

  it('pauses when readiness or membership changes during playback', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_membership',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })

    nowMs = 12_000
    const joined = room.join({ id: 'participant_friend', name: 'Rana', media })
    expect(joined).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })

    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_replay_membership',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 22,
    })
    const unready = room.setReady('participant_friend', false, media)
    expect(unready).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })
  })

  it('pauses when any participant disconnects during playback', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_play_disconnect',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 30,
    })

    const disconnected = room.disconnect('participant_friend')
    expect(disconnected).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })
  })

  it('ignores buffering reports from participants who are not ready', () => {
    const room = createRoom()
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_buffer_guard',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_play_buffer_guard_again',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    room.setReady('participant_friend', false, media)

    const result = room.updatePlayerStatus('participant_friend', {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: false,
      buffering: true,
      sampledAtLocalMs: 10_000,
    })
    expect(result).toBeNull()
  })

  it('lets only the controller schedule a safe shared link and resets readiness', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)

    const rejected = room.openLink('participant_friend', {
      actionId: 'action_member_link',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      url: 'https://video.example/watch/42',
    })
    expect(rejected).toMatchObject({ ok: false, code: 'controller_only' })

    const opened = room.openLink('participant_host', {
      actionId: 'action_host_link',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      url: 'https://video.example/watch/42#player',
    })
    expect(opened).toMatchObject({
      ok: true,
      snapshot: {
        playback: { status: 'paused' },
        navigation: { url: 'https://video.example/watch/42' },
      },
    })
    expect(opened.snapshot.participants.every(participant => !participant.ready && !participant.mediaMatches)).toBe(true)
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
    room.setReady('participant_host', true, media)
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
    room.setReady('participant_host', true, media)
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
