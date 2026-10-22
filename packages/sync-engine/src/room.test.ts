import type { MediaFingerprint, OperationAcknowledgement, PlayerSample } from '@syncyourjoy/protocol'
import { CURRENT_CLIENT_CAPABILITIES, mediaMatches } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'
import type { RoomResult } from './room.ts'
import { PLAYBACK_PROGRESS_TIMEOUT_MS, PLAYBACK_STARTUP_GRACE_MS, playbackStartupDeadlineMs } from './playback-health.ts'

const media: MediaFingerprint = {
  service: 'youtube',
  canonicalId: 'youtube:abc123',
  title: 'A useful test video',
  durationSeconds: 600,
}

const crunchyMedia: MediaFingerprint = {
  service: 'crunchyroll',
  canonicalId: 'crunchyroll:GE00345558JAJP',
  title: 'Episode 12',
  durationSeconds: 1_470,
  pageUrl: 'https://www.crunchyroll.com/ar/watch/GE00345558JAJP/titre-localise',
}

function createRoomWithMedia(roomMedia: MediaFingerprint, now: () => number = () => 10_000): RoomCoordinator {
  return new RoomCoordinator(
    { roomId: 'room_123456', code: 'ABCDEFGH' },
    { id: 'participant_host', name: 'Muaz', media: roomMedia },
    now,
  )
}

function createRoom(now: () => number = () => 10_000): RoomCoordinator {
  return createRoomWithMedia(media, now)
}

/**
 * Host-approval join (docs/CODE_AUDIT.md SYJ-AUD-003) means a brand-new
 * participant identity no longer becomes a real member the moment it calls
 * join() -- it lands in `pendingJoinRequests` until the controller approves
 * it. Most existing scenarios in this file only care about exercising room
 * behavior *after* someone has become a genuine participant, so this helper
 * performs both steps (join, then the controller's approval) and returns
 * the final RoomResult, exactly as if a brand-new participant had been
 * admitted in one step under the pre-approval design.
 */
function joinApproved(room: RoomCoordinator, participant: { id: string; name: string; media: MediaFingerprint | null }): RoomResult {
  room.join(participant)
  const snapshot = room.snapshot()
  return room.respondToJoin(snapshot.controller.participantId, snapshot.controller.leaseEpoch, participant.id, true)
}

function createTransactionalRoom(now: () => number): RoomCoordinator {
  const room = new RoomCoordinator(
    { roomId: 'transactional_room', code: 'TRANS123' },
    { id: 'participant_host', name: 'Muaz', media, capabilities: CURRENT_CLIENT_CAPABILITIES },
    now,
  )
  room.join({ id: 'participant_friend', name: 'Rana', media, capabilities: CURRENT_CLIENT_CAPABILITIES })
  room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
  room.setReady('participant_host', true, media)
  room.setReady('participant_friend', true, media)
  return room
}

function operationAcknowledgement(room: RoomCoordinator, participantId: string, phase: OperationAcknowledgement['phase'], positionSeconds: number, sampleSequence: number): OperationAcknowledgement {
  const operation = room.snapshot().contract?.operation
  if (!operation)
    throw new Error('Expected an active transactional operation.')
  return {
    mediaEpoch: operation.mediaEpoch,
    operationId: operation.operationId,
    phase,
    participantId,
    bindingId: `binding_${participantId}`,
    sourceGeneration: 1,
    sampleSequence,
    observedPositionSeconds: positionSeconds,
    observedAtLocalMs: 10_000 + sampleSequence,
  }
}

function controlTransactional(room: RoomCoordinator, kind: 'play' | 'pause' | 'seek', positionSeconds: number): RoomResult {
  const snapshot = room.snapshot()
  return room.control('participant_host', {
    actionId: `transactional_${kind}_${snapshot.revision}`,
    basedOnRevision: snapshot.revision,
    leaseEpoch: snapshot.controller.leaseEpoch,
    kind,
    positionSeconds,
  })
}

