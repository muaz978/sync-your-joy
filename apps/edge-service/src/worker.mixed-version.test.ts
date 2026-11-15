import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import type { ServerMessage } from '@syncyourjoy/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  V0_2_4_PENDING_REQUEST_ROOM,
  V0_2_4_PENDING_SEEK_PAUSED_ROOM,
  V0_2_4_PENDING_SEEK_RESUME_ROOM,
  V0_2_4_PLAYING_ROOM,
  V0_2_4_RECORD_AFTER_ROLLBACK_OF_A_COMMITTED_ROOM,
} from './pre-contract-records.fixture.ts'

// The Durable Object base class only exists inside the Workers runtime. The
// room logic under test does not depend on anything it provides.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const { RoomDurableObject } = await import('./worker.ts')

// Evidence class: in-process tests over a hand-written storage harness that
// drives the real RoomDurableObject class, with clients that are scripted
// messages. There is no older edge service, no workerd and no real Durable
// Object storage here. The retained records are samples of what the v0.2.4
// release wrote (see pre-contract-records.fixture.ts), not records read from a
// deployment.

const CODE = 'EDGE1234'
const MEDIA = { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A private title', durationSeconds: 600 }
const START_MS = 1_900_000_000_000
const MAX_ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000

type Room = InstanceType<typeof RoomDurableObject>
type Snapshot = Extract<ServerMessage, { type: 'room_snapshot' }>
type Stored = { coordinator: Record<string, any>, pendingController: unknown, emptySinceMs: number | null, createdAtMs: number }

class FakeSocket {
  attachment: unknown
  sent: ServerMessage[] = []
  closed: { code: number | undefined, reason: string | undefined } | null = null

  constructor(participantId: string | null = null) {
    this.attachment = { participantId, roomCode: CODE, messageWindowStartedAt: Date.now(), messageCount: 0 }
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value)
  }

  deserializeAttachment(): unknown {
    return this.attachment
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }

  snapshots(): Snapshot[] {
    return this.sent.filter((message): message is Snapshot => message.type === 'room_snapshot')
  }

  reasons(): string[] {
    return this.snapshots().map(message => message.reason)
  }
}

function newStore(initial?: Stored): { store: Map<string, unknown>, alarms: number[] } {
  const store = new Map<string, unknown>()
  if (initial)
    store.set('room', structuredClone(initial))
  return { store, alarms: [] }
}

