import type { MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'
import { PLAYBACK_REPORT_SILENCE_TIMEOUT_MS, PLAYBACK_STARTUP_TIMEOUT_MS } from './playback-health.ts'

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

  it('cancels a pending seek when the controller lease changes', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const sought = room.control('host', {
      actionId: 'lease-change-seek',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'seek',
      positionSeconds: 120,
    })
    expect(sought).toMatchObject({ ok: true, snapshot: { seek: { positionSeconds: 120 } } })
    if (!sought.ok || !sought.snapshot.seek)
      throw new Error('Expected a pending seek.')

    const pendingRevision = sought.snapshot.seek.revision
    const transfer = room.transferControl('host', 'guest', sought.snapshot.controller.leaseEpoch)

    expect(transfer).toMatchObject({
      ok: true,
      snapshot: {
        controller: { participantId: 'guest', leaseEpoch: 2 },
        playback: { status: 'paused', positionSeconds: 120 },
        seek: null,
      },
    })
    expect(room.acknowledgeSeek('host', pendingRevision, 120)).toBeNull()
    expect(room.acknowledgeSeek('guest', pendingRevision, 120)).toBeNull()
    expect(room.snapshot().playback.status).toBe('paused')
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
    const firstStatus = room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, waiting))
    expect(firstStatus === null || firstStatus.ok && firstStatus.reason === 'participant_status_changed').toBe(true)
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

  it('pauses a required participant that never reports startup status', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()
    const deadline = state.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS

    expect(room.nextHealthDeadlineMs()).toBe(deadline)
    nowMs = deadline - 1
    expect(room.evaluateHealth()).toBeNull()
    nowMs = deadline
    const result = room.evaluateHealth()

    expect(result).toMatchObject({
      reason: 'participant_playback_silent',
      snapshot: { playback: { status: 'paused', positionSeconds: 30 } },
    })
    const revisionAfterFailure = room.snapshot().revision
    expect(room.evaluateHealth()).toBeNull()
    expect(room.snapshot().revision).toBe(revisionAfterFailure)
  })

  it('pauses a buffering participant after its status stream goes silent', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()

    nowMs = state.playback.effectiveAtServerMs + 100
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, { buffering: true, progressed: false, playbackStarted: true }))
    const deadline = nowMs + PLAYBACK_REPORT_SILENCE_TIMEOUT_MS
    expect(room.nextHealthDeadlineMs()).toBe(deadline)
    nowMs = deadline - 1
    expect(room.evaluateHealth()).toBeNull()
    nowMs = deadline
    const result = room.evaluateHealth()

    expect(result).toMatchObject({
      reason: 'participant_playback_silent',
      snapshot: { playback: { status: 'paused' } },
    })
  })

  it('uses the observed-start deadline for a player that reports never-started and then goes silent', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()

    nowMs = state.playback.effectiveAtServerMs + 9_000
    room.updatePlayerStatus('host', state.revision, sample(nowMs, 20, {
      paused: true,
      buffering: false,
      progressed: false,
      playbackStarted: true,
    }))
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, {
      paused: true,
      buffering: true,
      progressed: false,
      playbackStarted: false,
    }))
    const deadline = state.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
    expect(room.nextHealthDeadlineMs()).toBe(deadline)
    nowMs = deadline
    expect(room.evaluateHealth()).toMatchObject({
      reason: 'participant_playback_startup_timeout',
      snapshot: { playback: { status: 'paused' } },
    })
  })

  it('pauses a player for sustained no progress without waiting for another report', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()

    nowMs = state.playback.effectiveAtServerMs + 100
    room.updatePlayerStatus('guest', state.revision, sample(nowMs, 20, { progressed: true, playbackStarted: true }))
    const deadline = nowMs + 1_800
    expect(room.nextHealthDeadlineMs()).toBe(deadline)
    nowMs = deadline - 1
    expect(room.evaluateHealth()).toBeNull()
    nowMs = deadline
    const result = room.evaluateHealth()

    expect(result).toMatchObject({
      reason: 'participant_playback_stalled',
      snapshot: { playback: { status: 'paused' } },
    })
    const revisionAfterFailure = room.snapshot().revision
    expect(room.evaluateHealth()).toBeNull()
    expect(room.snapshot().revision).toBe(revisionAfterFailure)
  })

  it('keeps health deadlines on server receipt time when client timestamps move backward', () => {
    let nowMs = 10_000
    const room = readyRoom(() => nowMs)
    control(room, 'play', 20)
    const state = room.snapshot()

    nowMs = state.playback.effectiveAtServerMs + 100
    room.updatePlayerStatus('guest', state.revision, sample(900_000, 20, { progressed: true, playbackStarted: true }))
    const acceptedDeadline = nowMs + 1_800
    nowMs += 100
    expect(room.updatePlayerStatus('guest', state.revision, sample(899_999, 20.1, { progressed: true, playbackStarted: true }))).toBeNull()
    expect(room.exportState().participants.find(participant => participant.id === 'guest')?.lastSample?.sampledAtLocalMs).toBe(900_000)
    expect(room.nextHealthDeadlineMs()).toBe(acceptedDeadline)
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
    }))).toMatchObject({ ok: true, reason: 'participant_status_changed', snapshot: { participants: expect.arrayContaining([expect.objectContaining({ id: 'guest', playbackStatus: 'buffering' })]) } })
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

