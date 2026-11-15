import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import type { ServerMessage } from '@syncyourjoy/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

// Evidence class: in-process tests over a hand-written storage and alarm
// harness that drives the real RoomDurableObject class. This is not the
// Workers runtime: no workerd, no real Durable Object storage, no real alarm
// delivery, no hibernation. A "restart" is a second object built over the same
// store.

const CODE = 'EDGE1234'
const MEDIA = { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A private title', durationSeconds: 600 }
const START_MS = 1_900_000_000_000
const SEEK_BARRIER_MAX_WAIT_MS = 3_000
const PLAYBACK_PROGRESS_TIMEOUT_MS = 1_800
const PING_INTERVAL_MS = 5_000

type Room = InstanceType<typeof RoomDurableObject>
type Snapshot = Extract<ServerMessage, { type: 'room_snapshot' }>

class FakeSocket {
  attachment: unknown = null
  sent: ServerMessage[] = []
  closed: { code: number | undefined, reason: string | undefined } | null = null

  constructor() {
    this.attachment = { participantId: null, roomCode: CODE, messageWindowStartedAt: Date.now(), messageCount: 0 }
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

  last(): ServerMessage | undefined {
    return this.sent.at(-1)
  }
}

/** What a test can see and steer of the storage a room object runs over. */
interface Storage {
  store: Map<string, unknown>
  /** Alarm times the object asked for, in order. */
  alarms: number[]
  /** Counts of storage calls, so a test can state what a message costs. */
  puts: { count: number }
  setAlarms: { count: number }
  /** While set, every `put` waits for it; a test releases it to let the write finish. */
  putGate: { current: Promise<void> | null }
  /** While true, `put` throws instead of writing. */
  failPuts: { current: boolean }
}

function newStorage(store: Map<string, unknown> = new Map()): Storage {
  return {
    store,
    alarms: [],
    puts: { count: 0 },
    setAlarms: { count: 0 },
    putGate: { current: null },
    failPuts: { current: false },
  }
}

function objectOver(storage: Storage, sockets: FakeSocket[]): Room {
  const ctx = {
    storage: {
      get: async (key: string) => storage.store.get(key),
      put: async (key: string, value: unknown) => {
        storage.puts.count += 1
        if (storage.failPuts.current)
          throw new Error('storage unavailable')
        if (storage.putGate.current)
          await storage.putGate.current
        storage.store.set(key, structuredClone(value))
      },
      delete: async (key: string) => storage.store.delete(key),
      deleteAll: async () => { storage.store.clear() },
      setAlarm: async (at: number) => {
        storage.setAlarms.count += 1
        storage.alarms.push(at)
      },
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  }
  return new RoomDurableObject(ctx as never, {} as never)
}

/** Holds every write until `release()` is called. */
function holdWrites(storage: Storage): { release: () => void } {
  let release!: () => void
  storage.putGate.current = new Promise<void>((resolve) => { release = resolve })
  return {
    release: () => {
      storage.putGate.current = null
      release()
    },
  }
}

async function say(room: Room, socket: FakeSocket, message: unknown): Promise<void> {
  await room.webSocketMessage(socket as never, JSON.stringify(message))
}

/** Lets pending microtasks and macrotasks run, so a held write can be seen to be held. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const tick = (ms: number) => vi.setSystemTime(Date.now() + ms)

const approve = { type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_approve_friend', basedOnRevision: 0, leaseEpoch: 1 }

interface Pair {
  storage: Storage
  room: Room
  host: FakeSocket
  friend: FakeSocket
  sockets: FakeSocket[]
  revision: () => number
  stored: () => { coordinator: Record<string, any>, pendingController: unknown, emptySinceMs: number | null, createdAtMs: number }
  play: (positionSeconds?: number) => Promise<void>
  sample: (socket: FakeSocket, overrides?: Record<string, unknown>) => Promise<void>
  acknowledge: (socket: FakeSocket, participantId: string, phase: 'prepared' | 'started', sampleSequence: number) => Promise<void>
}

/**
 * A host and an approved friend. With `transactional` both advertise the
 * current capabilities, so Play is a prepared and committed operation; without
 * it neither advertises anything, so the room is legacy and a seek uses the
 * pending-seek barrier.
 */
async function pair(options: { transactional: boolean, ready?: boolean }): Promise<Pair> {
  vi.useFakeTimers({ toFake: ['Date'], now: START_MS })
  const storage = newStorage()
  const host = new FakeSocket()
  const friend = new FakeSocket()
  const sockets = [host, friend]
  const room = objectOver(storage, sockets)
  const capabilities = options.transactional ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}
  await say(room, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, ...capabilities })
  await say(room, friend, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: MEDIA, ...capabilities })
  await say(room, host, approve)
  if (options.ready !== false) {
    await say(room, host, { type: 'set_ready', ready: true, media: MEDIA })
    await say(room, friend, { type: 'set_ready', ready: true, media: MEDIA })
  }
  const revision = () => host.snapshots().at(-1)!.snapshot.revision
  return {
    storage,
    room,
    host,
    friend,
    sockets,
    revision,
    stored: () => storage.store.get('room') as ReturnType<Pair['stored']>,
    play: positionSeconds => say(room, host, { type: 'control', actionId: `action_play_${storage.puts.count}`, basedOnRevision: revision(), leaseEpoch: 1, kind: 'play', positionSeconds: positionSeconds ?? 20 }),
    sample: (socket, overrides = {}) => say(room, socket, {
      type: 'player_status',
      basedOnRevision: revision(),
      sample: { positionSeconds: 20, durationSeconds: 600, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: Date.now(), ...overrides },
    }),
    acknowledge: (socket, participantId, phase, sampleSequence) => {
      const operation = host.snapshots().at(-1)!.snapshot.contract?.operation
      if (!operation)
        throw new Error('Expected a transactional operation.')
      return say(room, socket, {
        type: 'operation_ack',
        acknowledgement: {
          mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase, participantId,
          bindingId: `binding_${participantId}`, sourceGeneration: 1, sampleSequence, observedPositionSeconds: 20, observedAtLocalMs: Date.now(),
        },
      })
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RoomDurableObject: a due alarm is saved before it is announced', () => {
  // Each case builds a room whose next deadline is of one family, moves the
  // clock to that deadline, holds the write, and checks what the members have
  // heard while it is held and what the store held at the moment they heard it.
  const cases: Array<{
    family: string
    reason: string
    build: () => Promise<Pair>
    durable: (stored: ReturnType<Pair['stored']>) => boolean
  }> = [
    {
      family: 'seek',
      reason: 'seek_timeout_paused',
      build: async () => {
        const room = await pair({ transactional: false, ready: false })
        await say(room.room, room.host, { type: 'control', actionId: 'action_seek', basedOnRevision: room.revision(), leaseEpoch: 1, kind: 'seek', positionSeconds: 30 })
        expect(room.host.reasons().at(-1)).toBe('control_seek_pending')
        tick(SEEK_BARRIER_MAX_WAIT_MS)
        return room
      },
      durable: stored => stored.coordinator.pendingSeek === null && stored.coordinator.playback.status === 'paused',
    },
    {
      family: 'operation',
      reason: 'operation_timeout_paused',
      build: async () => {
        const room = await pair({ transactional: true })
        await room.play()
        expect(room.host.reasons().at(-1)).toBe('control_play_pending')
        tick(SEEK_BARRIER_MAX_WAIT_MS)
        return room
      },
      durable: stored => stored.coordinator.contract.operation?.phase === 'failed' && stored.coordinator.playback.status === 'paused',
    },
    {
      family: 'health',
      reason: 'participant_playback_stalled',
      build: async () => {
        const room = await pair({ transactional: false })
        await room.play()
        expect(room.host.reasons().at(-1)).toBe('control_play')
        tick(1_000)
        await room.sample(room.host)
        tick(PLAYBACK_PROGRESS_TIMEOUT_MS)
        return room
      },
      durable: stored => stored.coordinator.playback.status === 'paused',
    },
  ]

  for (const { family, reason, build, durable } of cases) {
    it(`writes the ${family} transition before any member hears it`, async () => {
      const room = await build()
      const storedWhenHeard: Array<ReturnType<Pair['stored']>> = []
      for (const socket of [room.host, room.friend]) {
        const send = socket.send.bind(socket)
        socket.send = (data: string) => {
          if ((JSON.parse(data) as ServerMessage & { reason?: string }).reason === reason)
            storedWhenHeard.push(structuredClone(room.stored()))
          send(data)
        }
      }
      expect(durable(room.stored())).toBe(false)
      const held = holdWrites(room.storage)

      const turn = room.room.alarm()
      await settle()

      // The room is changed in memory, but nobody has been told and the store
      // still holds the state from before the alarm.
      expect(room.host.reasons()).not.toContain(reason)
      expect(room.friend.reasons()).not.toContain(reason)
      expect(durable(room.stored())).toBe(false)

      held.release()
      await turn

      expect(room.host.reasons().filter(item => item === reason)).toHaveLength(1)
      expect(room.friend.reasons().filter(item => item === reason)).toHaveLength(1)
      expect(storedWhenHeard).toHaveLength(2)
      expect(storedWhenHeard.every(durable)).toBe(true)
    })

    it(`announces nothing for the ${family} transition when its write fails`, async () => {
      const room = await build()
      const before = room.host.sent.length
      room.storage.failPuts.current = true

      await expect(room.room.alarm()).rejects.toThrow('storage unavailable')

      expect(room.host.sent).toHaveLength(before)
      expect(room.friend.reasons()).not.toContain(reason)
    })

    it(`makes one ${family} transition when the same alarm is delivered again, and when it is delivered late`, async () => {
      const room = await build()

      await room.room.alarm()
      const revisionAfterFirst = room.revision()
      const storedAfterFirst = structuredClone(room.stored())
      const heard = room.host.sent.length
      expect(room.host.reasons().filter(item => item === reason)).toHaveLength(1)

      // The platform delivers the same alarm again, and then an hour late.
      await room.room.alarm()
      tick(60 * 60 * 1000)
      await room.room.alarm()

      expect(room.host.sent).toHaveLength(heard)
      expect(room.friend.reasons().filter(item => item === reason)).toHaveLength(1)
      expect(room.host.snapshots().at(-1)!.snapshot.revision).toBe(revisionAfterFirst)
      expect(room.stored()).toEqual(storedAfterFirst)
    })
  }
})

/** A second object over the same store with the sockets that are still attached: what a restart or an eviction leaves. */
function restart(before: Pair): { room: Room, storage: Storage } {
  const storage = newStorage(before.storage.store)
  return { room: objectOver(storage, before.sockets), storage }
}

const restored = async (room: Room) => {
  await (room as unknown as { initialized: Promise<void> }).initialized
  return room
}

type Participants = Array<{ id: string, lastSample: unknown, lastSampleReceivedAtMs?: number, lastProgressAtServerMs?: number }>

const coordinatorOf = (room: Room) => (room as unknown as {
  coordinator: { exportState: () => { revision: number, playback: { status: string, positionSeconds: number }, participants: Participants, contract: { mode: string, operation: { phase: string, reason?: string, deadlineAtServerMs: number } | null } } }
}).coordinator

const evidenceOf = (participants: Participants) => participants.map(({ id, lastSample, lastSampleReceivedAtMs, lastProgressAtServerMs }) => ({ id, lastSample, lastSampleReceivedAtMs, lastProgressAtServerMs }))

describe('RoomDurableObject: a cancelled operation across a restart', () => {
  it('stays cancelled, schedules no alarm for its old deadline and is not released when that deadline passes', async () => {
    const room = await pair({ transactional: true })
    await room.play()
    expect(room.host.reasons().at(-1)).toBe('control_play_pending')
    const oldDeadlineMs = room.host.snapshots().at(-1)!.snapshot.contract!.operation!.deadlineAtServerMs
    await say(room.room, room.host, { type: 'transfer_control', participantId: 'participant_friend', leaseEpoch: 1 })
    expect(room.stored().coordinator.contract.operation).toMatchObject({ phase: 'cancelled', reason: 'superseded' })

    const restarted = restart(room)
    await restored(restarted.room)
    expect(restarted.storage.alarms).not.toContain(oldDeadlineMs)

    vi.setSystemTime(oldDeadlineMs + 1_000)
    const heard = room.host.sent.length
    await restarted.room.alarm()

    expect(room.host.sent).toHaveLength(heard)
    expect(room.friend.reasons()).not.toContain('operation_timeout_paused')
    expect(restarted.storage.alarms).not.toContain(oldDeadlineMs)
    expect(coordinatorOf(restarted.room).exportState().contract.operation).toMatchObject({ phase: 'cancelled', reason: 'superseded' })
    expect(room.stored().coordinator.contract.operation).toMatchObject({ phase: 'cancelled', reason: 'superseded' })
  })
})

describe('RoomDurableObject: a restart after a sample that was not saved', () => {
  // A report that changes nothing a member can see is accepted in memory and
  // not written (updatePlayerStatus returns null, so nothing is saved), and a
  // ping is not written either. What is saved is the evidence of the last
  // write, which can be one ping interval (five seconds) older than the last
  // sample, against a progress limit of 1.8 s.
  async function playingThenRestarted() {
    const room = await pair({ transactional: false })
    await room.play()
    tick(1_000)
    await room.sample(room.host)
    await room.sample(room.friend)
    tick(1_000)
    await room.sample(room.host, { positionSeconds: 22 })
    await room.sample(room.friend, { positionSeconds: 22 })
    const writesBefore = room.storage.puts.count
    tick(1_000)
    await room.sample(room.host, { positionSeconds: 23 })
    await room.sample(room.friend, { positionSeconds: 23 })
    // The two samples above are in memory only.
    expect(room.storage.puts.count).toBe(writesBefore)
    const saved = evidenceOf(room.stored().coordinator.participants)
    tick(100)
    const restarted = restart(room)
    await restored(restarted.room)
    return { room, restarted, saved }
  }

  it('does not credit the restored room with progress it never saved', async () => {
    const { room, restarted, saved } = await playingThenRestarted()

    expect(saved.map(item => item.lastProgressAtServerMs)).toEqual([START_MS + 1_000, START_MS + 1_000])
    // The restored evidence is what was written, not the time of the restore
    // and not the later samples that were only in memory.
    expect(evidenceOf(coordinatorOf(restarted.room).exportState().participants)).toEqual(saved)
    expect(evidenceOf(room.stored().coordinator.participants)).toEqual(saved)
    // And the health alarm is derived from that evidence.
    expect(restarted.storage.alarms[0]).toBe(START_MS + 1_000 + PLAYBACK_PROGRESS_TIMEOUT_MS)
  })

  it('pauses the restored room as stalled at its first alarm when the saved evidence is older than 1.8 s, although the last real sample was 100 ms ago (current behaviour, no grace)', async () => {
    const { room, restarted } = await playingThenRestarted()
    const hostHeard = room.host.reasons().length
    const friendHeard = room.friend.reasons().length

    await restarted.room.alarm()

    expect(room.host.reasons().slice(hostHeard)).toEqual(['participant_playback_stalled'])
    expect(room.friend.reasons().slice(friendHeard)).toEqual(['participant_playback_stalled'])
    expect(coordinatorOf(restarted.room).exportState().playback.status).toBe('paused')
  })

  it('keeps the room playing when a member reports again after the restore and before that alarm', async () => {
    const { room, restarted } = await playingThenRestarted()
    const heard = room.host.reasons().length

    for (const socket of [room.host, room.friend]) {
      await say(restarted.room, socket, {
        type: 'player_status',
        basedOnRevision: room.revision(),
        sample: { positionSeconds: 23.2, durationSeconds: 600, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: Date.now() },
      })
    }
    await restarted.room.alarm()

    expect(room.host.reasons().slice(heard)).not.toContain('participant_playback_stalled')
    expect(coordinatorOf(restarted.room).exportState().playback.status).toBe('playing')
  })
})

describe('RoomDurableObject: a restart in the middle of an operation\'s start', () => {
  // Starts are recorded one at a time. Between the first and the last the
  // stored operation is committed with some, not all, participants started,
  // and the protocol validator for a stored operation accepts a committed one
  // only with no started participant. Owner decision of 2026-10-31 on #60: a
  // partly started committed operation that is restored on the edge service
  // takes the pause fallback, and a test pins that.
  async function partlyStarted() {
    const room = await pair({ transactional: true })
    await room.play()
    await room.acknowledge(room.host, 'participant_host', 'prepared', 1)
    await room.acknowledge(room.friend, 'participant_friend', 'prepared', 1)
    const committed = room.host.snapshots().at(-1)!.snapshot.contract!.operation!
    expect(committed.phase).toBe('committed')
    tick(committed.effectiveAtServerMs! - Date.now() + 10)
    await room.acknowledge(room.host, 'participant_host', 'started', 2)
    const stored = room.stored().coordinator
    expect(stored.contract.operation).toMatchObject({ phase: 'committed', startedParticipantIds: ['participant_host'] })
    expect(stored.playback.status).toBe('playing')
    return { room, storedRevision: stored.revision, operation: committed }
  }

  it('restores paused at the operation target with no operation, one revision on, and saves that', async () => {
    const { room, storedRevision } = await partlyStarted()

    const restarted = restart(room)
    await restored(restarted.room)

    const restoredState = coordinatorOf(restarted.room).exportState()
    expect(restoredState.playback).toMatchObject({ status: 'paused', positionSeconds: 20 })
    expect(restoredState.contract.operation).toBeNull()
    expect(restoredState.revision).toBe(storedRevision + 1)
    // The fallback is what was written, so a second restart does not repeat it.
    expect(room.stored().coordinator.playback.status).toBe('paused')
    expect(room.stored().coordinator.contract.operation).toBeNull()
    expect(room.stored().coordinator.revision).toBe(storedRevision + 1)
    // No deadline is left to fire for an operation or a health check that no longer exists.
    expect(restarted.storage.alarms).toEqual([START_MS + 6 * 60 * 60 * 1000])
  })

  it('does not let a late acknowledgement of the dropped operation bring it back', async () => {
    const { room, operation } = await partlyStarted()
    const restarted = restart(room)
    await restored(restarted.room)
    const heard = room.host.sent.length

    await say(restarted.room, room.friend, {
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase: 'started', participantId: 'participant_friend',
        bindingId: 'binding_participant_friend', sourceGeneration: 1, sampleSequence: 3, observedPositionSeconds: 20, observedAtLocalMs: Date.now(),
      },
    })

    expect(room.host.sent).toHaveLength(heard)
    expect(coordinatorOf(restarted.room).exportState().playback.status).toBe('paused')
    expect(coordinatorOf(restarted.room).exportState().contract.operation).toBeNull()
  })

  // What follows is what happens today, recorded so a change to it is a
  // decision and not an accident. It is not endorsed here: see the CR-B06 report.
  it('tells the attached members nothing at the restore: they hear of the pause with the next broadcast (current behaviour, open question)', async () => {
    const { room } = await partlyStarted()
    const heard = room.host.sent.length

    const restarted = restart(room)
    await restored(restarted.room)

    expect(room.host.sent).toHaveLength(heard)
    expect(room.friend.snapshots().at(-1)!.snapshot.playback.status).toBe('playing')

    // A member that still believes the room plays keeps reporting against the
    // revision it holds, and the restored room, one revision on, rejects it.
    await say(restarted.room, room.host, {
      type: 'player_status',
      basedOnRevision: room.revision(),
      sample: { positionSeconds: 21, durationSeconds: 600, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: Date.now() },
    })
    expect(room.host.sent).toHaveLength(heard)
    expect(coordinatorOf(restarted.room).exportState().revision).toBe(room.revision() + 1)
  })
})