function objectOver(storage: ReturnType<typeof newStore>, sockets: FakeSocket[]): Room {
  const ctx = {
    storage: {
      get: async (key: string) => storage.store.get(key),
      put: async (key: string, value: unknown) => { storage.store.set(key, structuredClone(value)) },
      delete: async (key: string) => storage.store.delete(key),
      deleteAll: async () => { storage.store.clear() },
      setAlarm: async (at: number) => { storage.alarms.push(at) },
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  }
  return new RoomDurableObject(ctx as never, {} as never)
}

const restored = async (room: Room) => {
  await (room as unknown as { initialized: Promise<void> }).initialized
  return room
}

async function say(room: Room, socket: FakeSocket, message: unknown): Promise<void> {
  await room.webSocketMessage(socket as never, JSON.stringify(message))
}

const storedOf = (storage: ReturnType<typeof newStore>) => storage.store.get('room') as Stored

const approve = (participantId: string) => ({ type: 'respond_to_join', participantId, approve: true, actionId: `action_approve_${participantId}`, basedOnRevision: 0, leaseEpoch: 1 })

afterEach(() => {
  vi.useRealTimers()
})

interface Members {
  storage: ReturnType<typeof newStore>
  room: Room
  host: FakeSocket
  friend: FakeSocket
  sockets: FakeSocket[]
  revision: () => number
  operation: () => NonNullable<NonNullable<Snapshot['snapshot']['contract']>['operation']>
  play: (positionSeconds?: number) => Promise<void>
  ack: (socket: FakeSocket, participantId: string, operation: { mediaEpoch: number, operationId: string }, phase?: 'prepared' | 'started') => Promise<void>
}

/** A host and an approved friend, both ready. `friendCapabilities` null means the friend advertises nothing, as a client from before the contract does. */
async function members(friendCapabilities: typeof CURRENT_CLIENT_CAPABILITIES | null): Promise<Members> {
  vi.useFakeTimers({ toFake: ['Date'], now: START_MS })
  const storage = newStore()
  const host = new FakeSocket()
  const friend = new FakeSocket()
  const sockets = [host, friend]
  const room = objectOver(storage, sockets)
  await say(room, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, capabilities: CURRENT_CLIENT_CAPABILITIES })
  await say(room, friend, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: MEDIA, ...(friendCapabilities ? { capabilities: friendCapabilities } : {}) })
  await say(room, host, approve('participant_friend'))
  await say(room, host, { type: 'set_ready', ready: true, media: MEDIA })
  await say(room, friend, { type: 'set_ready', ready: true, media: MEDIA })
  const revision = () => host.snapshots().at(-1)!.snapshot.revision
  return {
    storage,
    room,
    host,
    friend,
    sockets,
    revision,
    operation: () => {
      const operation = host.snapshots().at(-1)!.snapshot.contract?.operation
      if (!operation)
        throw new Error('Expected an operation in the last snapshot.')
      return operation
    },
    play: positionSeconds => say(room, host, { type: 'control', actionId: `action_play_${revision()}`, basedOnRevision: revision(), leaseEpoch: 1, kind: 'play', positionSeconds: positionSeconds ?? 20 }),
    ack: (socket, participantId, operation, phase = 'prepared') => say(room, socket, {
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase, participantId,
        bindingId: `binding_${participantId}`, sourceGeneration: 1, sampleSequence: 1, observedPositionSeconds: 20, observedAtLocalMs: Date.now(),
      },
    }),
  }
}

describe('RoomDurableObject: a room with a client that advertises nothing stays legacy', () => {
  it('uses the legacy commands and creates no operation, and ignores an operation_ack', async () => {
    const room = await members(null)
    expect(room.host.snapshots().at(-1)!.snapshot.contract).toMatchObject({ mode: 'legacy', operation: null })

    await room.play()
    expect(room.host.reasons().at(-1)).toBe('control_play')
    expect(room.host.snapshots().at(-1)!.snapshot.contract).toMatchObject({ mode: 'legacy', operation: null })

    // An acknowledgement for an operation that was never issued: it changes
    // nothing and nothing is announced for it. (This alone does not pin the
    // mode check, since an unknown operation id is also refused; the test of a
    // genuine operation below does.)
    const before = structuredClone(storedOf(room.storage))
    const heard = room.host.sent.length
    await room.ack(room.host, 'participant_host', { mediaEpoch: 0, operationId: 'operation_that_was_never_issued' })
    await room.ack(room.friend, 'participant_friend', { mediaEpoch: 0, operationId: 'operation_that_was_never_issued' }, 'started')
    expect(room.host.sent).toHaveLength(heard)
    expect(room.friend.snapshots().at(-1)!.snapshot.revision).toBe(room.revision())
    expect(storedOf(room.storage)).toEqual(before)
  })

  it('uses the seek barrier for a seek, and the legacy seek_applied path settles it', async () => {
    const room = await members(null)

    await say(room.room, room.host, { type: 'control', actionId: 'action_seek', basedOnRevision: room.revision(), leaseEpoch: 1, kind: 'seek', positionSeconds: 30 })

    expect(room.host.reasons().at(-1)).toBe('control_seek_pending')
    expect(room.host.snapshots().at(-1)!.snapshot.contract?.operation).toBeNull()
    const revision = room.revision()
    await say(room.room, room.host, { type: 'seek_applied', revision, positionSeconds: 30 })
    await say(room.room, room.friend, { type: 'seek_applied', revision, positionSeconds: 30 })
    expect(room.host.reasons().at(-1)).toBe('seek_aligned_paused')
  })
})