describe('player reports: a replayed report, a client clock step and the order of reports (CR-B04, Option A)', () => {
  /** A Play to 20 s that both players have started and are reporting progress for, one report a second. */
  function playingWithProgress(): { room: RoomCoordinator, clock: { value: number }, revision: number, startedAtMs: number } {
    const clock = { value: 10_000 }
    const room = readyRoom(() => clock.value)
    control(room, 'play', 20)
    const state = room.snapshot()
    const startedAtMs = state.playback.effectiveAtServerMs
    clock.value = startedAtMs + 500
    for (const id of ['host', 'guest'])
      room.updatePlayerStatus(id, state.revision, sample(clock.value, 20.5, { progressed: true, playbackStarted: true }))
    return { room, clock, revision: state.revision, startedAtMs }
  }

  const evidenceOf = (room: RoomCoordinator, id: string) => {
    const participant = room.exportState().participants.find(item => item.id === id)
    return { receivedAtMs: participant?.lastSampleReceivedAtMs, progressAtMs: participant?.lastProgressAtServerMs, sampledAtLocalMs: participant?.lastSample?.sampledAtLocalMs }
  }

  describe('a report delivered again', () => {
    it('does not refresh when the coordinator last heard from the player, or when it last saw progress', () => {
      const { room, clock, revision } = playingWithProgress()
      const accepted = sample(clock.value, 20.5, { progressed: true, playbackStarted: true })
      const before = evidenceOf(room, 'guest')
      const deadlineBefore = room.nextHealthDeadlineMs()

      clock.value += 700
      expect(room.updatePlayerStatus('guest', revision, accepted)).toBeNull()

      expect(evidenceOf(room, 'guest')).toEqual(before)
      expect(room.nextHealthDeadlineMs()).toBe(deadlineBefore)
    })

    it('cannot keep a stopped player alive: repeating its last progress report does not postpone the stall pause', () => {
      const { room, clock, revision } = playingWithProgress()
      const lastProgressAtMs = clock.value
      const lastReport = sample(clock.value, 20.5, { progressed: true, playbackStarted: true })

      // The guest's player has frozen; something keeps delivering its last good report every 400 ms.
      while (clock.value < lastProgressAtMs + 1_800 - 400) {
        clock.value += 400
        room.updatePlayerStatus('guest', revision, lastReport)
        room.updatePlayerStatus('host', revision, sample(clock.value, 20.5 + (clock.value - lastProgressAtMs) / 1_000, { progressed: true, playbackStarted: true }))
        expect(room.evaluateHealth()).toBeNull()
      }
      clock.value = lastProgressAtMs + 1_800
      room.updatePlayerStatus('host', revision, sample(clock.value, 22.3, { progressed: true, playbackStarted: true }))
      room.updatePlayerStatus('guest', revision, lastReport)

      expect(room.evaluateHealth()).toMatchObject({
        reason: 'participant_playback_stalled',
        snapshot: { playback: { status: 'paused' }, participants: expect.arrayContaining([expect.objectContaining({ id: 'guest', playbackStatus: 'recovery-required' })]) },
      })
    })

    it('cannot keep a silent, buffering player alive: repeating its last report does not postpone the silence pause', () => {
      const { room, clock, startedAtMs } = playingWithProgress()
      const revision = room.snapshot().revision
      const bufferingReport = sample(startedAtMs + 600, 20.6, { buffering: true, progressed: false, playbackStarted: true })
      clock.value = startedAtMs + 600
      room.updatePlayerStatus('guest', revision, bufferingReport)
      const silenceDeadlineMs = clock.value + PLAYBACK_REPORT_SILENCE_TIMEOUT_MS

      // Keep the host genuinely healthy so only the guest's silence can pause the room.
      const keepHostAlive = () => room.updatePlayerStatus('host', revision, sample(clock.value, 20 + (clock.value - startedAtMs) / 1_000, { progressed: true, playbackStarted: true }))
      while (clock.value < silenceDeadlineMs - 500) {
        clock.value += 500
        keepHostAlive()
        room.updatePlayerStatus('guest', revision, bufferingReport)
        expect(room.evaluateHealth(), `at ${clock.value - startedAtMs} ms`).toBeNull()
      }
      clock.value = silenceDeadlineMs
      keepHostAlive()
      room.updatePlayerStatus('guest', revision, bufferingReport)

      expect(room.evaluateHealth()).toMatchObject({ reason: 'participant_playback_silent', snapshot: { playback: { status: 'paused' } } })
    })

    it('rejects only a whole-report duplicate: two different reports can share a millisecond', () => {
      const { room, clock, revision } = playingWithProgress()
      const sharedMs = clock.value + 1_000
      clock.value = sharedMs
      room.updatePlayerStatus('guest', revision, sample(sharedMs, 21.5, { progressed: true, playbackStarted: true }))
      clock.value += 50
      room.updatePlayerStatus('guest', revision, sample(sharedMs, 21.6, { progressed: true, playbackStarted: true, correctionCount: 1 }))

      const stored = room.exportState().participants.find(item => item.id === 'guest')
      expect(stored?.lastSample).toMatchObject({ positionSeconds: 21.6, correctionCount: 1 })
      expect(stored?.lastSampleReceivedAtMs).toBe(clock.value)
    })
  })

  describe('a client clock that steps back', () => {
    it('does not pause healthy players: reports whose timestamps are 5 s older than before are still taken as progress', () => {
      const { room, clock, revision, startedAtMs } = playingWithProgress()
      let hostClockOffsetMs = 0
      let reported = 0
      // Eight seconds of healthy reports, one a second from each player. The host's clock steps back 5 s after the third.
      for (let second = 1; second <= 8; second++) {
        clock.value = startedAtMs + 500 + second * 1_000
        if (second === 4)
          hostClockOffsetMs = -5_000
        const positionSeconds = 20.5 + second
        room.updatePlayerStatus('host', revision, sample(clock.value + hostClockOffsetMs, positionSeconds, { progressed: true, playbackStarted: true }))
        room.updatePlayerStatus('guest', revision, sample(clock.value, positionSeconds, { progressed: true, playbackStarted: true }))
        expect(room.evaluateHealth(), `after report ${second}`).toBeNull()
        expect(room.snapshot().playback.status, `after report ${second}`).toBe('playing')
        reported += 1
      }

      expect(reported).toBe(8)
      expect(evidenceOf(room, 'host').receivedAtMs).toBe(clock.value)
      expect(evidenceOf(room, 'host').progressAtMs).toBe(clock.value)
      // The host's recorded report is the stepped-back one, so its next report (a second later on that clock) is newer.
      expect(evidenceOf(room, 'host').sampledAtLocalMs).toBe(clock.value - 5_000)
    })

    it('also copes with a step back that is shorter than a report interval and with one far longer than the silence timeout', () => {
      for (const stepMs of [400, 1_500, 60_000]) {
        const { room, clock, revision, startedAtMs } = playingWithProgress()
        for (let second = 1; second <= 6; second++) {
          clock.value = startedAtMs + 500 + second * 1_000
          const offsetMs = second >= 3 ? -stepMs : 0
          room.updatePlayerStatus('host', revision, sample(clock.value + offsetMs, 20.5 + second, { progressed: true, playbackStarted: true }))
          room.updatePlayerStatus('guest', revision, sample(clock.value, 20.5 + second, { progressed: true, playbackStarted: true }))
          expect(room.evaluateHealth(), `step ${stepMs} ms, report ${second}`).toBeNull()
        }
        expect(room.snapshot().playback.status, `step ${stepMs} ms`).toBe('playing')
      }
    })

    it('still pauses a player that has stopped, however its clock moved', () => {
      const { room, clock, revision, startedAtMs } = playingWithProgress()
      // The host's clock steps back 5 s while it plays: two reports follow the step, the second one confirming it.
      for (const second of [1, 2]) {
        clock.value = startedAtMs + 500 + second * 1_000
        room.updatePlayerStatus('host', revision, sample(clock.value - 5_000, 20.5 + second, { progressed: true, playbackStarted: true }))
        room.updatePlayerStatus('guest', revision, sample(clock.value, 20.5 + second, { progressed: true, playbackStarted: true }))
      }
      expect(evidenceOf(room, 'host').sampledAtLocalMs).toBe(clock.value - 5_000)
      const stoppedAtMs = clock.value

      // Then the host's player stops: the position stays put, nothing progresses, and its reports keep arriving on the stepped clock.
      for (let step = 1; step <= 3; step++) {
        clock.value = stoppedAtMs + step * 500
        room.updatePlayerStatus('host', revision, sample(clock.value - 5_000, 22.5, { progressed: false, playbackStarted: true }))
        room.updatePlayerStatus('guest', revision, sample(clock.value, 22.5 + step * 0.5, { progressed: true, playbackStarted: true }))
        expect(evidenceOf(room, 'host').sampledAtLocalMs, `report ${step}`).toBe(clock.value - 5_000)
      }
      expect(evidenceOf(room, 'host').progressAtMs).toBe(stoppedAtMs)
      clock.value = stoppedAtMs + 1_800
      room.updatePlayerStatus('guest', revision, sample(clock.value, 24.3, { progressed: true, playbackStarted: true }))

      expect(room.evaluateHealth()).toMatchObject({
        reason: 'participant_playback_stalled',
        snapshot: { playback: { status: 'paused' }, participants: expect.arrayContaining([expect.objectContaining({ id: 'host', playbackStatus: 'recovery-required' })]) },
      })
    })
  })

  describe('a report that arrives late', () => {
    it('is still rejected when it is older and not further along than the report already recorded', () => {
      const { room, clock, revision, startedAtMs } = playingWithProgress()
      clock.value = startedAtMs + 1_500
      room.updatePlayerStatus('guest', revision, sample(clock.value, 21.5, { progressed: true, playbackStarted: true }))
      const before = evidenceOf(room, 'guest')

      clock.value += 300
      expect(room.updatePlayerStatus('guest', revision, sample(startedAtMs + 700, 20.7, { progressed: true, playbackStarted: true }))).toBeNull()
      // Barely ahead is not enough either: only a position clearly further along than the recorded one shows a clock change.
      expect(room.updatePlayerStatus('guest', revision, sample(startedAtMs + 1_400, 21.55, { progressed: true, playbackStarted: true }))).toBeNull()

      expect(evidenceOf(room, 'guest')).toEqual(before)
    })
  })
})

