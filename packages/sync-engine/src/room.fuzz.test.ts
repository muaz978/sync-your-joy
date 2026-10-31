import type { ClientCapabilities, MediaFingerprint, OperationAcknowledgement, PlayerSample, RoomSnapshot } from '@syncyourjoy/protocol'
import type { ControlIntent, OpenLinkIntent, RoomResult } from './room.ts'
import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { RoomCoordinator } from './room.ts'

/**
 * Property-based / fuzz harness for RoomCoordinator.
 *
 * room.test.ts and network-chaos.test.ts are entirely example/scenario-based:
 * every operation sequence they exercise was hand-picked by a human who
 * already knew what mattered. This file instead drives RoomCoordinator with
 * long, weighted-random operation sequences from a seeded PRNG and asserts a
 * fixed set of invariants after *every single step*, so it can stumble onto
 * the kind of unexpected interleaving (e.g. a readiness change arriving
 * while a seek is pending) that a scenario test would never think to write.
 *
 * Everything is deterministic and pure in-memory: RoomCoordinator takes an
 * injectable `now()`, so a fake clock that only ever increments per call is
 * enough to drive it — no real timers, no sleeping, no I/O. A failing seed
 * is fully reproducible: paste the printed `seed=` value back into a
 * one-off script (or a temporary `it.only`) using the same generator to
 * replay the exact same operation sequence.
 */

// -----------------------------------------------------------------------
// Seeded PRNG (mulberry32) — ~10 lines, no new dependency, deterministic.
// -----------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number

function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

function chance(rng: Rng, probability: number): boolean {
  return rng() < probability
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[randomInt(rng, 0, items.length - 1)]
  if (item === undefined)
    throw new Error('pick() called with an empty array')
  return item
}

interface Weighted<T> { weight: number, value: T }
function weightedPick<T>(rng: Rng, table: ReadonlyArray<Weighted<T>>): T {
  const total = table.reduce((sum, entry) => sum + entry.weight, 0)
  let roll = rng() * total
  for (const entry of table) {
    if (roll < entry.weight)
      return entry.value
    roll -= entry.weight
  }
  const last = table[table.length - 1]
  if (!last)
    throw new Error('weightedPick() called with an empty table')
  return last.value
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function randomAlnum(rng: Rng, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++)
    out += ID_ALPHABET.charAt(randomInt(rng, 0, ID_ALPHABET.length - 1))
  return out
}

// -----------------------------------------------------------------------
// Operation model
// -----------------------------------------------------------------------

interface JoinOp { kind: 'join', mode: 'new' | 'reconnect', id: string, name: string, media: MediaFingerprint | null, sessionToken?: string, capabilities?: ClientCapabilities }
interface DisconnectOp { kind: 'disconnect', id: string }
interface SetReadyOp { kind: 'setReady', id: string, ready: boolean, media: MediaFingerprint | null }
interface ControlOp { kind: 'control', participantId: string, intent: ControlIntent, reusedActionId: boolean }
interface AcknowledgeSeekOp { kind: 'acknowledgeSeek', participantId: string, revision: number, positionSeconds: number }
interface UpdatePlayerStatusOp { kind: 'updatePlayerStatus', participantId: string, basedOnRevision: number, sample: PlayerSample }
interface OpenLinkOp { kind: 'openLink', participantId: string, intent: OpenLinkIntent, reusedActionId: boolean }
interface TransferControlOp { kind: 'transferControl', fromParticipantId: string, toParticipantId: string, leaseEpoch: number }
interface RespondToJoinOp { kind: 'respondToJoin', controllerId: string, leaseEpoch: number, participantId: string, approve: boolean }
// Only generated for transactional runs: a room whose members all advertise
// the current capabilities, so seeks run through operations, not the legacy barrier.
// `atDeadlineMs` makes the coordinator's first clock read of the step return exactly that
// instant, so the `>=` against the operation deadline is exercised on its boundary.
interface AcknowledgeOperationOp { kind: 'acknowledgeOperation', participantId: string, acknowledgement: OperationAcknowledgement, atDeadlineMs?: number }
interface ReleaseExpiredOp { kind: 'releaseExpired' }
interface AdvanceClockOp { kind: 'advanceClock', ms: number }

type FuzzOp =
  | JoinOp
  | DisconnectOp
  | SetReadyOp
  | ControlOp
  | AcknowledgeSeekOp
  | UpdatePlayerStatusOp
  | OpenLinkOp
  | TransferControlOp
  | RespondToJoinOp
  | AcknowledgeOperationOp
  | ReleaseExpiredOp
  | AdvanceClockOp

/** The coordinator clock. `pinNextMs`, when set, is returned by the next read instead of a random step. */
interface FuzzClock { ms: number, pinNextMs: number | null }

interface FuzzModel {
  // Real, confirmed room members (host-approval join, SYJ-AUD-003, means a
  // brand-new join no longer lands here immediately -- see pendingIds).
  confirmedParticipantIds: string[]
  // Brand-new join requests that are pending the controller's approve/deny
  // decision. A reconnect targets confirmedParticipantIds only, since a
  // pending request has no real participant record to reconnect into.
  pendingParticipantIds: string[]
  sessionTokens: Map<string, string | undefined>
  actionIdPool: string[]
  nextIdCounter: number
  nextActionCounter: number
  lastLocalSampleMs: Map<string, number>
  localClockMs: number
  /** True when members advertise the current capabilities, so the room can be transactional. */
  transactional: boolean
  sampleSequences: Map<string, number>
}

// -----------------------------------------------------------------------
// Random value builders
// -----------------------------------------------------------------------

function randomMedia(rng: Rng): MediaFingerprint {
  return {
    service: 'fuzz-service',
    canonicalId: `fuzz:${randomAlnum(rng, 8)}`,
    title: `Fuzz Media ${randomAlnum(rng, 4)}`,
    durationSeconds: chance(rng, 0.85) ? randomInt(rng, 30, 3_600) : null,
  }
}