describe('RoomCoordinator', () => {
  it('lets participants gather before the host chooses a video page', () => {
    const room = new RoomCoordinator(
      { roomId: 'room_empty12', code: 'EMPTY123' },
      { id: 'participant_host', name: 'Muaz', media: null },
      () => 10_000,
    )
    const joined = room.join({ id: 'participant_friend', name: 'Rana', media: null })
    expect(joined).toMatchObject({ ok: true, reason: 'join_pending' })
    expect(joined.snapshot.media).toBeNull()
    expect(joined.snapshot.participants).toHaveLength(1)
    expect(joined.snapshot.pendingJoinRequests).toEqual([
      { id: 'participant_friend', name: 'Rana', requestedAtMs: expect.any(Number) },
    ])

    const approved = room.respondToJoin('participant_host', joined.snapshot.controller.leaseEpoch, 'participant_friend', true)
    expect(approved.snapshot.participants.every(participant => !participant.ready && !participant.mediaMatches)).toBe(true)

    const opened = room.openLink('participant_host', {
      actionId: 'action_empty_room_link',
      basedOnRevision: approved.snapshot.revision,
      leaseEpoch: approved.snapshot.controller.leaseEpoch,
      url: 'https://video.example/watch/42',
    })
    expect(opened).toMatchObject({ ok: true, snapshot: { navigation: { url: 'https://video.example/watch/42' } } })
  })

  it('requires every connected participant to be ready before play', () => {
    const room = createRoom()
    const joined = joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    })

    expect(sought).toMatchObject({
      ok: true,
      snapshot: {
        playback: { status: 'paused', positionSeconds: 120 },
        seek: { positionSeconds: 120, resumeWhenReady: true, acknowledgedParticipantIds: [] },
      },
    })
    const seekRevision = sought.snapshot.revision
    nowMs = 11_000
    room.acknowledgeSeek('participant_host', seekRevision, 120)
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    // A brand-new join request is merely pending until approved, so it must
    // not disrupt playback by itself -- only the controller's approval,
    // which actually admits a new member into the readiness set, does.
    const pending = room.join({ id: 'participant_friend', name: 'Rana', media })
    expect(pending).toMatchObject({ ok: true, reason: 'join_pending', snapshot: { playback: { status: 'playing' } } })
    const approved = room.respondToJoin('participant_host', pending.snapshot.controller.leaseEpoch, 'participant_friend', true)
    expect(approved).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })

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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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

  it('rejects a duplicate participant identity without the reconnect session token', () => {
    const secured = new RoomCoordinator(
      { roomId: 'room_secured1', code: 'SECURE12' },
      { id: 'participant_host', name: 'Muaz', media, sessionToken: 'host-session-token-123456' },
    )
    const rejected = secured.join({ id: 'participant_host', name: 'Impostor', media, sessionToken: 'wrong-session-token-123456' })
    expect(rejected).toMatchObject({ ok: false, code: 'session_invalid' })
    const accepted = secured.join({ id: 'participant_host', name: 'Muaz', media, sessionToken: 'host-session-token-123456' })
    expect(accepted).toMatchObject({ ok: true, reason: 'participant_reconnected' })
  })

  it('rejects impersonation of a participant whose record was never assigned a session token', () => {
    const room = createRoom()
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })

    const hijacked = room.join({ id: 'participant_friend', name: 'Attacker', media, sessionToken: 'attacker-chosen-token' })
    expect(hijacked).toMatchObject({ ok: false, code: 'session_invalid' })

    const reconnected = room.join({ id: 'participant_friend', name: 'Rana', media })
    expect(reconnected).toMatchObject({ ok: true, reason: 'participant_reconnected' })
  })

  it('does not restore readiness when a participant reconnects on different media', () => {
    const room = createRoom()
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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

  it('does not restart the room for the same Crunchyroll episode on a localized link', () => {
    const room = createRoomWithMedia(crunchyMedia)
    room.setReady('participant_host', true, crunchyMedia)
    const before = room.snapshot()

    const opened = room.openLink('participant_host', {
      actionId: 'action_same_episode_localized',
      basedOnRevision: before.revision,
      leaseEpoch: before.controller.leaseEpoch,
      url: 'https://crunchyroll.com/watch/GE00345558JAJP/original-title',
    })

    expect(opened).toMatchObject({ ok: true, reason: 'navigation_unchanged' })
    expect(opened.snapshot.revision).toBe(before.revision)
    expect(opened.snapshot.contract?.mediaEpoch).toBe(before.contract?.mediaEpoch)
    expect(opened.snapshot.media).toEqual(before.media)
    expect(opened.snapshot.participants).toEqual(before.participants)
  })

  it('cancels old work and requires fresh readiness for a new shared link', () => {
    const room = createTransactionalRoom(() => 10_000)
    const started = controlTransactional(room, 'play', 30)
    expect(started.snapshot.contract?.operation?.phase).toBe('preparing')

    const opened = room.openLink('participant_host', {
      actionId: 'action_new_episode_transaction',
      basedOnRevision: started.snapshot.revision,
      leaseEpoch: started.snapshot.controller.leaseEpoch,
      url: 'https://video.example/watch/next-episode',
    })

    expect(opened).toMatchObject({
      ok: true,
      reason: 'link_opened',
      snapshot: {
        playback: { status: 'paused', positionSeconds: 0 },
        contract: { mediaEpoch: 1, operation: null },
      },
    })
    expect(opened.snapshot.participants.every(participant => !participant.ready && !participant.mediaMatches && participant.playbackStatus === 'wrong-media')).toBe(true)
  })

  it('starts a freshly shared link at position zero instead of carrying over the previous video\'s position', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_play_previous_episode',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 1_200,
    })

    // The previous episode plays for a while before the host switches to a
    // new one -- long enough that, without the fix, expectedPosition() would
    // extrapolate well past where a brand-new video should ever start.
    nowMs += 60_000

    const opened = room.openLink('participant_host', {
      actionId: 'action_next_episode_link',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      url: 'https://video.example/watch/next-episode',
    })
    expect(opened).toMatchObject({
      ok: true,
      snapshot: { playback: { status: 'paused', positionSeconds: 0 } },
    })
  })

  it('rejects member controls and stale controller leases', () => {
    const room = createRoom()
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })

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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media: otherMedia })
    const result = room.setReady('participant_friend', true, otherMedia)
    const friend = result.snapshot.participants.find(participant => participant.id === 'participant_friend')

    expect(friend).toMatchObject({ ready: false, mediaMatches: false })
  })

  describe('a participant that buffers while the room plays (#141)', () => {
    function playingRoom(withFriend = false) {
      let nowMs = 10_000
      const room = createRoom(() => nowMs)
      room.setReady('participant_host', true, media)
      if (withFriend) {
        joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
        room.setReady('participant_friend', true, media)
      }
      room.control('participant_host', {
        actionId: 'action_play123',
        basedOnRevision: room.snapshot().revision,
        leaseEpoch: room.snapshot().controller.leaseEpoch,
        kind: 'play',
        positionSeconds: 20,
      })
      nowMs = 13_000
      const report = (buffering: boolean) => room.updatePlayerStatus('participant_host', room.snapshot().revision, {
        positionSeconds: 21.8,
        durationSeconds: 600,
        paused: false,
        buffering,
        progressed: !buffering,
        sampledAtLocalMs: nowMs,
      })
      return { room, report, at: (ms: number) => { nowMs = ms } }
    }

    it('keeps the room playing through a short rebuffer', () => {
      const { room, report, at } = playingRoom()
      report(true)
      at(14_000)
      report(true)
      at(14_900)
      const recovered = report(false)

      expect(room.snapshot().playback.status).toBe('playing')
      expect(recovered).not.toMatchObject({ reason: 'participant_buffering' })
    })

    it('pauses the room once the same participant has buffered continuously past the grace period', () => {
      const { room, report, at } = playingRoom()
      report(true)
      at(14_000)
      report(true)
      at(15_000)
      report(true)
      at(15_500)
      report(true)
      at(15_900)
      report(true)
      expect(room.snapshot().playback.status).toBe('playing')

      at(16_000)
      const result = report(true)

      expect(result).toMatchObject({ ok: true, reason: 'participant_buffering' })
      expect(room.snapshot().playback.status).toBe('paused')
      expect(room.snapshot().playback.positionSeconds).toBeGreaterThan(21)
    })

    it('starts the grace period again after the participant recovered in between', () => {
      const { room, report, at } = playingRoom()
      report(true)
      at(14_000)
      report(false)
      at(15_000)
      report(true)
      at(17_500)
      report(true)
      expect(room.snapshot().playback.status).toBe('playing')

      at(18_100)
      const result = report(true)
      expect(result).toMatchObject({ ok: true, reason: 'participant_buffering' })
    })

    it('lets a recovery report end the run even when it carries the same timestamp as the last report', () => {
      const { room, at } = playingRoom()
      const send = (buffering: boolean, sampledAtLocalMs: number) => room.updatePlayerStatus('participant_host', room.snapshot().revision, {
        positionSeconds: 21.8,
        durationSeconds: 600,
        paused: false,
        buffering,
        progressed: !buffering,
        sampledAtLocalMs,
      })
      send(true, 13_000)
      at(14_000)
      send(true, 14_000)
      // The participant recovers within the same millisecond as its last report.
      send(false, 14_000)
      at(15_500)
      send(true, 15_500)
      at(16_100)
      send(true, 16_100)

      // The new rebuffer has lasted 0.6 s, not the 3.1 s since the first run began.
      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('does not carry buffering reported while the room was paused into the next play', () => {
      const { room, report, at } = playingRoom()
      room.control('participant_host', {
        actionId: 'action_pause_before_buffer',
        basedOnRevision: room.snapshot().revision,
        leaseEpoch: room.snapshot().controller.leaseEpoch,
        kind: 'pause',
        positionSeconds: 21,
      })
      // The participant keeps reporting buffering while paused.
      report(true)
      at(14_000)
      report(true)
      at(15_000)
      report(true)
      room.control('participant_host', {
        actionId: 'action_play_after_buffer',
        basedOnRevision: room.snapshot().revision,
        leaseEpoch: room.snapshot().controller.leaseEpoch,
        kind: 'play',
        positionSeconds: 21,
      })
      at(19_000)
      report(true)

      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('starts the grace period again for a new play command', () => {
      const { room, report, at } = playingRoom()
      report(true)
      at(14_000)
      report(true)
      at(14_100)
      room.control('participant_host', {
        actionId: 'action_pause_mid_buffer',
        basedOnRevision: room.snapshot().revision,
        leaseEpoch: room.snapshot().controller.leaseEpoch,
        kind: 'pause',
        positionSeconds: 21,
      })
      at(14_200)
      room.control('participant_host', {
        actionId: 'action_play_mid_buffer',
        basedOnRevision: room.snapshot().revision,
        leaseEpoch: room.snapshot().controller.leaseEpoch,
        kind: 'play',
        positionSeconds: 21,
      })
      // Buffering reports carry on once a second across the new command.
      const pastStartupGraceMs = room.snapshot().playback.effectiveAtServerMs + 2_600
      for (let ms = 15_000; ms < pastStartupGraceMs; ms += 1_000) {
        at(ms)
        report(true)
      }
      at(pastStartupGraceMs)
      report(true)

      // Under three seconds into the new play, so the earlier buffering does not count.
      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('does not carry a buffering run into a restored room', () => {
      const { room, report, at } = playingRoom()
      report(true)
      at(14_000)
      report(true)
      at(15_500)
      const restored = RoomCoordinator.fromState(room.exportState(), () => 16_100)
      const result = restored.updatePlayerStatus('participant_host', restored.snapshot().revision, {
        positionSeconds: 21.8,
        durationSeconds: 600,
        paused: false,
        buffering: true,
        progressed: false,
        sampledAtLocalMs: 16_100,
      })

      expect(result).not.toMatchObject({ reason: 'participant_buffering' })
      expect(restored.snapshot().playback.status).toBe('playing')
    })

    it('does not count a duplicate delivery of the same sample as more buffering', () => {
      const { room, at } = playingRoom()
      const send = (sampledAtLocalMs: number) => room.updatePlayerStatus('participant_host', room.snapshot().revision, {
        positionSeconds: 21.8,
        durationSeconds: 600,
        paused: false,
        buffering: true,
        progressed: false,
        sampledAtLocalMs,
      })
      send(13_000)
      at(14_000)
      send(14_000)
      // The same sample arrives again later; it is not fresh evidence.
      at(16_100)
      send(14_000)

      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('does not count reports for an older revision towards the grace period', () => {
      const { room, at } = playingRoom()
      const stale = room.snapshot().revision - 1
      const sendAt = (revision: number, ms: number) => {
        at(ms)
        return room.updatePlayerStatus('participant_host', revision, {
          positionSeconds: 21.8,
          durationSeconds: 600,
          paused: false,
          buffering: true,
          progressed: false,
          sampledAtLocalMs: ms,
        })
      }
      sendAt(stale, 13_000)
      sendAt(stale, 14_000)
      sendAt(stale, 15_000)
      sendAt(room.snapshot().revision, 16_100)

      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('starts the grace period again when a seek resumes playback', () => {
      const { room, report, at } = playingRoom(true)
      report(true)
      at(14_000)
      report(true)
      at(14_100)
      const sought = room.control('participant_host', {
        actionId: 'action_seek_mid_buffer',
        basedOnRevision: room.snapshot().revision,
        leaseEpoch: room.snapshot().controller.leaseEpoch,
        kind: 'seek',
        positionSeconds: 120,
      })
      const seekRevision = sought.ok ? sought.snapshot.revision : room.snapshot().revision
      at(14_300)
      room.acknowledgeSeek('participant_host', seekRevision, 120)
      room.acknowledgeSeek('participant_friend', seekRevision, 120)
      expect(room.snapshot().playback.status).toBe('playing')

      const pastStartupGraceMs = room.snapshot().playback.effectiveAtServerMs + 2_600
      for (let ms = 15_000; ms < pastStartupGraceMs; ms += 1_000) {
        at(ms)
        report(true)
      }
      at(pastStartupGraceMs)
      report(true)

      // Under three seconds into the resumed play, so the earlier buffering does not count.
      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('pauses only when one participant\'s own run reaches the grace period, not the room\'s combined buffering', () => {
      const { room, report, at } = playingRoom(true)
      const friendReport = (ms: number) => room.updatePlayerStatus('participant_friend', room.snapshot().revision, {
        positionSeconds: 21.8,
        durationSeconds: 600,
        paused: false,
        buffering: true,
        progressed: false,
        sampledAtLocalMs: ms,
      })
      // The two take turns: someone is always buffering, but neither for three seconds yet.
      report(true)
      at(14_000)
      friendReport(14_000)
      at(15_000)
      report(true)
      at(16_000)
      friendReport(16_000)
      expect(room.snapshot().playback.status).toBe('playing')

      // The host's own run now spans 13 s to 17 s.
      at(17_000)
      const result = report(true)
      expect(result).toMatchObject({ ok: true, reason: 'participant_buffering' })
    })

    it('tracks each participant separately', () => {
      const { room, report, at } = playingRoom(true)
      const friendReport = (buffering: boolean, ms: number) => room.updatePlayerStatus('participant_friend', room.snapshot().revision, {
        positionSeconds: 21.8,
        durationSeconds: 600,
        paused: false,
        buffering,
        progressed: !buffering,
        sampledAtLocalMs: ms,
      })
      report(true)
      at(14_000)
      report(true)
      // The friend's first buffering report must not inherit the host's older run.
      at(16_000)
      friendReport(true, 16_000)

      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('does not count a gap in the reports as buffering time', () => {
      const { room, report, at } = playingRoom()
      report(true)
      // Nothing was heard for four seconds; the next report starts a new period.
      at(17_000)
      report(true)

      expect(room.snapshot().playback.status).toBe('playing')
    })
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

    expect(result).toMatchObject({ ok: true, reason: 'participant_status_changed', snapshot: { participants: [expect.objectContaining({ playbackStatus: 'buffering' })] } })
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

    expect(result).toMatchObject({ ok: true, reason: 'participant_status_changed', snapshot: { participants: [expect.objectContaining({ playbackStatus: 'recovery-required' })] } })
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
    })).toMatchObject({ ok: true, reason: 'participant_status_changed', snapshot: { participants: [expect.objectContaining({ playbackStatus: 'buffering' })] } })
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

  it('un-readies the participant a rejected play() blocked, so pressing play again cannot re-trigger the same rejection instantly', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
    room.setReady('participant_friend', true, media)
    room.control('participant_host', {
      actionId: 'action_play_blocks_friend',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const playRevision = room.snapshot().revision
    nowMs += 100
    const blocked = room.updatePlayerStatus('participant_friend', playRevision, {
      positionSeconds: 20,
      durationSeconds: 600,
      paused: true,
      buffering: false,
      sampledAtLocalMs: nowMs,
      playbackStartFailed: true,
    })

    expect(blocked?.snapshot.participants.find(participant => participant.id === 'participant_friend')?.ready).toBe(false)

    const replayedTooSoon = room.control('participant_host', {
      actionId: 'action_play_again_before_friend_recovers',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    expect(replayedTooSoon).toMatchObject({ ok: false, code: 'participants_not_ready' })

    room.setReady('participant_friend', true, media)
    const replayedAfterRecovery = room.control('participant_host', {
      actionId: 'action_play_after_friend_recovers',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    expect(replayedAfterRecovery).toMatchObject({ ok: true, reason: 'control_play' })
  })

  describe('automatic resume after a pause the system caused (#141)', () => {
    const IDS = ['participant_host', 'participant_friend'] as const

    function startedRoom(initialPosition = 40) {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      const report = (participantId: string, overrides: Partial<PlayerSample> = {}) => room.updatePlayerStatus(participantId, room.snapshot().revision, {
        positionSeconds: room.snapshot().playback.positionSeconds,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        progressed: true,
        playbackStarted: true,
        sampledAtLocalMs: nowMs,
        ...overrides,
      })
      const reportAll = (overrides: Partial<PlayerSample> = {}) => IDS.forEach(id => report(id, overrides))
      const play = (position = initialPosition) => {
        controlTransactional(room, 'play', position)
        let sequence = 1
        for (const id of IDS)
          room.acknowledgeOperation(id, operationAcknowledgement(room, id, 'prepared', position, sequence))
        const eff = room.snapshot().contract?.operation?.effectiveAtServerMs ?? nowMs
        nowMs = eff
        sequence += 1
        for (const id of IDS)
          room.acknowledgeOperation(id, operationAcknowledgement(room, id, 'started', position, sequence))
        reportAll({ progressed: true })
      }
      /** The friend buffers until the room pauses for everyone. */
      const bufferUntilPaused = (hostKeepsReporting = true) => {
        nowMs += 3_000
        let result: RoomResult | null = null
        for (let step = 0; step < 8 && room.snapshot().playback.status === 'playing'; step += 1) {
          if (hostKeepsReporting)
            report('participant_host')
          result = report('participant_friend', { buffering: true, progressed: false })
          nowMs += 1_000
        }
        return result
      }
      /** Both players report that they can play, as a paused player that has data does. */
      const everyoneCanPlay = (overrides: Partial<PlayerSample> = {}) => reportAll({ paused: true, buffering: false, progressed: false, canPlay: true, ...overrides })
      return { room, play, report, reportAll, bufferUntilPaused, everyoneCanPlay, at: (ms: number) => { nowMs = ms }, now: () => nowMs }
    }

    it('starts a Play for everyone once every player has been able to play for the stability window', () => {
      const { room, play, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      expect(bufferUntilPaused()).toMatchObject({ ok: true, reason: 'participant_buffering' })
      const pausedAt = room.snapshot().playback.positionSeconds
      expect(room.autoResumeDeadlineMs()).not.toBeNull()

      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toBeNull()
      at(now() + 1_000)
      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toBeNull()
      expect(room.snapshot().playback.status).toBe('paused')

      at(now() + 600)
      everyoneCanPlay()
      const resumed = room.evaluateAutoResume()
      expect(resumed).toMatchObject({
        ok: true,
        reason: 'auto_resume_play_pending',
        snapshot: { contract: { operation: { kind: 'play', phase: 'preparing', targetPositionSeconds: pausedAt } } },
      })
    })

    it('judges an older extension, which sends no canPlay, by its buffering flag alone', () => {
      const { room, play, bufferUntilPaused, reportAll, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      const waiting = () => reportAll({ paused: true, buffering: false, progressed: false })
      waiting()
      room.evaluateAutoResume()
      at(now() + 1_600)
      waiting()
      expect(room.evaluateAutoResume()).toMatchObject({ reason: 'auto_resume_play_pending' })
    })

    it('does not resume while any player still waits for data, and resumes once it has been able to play for the full window', () => {
      const { room, play, report, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()

      for (let step = 0; step < 5; step += 1) {
        everyoneCanPlay()
        report('participant_friend', { paused: true, buffering: true, progressed: false, canPlay: false })
        expect(room.evaluateAutoResume()).toBeNull()
        at(now() + 1_000)
      }
      expect(room.snapshot().playback.status).toBe('paused')
      expect(room.snapshot().contract?.operation?.phase).not.toBe('preparing')

      // A player that says it cannot play is not ready even when it does not call itself buffering.
      everyoneCanPlay()
      report('participant_friend', { paused: true, buffering: false, progressed: false, canPlay: false })
      at(now() + 2_000)
      expect(room.evaluateAutoResume()).toBeNull()

      everyoneCanPlay()
      room.evaluateAutoResume()
      at(now() + 1_600)
      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toMatchObject({ reason: 'auto_resume_play_pending' })
    })

    it('waits for an older extension that still reports buffering, as it does for one that says it cannot play', () => {
      const { room, play, report, reportAll, bufferUntilPaused, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      for (let step = 0; step < 4; step += 1) {
        reportAll({ paused: true, buffering: false, progressed: false })
        report('participant_friend', { paused: true, buffering: true, progressed: false })
        expect(room.evaluateAutoResume()).toBeNull()
        at(now() + 1_000)
      }
      expect(room.snapshot().playback.status).toBe('paused')
      expect(room.operationDeadlineMs()).toBeNull()
    })

    it('restarts the stability window when a player stops being able to play in between', () => {
      const { room, play, report, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      everyoneCanPlay()
      room.evaluateAutoResume()
      at(now() + 1_000)
      report('participant_friend', { paused: true, buffering: true, progressed: false, canPlay: false })
      report('participant_host', { paused: true, buffering: false, progressed: false, canPlay: true })
      expect(room.evaluateAutoResume()).toBeNull()

      at(now() + 1_000)
      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toBeNull()
      at(now() + 1_000)
      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toBeNull()
    })

    it('restarts the stability window when a player reports it cannot play and recovers between two looks at the wait', () => {
      const { room, play, report, reportAll, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toBeNull()

      at(now() + 1_000)
      report('participant_friend', { paused: true, buffering: false, progressed: false, canPlay: false })
      at(now() + 100)
      reportAll({ paused: true, buffering: false, progressed: false, canPlay: true })
      // Without a look at the wait in between, the dip must still count: the window began before it.
      at(now() + 500)
      reportAll({ paused: true, buffering: false, progressed: false, canPlay: true })
      expect(room.evaluateAutoResume()).toBeNull()
      expect(room.snapshot().contract?.operation?.phase).not.toBe('preparing')

      at(now() + 1_600)
      reportAll({ paused: true, buffering: false, progressed: false, canPlay: true })
      expect(room.evaluateAutoResume()).toMatchObject({ reason: 'auto_resume_play_pending' })
    })

    it('does not resume a player that is far from the room position, but does one that is a few seconds behind', () => {
      const { room, play, report, bufferUntilPaused, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      const roomPosition = room.snapshot().playback.positionSeconds
      const ready = (friendPosition: number) => {
        report('participant_host', { paused: true, buffering: false, progressed: false, canPlay: true, positionSeconds: roomPosition })
        report('participant_friend', { paused: true, buffering: false, progressed: false, canPlay: true, positionSeconds: friendPosition })
      }
      for (let step = 0; step < 4; step += 1) {
        ready(roomPosition - 20)
        expect(room.evaluateAutoResume()).toBeNull()
        at(now() + 1_000)
      }
      for (let step = 0; step < 3; step += 1) {
        ready(roomPosition - 4)
        const resumed = room.evaluateAutoResume()
        if (resumed?.ok && resumed.reason === 'auto_resume_play_pending')
          return
        at(now() + 1_000)
      }
      throw new Error('Expected the room to resume for a player a few seconds behind.')
    })

    it('does not undo a pause the controller makes after an automatic start failed but before the wait was looked at again', () => {
      const { room, play, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      everyoneCanPlay()
      const early = room.evaluateAutoResume()
      at(now() + 1_600)
      everyoneCanPlay()
      expect(early ?? room.evaluateAutoResume()).toMatchObject({ reason: 'auto_resume_play_pending' })
      for (const id of IDS)
        room.acknowledgeOperation(id, operationAcknowledgement(room, id, 'prepared', room.snapshot().playback.positionSeconds, 1))
      const deadline = room.operationDeadlineMs()
      if (deadline === null)
        throw new Error('Expected a start deadline.')
      at(deadline)
      expect(room.releaseExpiredOperation()).toMatchObject({ snapshot: { contract: { operation: { phase: 'failed' } } } })

      // The failure has not been looked at yet; the controller pauses first.
      controlTransactional(room, 'pause', room.snapshot().playback.positionSeconds)
      for (let step = 0; step < 8; step += 1) {
        at(now() + 2_000)
        everyoneCanPlay()
        expect(room.evaluateAutoResume()).toBeNull()
      }
      expect(room.snapshot().contract?.operation?.phase).toBe('failed')
      expect(room.autoResumeDeadlineMs()).toBeNull()
    })

    it('does not count a report from before the pause, or one that is no longer fresh', () => {
      const { room, play, report, reportAll, bufferUntilPaused, now, at } = startedRoom()
      play()
      // The host's last report is from before the pause, and says it can play.
      reportAll({ paused: true, buffering: false, progressed: false, canPlay: true })
      bufferUntilPaused(false)
      // The friend's samples are the buffering ones that caused the pause.
      expect(room.evaluateAutoResume()).toBeNull()
      at(now() + 5_000)
      expect(room.evaluateAutoResume()).toBeNull()

      // Only the friend reports again: the host's report still predates the pause.
      report('participant_friend', { paused: true, buffering: false, progressed: false, canPlay: true })
      expect(room.evaluateAutoResume()).toBeNull()
      at(now() + 3_000)
      report('participant_friend', { paused: true, buffering: false, progressed: false, canPlay: true })
      expect(room.evaluateAutoResume()).toBeNull()
      expect(room.snapshot().contract?.operation?.phase).not.toBe('preparing')

      // Once the host reports after the pause too, the wait can proceed.
      report('participant_host', { paused: true, buffering: false, progressed: false, canPlay: true })
      at(now() + 1_600)
      reportAll({ paused: true, buffering: false, progressed: false, canPlay: true })
      expect(room.evaluateAutoResume()).toBeNull()
      at(now() + 1_600)
      reportAll({ paused: true, buffering: false, progressed: false, canPlay: true })
      expect(room.evaluateAutoResume()).toMatchObject({ reason: 'auto_resume_play_pending' })
    })

    it('never arms for a pause the controller made, a refused play(), a pause during startup, or a legacy room', () => {
      const pausedByController = startedRoom()
      pausedByController.play()
      controlTransactional(pausedByController.room, 'pause', 41)
      expect(pausedByController.room.autoResumeDeadlineMs()).toBeNull()

      const refused = startedRoom()
      refused.play()
      refused.at(refused.now() + 3_000)
      expect(refused.report('participant_friend', { playbackStartFailed: true, paused: true, progressed: false })).toMatchObject({ reason: 'participant_playback_blocked' })
      expect(refused.room.autoResumeDeadlineMs()).toBeNull()

      let nowMs = 10_000
      const legacy = createRoom(() => nowMs)
      legacy.setReady('participant_host', true, media)
      legacy.control('participant_host', { actionId: 'action_legacy_play', basedOnRevision: legacy.snapshot().revision, leaseEpoch: legacy.snapshot().controller.leaseEpoch, kind: 'play', positionSeconds: 20 })
      for (let step = 0; step < 8 && legacy.snapshot().playback.status === 'playing'; step += 1) {
        nowMs += 1_000
        legacy.updatePlayerStatus('participant_host', legacy.snapshot().revision, { positionSeconds: 21, durationSeconds: 600, paused: false, buffering: true, progressed: false, sampledAtLocalMs: nowMs })
      }
      expect(legacy.snapshot().playback.status).toBe('paused')
      expect(legacy.autoResumeDeadlineMs()).toBeNull()
    })

    it('does not arm after a player that never started playback timed out at startup', () => {
      const { room, report, at } = startedRoom()
      controlTransactional(room, 'play', 40)
      for (const id of IDS)
        room.acknowledgeOperation(id, operationAcknowledgement(room, id, 'prepared', 40, 1))
      const effectiveAt = room.snapshot().contract?.operation?.effectiveAtServerMs
      if (!effectiveAt)
        throw new Error('Expected a committed Play.')
      at(effectiveAt + 11_000)

      const result = report('participant_friend', { playbackStarted: false, progressed: false })

      expect(result).toMatchObject({ ok: true, reason: 'participant_playback_startup_timeout', snapshot: { playback: { status: 'paused' } } })
      expect(room.autoResumeDeadlineMs()).toBeNull()
    })

    it('arms after a no-progress stall and after a player went silent, not only after buffering', () => {
      const stalled = startedRoom()
      stalled.play()
      for (let step = 0; step < 6 && stalled.room.snapshot().playback.status === 'playing'; step += 1) {
        stalled.at(stalled.now() + 1_000)
        stalled.report('participant_host')
        stalled.report('participant_friend', { progressed: false })
        stalled.room.evaluateHealth(stalled.now())
      }
      expect(stalled.room.snapshot().playback.status).toBe('paused')
      expect(stalled.room.autoResumeDeadlineMs()).not.toBeNull()

      const silent = startedRoom()
      silent.play()
      silent.at(silent.now() + 1_000)
      silent.report('participant_friend', { buffering: true, progressed: false })
      silent.at(silent.now() + 6_000)
      silent.report('participant_host')
      expect(silent.room.evaluateHealth(silent.now())).toMatchObject({ reason: 'participant_playback_silent' })
      expect(silent.room.autoResumeDeadlineMs()).not.toBeNull()
    })

    it('is cancelled by any change a person makes, and never undoes a deliberate pause', () => {
      const seeked = startedRoom()
      seeked.play()
      seeked.bufferUntilPaused()
      controlTransactional(seeked.room, 'seek', 100)
      expect(seeked.room.evaluateAutoResume()).toBeNull()
      expect(seeked.room.autoResumeDeadlineMs()).toBeNull()

      const rePaused = startedRoom()
      rePaused.play()
      rePaused.bufferUntilPaused()
      controlTransactional(rePaused.room, 'pause', 41)
      rePaused.everyoneCanPlay()
      rePaused.at(rePaused.now() + 5_000)
      rePaused.everyoneCanPlay()
      expect(rePaused.room.evaluateAutoResume()).toBeNull()
      expect(rePaused.room.snapshot().playback.status).toBe('paused')

      const left = startedRoom()
      left.play()
      left.bufferUntilPaused()
      left.room.disconnect('participant_friend')
      expect(left.room.evaluateAutoResume()).toBeNull()
      expect(left.room.autoResumeDeadlineMs()).toBeNull()
    })

    it('gives up at once when the Play it started never got every player prepared', () => {
      const { room, play, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      everyoneCanPlay()
      room.evaluateAutoResume()
      at(now() + 1_600)
      everyoneCanPlay()
      room.evaluateAutoResume()
      const deadline = room.operationDeadlineMs()
      if (deadline === null)
        throw new Error('Expected the automatic Play to have a deadline.')
      expect(room.autoResumeDeadlineMs()).toBeNull()

      at(deadline)
      expect(room.releaseExpiredOperation()).toMatchObject({ reason: 'operation_timeout_paused', snapshot: { contract: { operation: { phase: 'failed', reason: 'deadline-expired' } } } })
      expect(room.autoResumeDeadlineMs()).toBe(deadline)
      expect(room.evaluateAutoResume()).toMatchObject({ ok: true, reason: 'auto_resume_abandoned', snapshot: { playback: { status: 'paused' } } })

      // Nothing further is attempted, however long the players stay able to play.
      for (let step = 0; step < 6; step += 1) {
        at(now() + 5_000)
        everyoneCanPlay()
        expect(room.evaluateAutoResume()).toBeNull()
      }
      expect(room.autoResumeDeadlineMs()).toBeNull()
    })

    it('tries again after a start that failed once everyone had prepared, with a pause between, and stops after three', () => {
      const { room, play, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      const reasons: Array<string | undefined> = []
      const attempt = () => {
        everyoneCanPlay()
        const early = room.evaluateAutoResume()
        at(now() + 1_600)
        everyoneCanPlay()
        const started = early ?? room.evaluateAutoResume()
        reasons.push(started?.ok ? started.reason : undefined)
        for (const id of IDS)
          room.acknowledgeOperation(id, operationAcknowledgement(room, id, 'prepared', room.snapshot().playback.positionSeconds, 1))
        const deadline = room.operationDeadlineMs()
        if (deadline === null)
          throw new Error('Expected a start deadline.')
        at(deadline)
        expect(room.releaseExpiredOperation()).toMatchObject({ snapshot: { contract: { operation: { phase: 'failed', reason: 'start-timeout' } } } })
        const outcome = room.evaluateAutoResume()
        reasons.push(outcome?.ok ? outcome.reason : undefined)
      }

      attempt()
      // The first failure is followed by a wait, not by another attempt at once.
      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toBeNull()
      at(now() + 1_000)
      everyoneCanPlay()
      expect(room.evaluateAutoResume()).toBeNull()
      at(now() + 1_000)
      everyoneCanPlay()
      attempt()
      at(now() + 5_000)
      attempt()

      expect(reasons).toEqual([
        'auto_resume_play_pending', undefined,
        'auto_resume_play_pending', undefined,
        'auto_resume_play_pending', 'auto_resume_abandoned',
      ])
      expect(room.autoResumeDeadlineMs()).toBeNull()
    })

    it('stops waiting after two minutes if some player is never able to play', () => {
      const { room, play, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      const armedAt = now()
      at(armedAt + 100_000)
      everyoneCanPlay({ canPlay: false })
      expect(room.evaluateAutoResume()).toBeNull()
      // The abandonment has to be scheduled, not only possible: a missing deadline would never wake the room.
      expect(room.autoResumeDeadlineMs()).not.toBeNull()
      expect(room.autoResumeDeadlineMs()).toBeLessThanOrEqual(armedAt + 120_000)
      at(armedAt + 125_000)
      expect(room.evaluateAutoResume()).toMatchObject({ reason: 'auto_resume_abandoned' })
      expect(room.autoResumeDeadlineMs()).toBeNull()
    })

    it('stops being armed once the Play it started has begun, and a later stall arms a new wait', () => {
      const { room, play, reportAll, bufferUntilPaused, everyoneCanPlay, now, at } = startedRoom()
      play()
      bufferUntilPaused()
      everyoneCanPlay()
      room.evaluateAutoResume()
      at(now() + 1_600)
      everyoneCanPlay()
      room.evaluateAutoResume()
      const position = room.snapshot().playback.positionSeconds
      for (const [index, id] of IDS.entries())
        room.acknowledgeOperation(id, operationAcknowledgement(room, id, 'prepared', position, 10 + index))
      const effectiveAt = room.snapshot().contract?.operation?.effectiveAtServerMs ?? now()
      at(effectiveAt)
      for (const [index, id] of IDS.entries())
        room.acknowledgeOperation(id, operationAcknowledgement(room, id, 'started', position, 20 + index))
      expect(room.snapshot().contract?.operation?.phase).toBe('started')
      expect(room.evaluateAutoResume()).toBeNull()
      expect(room.autoResumeDeadlineMs()).toBeNull()

      // The room plays on and a player stalls again: that is a new wait.
      reportAll({ progressed: true })
      bufferUntilPaused()
      expect(room.snapshot().playback.status).toBe('paused')
      expect(room.autoResumeDeadlineMs()).not.toBeNull()
    })

    it('arms no more than three times inside two minutes, so a flapping connection cannot pause and resume forever', () => {
      const { room, play, bufferUntilPaused, at, now } = startedRoom()
      const armed: boolean[] = []
      for (let cycle = 0; cycle < 4; cycle += 1) {
        play(40 + cycle)
        bufferUntilPaused()
        armed.push(room.autoResumeDeadlineMs() !== null)
        at(now() + 2_000)
      }
      expect(armed).toEqual([true, true, true, false])
    })

    it('is lost, not restored, when the room is restored: the room stays paused', () => {
      const { room, play, bufferUntilPaused, now } = startedRoom()
      play()
      bufferUntilPaused()
      expect(room.autoResumeDeadlineMs()).not.toBeNull()

      const restored = RoomCoordinator.fromState(room.exportState(), now)
      expect(restored.snapshot().playback.status).toBe('paused')
      expect(restored.autoResumeDeadlineMs()).toBeNull()
      expect(restored.evaluateAutoResume()).toBeNull()
    })
  })

  describe('a participant whose browser rejected synchronized play (#68)', () => {
    function readyPair(now: () => number): RoomCoordinator {
      const room = createRoom(now)
      room.setReady('participant_host', true, media)
      joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
      room.setReady('participant_friend', true, media)
      return room
    }

    function hostControl(room: RoomCoordinator, kind: 'play' | 'pause'): RoomResult {
      const snapshot = room.snapshot()
      return room.control('participant_host', {
        actionId: `action_${kind}_${snapshot.revision}`,
        basedOnRevision: snapshot.revision,
        leaseEpoch: snapshot.controller.leaseEpoch,
        kind,
        positionSeconds: 20,
      })
    }

    function friendReport(room: RoomCoordinator, nowMs: number, playbackStartFailed: boolean): RoomResult | null {
      return room.updatePlayerStatus('participant_friend', room.snapshot().revision, {
        positionSeconds: 20,
        durationSeconds: 600,
        paused: true,
        buffering: false,
        sampledAtLocalMs: nowMs,
        playbackStartFailed,
      })
    }

    function friendState(room: RoomCoordinator) {
      return room.snapshot().participants.find(participant => participant.id === 'participant_friend')
    }

    it('keeps the blocked participant identified through later reports, controller commands and re-readying', () => {
      let nowMs = 10_000
      const room = readyPair(() => nowMs)
      hostControl(room, 'play')
      nowMs += 100
      expect(friendReport(room, nowMs, true)).toMatchObject({ ok: true, reason: 'participant_playback_blocked' })
      const pausedRevision = room.snapshot().revision

      // The extension keeps reporting the fault while the room is paused.
      // A repeat must neither pause the room again nor erase the state.
      nowMs += 1_000
      expect(friendReport(room, nowMs, true)).toBeNull()
      expect(room.snapshot().revision).toBe(pausedRevision)
      expect(friendState(room)).toMatchObject({ ready: false, playbackStatus: 'blocked' })

      // Controller commands rewrite everyone's status; the record survives.
      expect(hostControl(room, 'pause')).toMatchObject({ ok: true, reason: 'control_pause' })
      expect(friendState(room)).toMatchObject({ playbackStatus: 'blocked' })

      // Readiness is quorum membership, not proof that the browser allows
      // playback, so re-readying does not clear the block either.
      room.setReady('participant_friend', true, media)
      const readyRevision = room.snapshot().revision
      expect(friendState(room)).toMatchObject({ ready: true, playbackStatus: 'blocked' })
      nowMs += 1_000
      expect(friendReport(room, nowMs, true)).toBeNull()
      expect(room.snapshot()).toMatchObject({ revision: readyRevision, playback: { status: 'paused' } })
      expect(friendState(room)).toMatchObject({ ready: true, playbackStatus: 'blocked' })

      // The record stays coordinator-local; only the public status is shared.
      expect(friendState(room)).not.toHaveProperty('playbackBlocked')
    })

    it('clears the block only when that participant reports that playback was accepted', () => {
      let nowMs = 10_000
      const room = readyPair(() => nowMs)
      hostControl(room, 'play')
      nowMs += 100
      friendReport(room, nowMs, true)

      nowMs += 1_000
      expect(friendReport(room, nowMs, false)).toMatchObject({ ok: true, reason: 'participant_status_changed' })
      expect(friendState(room)).toMatchObject({ ready: false, playbackStatus: 'preparing' })

      room.setReady('participant_friend', true, media)
      expect(friendState(room)).toMatchObject({ ready: true, playbackStatus: 'ready' })
      expect(hostControl(room, 'play')).toMatchObject({ ok: true, reason: 'control_play' })
    })

    it('still stops a playing room when a participant re-readied without recovering', () => {
      let nowMs = 10_000
      const room = readyPair(() => nowMs)
      hostControl(room, 'play')
      nowMs += 100
      friendReport(room, nowMs, true)
      room.setReady('participant_friend', true, media)

      expect(hostControl(room, 'play')).toMatchObject({ ok: true, reason: 'control_play' })
      nowMs += 1_000
      expect(friendReport(room, nowMs, true)).toMatchObject({
        ok: true,
        reason: 'participant_playback_blocked',
        snapshot: { playback: { status: 'paused' } },
      })
      expect(friendState(room)).toMatchObject({ ready: false, playbackStatus: 'blocked' })
    })

    it('keeps the block when another participant fails a health check', () => {
      let nowMs = 10_000
      const room = readyPair(() => nowMs)
      hostControl(room, 'play')
      nowMs += 100
      friendReport(room, nowMs, true)
      room.setReady('participant_friend', true, media)
      hostControl(room, 'play')

      // Nobody reports after the new play command, so the host misses its
      // startup deadline first and the room pauses for the host instead.
      nowMs = playbackStartupDeadlineMs(room.snapshot().playback)
      expect(room.evaluateHealth()).toMatchObject({ ok: true, reason: 'participant_playback_silent' })
      expect(friendState(room)).toMatchObject({ playbackStatus: 'blocked' })
    })

    it('keeps a start-rejected participant blocked in a transactional room', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 80)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 80, 1))
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 80, 1))
      nowMs += 100
      expect(friendReport(room, nowMs, true)).toMatchObject({
        ok: true,
        reason: 'participant_playback_blocked',
        snapshot: { contract: { operation: { phase: 'cancelled', reason: 'start-rejected' } } },
      })
      const pausedRevision = room.snapshot().revision

      nowMs += 1_000
      expect(friendReport(room, nowMs, true)).toBeNull()
      expect(room.snapshot()).toMatchObject({
        revision: pausedRevision,
        contract: { operation: { phase: 'cancelled', reason: 'start-rejected' } },
      })
      expect(friendState(room)).toMatchObject({ ready: false, playbackStatus: 'blocked' })

      nowMs += 1_000
      expect(friendReport(room, nowMs, false)).toMatchObject({ ok: true, reason: 'participant_status_changed' })
      expect(friendState(room)).toMatchObject({ ready: false, playbackStatus: 'preparing' })
    })

    it('restores the block from persisted room state', () => {
      let nowMs = 10_000
      const room = readyPair(() => nowMs)
      hostControl(room, 'play')
      nowMs += 100
      friendReport(room, nowMs, true)

      const restored = RoomCoordinator.fromState(room.exportState(), () => nowMs)
      expect(friendState(restored)).toMatchObject({ playbackStatus: 'blocked' })
      hostControl(restored, 'pause')
      expect(friendState(restored)).toMatchObject({ playbackStatus: 'blocked' })
      nowMs += 1_000
      expect(friendReport(restored, nowMs, true)).toBeNull()
      nowMs += 1_000
      expect(friendReport(restored, nowMs, false)).toMatchObject({ ok: true, reason: 'participant_status_changed' })
    })

    it('drops the block when the controller opens a different page', () => {
      let nowMs = 10_000
      const room = readyPair(() => nowMs)
      hostControl(room, 'play')
      nowMs += 100
      friendReport(room, nowMs, true)

      const snapshot = room.snapshot()
      expect(room.openLink('participant_host', {
        actionId: 'action_open_next_page',
        basedOnRevision: snapshot.revision,
        leaseEpoch: snapshot.controller.leaseEpoch,
        url: 'https://video.example/watch/next',
      })).toMatchObject({ ok: true })
      expect(friendState(room)).toMatchObject({ playbackStatus: 'wrong-media' })
      expect(room.exportState().participants.find(participant => participant.id === 'participant_friend')?.playbackBlocked).toBe(false)
    })

    it('shows the block again immediately on a reconnect, before any new report', () => {
      let nowMs = 10_000
      const room = readyPair(() => nowMs)
      hostControl(room, 'play')
      nowMs += 100
      friendReport(room, nowMs, true)
      expect(friendState(room)).toMatchObject({ playbackStatus: 'blocked' })

      const disconnected = room.disconnect('participant_friend')
      expect(disconnected).toMatchObject({ ok: true })

      const reconnected = room.join({ id: 'participant_friend', name: 'Rana', media })
      expect(reconnected).toMatchObject({
        ok: true,
        snapshot: { participants: expect.arrayContaining([
          expect.objectContaining({ id: 'participant_friend', connected: true, mediaMatches: true, playbackStatus: 'blocked' }),
        ]) },
      })
      // A reconnect on genuinely different media must still classify by
      // media identity first: the record survives, but the visible status
      // does not claim a block on a page the block was never observed on.
      const otherMedia = { ...media, canonicalId: 'youtube:different999' }
      room.disconnect('participant_friend')
      const rejoinedElsewhere = room.join({ id: 'participant_friend', name: 'Rana', media: otherMedia })
      expect(rejoinedElsewhere).toMatchObject({
        ok: true,
        snapshot: { participants: expect.arrayContaining([
          expect.objectContaining({ id: 'participant_friend', mediaMatches: false, playbackStatus: 'wrong-media' }),
        ]) },
      })
      expect(room.exportState().participants.find(participant => participant.id === 'participant_friend')?.playbackBlocked).toBe(true)
    })

    it('does not let a tolerated stale report set or clear the block while the room stays playing', () => {
      // The revision tolerance in updatePlayerStatus (from the CR-D03
      // heartbeat-race fix) exists so a report that only missed a start
      // acknowledgement can still prove progress. It must not be a side
      // door for setting this persisted record: only an exact-revision
      // report may pause the room, so only an exact-revision report may
      // record why.
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs

      nowMs = startAtMs + 500
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
      const hostRevision = room.snapshot().revision
      nowMs = startAtMs + 1_500
      expect(room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 41.5, 2)))
        .toMatchObject({ reason: 'operation_started' })

      nowMs += 4
      const stale = room.updatePlayerStatus('participant_host', hostRevision, {
        positionSeconds: 41.5,
        durationSeconds: 600,
        paused: true,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: false,
        playbackStarted: false,
        playbackStartFailed: true,
      })

      expect(stale).not.toMatchObject({ reason: 'participant_playback_blocked' })
      expect(room.snapshot()).toMatchObject({ playback: { status: 'playing' } })
      expect(room.exportState().participants.find(participant => participant.id === 'participant_host')?.playbackBlocked).not.toBe(true)

      // The same participant's next EXACT-revision report can still record
      // the block normally.
      const currentRevision = room.snapshot().revision
      nowMs += 1
      const exact = room.updatePlayerStatus('participant_host', currentRevision, {
        positionSeconds: 41.5,
        durationSeconds: 600,
        paused: true,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: false,
        playbackStarted: false,
        playbackStartFailed: true,
      })
      expect(exact).toMatchObject({ reason: 'participant_playback_blocked' })
      expect(room.exportState().participants.find(participant => participant.id === 'participant_host')?.playbackBlocked).toBe(true)
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
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
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

  it('migrates a pre-contract pending seek to a paused-safe state without reusing historical ACKs', () => {
    const room = createRoom()
    const sought = room.control('participant_host', {
      actionId: 'action_pre_contract_seek',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 120,
    })
    if (!sought.ok || !sought.snapshot.seek)
      throw new Error('Expected a legacy pending seek.')

    const stored = room.exportState()
    delete stored.contract
    stored.pendingSeek = {
      ...sought.snapshot.seek,
      acknowledgedParticipantIds: ['participant_host'],
    }
    const restored = RoomCoordinator.fromState(stored, () => 20_000)

    expect(restored.snapshot()).toMatchObject({
      playback: { status: 'paused', positionSeconds: 120 },
      seek: null,
      contract: { mode: 'legacy', operation: null },
    })
    expect(restored.pendingSeekDeadlineMs()).toBeNull()
    expect(restored.acknowledgeSeek('participant_host', stored.pendingSeek.revision, 120)).toBeNull()
    expect(restored.exportState().stateVersion).toBe(2)
  })

  it('migrates a partially written contract with a pending seek to the same paused-safe state', () => {
    const room = createRoom()
    const sought = room.control('participant_host', {
      actionId: 'action_partial_contract_seek',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 150,
    })
    if (!sought.ok || !sought.snapshot.seek)
      throw new Error('Expected a legacy pending seek.')

    const stored = room.exportState()
    stored.contract = { mode: 'legacy' } as NonNullable<typeof stored.contract>
    stored.pendingSeek = {
      ...sought.snapshot.seek,
      acknowledgedParticipantIds: ['participant_host'],
    }
    const restored = RoomCoordinator.fromState(stored, () => 20_000)

    expect(restored.snapshot()).toMatchObject({
      playback: { status: 'paused', positionSeconds: 150 },
      seek: null,
      contract: { mode: 'legacy', operation: null },
    })
    expect(restored.pendingSeekDeadlineMs()).toBeNull()
    expect(restored.acknowledgeSeek('participant_host', stored.pendingSeek.revision, 150)).toBeNull()
  })

  it('preserves an explicitly versioned legacy seek instead of treating it as pre-contract state', () => {
    const room = createRoom()
    const sought = room.control('participant_host', {
      actionId: 'action_current_legacy_seek',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 90,
    })
    expect(sought).toMatchObject({ ok: true, snapshot: { seek: { positionSeconds: 90 } } })

    const restored = RoomCoordinator.fromState(room.exportState(), () => 10_000)
    expect(restored.snapshot()).toEqual(room.snapshot())
  })

  it('keeps a mixed-version room on the legacy path and ignores transactional ACKs', () => {
    const room = new RoomCoordinator(
      { roomId: 'mixed_version_room', code: 'MIXED123' },
      { id: 'participant_host', name: 'Muaz', media, capabilities: CURRENT_CLIENT_CAPABILITIES },
      () => 10_000,
    )
    room.join({ id: 'participant_old', name: 'Legacy', media })
    room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_old', true)
    room.setReady('participant_host', true, media)
    room.setReady('participant_old', true, media)

    expect(room.snapshot().contract).toMatchObject({ mode: 'legacy', sharedCapabilities: [] })
    const control = room.control('participant_host', {
      actionId: 'action_mixed_play',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 0,
    })
    expect(control).toMatchObject({ ok: true, snapshot: { playback: { status: 'playing' }, contract: { operation: null } } })
    expect(room.acknowledgeOperation('participant_host', {
      mediaEpoch: 0,
      operationId: 'operation_mixed_123456',
      phase: 'prepared',
      participantId: 'participant_host',
      bindingId: 'binding_host_123456',
      sourceGeneration: 1,
      sampleSequence: 1,
      observedPositionSeconds: 0,
      observedAtLocalMs: 10_001,
    })).toBeNull()
  })

  it('lets a pending seek resolve after an unrelated readiness change bumps the room revision without clearing it', () => {
    const room = createRoom()
    joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
    joinApproved(room, { id: 'participant_extra', name: 'Sam', media: null })
    room.setReady('participant_host', true, media)
    room.setReady('participant_friend', true, media)

    const sought = room.control('participant_host', {
      actionId: 'action_seek_during_join',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 100,
    })
    const seekRevision = sought.snapshot.revision

    // 'extra' catching up to matching, ready media bumps the room revision
    // without clearing the pending seek, since it was not ready before.
    room.setReady('participant_extra', true, media)
    expect(room.snapshot().revision).toBeGreaterThan(seekRevision)
    expect(room.snapshot().seek).toMatchObject({ revision: seekRevision })
    room.acknowledgeSeek('participant_host', seekRevision, 100)

    const friendAck = room.acknowledgeSeek('participant_friend', seekRevision, 100)
    expect(friendAck).toMatchObject({ ok: true, reason: 'seek_participant_aligned' })

    const extraAck = room.acknowledgeSeek('participant_extra', seekRevision, 100)
    expect(extraAck).toMatchObject({
      ok: true,
      reason: 'seek_aligned_paused',
      snapshot: { seek: null, playback: { status: 'paused', positionSeconds: 100 } },
    })
  })

  it('admits a new participant once previous participants disconnect, even after the room previously filled up', () => {
    const room = createRoom()
    const memberIds = Array.from({ length: 9 }, (_, index) => `participant_member_${index}`)
    for (const id of memberIds)
      joinApproved(room, { id, name: id, media })
    expect(room.snapshot().participants).toHaveLength(10)

    for (const id of memberIds)
      room.disconnect(id)

    const rejoined = room.join({ id: 'participant_newcomer', name: 'Newcomer', media })
    expect(rejoined).toMatchObject({ ok: true, reason: 'join_pending' })
  })

  it('clamps a seek target to the known media duration', () => {
    const room = createRoom()
    room.setReady('participant_host', true, media)
    const result = room.control('participant_host', {
      actionId: 'action_seek_beyond_duration',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 999_999,
    })
    expect(result).toMatchObject({ ok: true, snapshot: { seek: { positionSeconds: 600 } } })
  })

  it('ignores an out-of-order stale sample that would otherwise mask a real freeze', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    room.control('participant_host', {
      actionId: 'action_play_stale_sample',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    const playRevision = room.snapshot().revision
    const startedAtMs = room.snapshot().playback.effectiveAtServerMs

    nowMs = startedAtMs + 200
    room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20.1,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: nowMs,
    })

    // A reconnect race delivers a stale, out-of-order sample: an older local
    // timestamp reporting a lower position than the one already recorded.
    nowMs = startedAtMs + 900
    const staleResult = room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 19.0,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: startedAtMs + 100,
    })
    expect(staleResult).toBeNull()

    nowMs = startedAtMs + 2_000
    const result = room.updatePlayerStatus('participant_host', playRevision, {
      positionSeconds: 20.1,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: nowMs,
    })

    expect(result).toMatchObject({
      ok: true,
      reason: 'participant_playback_stalled',
      snapshot: { playback: { status: 'paused' } },
    })
  })

  it('does not leak internal timing bookkeeping fields in the snapshot', () => {
    const room = createRoom()
    const participant = room.snapshot().participants.find(item => item.id === 'participant_host')

    expect(participant).not.toHaveProperty('lastSampleReceivedAtMs')
    expect(participant).not.toHaveProperty('lastProgressAtServerMs')
    expect(Object.keys(participant ?? {}).sort()).toEqual(
      ['connected', 'id', 'latencyMs', 'mediaMatches', 'name', 'playbackStatus', 'ready', 'role'].sort(),
    )
  })

  describe('CR-B02 coordinator prepare and commit transactions', () => {
    it('keeps play paused until the fixed participant set prepares, then requires observed starts', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)

      expect(room.snapshot().contract).toMatchObject({ mode: 'transactional', sharedCapabilities: expect.arrayContaining(['prepare-start']) })
      const pending = controlTransactional(room, 'play', 40)
      expect(pending).toMatchObject({
        ok: true,
        reason: 'control_play_pending',
        snapshot: {
          playback: { status: 'paused', positionSeconds: 40 },
          contract: { operation: { phase: 'preparing', requiredParticipantIds: ['participant_host', 'participant_friend'], preparedParticipantIds: [] } },
        },
      })

      const hostPrepared = room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      expect(hostPrepared).toMatchObject({ ok: true, reason: 'operation_participant_prepared', snapshot: { playback: { status: 'paused' } } })
      const benignSnapshotUpdate = room.setReady('participant_host', true, media)
      expect(benignSnapshotUpdate).toMatchObject({ ok: true, reason: 'readiness_unchanged' })

      const guestPrepared = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      expect(guestPrepared).toMatchObject({ ok: true, reason: 'operation_committed', snapshot: { playback: { status: 'playing' }, contract: { operation: { phase: 'committed' } } } })
      if (!guestPrepared?.ok || !guestPrepared.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a scheduled transactional start.')

      nowMs = guestPrepared.snapshot.contract.operation.effectiveAtServerMs
      const hostStarted = room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40, 2))
      expect(hostStarted).toMatchObject({ ok: true, reason: 'operation_participant_started' })
      const guestStarted = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 40, 2))
      expect(guestStarted).toMatchObject({ ok: true, reason: 'operation_started', snapshot: { contract: { operation: { phase: 'started', startedParticipantIds: ['participant_host', 'participant_friend'] } } } })
      expect(room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 40, 2))).toMatchObject({ ok: true, reason: 'operation_start_duplicate' })
    })

    it('keeps a separate post-commit window for real started evidence', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      const pending = controlTransactional(room, 'play', 40)
      if (!pending.ok || !pending.snapshot.contract?.operation)
        throw new Error('Expected a pending transactional operation.')
      const preparationDeadline = pending.snapshot.contract.operation.deadlineAtServerMs

      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      nowMs = 10_500
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startEvidenceDeadline = committed.snapshot.contract.operation.deadlineAtServerMs
      expect(startEvidenceDeadline).toBeGreaterThan(preparationDeadline)

      nowMs = startEvidenceDeadline - 1
      expect(room.releaseExpiredOperation()).toBeNull()
      nowMs = startEvidenceDeadline
      expect(room.releaseExpiredOperation()).toMatchObject({
        ok: true,
        reason: 'operation_timeout_paused',
        snapshot: { contract: { operation: { phase: 'failed', reason: 'start-timeout' } } },
      })
    })

    it('rebases steady-play health timing when a delayed participant confirms start', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')

      nowMs = committed.snapshot.contract.operation.effectiveAtServerMs + 1_000
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 41, 2))
      const friendStarted = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 41, 2))
      expect(friendStarted).toMatchObject({ ok: true, reason: 'operation_started' })
      const startedRevision = room.snapshot().revision
      for (const participantId of ['participant_host', 'participant_friend']) {
        room.updatePlayerStatus(participantId, startedRevision, {
          positionSeconds: 41,
          durationSeconds: 600,
          paused: false,
          buffering: false,
          sampledAtLocalMs: nowMs,
          progressed: false,
          playbackStarted: true,
        })
      }

      nowMs += PLAYBACK_PROGRESS_TIMEOUT_MS - 1
      expect(room.evaluateHealth()).toBeNull()
      nowMs += 1
      expect(room.evaluateHealth()).toMatchObject({ reason: 'participant_playback_stalled' })
    })

    it('keeps an early starter\'s progress report that races a later start acknowledgement', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs

      // The host proves playback on its first one-second report tick.
      nowMs = startAtMs + 500
      room.updatePlayerStatus('participant_host', room.snapshot().revision, {
        positionSeconds: 40.5,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: true,
        playbackStarted: true,
      })
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
      const hostRevision = room.snapshot().revision

      // On the next tick the friend's start acknowledgement advances the
      // revision a few milliseconds before the host's heartbeat, stamped with
      // the revision the host last received, reaches the coordinator.
      nowMs = startAtMs + 1_500
      expect(room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 41.5, 2)))
        .toMatchObject({ reason: 'operation_started' })
      nowMs += 4
      room.updatePlayerStatus('participant_host', hostRevision, {
        positionSeconds: 41.5,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: true,
        playbackStarted: true,
      })
      const hostHeartbeatAtMs = nowMs
      nowMs = startAtMs + 2_000
      room.updatePlayerStatus('participant_friend', room.snapshot().revision, {
        positionSeconds: 42,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: true,
        playbackStarted: true,
      })

      // Only a start acknowledgement separates the heartbeat from the current
      // revision, so it still proves progress for the unchanged play command.
      nowMs = startAtMs + 500 + PLAYBACK_PROGRESS_TIMEOUT_MS
      expect(room.evaluateHealth()).toBeNull()
      nowMs = hostHeartbeatAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS
      expect(room.evaluateHealth()).toMatchObject({
        reason: 'participant_playback_stalled',
        snapshot: { participants: expect.arrayContaining([expect.objectContaining({ id: 'participant_host', playbackStatus: 'recovery-required' })]) },
      })
    })

    it('rejects a report from a start acknowledgement run once a newer command supersedes it', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs

      nowMs = startAtMs + 500
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
      const hostRevision = room.snapshot().revision
      nowMs = startAtMs + 1_500
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 41.5, 2))
      controlTransactional(room, 'pause', 41.5)
      const paused = room.snapshot()

      const delayed = room.updatePlayerStatus('participant_host', hostRevision, {
        positionSeconds: 41.6,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: true,
        playbackStarted: true,
      })

      expect(delayed).toBeNull()
      expect(room.snapshot()).toMatchObject({ revision: paused.revision, playback: { status: 'paused' } })
      expect(room.exportState().participants.find(participant => participant.id === 'participant_host')?.lastSample?.positionSeconds).not.toBe(41.6)
    })

    it('lets an in-run stale recovery report end a buffering run (#141)', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs
      const hostReport = (revision: number, buffering: boolean) => room.updatePlayerStatus('participant_host', revision, {
        positionSeconds: 41,
        durationSeconds: 600,
        paused: false,
        buffering,
        progressed: !buffering,
        sampledAtLocalMs: nowMs,
      })

      nowMs = startAtMs + 500
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
      const hostRevision = room.snapshot().revision
      // The host buffers for a while, reported at the current revision.
      nowMs = startAtMs + 2_600
      hostReport(hostRevision, true)
      nowMs = startAtMs + 3_600
      hostReport(hostRevision, true)
      // The friend's start acknowledgement advances the revision.
      nowMs = startAtMs + 3_700
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 43.7, 2))
      const currentRevision = room.snapshot().revision
      expect(currentRevision).toBeGreaterThan(hostRevision)
      // An in-flight report from before that, saying the host recovered, is still accepted.
      nowMs = startAtMs + 3_800
      hostReport(hostRevision, false)
      // A new rebuffer starts; it has lasted well under three seconds.
      nowMs = startAtMs + 4_500
      hostReport(currentRevision, true)
      nowMs = startAtMs + 5_600
      hostReport(currentRevision, true)

      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('does not let an in-run stale buffering report extend a buffering run (#141)', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs
      const hostBuffering = (revision: number) => room.updatePlayerStatus('participant_host', revision, {
        positionSeconds: 41,
        durationSeconds: 600,
        paused: false,
        buffering: true,
        progressed: false,
        sampledAtLocalMs: nowMs,
      })

      nowMs = startAtMs + 500
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
      const hostRevision = room.snapshot().revision
      nowMs = startAtMs + 2_600
      hostBuffering(hostRevision)
      nowMs = startAtMs + 3_600
      hostBuffering(hostRevision)
      nowMs = startAtMs + 3_700
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 43.7, 2))
      const currentRevision = room.snapshot().revision
      expect(currentRevision).toBeGreaterThan(hostRevision)
      // A buffering report from before the revision change is still accepted, but it is not evidence for the run.
      nowMs = startAtMs + 5_000
      hostBuffering(hostRevision)
      // The next current report is more than 2.5 s after the last counted one, so a new run starts.
      nowMs = startAtMs + 6_200
      hostBuffering(currentRevision)

      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('accepts an in-run stale report as progress but never lets it trip failure classification', () => {
      // The run tolerates a report that only missed a start acknowledgement,
      // but its own doc comment and the commit message both promise that
      // such a report "can prove progress but can never pause the room".
      // Failure classification requires an exact revision match, so a stale
      // report carrying an explicit failure must fall through to a plain
      // status change instead of pausing the transactional operation.
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs

      nowMs = startAtMs + 500
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
      const hostRevision = room.snapshot().revision
      nowMs = startAtMs + 1_500
      expect(room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 41.5, 2)))
        .toMatchObject({ reason: 'operation_started' })
      const revisionBeforeStaleReport = room.snapshot().revision

      nowMs += 4
      const stalePlaybackFailure = room.updatePlayerStatus('participant_host', hostRevision, {
        positionSeconds: 41.5,
        durationSeconds: 600,
        paused: true,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: false,
        playbackStarted: false,
        playbackStartFailed: true,
      })

      expect(stalePlaybackFailure).toMatchObject({ ok: true, reason: 'participant_status_changed' })
      expect(room.snapshot()).toMatchObject({
        revision: revisionBeforeStaleReport,
        playback: { status: 'playing' },
        contract: { operation: { phase: 'started' } },
      })

      const staleBuffering = room.updatePlayerStatus('participant_friend', hostRevision, {
        positionSeconds: 41.5,
        durationSeconds: 600,
        paused: false,
        buffering: true,
        sampledAtLocalMs: nowMs + 1,
        progressed: false,
        playbackStarted: true,
      })
      expect(staleBuffering).not.toMatchObject({ reason: 'participant_buffering' })
      expect(room.snapshot()).toMatchObject({ revision: revisionBeforeStaleReport, playback: { status: 'playing' } })
    })

    it('keeps rejecting a report from before the run and one stamped ahead of the current revision', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      const initialRevision = room.snapshot().revision
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs

      nowMs = startAtMs + 500
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
      nowMs = startAtMs + 1_500
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 41.5, 2))
      const currentRevision = room.snapshot().revision

      // Stamped before the play command even existed: well below the run's
      // own lower bound, so it must stay rejected exactly as an ordinary
      // stale report would, and must never overwrite the stored sample.
      nowMs += 10
      expect(room.updatePlayerStatus('participant_host', initialRevision, {
        positionSeconds: 0,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: true,
        playbackStarted: true,
      })).toBeNull()
      expect(room.exportState().participants.find(participant => participant.id === 'participant_host')?.lastSample).toBeNull()

      // Stamped one revision ahead of what the coordinator has reached: not
      // yet current under any definition, so it must also stay rejected.
      expect(room.updatePlayerStatus('participant_host', currentRevision + 1, {
        positionSeconds: 41.5,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: true,
        playbackStarted: true,
      })).toBeNull()
      expect(room.exportState().participants.find(participant => participant.id === 'participant_host')?.lastSample).toBeNull()
    })

    it('extends the run across three consecutive start acknowledgements before a heartbeat lands', () => {
      // The traced production race showed a report one to two revisions
      // behind the current one, spanning more than a single acknowledgement.
      // A room of three requires two more acknowledgements after the first
      // to reach `started`, reproducing that shape instead of the minimal
      // one-acknowledgement gap a two-participant room can only ever show.
      let nowMs = 10_000
      const room = new RoomCoordinator(
        { roomId: 'transactional_room_3', code: 'TRANS3123' },
        { id: 'participant_host', name: 'Muaz', media, capabilities: CURRENT_CLIENT_CAPABILITIES },
        () => nowMs,
      )
      room.join({ id: 'participant_friend', name: 'Rana', media, capabilities: CURRENT_CLIENT_CAPABILITIES })
      room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
      room.join({ id: 'participant_third', name: 'Sam', media, capabilities: CURRENT_CLIENT_CAPABILITIES })
      room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_third', true)
      for (const participantId of ['participant_host', 'participant_friend', 'participant_third'])
        room.setReady(participantId, true, media)

      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_third', operationAcknowledgement(room, 'participant_third', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')
      const startAtMs = committed.snapshot.contract.operation.effectiveAtServerMs

      nowMs = startAtMs + 200
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.2, 2))
      const hostRevision = room.snapshot().revision
      nowMs = startAtMs + 400
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 40.4, 2))
      nowMs = startAtMs + 600
      expect(room.acknowledgeOperation('participant_third', operationAcknowledgement(room, 'participant_third', 'started', 40.6, 2)))
        .toMatchObject({ reason: 'operation_started' })
      const currentRevision = room.snapshot().revision
      expect(currentRevision).toBe(hostRevision + 2)

      // Stamped at the revision right after the host's OWN acknowledgement,
      // two acknowledgements (friend's and third's) behind the current one:
      // the shape the traced production race actually showed, which a
      // two-participant room can never reproduce.
      nowMs = startAtMs + 700
      const chained = room.updatePlayerStatus('participant_host', hostRevision, {
        positionSeconds: 40.7,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: true,
        playbackStarted: true,
      })
      // The report is accepted as progress evidence; the coordinator returns
      // null here only because 'playing' was already the visible status, the
      // same no-op result an exact-revision report of unchanged status gets.
      expect(chained).toBeNull()
      expect(room.exportState().participants.find(participant => participant.id === 'participant_host')?.lastSample).toMatchObject({ positionSeconds: 40.7 })
      const chainedRevision = room.snapshot().revision
      nowMs = startAtMs + 700 + PLAYBACK_PROGRESS_TIMEOUT_MS - 1
      expect(room.evaluateHealth()).toBeNull()
      expect(room.snapshot().revision).toBe(chainedRevision)
    })

    it('does not expire an operation after every participant has confirmed start', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')

      nowMs = committed.snapshot.contract.operation.effectiveAtServerMs
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40, 2))
      const started = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 40, 2))
      expect(started).toMatchObject({ ok: true, reason: 'operation_started', snapshot: { contract: { operation: { phase: 'started' } } } })

      nowMs = committed.snapshot.contract.operation.deadlineAtServerMs + 1
      expect(room.releaseExpiredOperation()).toBeNull()
      expect(room.snapshot().contract?.operation).toMatchObject({ phase: 'started' })
    })

    it('does not classify a committed participant as stalled before transactional startup grace', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')

      const effectiveAtServerMs = committed.snapshot.contract.operation.effectiveAtServerMs
      nowMs = effectiveAtServerMs + 1_900
      expect(room.updatePlayerStatus('participant_host', room.snapshot().revision, {
        positionSeconds: 40,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: false,
        playbackStarted: true,
      })).toBeNull()
      expect(room.snapshot().playback.status).toBe('playing')

      nowMs = effectiveAtServerMs + PLAYBACK_STARTUP_GRACE_MS
      expect(room.updatePlayerStatus('participant_host', room.snapshot().revision, {
        positionSeconds: 40,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: false,
        playbackStarted: true,
      })).toMatchObject({ reason: 'participant_playback_stalled', snapshot: { playback: { status: 'paused' } } })
    })

    it('cancels a started transaction once timer-driven health detects no progress', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed transactional operation.')

      nowMs = committed.snapshot.contract.operation.effectiveAtServerMs
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40, 2))
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 40, 2))
      const startedRevision = room.snapshot().revision
      nowMs += 100
      room.updatePlayerStatus('participant_host', startedRevision, {
        positionSeconds: 40,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: 1,
        progressed: true,
        playbackStarted: true,
      })
      const healthDeadline = nowMs + 1_800

      nowMs = healthDeadline - 1
      expect(room.evaluateHealth()).toBeNull()
      nowMs = healthDeadline
      expect(room.evaluateHealth()).toMatchObject({
        ok: true,
        reason: 'participant_playback_stalled',
        snapshot: {
          playback: { status: 'paused' },
          contract: { operation: { phase: 'cancelled', reason: 'manual-recovery' } },
        },
      })
    })

    it('keeps a paused seek committed at its fixed target and rejects stale or duplicate operation evidence', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      const sought = controlTransactional(room, 'seek', 180)
      expect(sought).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused', positionSeconds: 180 }, contract: { operation: { kind: 'seek', resumeWhenReady: false } } } })

      const firstAck = operationAcknowledgement(room, 'participant_host', 'prepared', 180, 1)
      expect(room.acknowledgeOperation('participant_host', firstAck)).toMatchObject({ ok: true, reason: 'operation_participant_prepared' })
      expect(room.acknowledgeOperation('participant_host', firstAck)).toMatchObject({ ok: true, reason: 'operation_prepare_duplicate' })
      expect(room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 180, 1))).toMatchObject({
        ok: true,
        reason: 'operation_seek_committed_paused',
        snapshot: { playback: { status: 'paused', positionSeconds: 180 }, contract: { operation: { phase: 'committed' } } },
      })

      const oldOperation = room.snapshot().contract!.operation!
      const superseding = controlTransactional(room, 'play', 180)
      expect(superseding).toMatchObject({ ok: true, reason: 'control_play_pending' })
      expect(room.acknowledgeOperation('participant_host', {
        ...firstAck,
        operationId: oldOperation.operationId,
        mediaEpoch: oldOperation.mediaEpoch,
        sampleSequence: 2,
      })).toBeNull()
    })

    it('settles a committed paused seek when its window closes instead of failing the room', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'seek', 180)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 180, 1))
      expect(room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 180, 1))).toMatchObject({
        reason: 'operation_seek_committed_paused',
      })
      const committed = room.snapshot()
      const deadlineMs = committed.contract!.operation!.deadlineAtServerMs

      // Inside the window the seek is still reported as committed, and a
      // heartbeat from a paused, aligned player must not flip a participant
      // back to `seeking`.
      nowMs += 1_000
      room.updatePlayerStatus('participant_host', committed.revision, {
        positionSeconds: 180,
        durationSeconds: 600,
        paused: true,
        buffering: false,
        sampledAtLocalMs: nowMs,
      })
      expect(room.releaseExpiredOperation(nowMs)).toBeNull()
      expect(room.snapshot()).toMatchObject({
        contract: { operation: { kind: 'seek', phase: 'committed' } },
        participants: [expect.objectContaining({ playbackStatus: 'ready' }), expect.objectContaining({ playbackStatus: 'ready' })],
      })
      // A paused seek has nothing to start, so a start acknowledgement is not
      // accepted: it would leave a partly started operation.
      nowMs = committed.contract!.operation!.effectiveAtServerMs! + 50
      expect(room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 180, 2))).toBeNull()

      // A paused seek never sends a `started` acknowledgement, so its window
      // closing is a completion, not a failed start.
      expect(room.operationDeadlineMs()).toBe(deadlineMs)
      nowMs = deadlineMs
      const settled = room.releaseExpiredOperation(nowMs)
      expect(settled).toMatchObject({
        ok: true,
        reason: 'operation_seek_settled',
        snapshot: {
          playback: { status: 'paused', positionSeconds: 180 },
          contract: { operation: null },
          participants: [expect.objectContaining({ playbackStatus: 'ready' }), expect.objectContaining({ playbackStatus: 'ready' })],
        },
      })
      expect(settled!.snapshot.revision).toBeGreaterThan(committed.revision)
      expect(room.operationDeadlineMs()).toBeNull()
      expect(room.releaseExpiredOperation(nowMs + 60_000)).toBeNull()

      // The room is free for the next command.
      expect(controlTransactional(room, 'play', 180)).toMatchObject({ reason: 'control_play_pending' })
    })

    describe('repeated Play presses while a Play is still preparing', () => {
      let pressCount = 0
      function press(room: RoomCoordinator, positionSeconds: number): RoomResult {
        const snapshot = room.snapshot()
        pressCount += 1
        // A real client sends a fresh action id for every press.
        return room.control('participant_host', {
          actionId: `repeated_press_${pressCount}`,
          basedOnRevision: snapshot.revision,
          leaseEpoch: snapshot.controller.leaseEpoch,
          kind: 'play',
          positionSeconds,
        })
      }

      it('keeps the operation, its prepared evidence and its deadline instead of restarting all three', () => {
        let nowMs = 10_000
        const room = createTransactionalRoom(() => nowMs)
        expect(press(room, 42)).toMatchObject({ reason: 'control_play_pending' })
        const original = structuredClone(room.snapshot().contract!.operation!)
        nowMs += 400
        expect(room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 42, 1)))
          .toMatchObject({ reason: 'operation_participant_prepared' })
        const revisionBefore = room.snapshot().revision

        // The storm from the report: presses about 200 ms apart, all for the
        // position the operation is already preparing.
        for (const offset of [200, 200, 200]) {
          nowMs += offset
          expect(press(room, 42.05)).toMatchObject({ ok: true, reason: 'control_play_unchanged' })
        }

        expect(room.snapshot().revision).toBe(revisionBefore)
        expect(room.snapshot().contract!.operation).toMatchObject({
          operationId: original.operationId,
          phase: 'preparing',
          preparedParticipantIds: ['participant_host'],
          deadlineAtServerMs: original.deadlineAtServerMs,
        })

        // The peer that was still preparing completes the ORIGINAL operation.
        expect(room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 42, 1)))
          .toMatchObject({ reason: 'operation_committed', snapshot: { contract: { operation: { operationId: original.operationId, phase: 'committed' } } } })
      })

      it('does not stretch the window: the first deadline still fails the operation however many presses arrive', () => {
        let nowMs = 10_000
        const room = createTransactionalRoom(() => nowMs)
        press(room, 42)
        const original = room.snapshot().contract!.operation!
        for (let index = 0; index < 5; index += 1) {
          nowMs += 500
          press(room, 42)
        }
        expect(room.operationDeadlineMs()).toBe(original.deadlineAtServerMs)
        nowMs = original.deadlineAtServerMs
        expect(room.releaseExpiredOperation(nowMs)).toMatchObject({
          reason: 'operation_timeout_paused',
          snapshot: { contract: { operation: { phase: 'failed', reason: 'deadline-expired' } } },
        })
        // After the failure the next press is a new attempt, not a swallowed duplicate.
        expect(press(room, 42)).toMatchObject({ reason: 'control_play_pending' })
        expect(room.snapshot().contract!.operation!.operationId).not.toBe(original.operationId)
      })

      it('still starts a new operation for a different position, once committed, once expired, or after someone joins', () => {
        let nowMs = 10_000
        const room = createTransactionalRoom(() => nowMs)
        press(room, 42)
        const first = room.snapshot().contract!.operation!.operationId

        // A different position is a different intent.
        expect(press(room, 90)).toMatchObject({ reason: 'control_play_pending' })
        const second = room.snapshot().contract!.operation!.operationId
        expect(second).not.toBe(first)

        // A press arriving after the deadline but before the timer released the
        // operation must not be swallowed by an operation that is already dead.
        nowMs += 3_000
        expect(press(room, 90)).toMatchObject({ reason: 'control_play_pending' })
        expect(room.snapshot().contract!.operation!.operationId).not.toBe(second)

        // Once every participant prepared, the operation has committed and a
        // press is a deliberate restart (for example after a rejected play()).
        room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 90, 1))
        room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 90, 1))
        const committed = room.snapshot().contract!.operation!
        expect(committed.phase).toBe('committed')
        expect(press(room, 90)).toMatchObject({ reason: 'control_play_pending' })
        expect(room.snapshot().contract!.operation!.operationId).not.toBe(committed.operationId)

        // A participant joining changes who must prepare; the old operation is
        // cancelled and the press starts a new one that includes them.
        const before = room.snapshot().contract!.operation!.operationId
        room.join({ id: 'participant_third', name: 'Third', media, capabilities: CURRENT_CLIENT_CAPABILITIES })
        room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_third', true)
        room.setReady('participant_third', true, media)
        expect(press(room, 90)).toMatchObject({ reason: 'control_play_pending' })
        expect(room.snapshot().contract!.operation!.operationId).not.toBe(before)
        expect(room.snapshot().contract!.operation!.requiredParticipantIds).toContain('participant_third')
      })
    })

    it('preserves resume intent when a seek supersedes a currently playing operation', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 40)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
      expect(committed).toMatchObject({ ok: true, snapshot: { playback: { status: 'playing' } } })

      const sought = controlTransactional(room, 'seek', 80)
      expect(sought).toMatchObject({
        ok: true,
        snapshot: { playback: { status: 'paused' }, contract: { operation: { kind: 'seek', resumeWhenReady: true } } },
      })
    })

    it('cancels between prepare and start and preserves the requested target without shrinking the quorum', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 80)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 80, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 80, 1))
      expect(committed).toMatchObject({ ok: true, snapshot: { contract: { operation: { phase: 'committed' } } } })

      nowMs += 100
      const failed = room.updatePlayerStatus('participant_friend', room.snapshot().revision, {
        positionSeconds: 80,
        durationSeconds: 600,
        paused: true,
        buffering: false,
        sampledAtLocalMs: nowMs,
        playbackStartFailed: true,
      })
      expect(failed).toMatchObject({
        ok: true,
        reason: 'participant_playback_blocked',
        snapshot: {
          playback: { status: 'paused', positionSeconds: 80 },
          contract: { operation: { phase: 'cancelled', reason: 'start-rejected', requiredParticipantIds: ['participant_host', 'participant_friend'] } },
        },
      })
      expect(room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 80, 2))).toBeNull()
    })

    it('uses the coordinator clock, not an arbitrary failed guest sample, for steady-play recovery', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 20)
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 20, 1))
      const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 20, 1))
      if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
        throw new Error('Expected a committed operation.')
      nowMs = committed.snapshot.contract.operation.effectiveAtServerMs
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 20, 2))
      room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 20, 2))

      nowMs += 2_000
      const recovered = room.updatePlayerStatus('participant_friend', room.snapshot().revision, {
        positionSeconds: 599,
        durationSeconds: 600,
        paused: false,
        buffering: false,
        sampledAtLocalMs: nowMs,
        progressed: false,
        playbackStarted: true,
      })
      expect(recovered).toMatchObject({ ok: true, reason: 'participant_playback_stalled', snapshot: { playback: { status: 'paused' }, contract: { operation: { phase: 'cancelled', reason: 'manual-recovery' } } } })
      expect(recovered?.snapshot.playback.positionSeconds).toBeLessThan(30)
    })

    it('cancels on lease transfer, fails closed on the deadline, and restores pending transactional state', () => {
      let nowMs = 10_000
      const room = createTransactionalRoom(() => nowMs)
      controlTransactional(room, 'play', 55)
      const pendingOperation = room.snapshot().contract!.operation!
      room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 55, 1))
      const transferred = room.transferControl('participant_host', 'participant_friend', room.snapshot().controller.leaseEpoch)
      expect(transferred).toMatchObject({ ok: true, snapshot: { contract: { operation: { phase: 'cancelled', reason: 'superseded' } } } })
      expect(room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 55, 1))).toBeNull()

      const secondRoom = createTransactionalRoom(() => nowMs)
      controlTransactional(secondRoom, 'play', 55)
      const restored = RoomCoordinator.fromState(secondRoom.exportState(), () => nowMs)
      const deadline = restored.snapshot().contract!.operation!.deadlineAtServerMs
      nowMs = deadline
      expect(restored.releaseExpiredOperation()).toMatchObject({ ok: true, reason: 'operation_timeout_paused', snapshot: { playback: { status: 'paused', positionSeconds: 55 }, contract: { operation: { phase: 'failed', reason: 'deadline-expired' } } } })
      expect(pendingOperation.mediaEpoch).toBe(restored.snapshot().contract!.operation!.mediaEpoch)

      const navigatedRoom = createTransactionalRoom(() => nowMs)
      controlTransactional(navigatedRoom, 'play', 55)
      const navigation = navigatedRoom.openLink('participant_host', {
        actionId: 'transactional_navigation',
        basedOnRevision: navigatedRoom.snapshot().revision,
        leaseEpoch: navigatedRoom.snapshot().controller.leaseEpoch,
        url: 'https://video.example/watch/new-episode',
      })
      expect(navigation).toMatchObject({ ok: true, reason: 'link_opened', snapshot: { playback: { status: 'paused', positionSeconds: 0 }, contract: { mediaEpoch: 1, operation: null } } })
    })
  })

  describe('host-approval join (SYJ-AUD-003)', () => {
    it('places a new join request in pendingJoinRequests, not participants', () => {
      const room = createRoom()
      const joined = room.join({ id: 'participant_friend', name: 'Rana', media })

      expect(joined).toMatchObject({ ok: true, reason: 'join_pending' })
      expect(joined.snapshot.participants.map(p => p.id)).toEqual(['participant_host'])
      expect(joined.snapshot.pendingJoinRequests).toEqual([
        { id: 'participant_friend', name: 'Rana', requestedAtMs: expect.any(Number) },
      ])
    })

    it('never exposes media or a session token on a pending join request', () => {
      const room = createRoom()
      const joined = room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })
      const request = joined.snapshot.pendingJoinRequests[0]

      expect(request).not.toHaveProperty('media')
      expect(request).not.toHaveProperty('sessionToken')
      expect(Object.keys(request ?? {}).sort()).toEqual(['id', 'name', 'requestedAtMs'].sort())
    })

    it('approving a pending request moves it into participants with the standard new-member defaults', () => {
      const room = createRoom()
      const joined = room.join({ id: 'participant_friend', name: 'Rana', media })
      const approved = room.respondToJoin('participant_host', joined.snapshot.controller.leaseEpoch, 'participant_friend', true)

      expect(approved).toMatchObject({ ok: true, reason: 'join_approved' })
      expect(approved.snapshot.pendingJoinRequests).toEqual([])
      expect(approved.snapshot.participants).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'participant_friend',
          name: 'Rana',
          role: 'member',
          ready: false,
          connected: true,
          mediaMatches: true,
          latencyMs: null,
        }),
      ]))
    })

    it('denying a pending request removes it without touching other participants or the revision-based invariants', () => {
      const room = createRoom()
      const joined = room.join({ id: 'participant_friend', name: 'Rana', media })
      const revisionBeforeDeny = joined.snapshot.revision

      const denied = room.respondToJoin('participant_host', joined.snapshot.controller.leaseEpoch, 'participant_friend', false)

      expect(denied).toMatchObject({ ok: true, reason: 'join_denied' })
      expect(denied.snapshot.pendingJoinRequests).toEqual([])
      expect(denied.snapshot.participants.map(p => p.id)).toEqual(['participant_host'])
      expect(denied.snapshot.revision).toBeGreaterThan(revisionBeforeDeny)

      // The identity is gone from pendingJoinRequests entirely -- it can only
      // come back by submitting a brand-new join request.
      const secondResponse = room.respondToJoin('participant_host', denied.snapshot.controller.leaseEpoch, 'participant_friend', true)
      expect(secondResponse).toMatchObject({ ok: false, code: 'not_found' })
    })

    it('rejects respondToJoin from a non-controller or with a stale lease epoch', () => {
      const room = createRoom()
      const joined = room.join({ id: 'participant_friend', name: 'Rana', media })

      const fromNonController = room.respondToJoin('participant_someone_else', joined.snapshot.controller.leaseEpoch, 'participant_friend', true)
      expect(fromNonController).toMatchObject({ ok: false, code: 'controller_only' })
      expect(fromNonController.snapshot.pendingJoinRequests).toHaveLength(1)

      const withStaleLease = room.respondToJoin('participant_host', joined.snapshot.controller.leaseEpoch + 1, 'participant_friend', true)
      expect(withStaleLease).toMatchObject({ ok: false, code: 'controller_only' })
      expect(withStaleLease.snapshot.pendingJoinRequests).toHaveLength(1)
    })

    it('caps pending requests plus connected participants combined at 10, the same as the connected-only cap', () => {
      const room = createRoom()
      const memberIds = Array.from({ length: 9 }, (_, index) => `participant_member_${index}`)
      for (const id of memberIds)
        joinApproved(room, { id, name: id, media })
      expect(room.snapshot().participants).toHaveLength(10)

      const overflow = room.join({ id: 'participant_overflow', name: 'Overflow', media })
      expect(overflow).toMatchObject({ ok: false, code: 'room_full' })
      expect(overflow.snapshot.pendingJoinRequests).toEqual([])

      // Freeing one connected slot without approving anyone lets exactly one
      // new request become pending -- and no more, since 9 connected + 1
      // pending is already back at the cap of 10.
      room.disconnect(memberIds[0]!)
      const admitted = room.join({ id: 'participant_pending_1', name: 'Pending One', media })
      expect(admitted).toMatchObject({ ok: true, reason: 'join_pending' })

      const secondOverflow = room.join({ id: 'participant_pending_2', name: 'Pending Two', media })
      expect(secondOverflow).toMatchObject({ ok: false, code: 'room_full' })
    })

    it('re-checks the cap when a request is approved, so members who return while requests wait cannot push the room past 10', () => {
      const room = createRoom()
      const members = Array.from({ length: 8 }, (_, index) => `participant_member_${index}`)
      for (const id of members)
        joinApproved(room, { id, name: id, media })
      const connected = () => room.snapshot().participants.filter(participant => participant.connected).length
      expect(connected()).toBe(9)

      // Three members drop, so three new requests fit under the cap...
      for (const id of members.slice(0, 3))
        room.disconnect(id)
      for (let index = 0; index < 3; index += 1)
        expect(room.join({ id: `participant_late_${index}`, name: `Late ${index}`, media })).toMatchObject({ ok: true, reason: 'join_pending' })

      // ...and the same three come back while the requests are still waiting.
      for (const id of members.slice(0, 3))
        expect(room.join({ id, name: id, media })).toMatchObject({ ok: true })
      expect(connected()).toBe(9)

      const approve = (id: string, value = true) => room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, id, value)
      // One place is left: the first approval fits, the next one does not.
      expect(approve('participant_late_0')).toMatchObject({ ok: true, reason: 'join_approved' })
      const refused = approve('participant_late_1')
      expect(refused).toMatchObject({ ok: false, code: 'room_full' })
      expect(connected()).toBe(10)

      // The refused request stays pending and can still be decided.
      expect(room.snapshot().pendingJoinRequests.map(request => request.id)).toEqual(['participant_late_1', 'participant_late_2'])
      expect(approve('participant_late_1', false)).toMatchObject({ ok: true, reason: 'join_denied' })
      room.disconnect(members[0]!)
      expect(approve('participant_late_2')).toMatchObject({ ok: true, reason: 'join_approved' })
      expect(connected()).toBe(10)
    })

    it('leaves reconnecting an existing participant identity completely unaffected -- still instant, still the untouched reconnect branch', () => {
      const room = createRoom()
      joinApproved(room, { id: 'participant_friend', name: 'Rana', media })
      // An unrelated pending request for a different identity must not
      // change how an existing participant's reconnect is handled.
      room.join({ id: 'participant_stranger', name: 'Stranger', media })

      room.disconnect('participant_friend')
      const reconnected = room.join({ id: 'participant_friend', name: 'Rana', media })

      expect(reconnected).toMatchObject({ ok: true, reason: 'participant_reconnected' })
      expect(reconnected.snapshot.pendingJoinRequests.map(request => request.id)).toEqual(['participant_stranger'])
    })

    it('shows an unapproved requester only its own pending entry and nothing about the room', () => {
      const room = createRoom()
      room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })
      room.join({ id: 'participant_other', name: 'Other', media, sessionToken: 'other-session-token-0000000' })

      const view = room.pendingSnapshot('participant_friend')

      expect(view).toMatchObject({
        navigation: null,
        seek: null,
        participants: [],
        playback: { status: 'paused', positionSeconds: 0 },
        pendingJoinRequests: [{ id: 'participant_friend', name: 'Rana' }],
      })
      expect(view.contract).toBeUndefined()
      expect(JSON.stringify(view)).not.toContain('Other')
      expect(JSON.stringify(view)).not.toContain('session-token')
      expect(JSON.stringify(view)).not.toContain(media.title)
      expect(JSON.stringify(view)).not.toContain(media.canonicalId)
    })

    it('gives the placeholder a fingerprint that no real media matches instead of null, so a player stays inert', () => {
      const room = createRoom()
      room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })

      const view = room.pendingSnapshot('participant_friend')

      // A deployed content script applies a snapshot to the page's video
      // whenever the snapshot's media is null or matches. A paused-at-0
      // placeholder with null media would pause and rewind the requester's
      // video; a non-null fingerprint that matches nothing makes it stop at
      // its episode-mismatch guard.
      expect(view.media).not.toBeNull()
      const realMedia: MediaFingerprint[] = [
        media,
        { service: 'youtube', canonicalId: 'youtube:abc123', title: 'A video', durationSeconds: 600 },
        { service: 'crunchyroll', canonicalId: 'crunchyroll:GE00365016JAJP', title: 'Episode', durationSeconds: null },
        { service: 'netflix', canonicalId: 'netflix:80100172', title: 'Show', durationSeconds: 3_000 },
        { service: 'html5', canonicalId: 'page:https://watch.example/episode/42', title: 'Page', durationSeconds: null, pageUrl: 'https://watch.example/episode/42' },
      ]
      for (const candidate of realMedia)
        expect(mediaMatches(view.media, candidate)).toBe(false)
    })

    it('carries no room-derived counter, controller identity or time in the placeholder', () => {
      let nowMs = 10_000
      const room = createRoom(() => nowMs)
      room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })
      nowMs = 55_000
      room.setReady('participant_host', true, media)
      const full = room.snapshot()
      expect(full.revision).toBeGreaterThan(0)
      expect(full.playback.effectiveAtServerMs).toBeGreaterThan(0)

      const view = room.pendingSnapshot('participant_friend')

      expect(view.revision).toBe(0)
      expect(view.playback.effectiveAtServerMs).toBe(0)
      expect(view.controller.leaseEpoch).toBe(0)
      expect(view.controller.participantId).not.toBe(full.controller.participantId)
      // The participant-id grammar cannot produce this value, so a client
      // can never pick it as its own id and read the placeholder as the
      // controller.
      expect(view.controller.participantId).toMatch(/[^a-zA-Z0-9_-]/)
    })

    it('does not let another session take over a pending request by reusing its participant id', () => {
      const room = createRoom()
      room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })

      const withoutToken = room.join({ id: 'participant_friend', name: 'Attacker', media })
      const wrongToken = room.join({ id: 'participant_friend', name: 'Attacker', media, sessionToken: 'someone-elses-token-0000000' })

      expect(withoutToken).toMatchObject({ ok: false, code: 'session_invalid' })
      expect(wrongToken).toMatchObject({ ok: false, code: 'session_invalid' })
      expect(room.snapshot().pendingJoinRequests).toEqual([
        { id: 'participant_friend', name: 'Rana', requestedAtMs: expect.any(Number) },
      ])
    })

    it('lets the same session re-attach to its pending request without losing its place', () => {
      let nowMs = 10_000
      const room = createRoom(() => nowMs)
      room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })
      const requestedAtMs = room.snapshot().pendingJoinRequests[0]!.requestedAtMs
      nowMs += 5_000

      const again = room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })

      expect(again).toMatchObject({ ok: true, reason: 'join_pending' })
      expect(again.snapshot.pendingJoinRequests).toEqual([
        { id: 'participant_friend', name: 'Rana', requestedAtMs },
      ])
    })

    it('withdraws a pending request so it can no longer be approved into a member with no connection', () => {
      const room = createRoom()
      room.join({ id: 'participant_friend', name: 'Rana', media, sessionToken: 'friend-session-token-000000' })
      // The old behavior: disconnect() ignores a requester that is not a participant.
      expect(room.disconnect('participant_friend')).toBeNull()
      expect(room.hasPendingJoin('participant_friend')).toBe(true)

      const withdrawn = room.cancelPendingJoin('participant_friend')

      expect(withdrawn).toMatchObject({ ok: true, reason: 'join_cancelled', snapshot: { pendingJoinRequests: [] } })
      expect(room.hasPendingJoin('participant_friend')).toBe(false)
      const snapshot = room.snapshot()
      const approval = room.respondToJoin('participant_host', snapshot.controller.leaseEpoch, 'participant_friend', true)
      expect(approval).toMatchObject({ ok: false, code: 'not_found' })
      expect(room.hasParticipant('participant_friend')).toBe(false)
      expect(room.cancelPendingJoin('participant_friend')).toBeNull()
    })
  })
})