describe('a report in flight across a revision that is not a new command (CR-B04)', () => {
  interface Scene {
    room: RoomCoordinator
    clock: { value: number }
    playRevision: number
    startedAtMs: number
  }

  /** A room of host, guest and a third member, playing, with host and guest reporting progress at the Play's revision. */
  function playingRoom(): Scene {
    const clock = { value: 10_000 }
    const room = readyRoom(() => clock.value)
    room.join({ id: 'third', name: 'Third', media })
    room.respondToJoin('host', room.snapshot().controller.leaseEpoch, 'third', true)
    room.setReady('host', true, media)
    room.setReady('guest', true, media)
    room.setReady('third', true, media)
    control(room, 'play', 20)
    const playRevision = room.snapshot().revision
    const startedAtMs = room.snapshot().playback.effectiveAtServerMs
    clock.value = startedAtMs + 500
    for (const id of ['host', 'guest', 'third'])
      room.updatePlayerStatus(id, playRevision, sample(clock.value, 20.5, { progressed: true, playbackStarted: true }))
    return { room, clock, playRevision, startedAtMs }
  }

  const progressAtMs = (room: RoomCoordinator, id: string) => room.exportState().participants.find(item => item.id === id)?.lastProgressAtServerMs
  const recordedSample = (room: RoomCoordinator, id: string) => room.exportState().participants.find(item => item.id === id)?.lastSample

  /** The guest's next report, built on the revision it last saw, reaches the coordinator after the event. */
  function reportInFlight(scene: Scene, overrides: Partial<PlayerSample> = {}) {
    scene.clock.value = scene.startedAtMs + 1_300
    return scene.room.updatePlayerStatus('guest', scene.playRevision, sample(scene.clock.value, 21.3, { progressed: true, playbackStarted: true, ...overrides }))
  }

  const events: Array<[string, (room: RoomCoordinator) => void]> = [
    ['a join request', (room) => { room.join({ id: 'newcomer', name: 'Newcomer', media }) }],
    ['a join request that the controller denies', (room) => {
      room.join({ id: 'newcomer', name: 'Newcomer', media })
      room.respondToJoin('host', room.snapshot().controller.leaseEpoch, 'newcomer', false)
    }],
    ['a join request that is withdrawn', (room) => {
      room.join({ id: 'newcomer', name: 'Newcomer', media })
      room.cancelPendingJoin('newcomer')
    }],
    ['a change of controller that does not pause the room', (room) => {
      room.transferControl('host', 'guest', room.snapshot().controller.leaseEpoch)
    }],
    ['a member whose connection drops and who is waited for', (room) => { room.disconnect('third') }],
    ['a member who drops and returns inside the wait', (room) => {
      room.disconnect('third')
      room.join({ id: 'third', name: 'Third', media })
    }],
  ]

  for (const [name, event] of events) {
    it(`counts a report in flight across ${name} as progress`, () => {
      const scene = playingRoom()
      event(scene.room)
      expect(scene.room.snapshot().playback.status).toBe('playing')
      expect(scene.room.snapshot().revision).toBeGreaterThan(scene.playRevision)

      reportInFlight(scene)

      expect(progressAtMs(scene.room, 'guest')).toBe(scene.clock.value)
      // It proves the player is alive; it is not kept as the report a failure is classified from.
      expect(recordedSample(scene.room, 'guest')).toMatchObject({ positionSeconds: 20.5 })
      expect(scene.room.evaluateHealth()).toBeNull()
      expect(scene.room.snapshot().playback.status).toBe('playing')
    })
  }

  it('counts a report in flight across a member becoming ready as progress', () => {
    const scene = playingRoom()
    // A member that is connected but not ready while the room plays can only be restored, never reached by a live command.
    const stored = scene.room.exportState()
    const third = stored.participants.find(participant => participant.id === 'third')!
    third.ready = false
    const room = RoomCoordinator.fromState(stored, () => scene.clock.value)
    // A restore starts with no tolerance, so take the Play's revision from the restored room.
    const playRevision = room.snapshot().revision
    expect(room.setReady('third', true, media)).toMatchObject({ ok: true, reason: 'participant_ready' })
    expect(room.snapshot().playback.status).toBe('playing')

    scene.clock.value = scene.startedAtMs + 1_300
    room.updatePlayerStatus('guest', playRevision, sample(scene.clock.value, 21.3, { progressed: true, playbackStarted: true }))

    expect(progressAtMs(room, 'guest')).toBe(scene.clock.value)
  })

  it('keeps failure classification exact: a failed start reported in flight does not pause the room or block the player', () => {
    const scene = playingRoom()
    scene.room.join({ id: 'newcomer', name: 'Newcomer', media })

    const revisionBefore = scene.room.snapshot().revision
    const result = reportInFlight(scene, { paused: true, playbackStartFailed: true, progressed: false })

    expect(result).not.toMatchObject({ reason: 'participant_playback_blocked' })
    expect(scene.room.snapshot()).toMatchObject({ revision: revisionBefore, playback: { status: 'playing' } })
    expect(scene.room.exportState().participants.find(participant => participant.id === 'guest')?.playbackBlocked).toBe(false)
    // The same report at the current revision is a failure and does pause the room.
    expect(scene.room.updatePlayerStatus('guest', scene.room.snapshot().revision, sample(scene.clock.value + 100, 21.3, { paused: true, playbackStartFailed: true, progressed: false })))
      .toMatchObject({ ok: true, reason: 'participant_playback_blocked', snapshot: { playback: { status: 'paused' } } })
  })

  it('keeps failure classification exact: a stalled report in flight does not pause the room', () => {
    const scene = playingRoom()
    scene.room.join({ id: 'newcomer', name: 'Newcomer', media })
    // The guest made no progress for longer than the timeout, but this report only counts as evidence that it is alive.
    scene.clock.value = scene.startedAtMs + 500 + 2_500
    scene.room.updatePlayerStatus('host', scene.room.snapshot().revision, sample(scene.clock.value, 23, { progressed: true, playbackStarted: true }))
    scene.room.updatePlayerStatus('third', scene.room.snapshot().revision, sample(scene.clock.value, 23, { progressed: true, playbackStarted: true }))

    const revisionBefore = scene.room.snapshot().revision
    const result = scene.room.updatePlayerStatus('guest', scene.playRevision, sample(scene.clock.value, 20.5, { progressed: false, playbackStarted: true }))

    expect(result).not.toMatchObject({ reason: 'participant_playback_stalled' })
    expect(scene.room.snapshot()).toMatchObject({ revision: revisionBefore, playback: { status: 'playing' } })
    // The stored evidence is not refreshed by a report that shows no progress, so the timer still finds the stall.
    expect(scene.room.evaluateHealth()).toMatchObject({ reason: 'participant_playback_stalled' })
  })

  it('still rejects a report from before a new Play, after an unrelated revision', () => {
    const scene = playingRoom()
    scene.room.join({ id: 'newcomer', name: 'Newcomer', media })
    scene.clock.value = scene.startedAtMs + 1_000
    control(scene.room, 'play', 40)
    const beforeLate = recordedSample(scene.room, 'guest')

    const result = reportInFlight(scene)

    expect(result).toBeNull()
    expect(recordedSample(scene.room, 'guest')).toEqual(beforeLate)
    expect(recordedSample(scene.room, 'guest')).toBeNull()
  })

  it('still rejects a report from before a resuming seek, after an unrelated revision', () => {
    const scene = playingRoom()
    scene.room.join({ id: 'newcomer', name: 'Newcomer', media })
    scene.clock.value = scene.startedAtMs + 1_000
    control(scene.room, 'seek', 300)
    const beforeLate = recordedSample(scene.room, 'guest')

    expect(reportInFlight(scene)).toBeNull()
    expect(recordedSample(scene.room, 'guest')).toEqual(beforeLate)
  })

  it('still rejects a report stamped before the Play and one stamped ahead of the room', () => {
    const scene = playingRoom()
    scene.room.join({ id: 'newcomer', name: 'Newcomer', media })
    scene.clock.value = scene.startedAtMs + 1_300
    const beforeLate = recordedSample(scene.room, 'guest')

    expect(scene.room.updatePlayerStatus('guest', scene.playRevision - 1, sample(scene.clock.value, 21.3, { progressed: true, playbackStarted: true }))).toBeNull()
    expect(scene.room.updatePlayerStatus('guest', scene.room.snapshot().revision + 1, sample(scene.clock.value, 21.3, { progressed: true, playbackStarted: true }))).toBeNull()
    expect(recordedSample(scene.room, 'guest')).toEqual(beforeLate)
  })

  it('does not carry the tolerance across a command in between: a report from before an intervening pause and Play is rejected', () => {
    const scene = playingRoom()
    scene.room.join({ id: 'newcomer', name: 'Newcomer', media })
    scene.clock.value = scene.startedAtMs + 900
    const afterJoin = scene.room.snapshot()
    scene.room.control('host', { actionId: 'pause-between', basedOnRevision: afterJoin.revision, leaseEpoch: afterJoin.controller.leaseEpoch, kind: 'pause', positionSeconds: 21 })
    scene.room.join({ id: 'second', name: 'Second', media })

    expect(reportInFlight(scene)).toBeNull()
  })

  it('does not keep the tolerance across a restore: a restored room starts with none', () => {
    const scene = playingRoom()
    scene.room.join({ id: 'newcomer', name: 'Newcomer', media })
    scene.clock.value = scene.startedAtMs + 1_300
    const restored = RoomCoordinator.fromState(scene.room.exportState(), () => scene.clock.value)

    const progressBefore = progressAtMs(restored, 'guest')
    restored.updatePlayerStatus('guest', scene.playRevision, sample(scene.clock.value, 21.3, { progressed: true, playbackStarted: true }))
    expect(progressAtMs(restored, 'guest')).toBe(progressBefore)
    restored.updatePlayerStatus('guest', restored.snapshot().revision, sample(scene.clock.value, 21.3, { progressed: true, playbackStarted: true }))
    expect(progressAtMs(restored, 'guest')).toBe(scene.clock.value)
  })
})