describe('RoomDurableObject: a legacy client during a live operation', () => {
  /** Both members advertise the current contract and a Play is preparing. */
  async function preparing() {
    const room = await members(CURRENT_CLIENT_CAPABILITIES)
    await room.play()
    const operation = room.operation()
    expect(room.host.reasons().at(-1)).toBe('control_play_pending')
    expect(operation).toMatchObject({ kind: 'play', phase: 'preparing' })
    return { room, operation }
  }

  /**
   * The operation is cancelled, the room is legacy, the members were told and
   * what they were told was saved, and the genuine operation's
   * acknowledgements, which a transactional room would accept, change nothing.
   * `reason` is the one the coordinator records: a join or a return is a
   * membership change, which pauses the room and cancels the operation before
   * negotiation runs, so it is the membership reason and not `legacy-peer`.
   */
  async function expectCancelled(room: Members, operation: { mediaEpoch: number, operationId: string }, snapshotReason: string, operationReason: string) {
    const announced = room.host.snapshots().at(-1)!
    expect(announced.reason).toBe(snapshotReason)
    expect(announced.snapshot.contract).toMatchObject({ mode: 'legacy', operation: { operationId: operation.operationId, phase: 'cancelled', reason: operationReason } })
    expect(announced.snapshot.playback.status).toBe('paused')
    expect(storedOf(room.storage).coordinator.contract).toMatchObject({ mode: 'legacy', operation: { phase: 'cancelled', reason: operationReason } })
    expect(storedOf(room.storage).coordinator.revision).toBe(announced.snapshot.revision)

    const heard = room.host.sent.length
    const saved = structuredClone(storedOf(room.storage))
    await room.ack(room.host, 'participant_host', operation)
    await room.ack(room.friend, 'participant_friend', operation)
    await room.ack(room.host, 'participant_host', operation, 'started')
    expect(room.host.sent).toHaveLength(heard)
    expect(storedOf(room.storage)).toEqual(saved)
  }

  it('cancels the operation when a client that advertises nothing is approved into the room', async () => {
    const { room, operation } = await preparing()
    const newcomer = new FakeSocket()
    room.sockets.push(newcomer)

    await say(room.room, newcomer, { type: 'join_room', protocolVersion: 1, participantId: 'participant_old', name: 'Sam', code: CODE, media: MEDIA })
    expect(newcomer.sent.at(-1)).toMatchObject({ type: 'room_joined' })
    // A request is not a member: the room is still transactional with its operation live.
    expect(room.operation()).toMatchObject({ operationId: operation.operationId, phase: 'preparing' })
    await say(room.room, room.host, approve('participant_old'))

    await expectCancelled(room, operation, 'join_approved', 'participant-disconnected')
  })

  it('cancels the operation when a member comes back on an older client that advertises nothing', async () => {
    const { room, operation } = await preparing()
    const token = (room.friend.sent.find(message => message.type === 'room_joined') as Extract<ServerMessage, { type: 'room_joined' }>).sessionToken
    const downgraded = new FakeSocket()
    room.sockets.splice(room.sockets.indexOf(room.friend), 1, downgraded)

    await say(room.room, downgraded, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: MEDIA, sessionToken: token })
    expect(downgraded.sent.at(-1)).toMatchObject({ type: 'room_joined' })

    await expectCancelled({ ...room, friend: downgraded }, operation, 'participant_reconnected', 'participant-disconnected')
  })

  // Negotiation is redone when a member joins, comes back, or the room is
  // restored (refreshNegotiation in room.ts), and not when a member leaves.
  // This is what happens today; whether the mode should be renegotiated on a
  // leave is a question for the owner. The room fails closed to legacy.
  it('stays legacy after the legacy client has left, until a member joins or comes back (current behaviour)', async () => {
    const { room, operation } = await preparing()
    const newcomer = new FakeSocket()
    room.sockets.push(newcomer)
    await say(room.room, newcomer, { type: 'join_room', protocolVersion: 1, participantId: 'participant_old', name: 'Sam', code: CODE, media: MEDIA })
    await say(room.room, room.host, approve('participant_old'))
    expect(room.host.snapshots().at(-1)!.snapshot.contract?.mode).toBe('legacy')

    room.sockets.splice(room.sockets.indexOf(newcomer), 1)
    await room.room.webSocketClose(newcomer as never, 1000, 'left_room')
    expect(room.host.reasons().at(-1)).toBe('participant_disconnected')
    expect(room.host.snapshots().at(-1)!.snapshot.contract).toMatchObject({ mode: 'legacy', operation: { operationId: operation.operationId, phase: 'cancelled' } })
    await room.play(25)
    expect(room.host.reasons().at(-1)).toBe('control_play')
    // The legacy Play creates no operation; the cancelled one is still what the snapshot carries.
    expect(room.host.snapshots().at(-1)!.snapshot.contract?.operation).toMatchObject({ operationId: operation.operationId, phase: 'cancelled' })

    // A current member coming back is what negotiates the room again.
    const token = (room.friend.sent.find(message => message.type === 'room_joined') as Extract<ServerMessage, { type: 'room_joined' }>).sessionToken
    const friendBack = new FakeSocket()
    room.sockets.splice(room.sockets.indexOf(room.friend), 1, friendBack)
    await say(room.room, friendBack, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: MEDIA, sessionToken: token, capabilities: CURRENT_CLIENT_CAPABILITIES })
    expect(room.host.snapshots().at(-1)!.snapshot.contract?.mode).toBe('transactional')
  })

  it('cancels a live operation as legacy-peer when a stored room carries one for a member that advertises nothing', async () => {
    const { room, operation } = await preparing()
    const record = structuredClone(storedOf(room.storage))
    for (const participant of record.coordinator.participants) {
      if (participant.id === 'participant_friend')
        delete participant.capabilities
    }
    expect(record.coordinator.contract.operation).toMatchObject({ operationId: operation.operationId, phase: 'preparing' })

    const storage = newStore(record)
    const sockets = [new FakeSocket('participant_host'), new FakeSocket('participant_friend')]
    const restarted = await restored(objectOver(storage, sockets))

    const state = (restarted as unknown as { coordinator: { exportState: () => Record<string, any> } }).coordinator.exportState()
    expect(state.contract).toMatchObject({ mode: 'legacy', operation: { operationId: operation.operationId, phase: 'cancelled', reason: 'legacy-peer' } })
    expect(state.playback.status).toBe('paused')
    expect(storedOf(storage).coordinator.contract).toMatchObject({ mode: 'legacy', operation: { phase: 'cancelled', reason: 'legacy-peer' } })
  })
})

