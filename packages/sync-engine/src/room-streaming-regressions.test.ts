import type { MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'
import { PLAYBACK_STARTUP_TIMEOUT_MS } from './playback-health.ts'

const media: MediaFingerprint = {
  service: 'crunchyroll',
  canonicalId: 'crunchyroll:EPISODE123',
  title: 'Adaptive streaming fixture',
  durationSeconds: 1_400,
}

function readyRoom(now: () => number): RoomCoordinator {
  const room = new RoomCoordinator(
    { roomId: 'streaming-room', code: 'STREAM23' },
    { id: 'host', name: 'Host', media },
    now,
  )
  room.join({ id: 'guest', name: 'Guest', media })
  room.respondToJoin('host', room.snapshot().controller.leaseEpoch, 'guest', true)
  room.setReady('host', true, media)
  room.setReady('guest', true, media)
  return room
}

function control(room: RoomCoordinator, kind: 'play' | 'seek', positionSeconds: number): void {
  const state = room.snapshot()
  const result = room.control('host', {
    actionId: `${kind}-${state.revision}`,
    basedOnRevision: state.revision,
    leaseEpoch: state.controller.leaseEpoch,
    kind,
    positionSeconds,
  })
  expect(result.ok).toBe(true)
}

function sample(atMs: number, positionSeconds: number, overrides: Partial<PlayerSample> = {}): PlayerSample {
  return {
    positionSeconds,
    durationSeconds: media.durationSeconds,
    paused: false,
    buffering: false,
    sampledAtLocalMs: atMs,
    ...overrides,
  }
}

describe('adaptive streaming coordination regressions', () => {
  it('does not accept a seek acknowledgement at the exact barrier deadline', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const sought = room.control('host', {
      actionId: 'deadline-seek',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 120,
    })
    expect(sought.ok).toBe(true)
    if (!sought.ok || !sought.snapshot.seek)
      throw new Error('Expected a pending seek.')

    nowMs = sought.snapshot.seek.deadlineAtServerMs
    const result = room.acknowledgeSeek('host', sought.snapshot.seek.revision, 120)

    expect(result).toMatchObject({
      ok: true,
      reason: 'seek_timeout_paused',
      snapshot: { playback: { status: 'paused', positionSeconds: 120 }, seek: null },
    })
  })

  it('cancels a seek when a required participant explicitly fails instead of shrinking the quorum', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    room.join({ id: 'backup', name: 'Backup', media })
    room.respondToJoin('host', room.snapshot().controller.leaseEpoch, 'backup', true)
    room.setReady('backup', true, media)
    control(room, 'play', 20)
    const sought = room.control('host', {
      actionId: 'failed-member-seek',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 120,
    })
    expect(sought.ok).toBe(true)
    if (!sought.ok || !sought.snapshot.seek)
      throw new Error('Expected a pending seek.')

    nowMs += 100
    const failure = room.updatePlayerStatus('guest', sought.snapshot.revision, sample(nowMs, 120, {
      paused: true,
      playbackStarted: false,
      playbackStartFailed: true,
    }))

    expect(failure).toMatchObject({ reason: 'participant_playback_blocked' })
    expect(room.snapshot()).toMatchObject({
      playback: { status: 'paused', positionSeconds: 120 },
      seek: null,
      participants: expect.arrayContaining([
        expect.objectContaining({ id: 'guest', ready: false }),
      ]),
    })
    expect(room.acknowledgeSeek('host', sought.snapshot.seek.revision, 120)).toBeNull()
    expect(room.acknowledgeSeek('backup', sought.snapshot.seek.revision, 120)).toBeNull()
  })

  it('waits for the controller to finish loading a seek even when the guest is already aligned', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    control(room, 'seek', 120)
    const revision = room.snapshot().seek!.revision

    nowMs += 80
    const guestAligned = room.acknowledgeSeek('guest', revision, 120)
    expect(guestAligned).toMatchObject({
      reason: 'seek_participant_aligned',
      snapshot: { playback: { status: 'paused' }, seek: { acknowledgedParticipantIds: ['guest'] } },
    })

    nowMs += 900
    const controllerAligned = room.acknowledgeSeek('host', revision, 120)
    expect(controllerAligned).toMatchObject({
      reason: 'seek_aligned_play_scheduled',
      snapshot: { playback: { status: 'playing', positionSeconds: 120 }, seek: null },
    })
  })

  it('does not count a corrective currentTime jump as progress when the player explicitly reports none', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()
    const startedAt = state.playback.effectiveAtServerMs

    nowMs = startedAt + 100
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, { progressed: false }))
    nowMs = startedAt + 900
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20.8, { progressed: false }))
    nowMs = startedAt + 1_800
    const result = room.updatePlayerStatus('guest', state.revision, sample(nowMs, 21.6, { progressed: false }))

    expect(result).toMatchObject({ reason: 'participant_playback_stalled', snapshot: { playback: { status: 'paused' } } })
  })

  it('does not let delayed reports from a superseded playback command reset current progress health', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const supersededRevision = room.snapshot().revision
    control(room, 'play', 120)
    const state = room.snapshot()
    const startedAt = state.playback.effectiveAtServerMs

    nowMs = startedAt + 100
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 120, { progressed: false }))
    nowMs = startedAt + 900
    room.updatePlayerStatus('guest', supersededRevision, sample(nowMs, 21, { progressed: true }))
    expect(room.exportState().participants.find(participant => participant.id === 'guest')?.lastSample?.positionSeconds).toBe(120)

    nowMs = startedAt + 1_800
    const result = room.updatePlayerStatus('guest', state.revision, sample(nowMs, 120, { progressed: false }))
    expect(result).toMatchObject({ reason: 'participant_playback_stalled', snapshot: { playback: { status: 'paused' } } })
  })

  it.each([
    { paused: true, buffering: true },
    { paused: false, buffering: false },
  ])('bounds a pending startup without marking the participant unready: %j', (playerState) => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()
    const deadline = state.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
    const waiting = { ...playerState, progressed: false, playbackStarted: false }

    nowMs = state.playback.effectiveAtServerMs + 4_000
    expect(room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, waiting))).toBeNull()
    nowMs = deadline - 1
    expect(room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, waiting))).toBeNull()
    nowMs = deadline
    const result = room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, waiting))
    expect(result).toMatchObject({
      reason: 'participant_playback_startup_timeout',
      snapshot: { playback: { status: 'paused', positionSeconds: 20 } },
    })
    expect(room.snapshot().participants.find(participant => participant.id === 'guest')?.ready).toBe(true)
  })

  it('allows a slow startup that begins making real progress before its deadline', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()
    const deadline = state.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
    nowMs = deadline - 900
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, { playbackStarted: false, progressed: false, buffering: true }))
    nowMs = deadline - 500
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20.1, { playbackStarted: true, progressed: true }))
    nowMs = deadline
    expect(room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20.6, { playbackStarted: true, progressed: true }))).toBeNull()
    expect(room.snapshot().playback.status).toBe('playing')
  })

  it('does not treat a transient player restart as ten seconds without progress', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()
    nowMs = state.playback.effectiveAtServerMs + 30_000
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 50, { playbackStarted: true, progressed: true }))
    nowMs += 100
    expect(room.updatePlayerStatus('guest', state.revision, sample(nowMs, 50, {
      playbackStarted: false,
      progressed: false,
      paused: true,
      buffering: true,
    }))).toBeNull()
    expect(room.snapshot().playback.status).toBe('playing')
  })

  it('rejects a queued play command that would otherwise bypass an unfinished seek', () => {
    const room = readyRoom(() => 10_000)
    control(room, 'play', 20)
    const beforeSeek = room.snapshot()
    control(room, 'seek', 120)
    const seekingState = room.snapshot()
    const result = room.control('host', {
      actionId: 'queued-native-play',
      basedOnRevision: beforeSeek.revision,
      leaseEpoch: beforeSeek.controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 120,
    })
    expect(result).toMatchObject({ ok: false, code: 'seek_in_progress' })
    expect(room.snapshot()).toEqual(seekingState)
  })
})