/** Sometimes exactly matching media, sometimes a near-miss, sometimes unrelated/null. */
function mediaVariant(rng: Rng, base: MediaFingerprint | null): MediaFingerprint | null {
  if (!base)
    return chance(rng, 0.5) ? randomMedia(rng) : null

  const roll = rng()
  if (roll < 0.55)
    return { ...base }
  if (roll < 0.85)
    return { ...base, canonicalId: `${base.canonicalId}-variant-${randomAlnum(rng, 4)}` }
  return chance(rng, 0.5) ? randomMedia(rng) : null
}

function pickParticipantId(rng: Rng, model: FuzzModel, ghostProbability: number): string {
  if (model.confirmedParticipantIds.length === 0 || chance(rng, ghostProbability))
    return `ghost_${randomAlnum(rng, 10)}`
  return pick(rng, model.confirmedParticipantIds)
}

function pickPendingParticipantId(rng: Rng, model: FuzzModel, ghostProbability: number): string {
  if (model.pendingParticipantIds.length === 0 || chance(rng, ghostProbability))
    return `ghost_${randomAlnum(rng, 10)}`
  return pick(rng, model.pendingParticipantIds)
}

function pickRevision(rng: Rng, snap: RoomSnapshot): number {
  return weightedPick(rng, [
    { weight: 60, value: snap.revision },
    { weight: 20, value: Math.max(0, snap.revision - randomInt(rng, 1, 5)) },
    { weight: 20, value: snap.revision + randomInt(rng, 1, 5) },
  ])
}

function pickLeaseEpoch(rng: Rng, snap: RoomSnapshot): number {
  return weightedPick(rng, [
    { weight: 80, value: snap.controller.leaseEpoch },
    { weight: 10, value: Math.max(0, snap.controller.leaseEpoch - randomInt(rng, 1, 2)) },
    { weight: 10, value: snap.controller.leaseEpoch + randomInt(rng, 1, 2) },
  ])
}

function pickPositionSeconds(rng: Rng, durationHint: number | null): number {
  return weightedPick(rng, [
    { weight: 40, value: durationHint !== null ? rng() * durationHint : rng() * 300 },
    { weight: 30, value: durationHint !== null ? durationHint * (1.2 + rng() * 3) : rng() * 5_000 },
    { weight: 30, value: rng() * 10_000 },
  ])
}

function pickOrCreateActionId(rng: Rng, model: FuzzModel): { actionId: string, reused: boolean } {
  if (model.actionIdPool.length > 0 && chance(rng, 0.3))
    return { actionId: pick(rng, model.actionIdPool), reused: true }
  model.nextActionCounter += 1
  return { actionId: `act_${model.nextActionCounter}_${randomAlnum(rng, 6)}`, reused: false }
}

const SAMPLE_HOSTS = ['video.example', 'stream.example', 'watch.example', 'clips.example']
const MALFORMED_URLS = ['not a url', 'ftp://video.example/x', 'javascript:alert(1)', `https://${'x'.repeat(300)}.example/long`]
function randomPageUrl(rng: Rng): string {
  if (chance(rng, 0.15))
    return pick(rng, MALFORMED_URLS)
  const host = pick(rng, SAMPLE_HOSTS)
  const path = randomAlnum(rng, 6)
  const query = chance(rng, 0.5) ? `?utm_source=fuzz&vid=${randomAlnum(rng, 4)}` : ''
  return `https://${host}/watch/${path}${query}`
}

// -----------------------------------------------------------------------
// Operation generators — one per RoomCoordinator public method under test.
// -----------------------------------------------------------------------

function generateJoinOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): JoinOp {
  const op = generateJoinOpWithoutCapabilities(rng, model, snap)
  // Most members of a transactional run advertise the current capabilities;
  // the occasional one that does not turns the room into a legacy room, and
  // the barrier invariants then stop applying until it is transactional again.
  // A legacy run draws nothing here, so its sequences are unchanged.
  return model.transactional && chance(rng, 0.97) ? { ...op, capabilities: CURRENT_CLIENT_CAPABILITIES } : op
}

function generateJoinOpWithoutCapabilities(rng: Rng, model: FuzzModel, snap: RoomSnapshot): JoinOp {
  const wantsReconnect = model.confirmedParticipantIds.length > 0 && chance(rng, 0.35)

  if (!wantsReconnect) {
    model.nextIdCounter += 1
    const id = `p_${model.nextIdCounter}_${randomAlnum(rng, 6)}`
    const sessionToken = chance(rng, 0.6) ? `tok_${randomAlnum(rng, 24)}` : undefined
    return {
      kind: 'join',
      mode: 'new',
      id,
      name: `Fuzz-${randomAlnum(rng, 5)}`,
      media: reportedMedia(rng, model, snap),
      ...(sessionToken !== undefined ? { sessionToken } : {}),
    }
  }

  const id = pick(rng, model.confirmedParticipantIds)
  const knownToken = model.sessionTokens.get(id)
  const wantsWrongToken = chance(rng, 0.25)
  const sessionToken = wantsWrongToken
    ? (knownToken === undefined ? `intruder_${randomAlnum(rng, 24)}` : undefined)
    : knownToken
  return {
    kind: 'join',
    mode: 'reconnect',
    id,
    name: `Rejoin-${randomAlnum(rng, 4)}`,
    media: reportedMedia(rng, model, snap),
    ...(sessionToken !== undefined ? { sessionToken } : {}),
  }
}

function generateDisconnectOp(rng: Rng, model: FuzzModel): DisconnectOp {
  return { kind: 'disconnect', id: pickParticipantId(rng, model, 0.1) }
}

