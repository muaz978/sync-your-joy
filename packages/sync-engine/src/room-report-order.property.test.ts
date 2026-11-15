import type { MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { PLAYBACK_PROGRESS_TIMEOUT_MS } from './playback-health.ts'
import { RoomCoordinator } from './room.ts'

/**
 * Property-style check of the report ordering rules (CR-B04): over many seeded
 * sequences of reports, with replays, late and re-ordered deliveries, client
 * clock steps, reports that omit `progressed`, reports stamped with an older
 * revision after a join request, a player that keeps progressing is never
 * paused, and a player that stops is always paused by its progress deadline.
 *
 * Replays are drawn from the last REPLAY_WINDOW reports a player sent. The
 * coordinator remembers 64 reports per player, and a replay older than that
 * is only dropped when it is also older and not further along.
 */

const media: MediaFingerprint = { service: 'crunchyroll', canonicalId: 'crunchyroll:PROPERTY1', title: 'Property fixture', durationSeconds: 3_000 }
const STEP_MS = 250
const REPORT_EVERY_STEPS = 2
const REPLAY_WINDOW = 40
const CLOCK_STEPS_MS = [0, -5_000, -400, 3_000, -60_000]

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Outcome {
  pausedAtMs: number | null
  pausedParticipant: string | null
  lastGenuineProgressAtMs: number
  endedAtMs: number
}

function run(seed: number, mode: 'progressing' | 'frozen', durationMs: number): Outcome {
  const random = mulberry32(seed * 2 + (mode === 'frozen' ? 1 : 0))
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const clock = { value: 10_000 }
  const room = new RoomCoordinator({ roomId: 'property-room', code: 'PROPERTY' }, { id: 'host', name: 'Host', media }, () => clock.value)
  room.join({ id: 'guest', name: 'Guest', media })
  room.respondToJoin('host', room.snapshot().controller.leaseEpoch, 'guest', true)
  room.setReady('host', true, media)
  room.setReady('guest', true, media)
  const state = room.snapshot()
  room.control('host', { actionId: `play-${seed}`, basedOnRevision: state.revision, leaseEpoch: state.controller.leaseEpoch, kind: 'play', positionSeconds: 20 })
  const playRevision = room.snapshot().revision
  const startedAtMs = room.snapshot().playback.effectiveAtServerMs

  const freezeAtMs = startedAtMs + 1_000 + Math.floor(random() * 6) * 500
  const guestReports: PlayerSample[] = []
  let guestKnownRevision = playRevision
  let guestOffsetMs = 0
  let lastGenuineProgressAtMs = startedAtMs
  let frozenPosition: number | null = null
  let newcomers = 0
  let pending: string[] = []
  const outcome: Outcome = { pausedAtMs: null, pausedParticipant: null, lastGenuineProgressAtMs, endedAtMs: startedAtMs + durationMs }

  const send = (report: PlayerSample) => {
    guestReports.push(report)
    room.updatePlayerStatus('guest', guestKnownRevision, report)
  }

  for (let step = 1; clock.value < startedAtMs + durationMs && outcome.pausedAtMs === null; step++) {
    clock.value = startedAtMs + step * STEP_MS
    const elapsedMs = clock.value - startedAtMs

    // Events that raise the revision without pausing the room.
    if (random() < 0.04 && newcomers < 6) {
      newcomers += 1
      const id = `newcomer${newcomers}`
      room.join({ id, name: id, media })
      pending.push(id)
    }
    else if (random() < 0.03 && pending.length > 0) {
      room.cancelPendingJoin(pending.shift()!)
    }
    if (random() < 0.3)
      guestKnownRevision = room.snapshot().revision
    if (random() < 0.05)
      guestOffsetMs = pick(CLOCK_STEPS_MS)

    if (step % REPORT_EVERY_STEPS === 0) {
      room.updatePlayerStatus('host', room.snapshot().revision, {
        positionSeconds: 20 + elapsedMs / 1_000,
        durationSeconds: media.durationSeconds,
        paused: false,
        buffering: false,
        sampledAtLocalMs: clock.value,
        progressed: true,
        playbackStarted: true,
      })

      const frozen = mode === 'frozen' && clock.value >= freezeAtMs
      if (frozen && frozenPosition === null)
        frozenPosition = 20 + (lastGenuineProgressAtMs - startedAtMs) / 1_000
      const previous = guestReports.at(-1)
      const report: PlayerSample = {
        positionSeconds: frozen ? frozenPosition! : 20 + elapsedMs / 1_000,
        durationSeconds: media.durationSeconds,
        paused: false,
        buffering: false,
        sampledAtLocalMs: Math.max(0, clock.value + guestOffsetMs),
        playbackStarted: true,
        // The first report states its progress: a first report that omits it has no earlier one to be compared with.
        ...(guestReports.length === 0 ? { progressed: true } : frozen ? (random() < 0.5 ? { progressed: false } : {}) : (random() < 0.5 ? { progressed: true } : {})),
      }
      if (!frozen)
        lastGenuineProgressAtMs = clock.value
      send(report)
      // Deliveries that arrive again, or late.
      const recent = guestReports.slice(-REPLAY_WINDOW)
      if (random() < 0.3)
        send(pick(recent))
      if (random() < 0.15)
        send(report)
      if (previous !== undefined && random() < 0.1)
        send(previous)
    }
    else if (random() < 0.3 && guestReports.length > 0) {
      send(pick(guestReports.slice(-REPLAY_WINDOW)))
    }

    const result = room.evaluateHealth()
    if (result !== null || room.snapshot().playback.status !== 'playing') {
      outcome.pausedAtMs = clock.value
      outcome.pausedParticipant = room.snapshot().participants.find(participant => participant.playbackStatus === 'recovery-required' || participant.playbackStatus === 'silent')?.id ?? null
    }
  }
  outcome.lastGenuineProgressAtMs = lastGenuineProgressAtMs
  return outcome
}

describe('report ordering over many seeded sequences (CR-B04)', () => {
  const seeds = Array.from({ length: 300 }, (_, index) => index + 1)

  it('never pauses a player that keeps progressing, whatever the replays, clock steps, missing fields and older revisions', () => {
    const paused: Array<{ seed: number, at: number, who: string | null }> = []
    for (const seed of seeds) {
      const outcome = run(seed, 'progressing', 20_000)
      if (outcome.pausedAtMs !== null)
        paused.push({ seed, at: outcome.pausedAtMs, who: outcome.pausedParticipant })
    }
    expect(paused).toEqual([])
  })

  it('always pauses a player that stops, by its progress deadline, whatever is replayed or re-ordered afterwards', () => {
    const late: Array<{ seed: number, pausedAtMs: number | null, deadlineMs: number }> = []
    for (const seed of seeds) {
      const outcome = run(seed, 'frozen', 20_000)
      const deadlineMs = outcome.lastGenuineProgressAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS + STEP_MS
      if (outcome.pausedAtMs === null || outcome.pausedAtMs > deadlineMs)
        late.push({ seed, pausedAtMs: outcome.pausedAtMs, deadlineMs })
    }
    expect(late).toEqual([])
  })

  it('is deterministic: the same seed gives the same outcome', () => {
    expect(run(7, 'frozen', 20_000)).toEqual(run(7, 'frozen', 20_000))
    expect(run(7, 'progressing', 20_000)).toEqual(run(7, 'progressing', 20_000))
  })
})
