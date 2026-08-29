import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'

const media = {
  service: 'html5',
  canonicalId: 'page:https://fixture.example/watch/chaos',
  title: 'Chaos fixture',
  durationSeconds: 900,
  pageUrl: 'https://fixture.example/watch/chaos',
}

describe('deterministic network-chaos simulation', () => {
  it('keeps rapid controls ordered and duplicate delivery idempotent', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    const leaseEpoch = room.snapshot().controller.leaseEpoch
    const baseRevision = room.snapshot().revision

    const playing = room.control('host', {
      actionId: 'chaos-play', basedOnRevision: baseRevision, leaseEpoch, kind: 'play', positionSeconds: 0,
    })
    expect(playing).toMatchObject({ ok: true, snapshot: { playback: { status: 'playing' } } })

    nowMs += 65
    const paused = room.control('host', {
      actionId: 'chaos-pause', basedOnRevision: baseRevision, leaseEpoch, kind: 'pause', positionSeconds: 4,
    })
    expect(paused).toMatchObject({ ok: true, snapshot: { playback: { status: 'paused', positionSeconds: 4 } } })

    const duplicate = room.control('host', {
      actionId: 'chaos-pause', basedOnRevision: baseRevision, leaseEpoch, kind: 'pause', positionSeconds: 4,
    })
    expect(duplicate).toMatchObject({ ok: true, reason: 'duplicate_action' })
  })

  it('waits for all ready participants despite jitter before resuming a seek', () => {
    let nowMs = 20_000
    const room = readyRoom(() => nowMs)
    const beforePlay = room.snapshot()
    const started = room.control('host', {
      actionId: 'chaos-preplay',
      basedOnRevision: beforePlay.revision,
      leaseEpoch: beforePlay.controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 0,
    })
    expect(started).toMatchObject({ ok: true, snapshot: { playback: { status: 'playing' } } })
    const snapshot = room.snapshot()
    const seek = room.control('host', {
      actionId: 'chaos-seek',
      basedOnRevision: snapshot.revision,
      leaseEpoch: snapshot.controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 240,
      controllerSeekApplied: true,
    })
    expect(seek).toMatchObject({ ok: true, snapshot: { seek: { positionSeconds: 240 } } })
    if (!seek.ok)
      throw new Error('Expected the seek barrier to be created.')

    nowMs += 85
    const friendAck = room.acknowledgeSeek('friend', seek.snapshot.revision, 240.08)
    expect(friendAck).toMatchObject({
      ok: true,
      reason: 'seek_aligned_play_scheduled',
      snapshot: { playback: { status: 'playing', positionSeconds: 240 }, seek: null },
    })
  })

  it('keeps a fixed paused target when jitter exceeds the barrier deadline', () => {
    let nowMs = 30_000
    const room = readyRoom(() => nowMs)
    const snapshot = room.snapshot()
    const seek = room.control('host', {
      actionId: 'chaos-timeout-seek',
      basedOnRevision: snapshot.revision,
      leaseEpoch: snapshot.controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 480,
    })
    expect(seek.ok).toBe(true)
    if (!seek.ok || !seek.snapshot.seek)
      throw new Error('Expected a pending seek.')

    nowMs = seek.snapshot.seek.deadlineAtServerMs + 1
    const released = room.releaseExpiredSeek(nowMs)
    expect(released).toMatchObject({
      ok: true,
      reason: 'seek_timeout_paused',
      snapshot: { playback: { status: 'paused', positionSeconds: 480 }, seek: null },
    })
  })
})

function readyRoom(now: () => number): RoomCoordinator {
  const room = new RoomCoordinator(
    { roomId: 'room-chaos', code: 'CHAOS123', inviteToken: 'invite-chaos' },
    { id: 'host', name: 'Host', media },
    now,
  )
  room.join({ id: 'friend', name: 'Friend', media })
  room.setReady('host', true, media)
  room.setReady('friend', true, media)
  return room
}
