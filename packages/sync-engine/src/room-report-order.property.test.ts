import type { MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'
import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { PLAYBACK_PROGRESS_TIMEOUT_MS } from './playback-health.ts'
import { RoomCoordinator } from './room.ts'

/**
 * Property-style check of the report ordering rules (CR-B04). Over many seeded
 * sequences, a player that keeps progressing is never paused and a player that
 * stops is always paused by its progress deadline.
 *
 * Each sequence draws, from its seed:
 *   - the room: legacy, or transactional (prepared, committed, and the host and
 *     the guest each send an observed-start acknowledgement at a random time, which
 *     advances the revision, so reports the guest stamped earlier become alive-only);
 *   - whether the guest first reports that its player has not started
 *     (`playbackStarted: false`, paused or not, `progressed` stated or omitted) for
 *     up to three seconds before it plays;
 *   - events that raise the revision without pausing the room (join requests,
 *     withdrawals), and how far behind the guest's revision lags;
 *   - replays, late and re-ordered deliveries, client clock steps in both
 *     directions, and reports that omit `progressed`.
 *
 * Playing sequences run for twenty seconds, past the ten second startup deadline,
 * so a player that is judged by an old "not started" report is caught.
 *
 * The first version of this test used a legacy room and a guest that always said
 * `playbackStarted: true`, so it could not find a participant whose startup-pending
 * report was followed only by alive-only progress (review round 4). It does now.
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
const HOST = 'participant_host'
const GUEST = 'participant_guest'
// The client's clock is its own Date.now(), far from the coordinator's test clock: a step back never reaches zero.
const CLIENT_EPOCH_MS = 1_700_000_000_000
const SEED_COUNT = 3_000
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1)

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
  kind: 'legacy' | 'transactional'
  startupPending: boolean
  pausedAtMs: number | null
  pausedParticipant: string | null
  lastGenuineProgressAtMs: number
  endedAtMs: number
}

function run(seed: number, mode: 'progressing' | 'frozen', durationMs: number): Outcome {
  const random = mulberry32(seed * 2 + (mode === 'frozen' ? 1 : 0))
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const kind: Outcome['kind'] = random() < 0.5 ? 'legacy' : 'transactional'
  const startupPending = random() < 0.6
  const clock = { value: 10_000 }
  const capabilities = kind === 'transactional' ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}
  const room = new RoomCoordinator({ roomId: 'property-room', code: 'PROPERTY' }, { id: HOST, name: 'Host', media, ...capabilities }, () => clock.value)
  room.join({ id: GUEST, name: 'Guest', media, ...capabilities })
  room.respondToJoin(HOST, room.snapshot().controller.leaseEpoch, GUEST, true)
  room.setReady(HOST, true, media)
  room.setReady(GUEST, true, media)
  const state = room.snapshot()
  room.control(HOST, { actionId: `play-${seed}`, basedOnRevision: state.revision, leaseEpoch: state.controller.leaseEpoch, kind: 'play', positionSeconds: 20 })
  if (kind === 'transactional') {
    for (const id of [HOST, GUEST]) {
      const operation = room.snapshot().contract!.operation!
      room.acknowledgeOperation(id, { mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase: 'prepared', participantId: id, bindingId: `binding_${id}`, sourceGeneration: 1, sampleSequence: 1, observedPositionSeconds: 20, observedAtLocalMs: clock.value })
    }
  }
  const playRevision = room.snapshot().revision
  const startedAtMs = room.snapshot().playback.effectiveAtServerMs

  // The guest says "not started" for up to three seconds before it plays. Genuine progress begins after that.
  const startupEndsAtMs = startedAtMs + (startupPending ? 500 + Math.floor(random() * 6) * 500 : 0)
  const freezeAtMs = startupEndsAtMs + 1_000 + Math.floor(random() * 6) * 500
  // Each of the two sends its observed-start acknowledgement at a random time in the first three seconds.
  const ackAtMs: Record<string, number> = { [HOST]: startedAtMs + Math.floor(random() * 12) * 250, [GUEST]: startedAtMs + Math.floor(random() * 12) * 250 }
  const acked = new Set<string>()
  const guestReports: PlayerSample[] = []
  let guestKnownRevision = playRevision
  let guestOffsetMs = 0
  let lastGenuineProgressAtMs = startedAtMs
  let frozenPosition: number | null = null
  // Where the guest's player last was when it played: a frozen player stays exactly there.
  let lastPlayedPosition = 20
  let newcomers = 0
  const pending: string[] = []
  const outcome: Outcome = { kind, startupPending, pausedAtMs: null, pausedParticipant: null, lastGenuineProgressAtMs, endedAtMs: startedAtMs + durationMs }

  const send = (report: PlayerSample) => {
    guestReports.push(report)
    room.updatePlayerStatus(GUEST, guestKnownRevision, report)
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

    // Observed-start acknowledgements: each raises the revision.
    if (kind === 'transactional') {
      for (const id of [HOST, GUEST]) {
        const operation = room.snapshot().contract?.operation
        if (acked.has(id) || clock.value < ackAtMs[id]! || !operation || operation.phase !== 'committed')
          continue
        const result = room.acknowledgeOperation(id, { mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase: 'started', participantId: id, bindingId: `binding_${id}`, sourceGeneration: 1, sampleSequence: 2, observedPositionSeconds: 20 + elapsedMs / 1_000, observedAtLocalMs: clock.value })
        if (result !== null) {
          acked.add(id)
          // An acknowledgement is observed-start evidence: the coordinator restarts that player's progress window.
          if (id === GUEST)
            lastGenuineProgressAtMs = Math.max(lastGenuineProgressAtMs, clock.value)
        }
      }
    }

    if (step % REPORT_EVERY_STEPS === 0) {
      room.updatePlayerStatus(HOST, room.snapshot().revision, {
        positionSeconds: 20 + elapsedMs / 1_000,
        durationSeconds: media.durationSeconds,
        paused: false,
        buffering: false,
        sampledAtLocalMs: clock.value,
        progressed: true,
        playbackStarted: true,
      })

      const starting = clock.value < startupEndsAtMs
      const frozen = mode === 'frozen' && clock.value >= freezeAtMs
      if (frozen && frozenPosition === null)
        frozenPosition = lastPlayedPosition
      const previous = guestReports.at(-1)
      const report: PlayerSample = starting
        ? {
            positionSeconds: 20,
            durationSeconds: media.durationSeconds,
            paused: random() < 0.5,
            buffering: random() < 0.3,
            sampledAtLocalMs: CLIENT_EPOCH_MS + clock.value + guestOffsetMs,
            playbackStarted: false,
            ...(random() < 0.5 ? { progressed: false } : {}),
          }
        : {
            positionSeconds: frozen ? frozenPosition! : 20 + elapsedMs / 1_000,
            durationSeconds: media.durationSeconds,
            paused: false,
            buffering: false,
            sampledAtLocalMs: CLIENT_EPOCH_MS + clock.value + guestOffsetMs,
            playbackStarted: true,
            // The first playing report states its progress: it has no playing report before it to be compared with.
            ...(guestReports.every(sent => sent.playbackStarted === false) ? { progressed: true } : frozen ? (random() < 0.5 ? { progressed: false } : {}) : (random() < 0.5 ? { progressed: true } : {})),
          }
      if (!starting && !frozen) {
        lastGenuineProgressAtMs = clock.value
        lastPlayedPosition = report.positionSeconds
      }
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
  it(`never pauses a player that keeps progressing, whatever the room, the startup reports, the replays, clock steps, missing fields and older revisions (seeds 1 to ${SEED_COUNT})`, () => {
    // eslint-disable-next-line no-console
    console.info(`property test: progressing, seeds 1..${SEED_COUNT}`)
    const paused: Array<{ seed: number, kind: string, startupPending: boolean, at: number, who: string | null }> = []
    for (const seed of SEEDS) {
      const outcome = run(seed, 'progressing', 20_000)
      // Nobody may be paused: neither the guest nor the host, whichever of them the coordinator blames.
      if (outcome.pausedAtMs !== null)
        paused.push({ seed, kind: outcome.kind, startupPending: outcome.startupPending, at: outcome.pausedAtMs, who: outcome.pausedParticipant })
    }
    expect(paused).toEqual([])
  }, 120_000)

  it(`always pauses a player that stops, by its progress deadline, whatever is replayed or re-ordered afterwards (seeds 1 to ${SEED_COUNT})`, () => {
    // eslint-disable-next-line no-console
    console.info(`property test: frozen, seeds 1..${SEED_COUNT}`)
    const late: Array<{ seed: number, kind: string, startupPending: boolean, pausedAtMs: number | null, pausedParticipant: string | null, deadlineMs: number }> = []
    for (const seed of SEEDS) {
      const outcome = run(seed, 'frozen', 20_000)
      const deadlineMs = outcome.lastGenuineProgressAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS + STEP_MS
      // The stopped guest, and nobody else, must be the one that paused the room, by its deadline.
      if (outcome.pausedAtMs === null || outcome.pausedAtMs > deadlineMs || outcome.pausedParticipant !== GUEST)
        late.push({ seed, kind: outcome.kind, startupPending: outcome.startupPending, pausedAtMs: outcome.pausedAtMs, pausedParticipant: outcome.pausedParticipant, deadlineMs })
    }
    expect(late).toEqual([])
  }, 120_000)

  it('covers every kind of room and both startup shapes', () => {
    const seen = new Set<string>()
    for (const seed of SEEDS.slice(0, 200)) {
      const outcome = run(seed, 'progressing', 3_000)
      seen.add(`${outcome.kind}/${outcome.startupPending}`)
    }
    expect([...seen].sort()).toEqual(['legacy/false', 'legacy/true', 'transactional/false', 'transactional/true'])
  })

  it('is deterministic: the same seed gives the same outcome', () => {
    expect(run(7, 'frozen', 20_000)).toEqual(run(7, 'frozen', 20_000))
    expect(run(7, 'progressing', 20_000)).toEqual(run(7, 'progressing', 20_000))
  })
})