describe('a report that is only evidence the player is alive (CR-B04, review findings)', () => {
  function playing(): { room: RoomCoordinator, clock: { value: number }, revision: number, startedAtMs: number } {
    const clock = { value: 10_000 }
    const room = readyRoom(() => clock.value)
    control(room, 'play', 20)
    const state = room.snapshot()
    return { room, clock, revision: state.revision, startedAtMs: state.playback.effectiveAtServerMs }
  }
  const stored = (room: RoomCoordinator, id: string) => room.exportState().participants.find(item => item.id === id)
  const publicStatus = (room: RoomCoordinator, id: string) => room.snapshot().participants.find(item => item.id === id)?.playbackStatus

  describe('a delayed report from before a correction the player made on its own', () => {
    it('does not pause the room when it is older, further along, and says the start failed', () => {
      const { room, clock, revision, startedAtMs } = playing()
      clock.value = startedAtMs + 2_000
      room.updatePlayerStatus('host', revision, sample(startedAtMs + 2_000, 91, { progressed: true, playbackStarted: true }))
      room.updatePlayerStatus('guest', revision, sample(startedAtMs + 2_000, 91, { progressed: true, playbackStarted: true }))
      clock.value += 100

      // The player pulled itself back from 100 s to 91 s; the report from before the correction arrives afterwards.
      const late = room.updatePlayerStatus('guest', revision, sample(startedAtMs + 1_000, 100, { paused: true, progressed: false, playbackStarted: true, playbackStartFailed: true }))

      expect(late).not.toMatchObject({ reason: 'participant_playback_blocked' })
      expect(room.snapshot().playback.status).toBe('playing')
      expect(stored(room, 'guest')?.lastSample).toMatchObject({ positionSeconds: 91 })
      expect(stored(room, 'guest')?.playbackBlocked).toBe(false)
      expect(publicStatus(room, 'guest')).not.toBe('blocked')
    })

    it('rejects it outright when the player has made more corrections since it was sent', () => {
      const { room, clock, revision, startedAtMs } = playing()
      clock.value = startedAtMs + 2_000
      room.updatePlayerStatus('guest', revision, sample(startedAtMs + 2_000, 30.1, { progressed: true, playbackStarted: true, correctionCount: 1 }))
      const before = stored(room, 'guest')
      clock.value += 300

      expect(room.updatePlayerStatus('guest', revision, sample(startedAtMs + 1_000, 40, { progressed: true, playbackStarted: true, correctionCount: 0 }))).toBeNull()

      expect(stored(room, 'guest')?.lastSample).toEqual(before?.lastSample)
      expect(stored(room, 'guest')?.lastProgressAtServerMs).toBe(before?.lastProgressAtServerMs)
      expect(stored(room, 'guest')?.lastSampleReceivedAtMs).toBe(before?.lastSampleReceivedAtMs)
    })
  })

  describe('a report stamped with an older revision that only counts as progress', () => {
    it('does not become the evidence the timer classifies a failure from: a report that says the player had not started', () => {
      const { room, clock, revision, startedAtMs } = playing()
      clock.value = startedAtMs + 11_000
      for (const id of ['host', 'guest'])
        room.updatePlayerStatus(id, revision, sample(clock.value, 31, { progressed: true, playbackStarted: true }))
      room.join({ id: 'newcomer', name: 'Newcomer', media })
      clock.value += 200

      room.updatePlayerStatus('guest', revision, sample(clock.value, 31.2, { progressed: false, playbackStarted: false, paused: true }))

      expect(stored(room, 'guest')?.lastSample).toMatchObject({ playbackStarted: true, paused: false })
      expect(room.evaluateHealth()).toBeNull()
      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('does not show the participant as blocked, because an older report must not classify a failure', () => {
      const { room, clock, revision, startedAtMs } = playing()
      clock.value = startedAtMs + 1_000
      for (const id of ['host', 'guest'])
        room.updatePlayerStatus(id, revision, sample(clock.value, 21, { progressed: true, playbackStarted: true }))
      room.join({ id: 'newcomer', name: 'Newcomer', media })
      clock.value += 200

      room.updatePlayerStatus('guest', revision, sample(clock.value, 21.2, { paused: true, progressed: false, playbackStartFailed: true }))

      expect(publicStatus(room, 'guest')).not.toBe('blocked')
      expect(room.snapshot().playback.status).toBe('playing')
    })

    it('still proves the player is alive: progress and the last time it was heard from move', () => {
      const { room, clock, revision, startedAtMs } = playing()
      clock.value = startedAtMs + 1_000
      for (const id of ['host', 'guest'])
        room.updatePlayerStatus(id, revision, sample(clock.value, 21, { progressed: true, playbackStarted: true }))
      room.join({ id: 'newcomer', name: 'Newcomer', media })
      clock.value += 700

      room.updatePlayerStatus('guest', revision, sample(clock.value, 21.7, { progressed: true, playbackStarted: true }))

      expect(stored(room, 'guest')?.lastProgressAtServerMs).toBe(clock.value)
      expect(stored(room, 'guest')?.lastSampleReceivedAtMs).toBe(clock.value)
    })
  })

  describe('a clock step is told from a late report by the next report', () => {
    it('takes the first stepped-back report as evidence that the player is alive, and the next one that follows it as the newest report', () => {
      const { room, clock, revision, startedAtMs } = playing()
      clock.value = startedAtMs + 1_000
      room.updatePlayerStatus('host', revision, sample(clock.value, 21, { progressed: true, playbackStarted: true }))
      room.updatePlayerStatus('guest', revision, sample(clock.value, 21, { progressed: true, playbackStarted: true }))

      // The guest's clock steps back 5 s: older timestamp, further along.
      clock.value = startedAtMs + 2_000
      room.updatePlayerStatus('guest', revision, sample(startedAtMs + 2_000 - 5_000, 22, { progressed: true, playbackStarted: true }))
      expect(stored(room, 'guest')?.lastSample).toMatchObject({ positionSeconds: 21 })
      expect(stored(room, 'guest')?.lastProgressAtServerMs).toBe(clock.value)

      clock.value = startedAtMs + 3_000
      room.updatePlayerStatus('guest', revision, sample(startedAtMs + 3_000 - 5_000, 23, { progressed: true, playbackStarted: true }))
      expect(stored(room, 'guest')?.lastSample).toMatchObject({ positionSeconds: 23, sampledAtLocalMs: startedAtMs - 2_000 })
    })

    it('does not confirm a step from a second late report that is older than the first, or not further along', () => {
      const { room, clock, revision, startedAtMs } = playing()
      clock.value = startedAtMs + 2_000
      room.updatePlayerStatus('guest', revision, sample(startedAtMs + 2_000, 91, { progressed: true, playbackStarted: true }))
      clock.value += 100
      room.updatePlayerStatus('guest', revision, sample(startedAtMs + 1_000, 100, { progressed: true, playbackStarted: true }))
      clock.value += 100
      // Older than the first late report: not a step forward of it.
      room.updatePlayerStatus('guest', revision, sample(startedAtMs + 500, 101, { progressed: true, playbackStarted: true }))

      expect(stored(room, 'guest')?.lastSample).toMatchObject({ positionSeconds: 91 })
    })
  })
})
