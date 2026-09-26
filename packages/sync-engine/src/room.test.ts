import type { MediaFingerprint, OperationAcknowledgement, PlayerSample } from '@syncyourjoy/protocol'
import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'
import type { RoomResult } from './room.ts'
import { PLAYBACK_PROGRESS_TIMEOUT_MS, PLAYBACK_STARTUP_GRACE_MS } from './playback-health.ts'

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
  })
})
