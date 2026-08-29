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

  it('does not advance the room revision for an unchanged readiness heartbeat', () => {
    const room = createRoom()
    const initialRevision = room.snapshot().revision

    const unchangedNotReady = room.setReady('participant_host', false, media)
    expect(unchangedNotReady).toMatchObject({ ok: true, reason: 'readiness_unchanged' })
    expect(unchangedNotReady.snapshot.revision).toBe(initialRevision)

    const ready = room.setReady('participant_host', true, media)
    const readyRevision = ready.snapshot.revision
    const unchangedReady = room.setReady('participant_host', true, media)
    expect(unchangedReady).toMatchObject({ ok: true, reason: 'readiness_unchanged' })
    expect(unchangedReady.snapshot.revision).toBe(readyRevision)
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

  it('holds a playing seek until every ready participant confirms completion', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_play_before_barrier',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const sought = room.control('participant_host', {
      actionId: 'action_seek_with_barrier',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 120,
      controllerSeekApplied: true,
    })

    expect(sought).toMatchObject({
      ok: true,
      snapshot: {
        playback: { status: 'paused', positionSeconds: 120 },
        seek: { positionSeconds: 120, resumeWhenReady: true, acknowledgedParticipantIds: ['participant_host'] },
      },
    })
    const seekRevision = sought.snapshot.revision
    nowMs = 11_000
    const allAligned = room.acknowledgeSeek('participant_friend', seekRevision, 119.9)
    expect(allAligned).toMatchObject({
      ok: true,
      reason: 'seek_aligned_play_scheduled',
      snapshot: { playback: { status: 'playing', positionSeconds: 120 }, seek: null },
    })
    expect(allAligned?.snapshot.playback.effectiveAtServerMs).toBeGreaterThan(nowMs)
  })

  it('uses the latest target when seeks overlap and ignores obsolete acknowledgements', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_play_before_overlap', basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch, kind: 'play', positionSeconds: 10,
    })
    const first = room.control('participant_host', {
      actionId: 'action_first_overlap', basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch, kind: 'seek', positionSeconds: 60,
    })
    room.acknowledgeSeek('participant_host', first.snapshot.revision, 60)
    const second = room.control('participant_host', {
      actionId: 'action_second_overlap', basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch, kind: 'seek', positionSeconds: 180,
    })

    expect(second.snapshot.seek).toMatchObject({ positionSeconds: 180, resumeWhenReady: true, acknowledgedParticipantIds: [] })
    expect(room.acknowledgeSeek('participant_friend', first.snapshot.revision, 60)).toBeNull()
    expect(room.snapshot().seek?.acknowledgedParticipantIds).toEqual([])
    room.acknowledgeSeek('participant_host', second.snapshot.revision, 180)
    const completed = room.acknowledgeSeek('participant_friend', second.snapshot.revision, 180)
    expect(completed).toMatchObject({ snapshot: { playback: { status: 'playing', positionSeconds: 180 }, seek: null } })
  })

  it('keeps an originally paused room paused after everyone applies a seek', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    const sought = room.control('participant_host', {
      actionId: 'action_paused_seek', basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch, kind: 'seek', positionSeconds: 42,
    })
    room.acknowledgeSeek('participant_host', sought.snapshot.revision, 42)
    const completed = room.acknowledgeSeek('participant_friend', sought.snapshot.revision, 42)

    expect(completed).toMatchObject({
      reason: 'seek_aligned_paused',
      snapshot: { playback: { status: 'paused', positionSeconds: 42 }, seek: null },
    })
  })

  it('keeps a fixed paused target when a provider never acknowledges a seek', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_play_before_timeout', basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch, kind: 'play', positionSeconds: 10,
    })
    const sought = room.control('participant_host', {
      actionId: 'action_seek_timeout', basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch, kind: 'seek', positionSeconds: 90,
    })
    room.acknowledgeSeek('participant_host', sought.snapshot.revision, 90)

    expect(room.releaseExpiredSeek(sought.snapshot.seek!.deadlineAtServerMs - 1)).toBeNull()
    nowMs = sought.snapshot.seek!.deadlineAtServerMs
    const released = room.releaseExpiredSeek()

    expect(released).toMatchObject({
      ok: true,
      reason: 'seek_timeout_paused',
      snapshot: { seek: null, playback: { status: 'paused', positionSeconds: 90 } },
    })
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

  it('restores readiness after a brief reconnect with the same matching media', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_friend', true, media)

    const disconnected = room.disconnect('participant_friend')
    expect(disconnected).toMatchObject({
      ok: true,
      snapshot: { participants: expect.arrayContaining([
        expect.objectContaining({ id: 'participant_friend', connected: false, ready: true }),
      ]) },
    })

    const reconnected = room.join({ id: 'participant_friend', name: 'Rana', media })
    expect(reconnected).toMatchObject({
      ok: true,
      snapshot: { participants: expect.arrayContaining([
        expect.objectContaining({ id: 'participant_friend', connected: true, ready: true, mediaMatches: true }),
      ]) },
    })
  })

  it('does not restore readiness when a participant reconnects on different media', () => {
    const room = createRoom()
    room.join({ id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_friend', true, media)
    room.disconnect('participant_friend')

    const reconnected = room.join({
      id: 'participant_friend',
      name: 'Rana',
      media: { ...media, canonicalId: 'youtube:different' },
    })
    expect(reconnected).toMatchObject({
      ok: true,
      snapshot: { participants: expect.arrayContaining([
        expect.objectContaining({ id: 'participant_friend', connected: true, ready: false, mediaMatches: false }),
      ]) },
    })
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

    const result = room.updatePlayerStatus('participant_friend', room.snapshot().revision, {
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
    nowMs = 13_000
    const sample: PlayerSample = {
      positionSeconds: 21.8,
      durationSeconds: 600,
      paused: false,
      buffering: true,
      sampledAtLocalMs: nowMs,
    }
    const result = room.updatePlayerStatus('participant_host', room.snapshot().revision, sample)

    expect(result?.snapshot.playback.status).toBe('paused')
    expect(result?.snapshot.playback.positionSeconds).toBeGreaterThan(21)
  })

  it('ignores a stale buffering report that arrives after a newer play command', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    const staleRevision = room.snapshot().revision
    room.control('participant_host', {
      actionId: 'action_play_after_stale_status',
      basedOnRevision: staleRevision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    nowMs = 20_000

    const result = room.updatePlayerStatus('participant_host', staleRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: true,
      buffering: true,
      sampledAtLocalMs: 9_999,
    })

    expect(result).toBeNull()
    expect(room.snapshot().playback.status).toBe('playing')
  })

  it('ignores transient buffering during the synchronized playback startup window', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_with_startup_buffer',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const playRevision = room.snapshot().revision
    nowMs = room.snapshot().playback.effectiveAtServerMs + 1_000

    const result = room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: false,
      buffering: true,
      sampledAtLocalMs: nowMs,
    })

    expect(result).toBeNull()
    expect(room.snapshot().playback.status).toBe('playing')
  })

  it('does not stop the room clock for a transient paused report', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_blocked',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const playRevision = room.snapshot().revision
    nowMs = room.snapshot().playback.effectiveAtServerMs + 500

    const result = room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: true,
      buffering: false,
      sampledAtLocalMs: nowMs,
    })

    expect(result).toBeNull()
    expect(room.snapshot().playback.status).toBe('playing')
  })

  it('does not treat a player that never started as a buffering failure without explicit rejection', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_waiting_for_gesture',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const playRevision = room.snapshot().revision
    nowMs = room.snapshot().playback.effectiveAtServerMs + 4_000
    expect(room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: true,
      buffering: true,
      sampledAtLocalMs: nowMs,
      playbackStarted: false,
    })).toBeNull()
  })

  it('stops the room clock when the browser explicitly rejects synchronized play', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_blocked_explicit',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const playRevision = room.snapshot().revision
    nowMs += 100
    const result = room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: true,
      buffering: false,
      sampledAtLocalMs: nowMs,
      playbackStartFailed: true,
    })

    expect(result).toMatchObject({
      ok: true,
      reason: 'participant_playback_blocked',
      snapshot: { playback: { status: 'paused', positionSeconds: 20 } },
    })
  })

  it('stops the room clock when a ready participant reports no real progress', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_frozen',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const playRevision = room.snapshot().revision
    const startedAtMs = room.snapshot().playback.effectiveAtServerMs
    nowMs = startedAtMs + 900
    expect(room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: nowMs,
    })).toBeNull()

    nowMs = startedAtMs + 1_800
    const result = room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: nowMs,
    })

    expect(result).toMatchObject({
      ok: true,
      reason: 'participant_playback_stalled',
      snapshot: { playback: { status: 'paused', positionSeconds: 20 } },
    })
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
