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
// harness that drives the real RoomDurableObject class, with clients that are
// scripted messages. No workerd, no real alarm delivery (the test calls
// alarm() when the last requested alarm is due), no browser.

const CODE = 'EDGE1234'
const MEDIA = { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A private title', durationSeconds: 600 }
const START_MS = 1_900_000_000_000
const PLAYBACK_PROGRESS_TIMEOUT_MS = 1_800
const PLAYBACK_STARTUP_TIMEOUT_MS = 10_000

type Room = InstanceType<typeof RoomDurableObject>
type Snapshot = Extract<ServerMessage, { type: 'room_snapshot' }>

class FakeSocket {
  attachment: unknown = null
  sent: ServerMessage[] = []

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

  close(): void {}

  snapshots(): Snapshot[] {
    return this.sent.filter((message): message is Snapshot => message.type === 'room_snapshot')
  }

  reasons(): string[] {
    return this.snapshots().map(message => message.reason)
  }
}

interface Harness {
  store: Map<string, unknown>
  alarms: number[]
  puts: { count: number }
  room: Room
  host: FakeSocket
  friend: FakeSocket
  revision: () => number
  say: (socket: FakeSocket, message: unknown) => Promise<void>
  /** Delivers the alarm the way the platform would: only when the last one requested is due. */
  deliverDueAlarm: () => Promise<boolean>
}

async function twoMembers(options: { transactional: boolean }): Promise<Harness> {
  vi.useFakeTimers({ toFake: ['Date'], now: START_MS })
  const store = new Map<string, unknown>()
  const alarms: number[] = []
  const puts = { count: 0 }
  const host = new FakeSocket()
  const friend = new FakeSocket()
  const sockets = [host, friend]
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        puts.count += 1
        store.set(key, structuredClone(value))
      },
      delete: async (key: string) => store.delete(key),
      deleteAll: async () => { store.clear() },
      setAlarm: async (at: number) => { alarms.push(at) },
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  }
  const room = new RoomDurableObject(ctx as never, {} as never)
  const say = (socket: FakeSocket, message: unknown) => room.webSocketMessage(socket as never, JSON.stringify(message))
  const capabilities = options.transactional ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}
  await say(host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, ...capabilities })
  await say(friend, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: MEDIA, ...capabilities })
  await say(host, { type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_approve_friend', basedOnRevision: 0, leaseEpoch: 1 })
  await say(host, { type: 'set_ready', ready: true, media: MEDIA })
  await say(friend, { type: 'set_ready', ready: true, media: MEDIA })
  return {
    store,
    alarms,
    puts,
    room,
    host,
    friend,
    revision: () => host.snapshots().at(-1)!.snapshot.revision,
    say,
    deliverDueAlarm: async () => {
      if (alarms.length === 0 || alarms.at(-1)! > Date.now())
        return false
      await room.alarm()
      return true
    },
  }
}

const tick = (ms: number) => vi.setSystemTime(Date.now() + ms)

afterEach(() => {
  vi.useRealTimers()
})

describe('RoomDurableObject: an operation_ack that is not accepted changes nothing', () => {
  /** A Play that is preparing for two members on the current contract. */
  async function preparing() {
    const room = await twoMembers({ transactional: true })
    await room.say(room.host, { type: 'control', actionId: 'action_play', basedOnRevision: room.revision(), leaseEpoch: 1, kind: 'play', positionSeconds: 20 })
    const operation = room.host.snapshots().at(-1)!.snapshot.contract!.operation!
    expect(room.host.reasons().at(-1)).toBe('control_play_pending')
    const acknowledgement = (overrides: Record<string, unknown> = {}) => ({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase: 'prepared', participantId: 'participant_friend',
        bindingId: 'binding_participant_friend', sourceGeneration: 1, sampleSequence: 1, observedPositionSeconds: 20, observedAtLocalMs: Date.now(),
        ...overrides,
      },
    })
    return { room, operation, acknowledgement }
  }

  /** What a refused acknowledgement must leave: no snapshot to anyone, nothing written, the stored room as it was. */
  async function expectNothing(room: Harness, send: () => Promise<void>) {
    const snapshotsHeard = [room.host, room.friend].map(socket => socket.snapshots().length)
    const writes = room.puts.count
    const alarms = room.alarms.length
    const stored = structuredClone(room.store.get('room'))

    await send()

    expect([room.host, room.friend].map(socket => socket.snapshots().length)).toEqual(snapshotsHeard)
    expect(room.puts.count).toBe(writes)
    expect(room.alarms).toHaveLength(alarms)
    expect(room.store.get('room')).toEqual(stored)
  }

  it('accepts a correct acknowledgement and announces it, which the refusals below are compared with', async () => {
    const { room, acknowledgement } = await preparing()

    await room.say(room.friend, acknowledgement())

    expect(room.host.reasons().at(-1)).toBe('operation_participant_prepared')
    expect(room.friend.reasons().at(-1)).toBe('operation_participant_prepared')
  })

  it('does not accept an acknowledgement that claims to be from another participant, in either direction', async () => {
    const { room, acknowledgement } = await preparing()

    await expectNothing(room, () => room.say(room.friend, acknowledgement({ participantId: 'participant_host' })))
    await expectNothing(room, () => room.say(room.host, acknowledgement({ participantId: 'participant_friend' })))
    // The claim is refused, not the sender: the host's own acknowledgement is still accepted afterwards.
    await room.say(room.host, acknowledgement({ participantId: 'participant_host', bindingId: 'binding_participant_host' }))
    expect(room.host.reasons().at(-1)).toBe('operation_participant_prepared')
  })

  it('does not accept an acknowledgement from a request that has not been approved', async () => {
    const { room, acknowledgement } = await preparing()
    const stranger = new FakeSocket()
    ;(room.room as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [room.host, room.friend, stranger]
    await room.say(stranger, { type: 'join_room', protocolVersion: 1, participantId: 'participant_stranger', name: 'Sam', code: CODE, media: MEDIA, capabilities: CURRENT_CLIENT_CAPABILITIES })
    expect(stranger.sent.at(-1)).toMatchObject({ type: 'room_joined' })

    await expectNothing(room, () => room.say(stranger, acknowledgement({ participantId: 'participant_stranger' })))
    expect(stranger.snapshots().filter(snapshot => snapshot.reason.startsWith('operation_'))).toEqual([])
  })

  it('does not accept an acknowledgement for another operation, another media epoch, a position that is not the target, or a start before the commit', async () => {
    const { room, acknowledgement } = await preparing()

    await expectNothing(room, () => room.say(room.friend, acknowledgement({ operationId: 'operation_that_was_never_issued' })))
    await expectNothing(room, () => room.say(room.friend, acknowledgement({ mediaEpoch: 7 })))
    await expectNothing(room, () => room.say(room.friend, acknowledgement({ observedPositionSeconds: 400 })))
    await expectNothing(room, () => room.say(room.friend, acknowledgement({ phase: 'started', observedPositionSeconds: 20 })))
  })

  it('does not accept an acknowledgement that the protocol cannot parse', async () => {
    const { room, acknowledgement } = await preparing()

    await expectNothing(room, () => room.say(room.friend, { type: 'operation_ack', acknowledgement: { ...acknowledgement().acknowledgement, phase: 'committed' } }))
    await expectNothing(room, () => room.say(room.friend, { type: 'operation_ack' }))
  })
})

describe('RoomDurableObject: a socket that only pings and reports metrics', () => {
  /** Both members play; each has reported once, healthy, a second after the Play. Returns the time of those reports. */
  async function playingWithOneReportEach() {
    const room = await twoMembers({ transactional: false })
    await room.say(room.host, { type: 'control', actionId: 'action_play', basedOnRevision: room.revision(), leaseEpoch: 1, kind: 'play', positionSeconds: 20 })
    expect(room.host.reasons().at(-1)).toBe('control_play')
    tick(1_000)
    const reportedAtMs = Date.now()
    for (const socket of [room.host, room.friend]) {
      await room.say(socket, {
        type: 'player_status',
        basedOnRevision: room.revision(),
        sample: { positionSeconds: 21, durationSeconds: 600, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: reportedAtMs },
      })
    }
    return { room, reportedAtMs }
  }

  it('is paused once as stalled, one pong answers each ping, and the alarm stays where the last report put it', async () => {
    const { room, reportedAtMs } = await playingWithOneReportEach()
    const stalledAtMs = reportedAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS
    expect(room.alarms.at(-1)).toBe(stalledAtMs)

    // From here both sockets send nothing but pings and the metrics report the
    // extension sends after each pong, much faster than the progress limit.
    const pings: Record<string, number> = { participant_host: 0, participant_friend: 0 }
    for (let step = 1; step <= 12; step += 1) {
      tick(400)
      for (const [socket, participantId] of [[room.host, 'participant_host'], [room.friend, 'participant_friend']] as const) {
        pings[participantId]! += 1
        await room.say(socket, { type: 'ping', id: `ping_${participantId}_${step}`, sentAtLocalMs: Date.now() })
        await room.say(socket, { type: 'client_metrics', roundTripMs: 30 })
      }
      await room.deliverDueAlarm()
      // Neither a ping nor a metrics report moves the deadline: until the room pauses, the alarm is still the one the last report set.
      if (room.host.reasons().at(-1) !== 'participant_playback_stalled')
        expect(room.alarms.at(-1)).toBe(stalledAtMs)
    }

    for (const socket of [room.host, room.friend])
      expect(socket.reasons().filter(reason => reason === 'participant_playback_stalled')).toHaveLength(1)
    expect(room.host.snapshots().at(-1)!.snapshot.playback.status).toBe('paused')
    for (const [socket, participantId] of [[room.host, 'participant_host'], [room.friend, 'participant_friend']] as const) {
      const pongs = socket.sent.filter((message): message is Extract<ServerMessage, { type: 'pong' }> => message.type === 'pong')
      expect(pongs).toHaveLength(pings[participantId]!)
      expect(pongs.map(pong => pong.id)).toEqual(Array.from({ length: pings[participantId]! }, (_, index) => `ping_${participantId}_${index + 1}`))
    }
  })

  it('does not pause or announce anything for pings alone while the room is already paused', async () => {
    const { room, reportedAtMs } = await playingWithOneReportEach()
    tick(PLAYBACK_PROGRESS_TIMEOUT_MS)
    expect(Date.now()).toBe(reportedAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS)
    await room.room.alarm()
    expect(room.host.reasons().at(-1)).toBe('participant_playback_stalled')
    const heard = room.host.sent.length

    for (let step = 0; step < 6; step += 1) {
      tick(2_000)
      await room.say(room.host, { type: 'ping', id: `ping_after_${step}`, sentAtLocalMs: Date.now() })
      await room.deliverDueAlarm()
    }

    expect(room.host.sent.slice(heard).filter(message => message.type === 'room_snapshot')).toEqual([])
    expect(room.host.sent.slice(heard).filter(message => message.type === 'pong')).toHaveLength(6)
  })
})

describe('RoomDurableObject: a participant that never reports', () => {
  it('is announced to both members as participant_playback_silent once, with its status silent, while the other keeps reporting', async () => {
    const room = await twoMembers({ transactional: false })
    await room.say(room.host, { type: 'control', actionId: 'action_play', basedOnRevision: room.revision(), leaseEpoch: 1, kind: 'play', positionSeconds: 20 })
    expect(room.host.reasons().at(-1)).toBe('control_play')
    const effectiveAtMs = room.host.snapshots().at(-1)!.snapshot.playback.effectiveAtServerMs

    // The host reports every second; the friend's socket is open, answers pings and sends metrics, and reports nothing.
    let position = 20
    for (let second = 1; second <= 14; second += 1) {
      tick(1_000)
      position += 1
      await room.say(room.host, {
        type: 'player_status',
        basedOnRevision: room.revision(),
        sample: { positionSeconds: position, durationSeconds: 600, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: Date.now() },
      })
      await room.say(room.friend, { type: 'ping', id: `ping_friend_${second}`, sentAtLocalMs: Date.now() })
      await room.say(room.friend, { type: 'client_metrics', roundTripMs: 30 })
      await room.deliverDueAlarm()
      if (Date.now() < effectiveAtMs + PLAYBACK_STARTUP_TIMEOUT_MS)
        expect(room.host.reasons()).not.toContain('participant_playback_silent')
    }

    for (const socket of [room.host, room.friend]) {
      expect(socket.reasons().filter(reason => reason === 'participant_playback_silent')).toHaveLength(1)
      expect(socket.reasons()).not.toContain('participant_playback_stalled')
    }
    const silent = room.host.snapshots().find(snapshot => snapshot.reason === 'participant_playback_silent')!
    expect(silent.snapshot.playback.status).toBe('paused')
    expect(silent.snapshot.participants.find(participant => participant.id === 'participant_friend')).toMatchObject({ playbackStatus: 'silent' })
    expect(silent.snapshot.participants.find(participant => participant.id === 'participant_host')).not.toMatchObject({ playbackStatus: 'silent' })
  })
})