describe('RoomDurableObject: stored rooms written before the contract existed (v0.2.4 samples)', () => {
  const WAKE_MS = START_MS + 5_000
  const host = () => new FakeSocket('participant_host')
  const friend = () => new FakeSocket('participant_friend')

  async function restoreFrom(fixture: unknown, sockets: FakeSocket[]) {
    vi.useFakeTimers({ toFake: ['Date'], now: WAKE_MS })
    const storage = newStore(fixture as Stored)
    const room = await restored(objectOver(storage, sockets))
    const coordinator = (room as unknown as { coordinator: { exportState: () => Record<string, any>, snapshot: () => Snapshot['snapshot'] } }).coordinator
    return { storage, room, coordinator }
  }

  it('has none of the fields that came with the contract, so the cases below are real replays', () => {
    for (const fixture of [V0_2_4_PLAYING_ROOM, V0_2_4_PENDING_SEEK_PAUSED_ROOM, V0_2_4_PENDING_SEEK_RESUME_ROOM, V0_2_4_PENDING_REQUEST_ROOM]) {
      const coordinator = (fixture as Stored).coordinator
      expect(coordinator).not.toHaveProperty('contract')
      expect(coordinator).not.toHaveProperty('stateVersion')
      expect(coordinator).not.toHaveProperty('disconnectGrace')
      for (const participant of coordinator.participants)
        expect(participant).not.toHaveProperty('capabilities')
    }
    // The record the v0.2.4 code wrote after a rollback has none of the contract fields either, but keeps the capabilities it was given.
    const rolledBack = (V0_2_4_RECORD_AFTER_ROLLBACK_OF_A_COMMITTED_ROOM as Stored).coordinator
    expect(rolledBack).not.toHaveProperty('contract')
    expect(rolledBack).not.toHaveProperty('stateVersion')
    expect(rolledBack).not.toHaveProperty('disconnectGrace')
    for (const participant of rolledBack.participants)
      expect(participant.capabilities).toMatchObject({ contractVersion: 1 })
  })

  it('restores a playing room paused at the position it had, keeps its health evidence and adds none', async () => {
    const sockets = [host(), friend()]
    const before = (V0_2_4_PLAYING_ROOM as Stored).coordinator
    expect(before.playback).toMatchObject({ status: 'playing', positionSeconds: 20 })

    const { storage, coordinator } = await restoreFrom(V0_2_4_PLAYING_ROOM, sockets)

    const after = coordinator.exportState()
    expect(after.playback).toMatchObject({ status: 'paused', positionSeconds: 20 })
    expect(after.revision).toBe(before.revision + 1)
    expect(after.contract).toMatchObject({ mode: 'legacy', operation: null })
    expect(after.participants.map((p: any) => [p.lastSample, p.lastSampleReceivedAtMs, p.lastProgressAtServerMs]))
      .toEqual(before.participants.map((p: any) => [p.lastSample, p.lastSampleReceivedAtMs, p.lastProgressAtServerMs]))
    // It is saved in the current shape, and only the lifetime limit is left to schedule: no health deadline for a room that is paused.
    expect(storedOf(storage).coordinator).toMatchObject({ stateVersion: 2, playback: { status: 'paused' }, contract: { mode: 'legacy', operation: null } })
    expect(storage.alarms).toEqual([START_MS + MAX_ROOM_LIFETIME_MS])
  })

  for (const [name, fixture, resumes] of [
    ['a paused room in the middle of a seek barrier', V0_2_4_PENDING_SEEK_PAUSED_ROOM, false],
    ['a playing room in the middle of a seek barrier that was to resume playback', V0_2_4_PENDING_SEEK_RESUME_ROOM, true],
  ] as const) {
    it(`restores ${name} paused at the seek target, drops the barrier, and ignores a late seek_applied`, async () => {
      const sockets = [host(), friend()]
      const before = (fixture as Stored).coordinator
      expect(before.pendingSeek).toMatchObject({ positionSeconds: 90, resumeWhenReady: resumes, acknowledgedParticipantIds: ['participant_host'] })

      const { storage, room, coordinator } = await restoreFrom(fixture, sockets)

      const after = coordinator.exportState()
      expect(after.pendingSeek).toBeNull()
      expect(after.playback).toMatchObject({ status: 'paused', positionSeconds: 90 })
      expect(after.revision).toBe(before.revision + 1)
      expect(after.contract).toMatchObject({ mode: 'legacy', operation: null })
      expect(storage.alarms).toEqual([START_MS + MAX_ROOM_LIFETIME_MS])

      // The old barrier's acknowledgement list is not preparation evidence: a
      // late alignment report for the revision it was issued under, from the
      // member that had not yet aligned, restarts nothing and announces nothing.
      const heard = sockets.map(socket => socket.sent.length)
      await say(room, sockets[1]!, { type: 'seek_applied', revision: before.revision, positionSeconds: 90 })
      await say(room, sockets[0]!, { type: 'seek_applied', revision: before.revision, positionSeconds: 90 })
      expect(sockets.map(socket => socket.sent.length)).toEqual(heard)
      expect(coordinator.exportState().playback).toMatchObject({ status: 'paused', positionSeconds: 90 })
      expect(storedOf(storage).coordinator.playback.status).toBe('paused')
    })
  }

  it('keeps a waiting request whose socket is still attached, and the host can still approve it', async () => {
    const sockets = [host(), friend()]

    const { storage, room, coordinator } = await restoreFrom(V0_2_4_PENDING_REQUEST_ROOM, sockets)

    expect(coordinator.snapshot().pendingJoinRequests.map(request => request.id)).toEqual(['participant_friend'])
    expect(storedOf(storage).coordinator.contract).toMatchObject({ mode: 'legacy' })
    await say(room, sockets[0]!, { ...approve('participant_friend'), basedOnRevision: coordinator.snapshot().revision })
    expect(sockets[1]!.snapshots().at(-1)).toMatchObject({ reason: 'join_approved', snapshot: { participants: [expect.anything(), expect.anything()] } })
  })

  it('rolls forward a room that the v0.2.4 coordinator wrote back after a rollback: paused at the Play\'s target with no operation, and transactional again for members that advertise it', async () => {
    const sockets = [host(), friend()]
    const before = (V0_2_4_RECORD_AFTER_ROLLBACK_OF_A_COMMITTED_ROOM as Stored).coordinator
    expect(before.playback).toMatchObject({ status: 'playing', positionSeconds: 20 })

    const { storage, room, coordinator } = await restoreFrom(V0_2_4_RECORD_AFTER_ROLLBACK_OF_A_COMMITTED_ROOM, sockets)

    const after = coordinator.exportState()
    expect(after.playback).toMatchObject({ status: 'paused', positionSeconds: 20 })
    expect(after.revision).toBe(before.revision + 1)
    expect(after.contract).toMatchObject({ mode: 'transactional', operation: null })
    expect(storedOf(storage).coordinator).toMatchObject({ stateVersion: 2, contract: { mode: 'transactional', operation: null } })
    expect(storage.alarms).toEqual([START_MS + MAX_ROOM_LIFETIME_MS])

    // The room is usable with the current contract again.
    await say(room, sockets[0]!, { type: 'control', actionId: 'action_play_after_rollback', basedOnRevision: coordinator.snapshot().revision, leaseEpoch: 1, kind: 'play', positionSeconds: 20 })
    expect(sockets[0]!.reasons().at(-1)).toBe('control_play_pending')
    expect(sockets[0]!.snapshots().at(-1)!.snapshot.contract?.operation).toMatchObject({ kind: 'play', phase: 'preparing' })
  })

  it('stays legacy while the members of the old room are back on current clients one at a time, and becomes transactional when both advertise', async () => {
    const stale = [host(), friend()]
    const { storage, room, coordinator } = await restoreFrom(V0_2_4_PENDING_SEEK_PAUSED_ROOM, stale)
    expect(coordinator.snapshot().contract?.mode).toBe('legacy')

    // The friend comes back on a current client (the token it was given by the old release); the host's record still has no capabilities.
    const friendBack = new FakeSocket()
    const sockets = [stale[0]!, friendBack]
    ;(room as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => sockets
    await say(room, friendBack, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: MEDIA, sessionToken: 'friend_token_aaaaaaaaaa', capabilities: CURRENT_CLIENT_CAPABILITIES })
    expect(friendBack.sent.at(-1)).toMatchObject({ type: 'room_joined' })
    expect(coordinator.snapshot().contract).toMatchObject({ mode: 'legacy' })
    await say(room, stale[0]!, { type: 'control', actionId: 'action_play_mixed', basedOnRevision: coordinator.snapshot().revision, leaseEpoch: 1, kind: 'play', positionSeconds: 90 })
    expect(stale[0]!.reasons().at(-1)).toBe('control_play')
    expect(coordinator.snapshot().contract?.operation).toBeNull()

    // Then the host comes back on a current client too.
    const hostBack = new FakeSocket()
    sockets.splice(0, 1, hostBack)
    await say(room, hostBack, { type: 'join_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, sessionToken: 'host_token_aaaaaaaaaaaa', capabilities: CURRENT_CLIENT_CAPABILITIES })
    expect(hostBack.sent.at(-1)).toMatchObject({ type: 'room_joined' })
    expect(coordinator.snapshot().contract?.mode).toBe('transactional')
    expect(storedOf(storage).coordinator.contract.mode).toBe('transactional')
  })
})
