import type { MediaFingerprint, RoomSnapshot } from '@syncyourjoy/protocol'
import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { applyEarliestDueDeadline, earliestAlarmAtMs, persistRoomAndSchedule, persistThenObserve } from './alarm.ts'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'

const media: MediaFingerprint = {
  service: 'youtube',
  canonicalId: 'youtube:edge-health',
  title: 'Edge health fixture',
  durationSeconds: 600,
}

function createRoom(now: () => number = () => 10_000): RoomCoordinator {
  return new RoomCoordinator(
    { roomId: 'edge_fixture', code: 'EDGE1234' },
    { id: 'participant_host', name: 'Muaz', media },
    now,
  )
}

function createTransactionalRoom(now: () => number): RoomCoordinator {
  const room = new RoomCoordinator(
    { roomId: 'edge_transactional_fixture', code: 'EDGE5678' },
    { id: 'participant_host', name: 'Muaz', media, capabilities: CURRENT_CLIENT_CAPABILITIES },
    now,
  )
  room.join({ id: 'participant_friend', name: 'Rana', media, capabilities: CURRENT_CLIENT_CAPABILITIES })
  room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
  room.setReady('participant_host', true, media)
  room.setReady('participant_friend', true, media)
  return room
}

function successfulResult(reason: string): { ok: true; reason: string; snapshot: RoomSnapshot } {
  return { ok: true, reason, snapshot: {} as RoomSnapshot }
}

describe('edge alarm and persistence boundaries', () => {
  it('selects the earliest valid alarm deadline and ignores absent values', () => {
    expect(earliestAlarmAtMs([null, undefined, 4_000, 2_000, Number.NaN, Number.POSITIVE_INFINITY])).toBe(2_000)
    expect(earliestAlarmAtMs([null, undefined])).toBeNull()
  })

  it('evaluates one deadline family per alarm turn in stable order', () => {
    const calls: string[] = []
    const coordinator = {
      releaseExpiredSeek: () => {
        calls.push('seek')
        return null
      },
      releaseExpiredOperation: () => {
        calls.push('operation')
        return successfulResult('operation_timeout_paused')
      },
      evaluateHealth: () => {
        calls.push('health')
        return successfulResult('participant_playback_stalled')
      },
    }

    const evaluation = applyEarliestDueDeadline(coordinator, 20_000)

    expect(evaluation).toMatchObject({ source: 'operation', result: { ok: true, reason: 'operation_timeout_paused' } })
    expect(calls).toEqual(['seek', 'operation'])
  })

  it('does not expose a transition until its durable write completes', async () => {
    const events: string[] = []

    await persistThenObserve(
      async () => { events.push('storage') },
      () => { events.push('broadcast') },
    )

    expect(events).toEqual(['storage', 'broadcast'])
  })

  it('persists the complete room record and schedules the earliest lifecycle deadline before observation', async () => {
    const events: string[] = []
    let storedRoom: unknown
    let scheduledAlarm: number | null = null
    const storage = {
      async put<T>(_key: string, value: T): Promise<void> {
        storedRoom = value
        events.push('storage')
      },
      async setAlarm(timestamp: number): Promise<void> {
        scheduledAlarm = timestamp
        events.push('alarm')
      },
    }
    const room = createRoom().exportState()

    await persistThenObserve(
      () => persistRoomAndSchedule(storage, {
        coordinator: room,
        pendingController: null,
        emptySinceMs: null,
        createdAtMs: 1_000,
      }, [9_000, 4_000, 8_000, 7_000, 6_000]),
      () => { events.push('broadcast') },
    )

    expect(storedRoom).toMatchObject({ coordinator: room, createdAtMs: 1_000 })
    expect(scheduledAlarm).toBe(4_000)
    expect(events).toEqual(['storage', 'alarm', 'broadcast'])
  })

  it('does not expose a transition when the durable write fails', async () => {
    const events: string[] = []

    await expect(persistThenObserve(
      async () => {
        events.push('storage')
        throw new Error('storage unavailable')
      },
      () => { events.push('broadcast') },
    )).rejects.toThrow('storage unavailable')

    expect(events).toEqual(['storage'])
  })

  it('rehydrates the last accepted sample and server progress deadline without manufacturing progress', () => {
    let nowMs = 10_000
    const room = createRoom(() => nowMs)
    room.setReady('participant_host', true, media)
    const started = room.control('participant_host', {
      actionId: 'edge_health_play',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 20,
    })
    expect(started.ok).toBe(true)

    const sample = {
      positionSeconds: 20.2,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: 10_250,
      progressed: true,
      playbackStarted: true,
    }
    nowMs = 10_250
    room.updatePlayerStatus('participant_host', room.snapshot().revision, sample)
    const stored = room.exportState()
    const storedParticipant = stored.participants.find(participant => participant.id === 'participant_host')

    expect(storedParticipant).toMatchObject({
      lastSample: sample,
      lastSampleReceivedAtMs: 10_250,
      lastProgressAtServerMs: 10_250,
    })

    const restored = RoomCoordinator.fromState(stored, () => nowMs)
    expect(restored.exportState().participants.find(participant => participant.id === 'participant_host')).toMatchObject({
      lastSample: sample,
      lastSampleReceivedAtMs: 10_250,
      lastProgressAtServerMs: 10_250,
    })
    expect(restored.nextHealthDeadlineMs()).toBe(room.nextHealthDeadlineMs())

    nowMs = restored.nextHealthDeadlineMs() ?? nowMs
    expect(restored.evaluateHealth()).toMatchObject({
      ok: true,
      reason: 'participant_playback_stalled',
      snapshot: { playback: { status: 'paused' } },
    })
  })

  it('does not release a cancelled operation after cold restore at its old deadline', () => {
    let nowMs = 10_000
    const room = createTransactionalRoom(() => nowMs)
    const pending = room.control('participant_host', {
      actionId: 'edge_cancelled_operation',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 55,
    })
    expect(pending).toMatchObject({ ok: true, snapshot: { contract: { operation: { phase: 'preparing' } } } })

    const transferred = room.transferControl('participant_host', 'participant_friend', room.snapshot().controller.leaseEpoch)
    expect(transferred).toMatchObject({ ok: true, snapshot: { contract: { operation: { phase: 'cancelled', reason: 'superseded' } } } })

    const restored = RoomCoordinator.fromState(room.exportState(), () => nowMs)
    const oldDeadline = restored.snapshot().contract?.operation?.deadlineAtServerMs ?? nowMs
    expect(restored.operationDeadlineMs()).toBeNull()

    nowMs = oldDeadline + 1_000_000
    expect(restored.releaseExpiredOperation()).toBeNull()
    expect(restored.snapshot().contract?.operation).toMatchObject({ phase: 'cancelled', reason: 'superseded' })
  })
})