/**
 * A transactional run mostly reports the room's own media, so that the
 * room is often fully ready and seeks can reach their commit. A legacy run
 * draws exactly as before.
 */
function reportedMedia(rng: Rng, model: FuzzModel, snap: RoomSnapshot): MediaFingerprint | null {
  if (model.transactional && snap.media && chance(rng, 0.9))
    return { ...snap.media }
  return mediaVariant(rng, snap.media)
}

function generateSetReadyOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): SetReadyOp {
  return {
    kind: 'setReady',
    id: pickParticipantId(rng, model, 0.1),
    ready: chance(rng, model.transactional ? 0.92 : 0.7),
    media: reportedMedia(rng, model, snap),
  }
}

function generateControlOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): ControlOp {
  const kind = weightedPick<ControlIntent['kind']>(rng, model.transactional
    ? [{ weight: 30, value: 'play' }, { weight: 15, value: 'pause' }, { weight: 55, value: 'seek' }]
    : [{ weight: 30, value: 'play' }, { weight: 35, value: 'pause' }, { weight: 35, value: 'seek' }])
  const participantId = chance(rng, 0.7) ? snap.controller.participantId : pickParticipantId(rng, model, 0.1)
  const { actionId, reused } = pickOrCreateActionId(rng, model)
  return {
    kind: 'control',
    participantId,
    reusedActionId: reused,
    intent: {
      actionId,
      basedOnRevision: pickRevision(rng, snap),
      leaseEpoch: pickLeaseEpoch(rng, snap),
      kind,
      positionSeconds: pickPositionSeconds(rng, snap.media?.durationSeconds ?? null),
    },
  }
}

function generateOpenLinkOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): OpenLinkOp {
  const participantId = chance(rng, 0.7) ? snap.controller.participantId : pickParticipantId(rng, model, 0.1)
  const { actionId, reused } = pickOrCreateActionId(rng, model)
  return {
    kind: 'openLink',
    participantId,
    reusedActionId: reused,
    intent: {
      actionId,
      basedOnRevision: pickRevision(rng, snap),
      leaseEpoch: pickLeaseEpoch(rng, snap),
      url: randomPageUrl(rng),
    },
  }
}

function generateAcknowledgeSeekOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): AcknowledgeSeekOp {
  const participantId = pickParticipantId(rng, model, 0.15)
  const pending = snap.seek
  const revision = pending && chance(rng, 0.7)
    ? pending.revision
    : randomInt(rng, Math.max(0, snap.revision - 5), snap.revision + 3)
  const positionSeconds = pending && chance(rng, 0.6)
    ? pending.positionSeconds + (rng() - 0.5)
    : rng() * 5_000
  return { kind: 'acknowledgeSeek', participantId, revision, positionSeconds }
}

function generateUpdatePlayerStatusOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): UpdatePlayerStatusOp {
  const readyConnectedIds = snap.participants.filter(p => p.ready && p.connected).map(p => p.id)
  const participantId = readyConnectedIds.length > 0 && chance(rng, 0.65)
    ? pick(rng, readyConnectedIds)
    : pickParticipantId(rng, model, 0.15)

  const basedOnRevision = chance(rng, 0.7)
    ? snap.revision
    : (chance(rng, 0.5) ? Math.max(0, snap.revision - randomInt(rng, 1, 3)) : snap.revision + randomInt(rng, 1, 3))

  const durationHint = snap.media?.durationSeconds ?? null
  // Deliberately generate both plausible positions AND ones far beyond the
  // media's known duration: nothing in RoomCoordinator's public signature
  // stops a client from reporting an oversized positionSeconds here.
  const positionSeconds = weightedPick(rng, [
    { weight: 45, value: durationHint !== null ? rng() * durationHint : rng() * 300 },
    { weight: 35, value: durationHint !== null ? durationHint * (1.5 + rng() * 5) : rng() * 20_000 },
    { weight: 20, value: 0 },
  ])

  model.localClockMs += randomInt(rng, 50, 400)
  let sampledAtLocalMs = model.localClockMs
  if (chance(rng, 0.15)) {
    // Occasionally simulate a reordered/duplicated delivery: an older local
    // timestamp than whatever we last sent for this participant.
    const lastKnown = model.lastLocalSampleMs.get(participantId) ?? 0
    sampledAtLocalMs = Math.max(0, lastKnown - randomInt(rng, 50, 500))
  }
  model.lastLocalSampleMs.set(participantId, Math.max(model.lastLocalSampleMs.get(participantId) ?? 0, sampledAtLocalMs))

  const playbackStartFailed = chance(rng, model.transactional ? 0.05 : 0.2)
  const sample: PlayerSample = {
    positionSeconds,
    durationSeconds: durationHint !== null && chance(rng, 0.7) ? durationHint : (chance(rng, 0.5) ? null : rng() * 10_000),
    paused: chance(rng, 0.4),
    buffering: chance(rng, model.transactional ? 0.15 : 0.45),
    sampledAtLocalMs,
    ...(chance(rng, 0.5) ? { progressed: chance(rng, 0.5) } : {}),
    ...(playbackStartFailed ? { playbackStartFailed: true } : {}),
    ...(chance(rng, 0.5) ? { playbackStarted: chance(rng, 0.7) } : {}),
  }

  return { kind: 'updatePlayerStatus', participantId, basedOnRevision, sample }
}

function generateTransferControlOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): TransferControlOp {
  return {
    kind: 'transferControl',
    fromParticipantId: chance(rng, 0.7) ? snap.controller.participantId : pickParticipantId(rng, model, 0.1),
    toParticipantId: pickParticipantId(rng, model, 0.1),
    leaseEpoch: pickLeaseEpoch(rng, snap),
  }
}

function generateRespondToJoinOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot): RespondToJoinOp {
  return {
    kind: 'respondToJoin',
    controllerId: chance(rng, 0.75) ? snap.controller.participantId : pickParticipantId(rng, model, 0.2),
    leaseEpoch: pickLeaseEpoch(rng, snap),
    participantId: pickPendingParticipantId(rng, model, 0.15),
    approve: chance(rng, 0.6),
  }
}

function generateAcknowledgeOperationOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot, clock: FuzzClock): AcknowledgeOperationOp {
  const operation = snap.contract?.operation ?? null
  // Most acknowledgements come from a required participant that has not
  // prepared yet and report the target, as a working player would. The rest
  // are the stale, misaddressed and misaligned ones a client can also send.
  const unprepared = operation?.phase === 'preparing'
    ? operation.requiredParticipantIds.filter(id => !operation.preparedParticipantIds.includes(id))
    : []
  const cooperative = operation !== null && unprepared.length > 0 && chance(rng, 0.65)
  const participantId = cooperative
    ? pick(rng, unprepared)
    : operation && operation.requiredParticipantIds.length > 0 && chance(rng, 0.8)
      ? pick(rng, operation.requiredParticipantIds)
      : pickParticipantId(rng, model, 0.15)
  const previous = model.sampleSequences.get(participantId) ?? 0
  // Mostly increasing, sometimes a repeat or an older sequence.
  const sampleSequence = cooperative || chance(rng, 0.9) ? previous + 1 : Math.max(0, previous - randomInt(rng, 0, 2))
  model.sampleSequences.set(participantId, Math.max(previous, sampleSequence))
  model.localClockMs += randomInt(rng, 5, 50)
  const aimed = cooperative || (operation !== null && chance(rng, 0.85))
  // The clock only moves forward, so a deadline already behind it cannot be hit exactly.
  const atDeadline = operation !== null && operation.deadlineAtServerMs > clock.ms && chance(rng, 0.12)
  return {
    kind: 'acknowledgeOperation',
    participantId,
    ...(atDeadline ? { atDeadlineMs: operation.deadlineAtServerMs } : {}),
    acknowledgement: {
      mediaEpoch: aimed ? operation!.mediaEpoch : snap.contract?.mediaEpoch ?? 0,
      operationId: aimed ? operation!.operationId : `operation_${randomAlnum(rng, 16)}`,
      phase: cooperative || chance(rng, 0.75) ? 'prepared' : 'started',
      participantId: cooperative || chance(rng, 0.95) ? participantId : `ghost_${randomAlnum(rng, 10)}`,
      bindingId: cooperative || chance(rng, 0.95) ? `binding_${participantId}` : `binding_other_${randomAlnum(rng, 6)}`,
      sourceGeneration: 1,
      sampleSequence,
      observedPositionSeconds: operation !== null && operation.targetPositionSeconds !== null && (cooperative || chance(rng, 0.8))
        ? operation.targetPositionSeconds + (rng() - 0.5) * 0.2
        : rng() * 5_000,
      observedAtLocalMs: model.localClockMs,
    },
  }
}

function generateOp(rng: Rng, model: FuzzModel, snap: RoomSnapshot, clock: FuzzClock): FuzzOp {
  // A transactional run spends fewer steps on membership churn, which cancels
  // every pending seek, and more on controls and acknowledgements.
  const kind = weightedPick<FuzzOp['kind']>(rng, model.transactional
    ? [
        { weight: 10, value: 'join' },
        { weight: 5, value: 'disconnect' },
        { weight: 16, value: 'setReady' },
        { weight: 24, value: 'control' },
        { weight: 6, value: 'updatePlayerStatus' },
        { weight: 1, value: 'openLink' },
        { weight: 1, value: 'transferControl' },
        { weight: 10, value: 'respondToJoin' },
        { weight: 30, value: 'acknowledgeOperation' },
        { weight: 3, value: 'releaseExpired' },
        { weight: 5, value: 'advanceClock' },
      ]
    : [
        { weight: 25, value: 'join' },
        { weight: 15, value: 'disconnect' },
        { weight: 15, value: 'setReady' },
        { weight: 20, value: 'control' },
        { weight: 8, value: 'acknowledgeSeek' },
        { weight: 12, value: 'updatePlayerStatus' },
        { weight: 3, value: 'openLink' },
        { weight: 2, value: 'transferControl' },
        { weight: 12, value: 'respondToJoin' },
      ])

  switch (kind) {
    case 'join': return generateJoinOp(rng, model, snap)
    case 'disconnect': return generateDisconnectOp(rng, model)
    case 'setReady': return generateSetReadyOp(rng, model, snap)
    case 'control': return generateControlOp(rng, model, snap)
    case 'acknowledgeSeek': return generateAcknowledgeSeekOp(rng, model, snap)
    case 'updatePlayerStatus': return generateUpdatePlayerStatusOp(rng, model, snap)
    case 'openLink': return generateOpenLinkOp(rng, model, snap)
    case 'transferControl': return generateTransferControlOp(rng, model, snap)
    case 'respondToJoin': return generateRespondToJoinOp(rng, model, snap)
    case 'acknowledgeOperation': return generateAcknowledgeOperationOp(rng, model, snap, clock)
    case 'releaseExpired': return { kind: 'releaseExpired' }
    // Long enough for a barrier window to run out between two steps.
    case 'advanceClock': return { kind: 'advanceClock', ms: randomInt(rng, 200, 4_000) }
  }
}