describe('RoomDurableObject: an alarm whose write failed and is delivered again', () => {
  // The platform retries a failed alarm() on the same object, with the
  // coordinator already changed in memory. Verification pass of 2026-10-31 on
  // #60 lists this as a characterization test; the owner has not recorded a
  // decision on changing it.
  async function failedSeekAlarm() {
    const room = await pair({ transactional: false, ready: false })
    await say(room.room, room.host, { type: 'control', actionId: 'action_seek', basedOnRevision: room.revision(), leaseEpoch: 1, kind: 'seek', positionSeconds: 30 })
    tick(SEEK_BARRIER_MAX_WAIT_MS)
    room.storage.failPuts.current = true
    await expect(room.room.alarm()).rejects.toThrow('storage unavailable')
    room.storage.failPuts.current = false
    return room
  }

  it('saves on the retry but announces nothing, because the retry finds nothing left to release (current behaviour)', async () => {
    const room = await failedSeekAlarm()
    expect(room.stored().coordinator.pendingSeek).not.toBeNull()

    await room.room.alarm()

    expect(room.stored().coordinator.pendingSeek).toBeNull()
    expect(room.stored().coordinator.playback.status).toBe('paused')
    expect(room.host.reasons()).not.toContain('seek_timeout_paused')
    expect(room.friend.reasons()).not.toContain('seek_timeout_paused')
  })

  it('announces the transition when the retry runs on a new object, because that one restores the state from before the alarm', async () => {
    const room = await failedSeekAlarm()
    const restarted = restart(room)
    await restored(restarted.room)

    await restarted.room.alarm()

    expect(room.host.reasons().filter(reason => reason === 'seek_timeout_paused')).toHaveLength(1)
    expect(room.friend.reasons().filter(reason => reason === 'seek_timeout_paused')).toHaveLength(1)
    expect(room.stored().coordinator.pendingSeek).toBeNull()
  })
})

describe('RoomDurableObject: what a report from a client costs in storage calls', () => {
  it('writes the room and sets the alarm once for each client_metrics report, and not at all for a ping', async () => {
    const room = await pair({ transactional: false })
    await room.play()
    const puts = room.storage.puts.count
    const alarms = room.storage.setAlarms.count

    await say(room.room, room.host, { type: 'ping', id: 'ping_1', sentAtLocalMs: Date.now() })
    expect(room.storage.puts.count).toBe(puts)
    expect(room.storage.setAlarms.count).toBe(alarms)
    expect(room.host.sent.filter(message => message.type === 'pong')).toHaveLength(1)

    await say(room.room, room.host, { type: 'client_metrics', roundTripMs: 40 })
    expect(room.storage.puts.count).toBe(puts + 1)
    expect(room.storage.setAlarms.count).toBe(alarms + 1)

    // Both clients report after each pong, every PING_INTERVAL_MS: that is
    // two writes and two alarm calls per interval for a two-person room.
    tick(PING_INTERVAL_MS)
    await say(room.room, room.friend, { type: 'client_metrics', roundTripMs: 60 })
    expect(room.storage.puts.count).toBe(puts + 2)
    expect(room.storage.setAlarms.count).toBe(alarms + 2)
  })
})