describe('a membership change while a transactional Play is running', () => {
  /** A Play at 40 s that both participants have started, with the clock at its start time. */
  function startedPlayAt40() {
    let nowMs = 10_000
    const room = createTransactionalRoom(() => nowMs)
    controlTransactional(room, 'play', 40)
    room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
    const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
    const startAtMs = committed?.ok ? committed.snapshot.contract?.operation?.effectiveAtServerMs : null
    if (!startAtMs)
      throw new Error('Expected a committed transactional operation.')
    nowMs = startAtMs + 100
    room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.1, 2))
    room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'started', 40.1, 2))
    expect(room.snapshot().contract?.operation?.phase).toBe('started')
    return { room, startAtMs, setNow: (value: number) => { nowMs = value } }
  }

  it('pauses where the room has got to, not where the Play began, when a participant disconnects', () => {
    const { room, startAtMs, setNow } = startedPlayAt40()
    // Fifty seconds of watching later (the 0.2.11 report: 100 s, and both players had only data from there on).
    setNow(startAtMs + 50_000)

    const disconnected = room.disconnect('participant_friend')

    expect(disconnected).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' }, contract: { operation: { phase: 'cancelled', reason: 'participant-disconnected' } } } })
    expect(disconnected?.snapshot.playback.positionSeconds).toBeCloseTo(90, 0)
  })

  it('keeps that position when the participant comes back', () => {
    const { room, startAtMs, setNow } = startedPlayAt40()
    setNow(startAtMs + 50_000)
    room.disconnect('participant_friend')

    setNow(startAtMs + 51_000)
    const rejoined = room.join({ id: 'participant_friend', name: 'Rana', media, capabilities: CURRENT_CLIENT_CAPABILITIES })

    expect(rejoined).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })
    expect(rejoined.snapshot.playback.positionSeconds).toBeCloseTo(90, 0)
  })

  it('also pauses where the room has got to when a participant becomes not ready', () => {
    const { room, startAtMs, setNow } = startedPlayAt40()
    setNow(startAtMs + 50_000)

    const result = room.setReady('participant_friend', false, media)

    expect(result).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })
    expect(result.snapshot.playback.positionSeconds).toBeCloseTo(90, 0)
  })

  it('pauses at the target when the Play had not started yet', () => {
    let nowMs = 10_000
    const room = createTransactionalRoom(() => nowMs)
    controlTransactional(room, 'play', 40)
    nowMs += 500

    const disconnected = room.disconnect('participant_friend')

    expect(disconnected).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused', positionSeconds: 40 }, contract: { operation: { phase: 'cancelled', reason: 'participant-disconnected' } } } })
  })

  it('pauses at the target when the Play was committed but its start time had not come', () => {
    let nowMs = 10_000
    const room = createTransactionalRoom(() => nowMs)
    controlTransactional(room, 'play', 40)
    room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
    const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
    if (!committed?.ok || !committed.snapshot.contract?.operation?.effectiveAtServerMs)
      throw new Error('Expected a committed transactional operation.')
    nowMs = committed.snapshot.contract.operation.effectiveAtServerMs - 100

    const disconnected = room.disconnect('participant_friend')

    expect(disconnected).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused', positionSeconds: 40 }, contract: { operation: { phase: 'cancelled', reason: 'participant-disconnected' } } } })
  })

  /** A committed Play whose start time has come and gone with no start acknowledgement from anyone. */
  function committedPlayPastItsStart() {
    let nowMs = 10_000
    const room = createTransactionalRoom(() => nowMs)
    controlTransactional(room, 'play', 40)
    room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'prepared', 40, 1))
    const committed = room.acknowledgeOperation('participant_friend', operationAcknowledgement(room, 'participant_friend', 'prepared', 40, 1))
    const operation = committed?.ok ? committed.snapshot.contract?.operation : null
    if (!operation?.effectiveAtServerMs)
      throw new Error('Expected a committed transactional operation.')
    return { room, operation, effectiveAtServerMs: operation.effectiveAtServerMs, setNow: (value: number) => { nowMs = value } }
  }

  it('pauses where the room has got to when someone confirmed starting and a participant then leaves', () => {
    const { room, effectiveAtServerMs, setNow } = committedPlayPastItsStart()
    setNow(effectiveAtServerMs + 2_000)
    room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 42, 2))
    expect(room.snapshot().contract?.operation?.phase).toBe('committed')

    const left = room.disconnect('participant_friend')

    expect(left).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused' } } })
    expect(left?.snapshot.playback.positionSeconds).toBeCloseTo(42, 0)
  })

  it('pauses at the target when a participant leaves after the start deadline but before the timeout was handled, even though someone confirmed starting', () => {
    const { room, operation, effectiveAtServerMs, setNow } = committedPlayPastItsStart()
    setNow(effectiveAtServerMs + 500)
    const confirmed = room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
    expect(confirmed).toMatchObject({ ok: true, reason: 'operation_participant_started' })
    // The deadline has passed and the sweep that would have timed the start out has not run yet.
    setNow(operation.deadlineAtServerMs + 1)

    const left = room.disconnect('participant_friend')

    expect(left).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused', positionSeconds: 40 }, contract: { operation: { phase: 'cancelled', reason: 'participant-disconnected' } } } })
  })

  it('pauses at the target when a start times out even though someone confirmed it', () => {
    const { room, operation, effectiveAtServerMs, setNow } = committedPlayPastItsStart()
    setNow(effectiveAtServerMs + 500)
    room.acknowledgeOperation('participant_host', operationAcknowledgement(room, 'participant_host', 'started', 40.5, 2))
    setNow(operation.deadlineAtServerMs + 1)

    const released = room.releaseExpiredOperation()

    expect(released).toMatchObject({ ok: true, reason: 'operation_timeout_paused', snapshot: { playback: { status: 'paused', positionSeconds: 40 } } })
  })

  it('pauses at the target when a participant disconnects after the start time but before anyone confirmed starting', () => {
    const { room, effectiveAtServerMs, setNow } = committedPlayPastItsStart()
    setNow(effectiveAtServerMs + 3_000)

    const disconnected = room.disconnect('participant_friend')

    expect(disconnected).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused', positionSeconds: 40 }, contract: { operation: { phase: 'cancelled', reason: 'participant-disconnected' } } } })
  })

  it('pauses at the target when a Play that never started times out', () => {
    const { room, operation, setNow } = committedPlayPastItsStart()
    setNow(operation.deadlineAtServerMs + 1)

    const released = room.releaseExpiredOperation()

    expect(released).toMatchObject({ ok: true, reason: 'operation_timeout_paused', snapshot: { playback: { status: 'paused', positionSeconds: 40 } } })
  })
})