function applyOp(room: RoomCoordinator, op: FuzzOp, clock: FuzzClock): RoomResult | null {
  switch (op.kind) {
    case 'join':
      return room.join({
        id: op.id,
        name: op.name,
        media: op.media,
        ...(op.sessionToken !== undefined ? { sessionToken: op.sessionToken } : {}),
        ...(op.capabilities !== undefined ? { capabilities: op.capabilities } : {}),
      })
    case 'disconnect':
      return room.disconnect(op.id)
    case 'setReady':
      return room.setReady(op.id, op.ready, op.media)
    case 'control':
      return room.control(op.participantId, op.intent)
    case 'acknowledgeSeek':
      return room.acknowledgeSeek(op.participantId, op.revision, op.positionSeconds)
    case 'updatePlayerStatus':
      return room.updatePlayerStatus(op.participantId, op.basedOnRevision, op.sample)
    case 'openLink':
      return room.openLink(op.participantId, op.intent)
    case 'transferControl':
      return room.transferControl(op.fromParticipantId, op.toParticipantId, op.leaseEpoch)
    case 'respondToJoin':
      return room.respondToJoin(op.controllerId, op.leaseEpoch, op.participantId, op.approve)
    case 'acknowledgeOperation':
      clock.pinNextMs = op.atDeadlineMs ?? null
      try {
        return room.acknowledgeOperation(op.participantId, op.acknowledgement)
      }
      finally {
        // A step that never reads the clock must not leave the pin for a later step.
        clock.pinNextMs = null
      }
    case 'releaseExpired':
      // The coordinator's alarm: it releases whichever barrier has run out.
      return room.releaseExpiredOperation() ?? room.releaseExpiredSeek()
    case 'advanceClock':
      clock.ms += op.ms
      return null
  }
}

function updateModel(model: FuzzModel, op: FuzzOp, result: RoomResult | null): void {
  if (op.kind === 'join') {
    if (result?.ok) {
      if (op.mode === 'reconnect') {
        // The reconnect branch is untouched by host-approval join: success
        // here means the identity was, and remains, a real participant.
        if (!model.confirmedParticipantIds.includes(op.id))
          model.confirmedParticipantIds.push(op.id)
      }
      else if (result.reason === 'join_pending') {
        if (!model.pendingParticipantIds.includes(op.id))
          model.pendingParticipantIds.push(op.id)
        model.sessionTokens.set(op.id, op.sessionToken)
      }
    }
    return
  }

  if (op.kind === 'respondToJoin') {
    if (result?.ok) {
      model.pendingParticipantIds = model.pendingParticipantIds.filter(id => id !== op.participantId)
      if (result.reason === 'join_approved' && !model.confirmedParticipantIds.includes(op.participantId))
        model.confirmedParticipantIds.push(op.participantId)
    }
    return
  }

  if (op.kind === 'control' || op.kind === 'openLink') {
    if (!op.reusedActionId && result?.ok && result.reason !== 'duplicate_action') {
      model.actionIdPool.push(op.intent.actionId)
      if (model.actionIdPool.length > 80)
        model.actionIdPool.shift()
    }
  }
}

// -----------------------------------------------------------------------
// Invariants
// -----------------------------------------------------------------------

const FORBIDDEN_PARTICIPANT_KEYS = ['sessionToken', 'media', 'lastSample', 'lastSampleReceivedAtMs', 'lastProgressAtServerMs'] as const
const FORBIDDEN_PENDING_JOIN_KEYS = ['sessionToken', 'media'] as const

function renderContext(seed: number, step: number, op: FuzzOp, history: readonly string[]): string {
  return `seed=${seed} step=${step} op=${JSON.stringify(op)}\nrecent ops:\n${history.slice(-15).join('\n')}`
}

function checkInvariants(options: {
  seed: number
  step: number
  op: FuzzOp
  before: RoomSnapshot
  after: RoomSnapshot
  history: readonly string[]
}): void {
  const { seed, step, op, before, after, history } = options
  const context = () => renderContext(seed, step, op, history)

  // 1. Revision never decreases.
  if (after.revision < before.revision)
    throw new Error(`Invariant violated: revision decreased from ${before.revision} to ${after.revision}.\n${context()}`)

  // 2. No internal bookkeeping field ever leaks into the public snapshot.
  for (const participant of after.participants) {
    for (const key of FORBIDDEN_PARTICIPANT_KEYS) {
      if (key in participant)
        throw new Error(`Invariant violated: participant "${participant.id}" leaked internal field "${key}".\n${context()}`)
    }
  }

  // 3. At most 10 connected participants (including on reconnect -- see the
  // "reconnect capacity bypass" regression test below, fixed in room.ts).
  const connectedCount = after.participants.filter(p => p.connected).length
  if (connectedCount > 10)
    throw new Error(`Invariant violated: connected participant count ${connectedCount} > 10.\n${context()}`)

  // 3b. A pending join request never exposes media or a session token --
  // the same minimal-exposure discipline as the participants mapping.
  for (const request of after.pendingJoinRequests) {
    for (const key of FORBIDDEN_PENDING_JOIN_KEYS) {
      if (key in request)
        throw new Error(`Invariant violated: pending join request "${request.id}" leaked internal field "${key}".\n${context()}`)
    }
  }

  // 4. Playback position never runs past a known media duration, including
  // via updatePlayerStatus()'s pause-on-failure/stall/buffering branch (see
  // the "unclamped status position" regression test below, fixed in room.ts).
  if (after.media && typeof after.media.durationSeconds === 'number' && after.playback.positionSeconds > after.media.durationSeconds)
    throw new Error(`Invariant violated: playback position ${after.playback.positionSeconds} exceeds media duration ${after.media.durationSeconds}.\n${context()}`)
}

/**
 * Invariant (SYJ-AUD-003): a brand-new (non-reconnecting) join request is
 * never accepted as pending while connected participants plus requests
 * already pending were already at the 10-participant cap. This is scoped to
 * `mode: 'new'` join operations specifically -- it is not a standing global
 * invariant, because the untouched reconnect branch enforces its own,
 * independent `connectedCount`-only cap and can transiently coexist with
 * pending requests that push the *combined* total above 10; that is
 * accepted, pre-existing behavior this task does not change.
 */
function checkJoinCapacityInvariant(options: {
  seed: number
  step: number
  op: JoinOp
  before: RoomSnapshot
  result: RoomResult | null
  history: readonly string[]
}): void {
  const { seed, step, op, before, result, history } = options
  const context = () => renderContext(seed, step, op, history)
  const combinedBefore = before.participants.filter(p => p.connected).length + before.pendingJoinRequests.length

  if (combinedBefore >= 10 && result?.ok) {
    throw new Error(`Capacity invariant violated: a brand-new join request was accepted as pending while connected+pending was already at the cap (${combinedBefore}).\n${context()}`)
  }
}

/** Invariant: resubmitting an already-accepted actionId is a total no-op. */
function checkDuplicateActionIdempotency(options: {
  seed: number
  step: number
  op: ControlOp | OpenLinkOp
  before: RoomSnapshot
  result: RoomResult | null
  history: readonly string[]
}): void {
  const { seed, step, op, before, result, history } = options
  const context = () => renderContext(seed, step, op, history)

  if (!result)
    throw new Error(`Idempotency invariant violated: reused actionId produced a null result.\n${context()}`)
  if (!result.ok || result.reason !== 'duplicate_action')
    throw new Error(`Idempotency invariant violated: reused actionId "${op.intent.actionId}" was not short-circuited as a duplicate (got ${JSON.stringify(result)}).\n${context()}`)
  if (JSON.stringify(result.snapshot) !== JSON.stringify(before))
    throw new Error(`Idempotency invariant violated: duplicate actionId "${op.intent.actionId}" mutated room state.\n${context()}`)
}

/** How often each barrier invariant was actually exercised, so a run cannot pass by never reaching one. */
interface BarrierStats {
  /** Steps that ended with a seek operation still collecting preparation. */
  pendingSeekSteps: number
  /** Acknowledgements received at or after the deadline of a pending seek. */
  lateAcknowledgements: number
  /** Those received exactly at the deadline, where `>=` and `>` differ. */
  deadlineAcknowledgements: number
  /** Pending seeks that the room committed, which is where playback may resume. */
  committedSeeks: number
  /** Committed seeks that resumed playback. */
  resumedSeeks: number
}

/**
 * Seek barrier invariants for a transactional room (CR-A07). They are checked
 * only while the room is transactional before and after the step, because the
 * legacy barrier recomputes its quorum and is no longer supported.
 *
 * A transactional seek is the `seek` operation in phase `preparing`; the
 * legacy `snapshot.seek` field is not used in this mode.
 *
 * `clockBeforeMs` is the coordinator clock before the step. The coordinator
 * reads the clock at least once during the step and the clock only moves
 * forward, so a step that starts at or after a deadline receives its
 * acknowledgement at or after that deadline.
 */
function checkSeekBarrierInvariants(options: {
  seed: number
  step: number
  op: FuzzOp
  before: RoomSnapshot
  after: RoomSnapshot
  clockBeforeMs: number
  stats: BarrierStats
  history: readonly string[]
}): void {
  const { seed, step, op, before, after, clockBeforeMs, stats, history } = options
  const context = () => renderContext(seed, step, op, history)
  if (after.contract?.mode !== 'transactional')
    return

  const afterOperation = after.contract.operation
  const afterPending = afterOperation?.kind === 'seek' && afterOperation.phase === 'preparing'

  // 1. A seek that is still collecting preparation holds the room paused.
  if (afterPending) {
    stats.pendingSeekSteps += 1
    if (after.playback.status !== 'paused')
      throw new Error(`Invariant violated: a pending seek to ${afterOperation.targetPositionSeconds} coexists with playback status "${after.playback.status}".\n${context()}`)

    // The quorum is fixed when the seek starts, so a required participant who
    // disconnects, becomes not ready or moves to other media must cancel the
    // seek rather than leave it waiting on, or later shrinking to exclude, them.
    const absent = after.participants
      .filter(p => afterOperation.requiredParticipantIds.includes(p.id) && !(p.connected && p.ready && p.mediaMatches))
      .map(p => p.id)
    if (absent.length > 0)
      throw new Error(`Invariant violated: a pending seek is still waiting on required participants who are no longer connected, ready and on the same media: ${absent.join(', ')}.\n${context()}`)
  }

  const beforeOperation = before.contract?.mode === 'transactional' ? before.contract.operation : null
  if (beforeOperation?.kind !== 'seek' || beforeOperation.phase !== 'preparing')
    return
  const sameOperation = afterOperation?.operationId === beforeOperation.operationId

  // 2. An acknowledgement received at or after the deadline never completes
  // the seek: the operation fails and the room stays paused.
  const receivedAtMs = op.kind === 'acknowledgeOperation' && op.atDeadlineMs !== undefined ? op.atDeadlineMs : clockBeforeMs
  if (op.kind === 'acknowledgeOperation' && receivedAtMs >= beforeOperation.deadlineAtServerMs) {
    stats.lateAcknowledgements += 1
    if (receivedAtMs === beforeOperation.deadlineAtServerMs)
      stats.deadlineAcknowledgements += 1
    if (after.playback.status === 'playing')
      throw new Error(`Invariant violated: an acknowledgement at or after the deadline ${beforeOperation.deadlineAtServerMs} (received at ${receivedAtMs}) left the room playing.\n${context()}`)
    if (!sameOperation || afterOperation?.phase !== 'failed')
      throw new Error(`Invariant violated: an acknowledgement at or after the deadline ${beforeOperation.deadlineAtServerMs} (received at ${receivedAtMs}) did not fail the seek: ${JSON.stringify(afterOperation)}.\n${context()}`)
  }

  // 3. The room only leaves a pending seek for playing through the commit,
  // and the commit needs a preparation from every participant that was
  // ready, connected and on the same media when it happened. A participant
  // that dropped out would have cancelled the seek instead.
  if (after.playback.status === 'playing' && before.playback.status !== 'playing') {
    if (!sameOperation || afterOperation?.phase !== 'committed')
      throw new Error(`Invariant violated: the room started playing out of a pending seek without committing it: ${JSON.stringify(afterOperation)}.\n${context()}`)
  }
  if (sameOperation && afterOperation !== null && afterOperation.phase !== 'preparing' && afterOperation.phase !== 'cancelled' && afterOperation.phase !== 'failed') {
    stats.committedSeeks += 1
    if (afterOperation.resumeWhenReady === true) {
      stats.resumedSeeks += 1
      if (after.playback.status !== 'playing')
        throw new Error(`Invariant violated: a committed seek that resumes did not start playing.\n${context()}`)
    }
    const expected = before.participants.filter(p => p.ready && p.connected && p.mediaMatches).map(p => p.id)
    const missing = expected.filter(id => !afterOperation.preparedParticipantIds.includes(id))
    if (missing.length > 0)
      throw new Error(`Invariant violated: the seek committed without a preparation from ${missing.join(', ')} (prepared: ${afterOperation.preparedParticipantIds.join(', ')}).\n${context()}`)
    const unprepared = afterOperation.requiredParticipantIds.filter(id => !afterOperation.preparedParticipantIds.includes(id))
    if (unprepared.length > 0)
      throw new Error(`Invariant violated: the seek committed with required participants unprepared: ${unprepared.join(', ')}.\n${context()}`)
  }
}

// -----------------------------------------------------------------------
// Seed runner
// -----------------------------------------------------------------------

function createFuzzRoom(seed: number, rng: Rng, transactional: boolean): { room: RoomCoordinator, model: FuzzModel, clock: FuzzClock } {
  const hostToken = chance(rng, 0.7) ? `tok_host_${randomAlnum(rng, 24)}` : undefined
  const drawnMedia = chance(rng, 0.75) ? randomMedia(rng) : null
  // A transactional run always starts with a video, so the room can get ready.
  const initialMedia = transactional ? drawnMedia ?? randomMedia(rng) : drawnMedia
  const clockState: FuzzClock = { ms: 1_000_000 + seed * 97, pinNextMs: null }
  const now = () => {
    if (clockState.pinNextMs !== null) {
      clockState.ms = clockState.pinNextMs
      clockState.pinNextMs = null
    }
    else {
      clockState.ms += randomInt(rng, 15, 140)
    }
    return clockState.ms
  }

  // Capability negotiation ignores an id shorter than six characters, so a
  // transactional run needs a longer host id to be negotiated at all.
  const hostId = transactional ? 'participant_host' : 'host'
  const room = new RoomCoordinator(
    { roomId: `room_fuzz_${seed}`, code: `FZ${String(seed).padStart(6, '0')}` },
    {
      id: hostId,
      name: 'Host',
      media: initialMedia,
      ...(hostToken !== undefined ? { sessionToken: hostToken } : {}),
      ...(transactional ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}),
    },
    now,
  )

  const model: FuzzModel = {
    confirmedParticipantIds: [hostId],
    pendingParticipantIds: [],
    sessionTokens: new Map([[hostId, hostToken]]),
    actionIdPool: [],
    nextIdCounter: 0,
    nextActionCounter: 0,
    lastLocalSampleMs: new Map(),
    localClockMs: clockState.ms,
    transactional,
    sampleSequences: new Map(),
  }

  return { room, model, clock: clockState }
}

function runFuzzSeed(seed: number, opsPerSeed: number, options: { transactional?: boolean, stats?: BarrierStats } = {}): void {
  const rng = mulberry32(seed)
  const { room, model, clock } = createFuzzRoom(seed, rng, options.transactional === true)
  const history: string[] = []

  let currentSnap: RoomSnapshot
  try {
    currentSnap = room.snapshot()
  }
  catch (error) {
    throw new Error(`Crash-resistance invariant violated: initial snapshot() threw.\nseed=${seed}\nerror=${String(error)}`)
  }

  for (let step = 0; step < opsPerSeed; step++) {
    const op = generateOp(rng, model, currentSnap, clock)
    const before = currentSnap
    const clockBeforeMs = clock.ms

    let result: RoomResult | null
    try {
      result = applyOp(room, op, clock)
    }
    catch (error) {
      throw new Error(`Crash-resistance invariant violated: an operation threw.\n${renderContext(seed, step, op, history)}\nerror=${String(error)}`)
    }

    let after: RoomSnapshot
    try {
      after = room.snapshot()
    }
    catch (error) {
      throw new Error(`Crash-resistance invariant violated: snapshot() threw after an operation.\n${renderContext(seed, step, op, history)}\nerror=${String(error)}`)
    }

    checkInvariants({ seed, step, op, before, after, history })
    if (options.stats)
      checkSeekBarrierInvariants({ seed, step, op, before, after, clockBeforeMs, stats: options.stats, history })

    if ((op.kind === 'control' || op.kind === 'openLink') && op.reusedActionId)
      checkDuplicateActionIdempotency({ seed, step, op, before, result, history })

    if (op.kind === 'join' && op.mode === 'new')
      checkJoinCapacityInvariant({ seed, step, op, before, result, history })

    updateModel(model, op, result)

    const resultSummary = result === null ? 'null' : { ok: result.ok, reason: result.ok ? result.reason : result.code }
    history.push(`#${step} ${JSON.stringify(op)} -> ${JSON.stringify(resultSummary)}`)
    if (history.length > 40)
      history.shift()

    currentSnap = after
  }
}

// -----------------------------------------------------------------------
// The fuzz test
// -----------------------------------------------------------------------

const SEED_COUNT = 240
const OPS_PER_SEED = 55
// The seek barrier invariants only bite once a run reaches a pending seek, a
// late acknowledgement or a commit, which most random steps do not, so this
// run uses more seeds.
const BARRIER_SEED_COUNT = 600

describe('RoomCoordinator property-based fuzz harness', () => {
  it(`holds core invariants across ${SEED_COUNT} random seeds x ${OPS_PER_SEED} operations each`, () => {
    for (let seed = 0; seed < SEED_COUNT; seed++)
      runFuzzSeed(seed, OPS_PER_SEED)
  })

  // The runs above build rooms whose members advertise nothing, so they are
  // always legacy rooms. These seeds advertise the current capabilities, so
  // the room is transactional and a seek is an operation with a fixed quorum.
  it(`holds the seek barrier invariants in transactional rooms across ${BARRIER_SEED_COUNT} random seeds x ${OPS_PER_SEED} operations each`, () => {
    const stats: BarrierStats = { pendingSeekSteps: 0, lateAcknowledgements: 0, deadlineAcknowledgements: 0, committedSeeks: 0, resumedSeeks: 0 }
    for (let seed = 0; seed < BARRIER_SEED_COUNT; seed++)
      runFuzzSeed(seed, OPS_PER_SEED, { transactional: true, stats })

    // The seeds are fixed, so these counts are fixed. They fail if a change
    // to the generators stops the run from reaching the situations above.
    expect(stats.pendingSeekSteps).toBeGreaterThan(0)
    expect(stats.lateAcknowledgements).toBeGreaterThan(0)
    expect(stats.deadlineAcknowledgements).toBeGreaterThan(0)
    expect(stats.committedSeeks).toBeGreaterThan(0)
    expect(stats.resumedSeeks).toBeGreaterThan(0)
  })
})

// -----------------------------------------------------------------------
// Known bugs the fuzzer found, reproduced minimally and deterministically.
// Not fixed here — see the PR description for triage. `it.fails` means the
// test body is *expected* to fail its assertion; it will start failing the
// suite (as a signal to remove the `.fails`) once room.ts is actually fixed.
// -----------------------------------------------------------------------

describe('bugs discovered by the fuzz harness (fixed in room.ts)', () => {
  // Was: RoomCoordinator.join()'s reconnect branch never re-checked the
  // connectedCount >= 10 cap the new-participant branch enforces, so a
  // participant who still held a valid session token could reconnect into
  // an already-full room and push the connected count past 10. Fixed by
  // running the same capacity check before `existing.connected = true`.
  it('does not let a reconnecting participant push a full room past the 10-connected cap', () => {
    const media: MediaFingerprint = { service: 'youtube', canonicalId: 'youtube:cap', title: 'Cap test', durationSeconds: 100 }
    const room = new RoomCoordinator(
      { roomId: 'room_cap', code: 'CAPCAPCA' },
      { id: 'host', name: 'Host', media, sessionToken: 'host-session-token-000000' },
      () => 1_000,
    )

    // Fill the room to the cap: host + 9 members = 10 connected. Host-approval
    // join (SYJ-AUD-003) means each brand-new member must be approved before
    // it becomes a real, connected participant.
    for (let i = 0; i < 9; i++) {
      room.join({ id: `member_${i}`, name: `Member ${i}`, media, sessionToken: `member-${i}-session-token-0000` })
      room.respondToJoin('host', room.snapshot().controller.leaseEpoch, `member_${i}`, true)
    }
    expect(room.snapshot().participants.filter(p => p.connected)).toHaveLength(10)

    // member_0 drops, freeing a slot; a brand-new tenth member takes it, so
    // the room is back at the cap while member_0 remains a known,
    // disconnected participant holding a still-valid session token.
    room.disconnect('member_0')
    room.join({ id: 'member_9', name: 'Member 9', media, sessionToken: 'member-9-session-token-0000' })
    room.respondToJoin('host', room.snapshot().controller.leaseEpoch, 'member_9', true)
    expect(room.snapshot().participants.filter(p => p.connected)).toHaveLength(10)

    // member_0 reconnects with that valid token while the room shows 10/10.
    const reconnected = room.join({ id: 'member_0', name: 'Member 0', media, sessionToken: 'member-0-session-token-0000' })

    expect(reconnected.snapshot.participants.filter(p => p.connected).length).toBeLessThanOrEqual(10)
  })

  // Was: RoomCoordinator.updatePlayerStatus()'s pause-on-failure branch set
  // `positionSeconds: Math.max(0, sample.positionSeconds)` straight from the
  // client-reported sample, with no upper bound -- unlike control(), which
  // always routes its target through clampToMediaDuration(). A player (or a
  // hostile client) reporting a position past the media's own duration,
  // combined with playbackStartFailed: true (or sustained buffering/stall),
  // left playback.positionSeconds greater than media.durationSeconds. Fixed
  // by routing this assignment through clampToMediaDuration() too.
  it('clamps an adversarial player-reported position to the media duration when pausing on failure', () => {
    const media: MediaFingerprint = { service: 'youtube', canonicalId: 'youtube:dur', title: 'Duration test', durationSeconds: 120 }
    const room = new RoomCoordinator(
      { roomId: 'room_dur', code: 'DURDURDU' },
      { id: 'host', name: 'Host', media },
      () => 10_000,
    )
    room.setReady('host', true, media)
    room.control('host', {
      actionId: 'action_play_dur',
      basedOnRevision: room.snapshot().revision,
      leaseEpoch: room.snapshot().controller.leaseEpoch,
      kind: 'play',
      positionSeconds: 10,
    })

    const result = room.updatePlayerStatus('host', room.snapshot().revision, {
      positionSeconds: 999_999,
      durationSeconds: 120,
      paused: true,
      buffering: false,
      sampledAtLocalMs: 20_000,
      playbackStartFailed: true,
    })

    expect(result?.snapshot.playback.positionSeconds).toBeLessThanOrEqual(120)
  })
})
