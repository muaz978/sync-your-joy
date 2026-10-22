import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import type { ServerMessage } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'
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

const CODE = 'EDGE1234'
const MEDIA = { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A private title', durationSeconds: 600 }

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

  last(): ServerMessage | undefined {
    return this.sent.at(-1)
  }
}

/** A socket that reads fine until `breakIt()` is called, then fails every read like an unreadable one. */
function socketThatBreaksLater() {
  const socket = new FakeSocket()
  const read = socket.deserializeAttachment.bind(socket)
  let broken = false
  socket.deserializeAttachment = () => {
    if (broken)
      throw new Error('attachment storage hiccup')
    return read()
  }
  return { socket, breakIt: () => { broken = true } }
}

/** Runs `probe` the first time the socket is closed, so a test can tell which code path closed it. */
function onFirstClose(socket: FakeSocket, probe: () => void): void {
  const close = socket.close.bind(socket)
  let seen = false
  socket.close = (code?: number, reason?: string) => {
    if (!seen) {
      seen = true
      probe()
    }
    close(code, reason)
  }
}

function createRoomObject(sockets: FakeSocket[]) {
  const store = new Map<string, unknown>()
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => { store.set(key, structuredClone(value)) },
      delete: async (key: string) => store.delete(key),
      deleteAll: async () => { store.clear() },
      setAlarm: async () => {},
      getAlarm: async () => null,
      deleteAlarm: async () => {},
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
  }
  return new RoomDurableObject(ctx as never, {} as never)
}

async function say(room: InstanceType<typeof RoomDurableObject>, socket: FakeSocket, message: unknown): Promise<void> {
  await room.webSocketMessage(socket as never, JSON.stringify(message))
}

async function roomWithPendingFriend() {
  const host = new FakeSocket()
  const friend = new FakeSocket()
  // A socket that connected to the room's address but never sent join_room.
  const observer = new FakeSocket()
  const room = createRoomObject([host, friend, observer])

  await say(room, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA })
  await say(room, friend, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null })
  const joined = friend.sent.find(message => message.type === 'room_joined')
  if (joined?.type !== 'room_joined')
    throw new Error('Expected the requester to receive room_joined')
  return { room, host, friend, observer, token: joined.sessionToken, joined }
}

const approve = { type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_approve_friend', basedOnRevision: 0, leaseEpoch: 1 }

describe('RoomDurableObject: who receives room state', () => {
  it('sends a socket that never joined nothing at all', async () => {
    const { room, host, observer } = await roomWithPendingFriend()

    await say(room, host, { type: 'set_ready', ready: true, media: MEDIA })
    await say(room, host, { type: 'request_diagnostics', reportId: 'report_edge_observer' })

    expect(host.sent.some(message => message.type === 'room_snapshot')).toBe(true)
    expect(observer.sent).toEqual([])
  })

  it('gives an unapproved requester a snapshot with nothing about the room and no later broadcasts', async () => {
    const { room, host, friend, joined } = await roomWithPendingFriend()

    expect(joined.snapshot).toMatchObject({
      navigation: null,
      seek: null,
      participants: [],
      playback: { status: 'paused', positionSeconds: 0 },
      pendingJoinRequests: [expect.objectContaining({ id: 'participant_friend', name: 'Rana' })],
    })
    // A fingerprint that matches no real media, never the room's own and
    // never null, so a deployed player stays inert while the request waits.
    expect(joined.snapshot.media).not.toBeNull()
    expect(joined.snapshot.media?.canonicalId).not.toBe(MEDIA.canonicalId)
    expect(JSON.stringify(joined)).not.toContain('private title')

    const receivedBefore = friend.sent.length
    await say(room, host, { type: 'set_ready', ready: true, media: MEDIA })
    await say(room, host, { type: 'request_diagnostics', reportId: 'report_edge_pending' })
    expect(friend.sent).toHaveLength(receivedBefore)
  })

  it('does not hand room state to a pending requester inside a rejection either', async () => {
    const { room, friend } = await roomWithPendingFriend()

    await say(room, friend, { type: 'control', actionId: 'action_pending_control', basedOnRevision: 0, leaseEpoch: 1, kind: 'play', positionSeconds: 1 })

    expect(friend.last()).toMatchObject({ type: 'command_rejected', actionId: 'action_pending_control', snapshot: null })
    expect(JSON.stringify(friend.last())).not.toContain('private title')
  })

  it('starts delivering the full state once the request is approved', async () => {
    const { room, host, friend, observer } = await roomWithPendingFriend()

    await say(room, host, approve)

    expect(friend.last()).toMatchObject({
      type: 'room_snapshot',
      reason: 'join_approved',
      snapshot: { participants: [expect.anything(), expect.anything()], media: { canonicalId: 'youtube:private-id' } },
    })
    expect(observer.sent).toEqual([])
  })

  it('withdraws a pending request when its socket closes, so it cannot be approved later', async () => {
    const { room, host, friend } = await roomWithPendingFriend()

    await room.webSocketClose(friend as never)

    expect(host.last()).toMatchObject({
      type: 'room_snapshot',
      reason: 'join_cancelled',
      snapshot: { pendingJoinRequests: [] },
    })
    await say(room, host, approve)
    expect(host.last()).toMatchObject({ type: 'command_rejected', code: 'not_found' })
  })

  it('refuses a client that only knows the pending participant id', async () => {
    const { room, host, friend } = await roomWithPendingFriend()
    const intruder = new FakeSocket()
    const withIntruder = [host, friend, intruder]
    ;(room as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => withIntruder

    await say(room, intruder, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Attacker', code: CODE, media: null })

    expect(intruder.last()).toMatchObject({ type: 'command_rejected', code: 'session_invalid', snapshot: null })
    await say(room, host, approve)
    expect(friend.last()).toMatchObject({
      reason: 'join_approved',
      snapshot: { participants: expect.arrayContaining([expect.objectContaining({ name: 'Rana' })]) },
    })
  })
})

describe('RoomDurableObject: the coordinator\'s timeline for a detailed report', () => {
  it('records why a socket closed and hands the timeline to the controller only', async () => {
    const { room, host, friend } = await roomWithPendingFriend()
    await say(room, host, approve)

    await room.webSocketClose(friend as never, 1006, 'Closed by https://example.test/watch?token=secret')
    await say(room, host, { type: 'request_diagnostics', reportId: 'report_edge_timeline' })

    const timeline = host.sent.find(message => message.type === 'diagnostics_room')
    if (timeline?.type !== 'diagnostics_room')
      throw new Error('Expected diagnostics_room')
    expect(timeline.reportId).toBe('report_edge_timeline')
    const closed = timeline.room.entries.find(entry => entry.kind === 'transport' && entry.event === 'socket_closed')
    expect(closed?.detail).toMatchObject({ participantId: 'participant_friend', code: 1006, reason: 'other', participantStillConnected: false })
    expect(JSON.stringify(timeline)).not.toContain('secret')
  })

  it('does not send it to a participant who asked without being the controller', async () => {
    const { room, host, friend } = await roomWithPendingFriend()
    await say(room, host, approve)

    await say(room, friend, { type: 'request_diagnostics', reportId: 'report_edge_member' })

    expect(friend.sent.some(message => message.type === 'diagnostics_room')).toBe(false)
    expect(friend.last()).toMatchObject({ type: 'error', code: 'controller_only' })
  })
})

describe('RoomDurableObject: rejections and re-attach for unapproved requests', () => {
  it('does not hand room state to a stranger who is turned away because the room is full', async () => {
    const { room, host, friend } = await roomWithPendingFriend()
    const sockets = [host, friend]
    ;(room as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => sockets
    // The host and the first request take two of the ten places; eight more
    // pending requests fill the room, because pending requests count.
    for (let index = 0; index < 8; index += 1) {
      const filler = new FakeSocket()
      sockets.push(filler)
      await say(room, filler, { type: 'join_room', protocolVersion: 1, participantId: `participant_filler_${index}`, name: `Filler ${index}`, code: CODE, media: null })
      expect(filler.last()).toMatchObject({ type: 'room_joined' })
    }

    const stranger = new FakeSocket()
    sockets.push(stranger)
    await say(room, stranger, { type: 'join_room', protocolVersion: 1, participantId: 'participant_stranger', name: 'Stranger', code: CODE, media: null })

    expect(stranger.last()).toMatchObject({ type: 'command_rejected', code: 'room_full', snapshot: null })
    expect(JSON.stringify(stranger.last())).not.toContain('private title')
  })

  it('refuses an approval sent by a pending requester without handing it room state', async () => {
    const { room, host, friend } = await roomWithPendingFriend()

    await say(room, friend, { type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_forged', basedOnRevision: 0, leaseEpoch: 1 })

    expect(friend.last()).toMatchObject({ type: 'command_rejected', actionId: 'action_forged', code: 'controller_only', snapshot: null })
    expect(JSON.stringify(friend.last())).not.toContain('private title')

    // The forged approval changed nothing: the host can still decide.
    await say(room, host, approve)
    expect(friend.last()).toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
  })

  it('tells only the denied requester it was denied, without any room state', async () => {
    const { room, host, friend, observer } = await roomWithPendingFriend()

    await say(room, host, { ...approve, approve: false, actionId: 'action_deny_friend' })

    expect(friend.last()).toMatchObject({ type: 'command_rejected', code: 'join_denied', snapshot: null })
    expect(JSON.stringify(friend.last())).not.toContain('private title')
    expect(observer.sent).toEqual([])
  })

  it('lets the same client re-attach to its pending request with the token it was issued', async () => {
    const { room, host, friend, token } = await roomWithPendingFriend()
    const again = new FakeSocket()
    ;(room as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [host, friend, again]

    await say(room, again, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: token })

    expect(again.last()).toMatchObject({ type: 'room_joined', sessionToken: token, snapshot: { participants: [] } })
    expect(friend.closed).toMatchObject({ reason: 'session_replaced' })
    await say(room, host, approve)
    expect(again.last()).toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
  })

  it('does not let a refused intruder withdraw the request by closing its own socket', async () => {
    const { room, host, friend } = await roomWithPendingFriend()
    const intruder = new FakeSocket()
    ;(room as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [host, friend, intruder]
    await say(room, intruder, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Attacker', code: CODE, media: null })
    expect(intruder.last()).toMatchObject({ type: 'command_rejected', code: 'session_invalid', snapshot: null })

    await room.webSocketClose(intruder as never)

    await say(room, host, approve)
    expect(friend.last()).toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
  })
})

describe('RoomDurableObject: empty room expiry with unapproved requests', () => {
  const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000
  const startMs = 1_900_000_000_000
  type Probe = { emptySinceMs: number | null, coordinator: unknown }
  const inspect = (room: InstanceType<typeof RoomDurableObject>) => room as unknown as Probe

  afterEach(() => {
    vi.useRealTimers()
  })

  async function emptiedRoom() {
    vi.useFakeTimers({ toFake: ['Date'], now: startMs })
    const host = new FakeSocket()
    const sockets: FakeSocket[] = [host]
    const room = createRoomObject(sockets)
    await say(room, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA })
    sockets.splice(sockets.indexOf(host), 1)
    await room.webSocketClose(host as never)
    expect(inspect(room).emptySinceMs).toBe(startMs)
    return { room, sockets }
  }

  it('does not let a withdrawn request restart the clock of an empty room', async () => {
    const { room, sockets } = await emptiedRoom()

    vi.setSystemTime(startMs + 29 * 60_000)
    const stranger = new FakeSocket()
    sockets.push(stranger)
    await say(room, stranger, { type: 'join_room', protocolVersion: 1, participantId: 'participant_stranger', name: 'X', code: CODE, media: null })
    sockets.splice(sockets.indexOf(stranger), 1)
    await room.webSocketClose(stranger as never)

    expect(inspect(room).emptySinceMs).toBe(startMs)
    vi.setSystemTime(startMs + EMPTY_ROOM_TTL_MS + 60_000)
    await room.alarm()
    expect(inspect(room).coordinator).toBeNull()
  })

  it('tells a request that is still waiting when the empty room expires', async () => {
    const { room, sockets } = await emptiedRoom()
    const waiting = new FakeSocket()
    sockets.push(waiting)
    await say(room, waiting, { type: 'join_room', protocolVersion: 1, participantId: 'participant_waiting', name: 'X', code: CODE, media: null })
    expect(waiting.last()).toMatchObject({ type: 'room_joined' })

    vi.setSystemTime(startMs + EMPTY_ROOM_TTL_MS + 60_000)
    await room.alarm()

    expect(inspect(room).coordinator).toBeNull()
    expect(waiting.closed).toEqual({ code: 1000, reason: 'room_expired' })
  })
})

describe('RoomDurableObject: lifecycle across restarts and expiry', () => {
  const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000
  const MAX_ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
  const CONTROLLER_GRACE_MS = 10_000
  const CONTROLLER_REARM_GRACE_MS = 20_000
  // The longest the extension waits between reconnect attempts: min(15 s,
  // 500 ms * 2^n) plus up to 250 ms of jitter (scheduleReconnect in
  // apps/extension/src/service-worker.ts).
  const LONGEST_RECONNECT_BACKOFF_MS = 15_000 + 250
  const startMs = 1_900_000_000_000
  type Inspect = { emptySinceMs: number | null, coordinator: { snapshot: () => { revision: number, participants: Array<{ id: string, connected: boolean }>, pendingJoinRequests: Array<{ id: string }>, controller: { participantId: string } }, nextHealthDeadlineMs: () => number | null } | null, pendingController: { participantId: string } | null }
  const inspect = (room: InstanceType<typeof RoomDurableObject>) => room as unknown as Inspect
  // The restore step runs inside the object's constructor; waiting for it
  // lets a test look at what restoring alone did, before any alarm or message.
  const restored = async (room: InstanceType<typeof RoomDurableObject>) => {
    await (room as unknown as { initialized: Promise<void> }).initialized
    return room
  }

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // A Durable Object over a shared store, so a "restart" is a second object
  // built over the same storage with whichever sockets are still attached. A
  // `putGate` holds every write until it resolves.
  function objectOver(store: Map<string, unknown>, sockets: FakeSocket[], alarms: number[] = [], existingAlarmAtMs: number | null = null, putGate: Promise<void> | null = null) {
    const ctx = {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          if (putGate)
            await putGate
          store.set(key, structuredClone(value))
        },
        delete: async (key: string) => store.delete(key),
        deleteAll: async () => { store.clear() },
        setAlarm: async (at: number) => { alarms.push(at) },
        getAlarm: async () => existingAlarmAtMs,
        deleteAlarm: async () => {},
      },
      blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
      getWebSockets: () => sockets,
      acceptWebSocket: () => {},
    }
    return new RoomDurableObject(ctx as never, {} as never)
  }

  async function roomWithHostAndRequest(alarms: number[] = []) {
    vi.useFakeTimers({ toFake: ['Date'], now: startMs })
    const store = new Map<string, unknown>()
    const host = new FakeSocket()
    const friend = new FakeSocket()
    const first = objectOver(store, [host, friend], alarms)
    await say(first, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA })
    await say(first, friend, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null })
    return { store, host, friend, first }
  }

  async function hostAndApprovedFriend(alarms: number[] = []) {
    const { store, host, friend, first } = await roomWithHostAndRequest(alarms)
    await say(first, host, approve)
    return { store, host, friend, first }
  }

  it('resumes a room the system paused from its alarm, and schedules that alarm (#141)', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: startMs })
    const alarms: number[] = []
    const host = new FakeSocket()
    const room = objectOver(new Map<string, unknown>(), [host], alarms)
    const snapshots = () => host.sent.filter((message): message is Extract<ServerMessage, { type: 'room_snapshot' }> => message.type === 'room_snapshot')
    const reasons = () => snapshots().map(message => message.reason)
    const revision = () => snapshots().at(-1)!.snapshot.revision
    const sample = (overrides: Record<string, unknown> = {}) => say(room, host, {
      type: 'player_status',
      basedOnRevision: revision(),
      sample: { positionSeconds: 20, durationSeconds: 600, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: Date.now(), ...overrides },
    })
    const tick = (ms: number) => vi.setSystemTime(Date.now() + ms)

    await say(room, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, capabilities: CURRENT_CLIENT_CAPABILITIES })
    await say(room, host, { type: 'set_ready', ready: true, media: MEDIA })
    await say(room, host, { type: 'control', actionId: 'action_edge_auto_resume', basedOnRevision: revision(), leaseEpoch: 1, kind: 'play', positionSeconds: 20 })
    const operation = snapshots().at(-1)!.snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const acknowledge = (phase: 'prepared' | 'started', sampleSequence: number) => say(room, host, {
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase, participantId: 'participant_host',
        bindingId: 'binding_host_123456', sourceGeneration: 1, sampleSequence, observedPositionSeconds: 20, observedAtLocalMs: Date.now(),
      },
    })
    await acknowledge('prepared', 1)
    vi.setSystemTime(snapshots().at(-1)!.snapshot.contract?.operation?.effectiveAtServerMs ?? startMs)
    await acknowledge('started', 2)

    tick(3_000)
    for (let step = 0; step < 8 && !reasons().includes('participant_buffering'); step += 1) {
      await sample({ buffering: true, progressed: false })
      tick(1_000)
    }
    expect(reasons()).toContain('participant_buffering')
    // The pause armed the wait, and the object asked for an alarm to look at it.
    expect(alarms.at(-1)).toBeLessThanOrEqual(Date.now() + 1_000)

    for (let step = 0; step < 5 && !reasons().includes('auto_resume_play_pending'); step += 1) {
      await sample({ paused: true, buffering: false, progressed: false, canPlay: true })
      await room.alarm()
      tick(1_000)
    }
    expect(reasons()).toContain('auto_resume_play_pending')
    expect(snapshots().at(-1)!.snapshot.contract?.operation).toMatchObject({ kind: 'play', phase: 'preparing' })
  })

  it('withdraws a stored request whose socket is gone, so it cannot be approved into a member with no connection', async () => {
    const { store, host } = await roomWithHostAndRequest()

    // The object is rebuilt and only the host's socket is still attached.
    const restarted = objectOver(store, [host])
    await say(restarted, host, approve)

    expect(host.last()).toMatchObject({ type: 'command_rejected', code: 'not_found' })
    expect(inspect(restarted).coordinator?.snapshot().pendingJoinRequests).toEqual([])
    // The cleanup was persisted, not just applied in memory.
    const again = objectOver(store, [host])
    await say(again, host, { type: 'request_diagnostics', reportId: 'report_after_restart' })
    expect(inspect(again).coordinator?.snapshot().pendingJoinRequests).toEqual([])
  })

  it('keeps a stored request whose socket is still attached', async () => {
    const { store, host, friend } = await roomWithHostAndRequest()

    const restarted = objectOver(store, [host, friend])
    await say(restarted, host, approve)

    expect(friend.last()).toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
  })

  it('marks a stored member with no socket disconnected, starts the empty clock and schedules controller recovery', async () => {
    const { store } = await roomWithHostAndRequest()

    const restarted = await restored(objectOver(store, []))

    const participants = inspect(restarted).coordinator?.snapshot().participants ?? []
    expect(participants.find(participant => participant.id === 'participant_host')?.connected).toBe(false)
    expect(inspect(restarted).emptySinceMs).toBe(startMs)
    expect(inspect(restarted).pendingController?.participantId).toBe('participant_host')
  })

  it('tells a member that kept its socket which request restoring withdrew', async () => {
    const { store, host } = await roomWithHostAndRequest()
    const before = host.sent.length

    // The requester's socket did not survive; the host's did.
    await restored(objectOver(store, [host]))

    const told = host.sent.slice(before)
    expect(told).toHaveLength(1)
    expect(told[0]).toMatchObject({ type: 'room_snapshot', reason: 'join_cancelled', snapshot: { pendingJoinRequests: [] } })
  })

  it('tells a member that kept its socket which participant restoring marked disconnected', async () => {
    const { store, host, first } = await roomWithHostAndRequest()
    await say(first, host, approve)
    const before = host.sent.length

    // The approved friend's socket did not survive; the host's did.
    await restored(objectOver(store, [host]))

    const told = host.sent.slice(before)
    expect(told).toHaveLength(1)
    const snapshot = told[0]
    expect(snapshot).toMatchObject({ type: 'room_snapshot', reason: 'participant_disconnected' })
    const participants = snapshot?.type === 'room_snapshot' ? snapshot.snapshot.participants : []
    expect(participants.find(participant => participant.id === 'participant_friend')?.connected).toBe(false)
    expect(participants.find(participant => participant.id === 'participant_host')?.connected).toBe(true)
  })

  it('sends nothing on restore when every stored connection still has its socket', async () => {
    const { store, host, friend } = await roomWithHostAndRequest()
    const hostBefore = host.sent.length
    const friendBefore = friend.sent.length

    await restored(objectOver(store, [host, friend]))

    expect(host.sent).toHaveLength(hostBefore)
    expect(friend.sent).toHaveLength(friendBefore)
  })

  it('still serves the restored room and schedules its alarm when reconciling it throws', async () => {
    const { store, host } = await roomWithHostAndRequest()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The first thing the reconciliation asks the coordinator for fails once,
    // before anything was repaired.
    const snapshot = vi.spyOn(RoomCoordinator.prototype, 'snapshot').mockImplementationOnce(() => {
      throw new Error('snapshot could not be built')
    })
    const alarms: number[] = []

    const restarted = await restored(objectOver(store, [host], alarms))
    snapshot.mockRestore()
    // The deadlines are still derived from the state that was restored.
    expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
    await say(restarted, host, approve)

    expect(logged).toHaveBeenCalledTimes(1)
    expect(inspect(restarted).coordinator).not.toBeNull()
    // The stored request was left as it was and is still decidable.
    expect(host.last()).toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
    logged.mockRestore()
  })

  it('announces the repair it had made when a later step of the reconciliation throws', async () => {
    const { store, host } = await roomWithHostAndRequest()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The first thing that asks the coordinator who is connected, which comes
    // after the request was withdrawn.
    const hasConnected = vi.spyOn(RoomCoordinator.prototype, 'hasConnectedParticipants').mockImplementationOnce(() => {
      throw new Error('derived state could not be read')
    })
    const before = host.sent.length

    const restarted = await restored(objectOver(store, [host]))
    hasConnected.mockRestore()

    expect(inspect(restarted).coordinator?.snapshot().pendingJoinRequests).toEqual([])
    // It was saved, so it is told: a repair that is durable and never
    // announced cannot be found again by a later restore.
    expect(host.sent.slice(before)).toContainEqual(expect.objectContaining({ type: 'room_snapshot', reason: 'join_cancelled' }))
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('makes one pass over the sockets when it restores, so a socket that fails the second time cannot split the repair from its announcement', async () => {
    const { store, host, friend, first } = await hostAndApprovedFriend()
    const friendToken = (friend.sent.find(message => message.type === 'room_joined') as { sessionToken: string }).sessionToken
    // The host's connection drops and, later, so does the friend's; the plan
    // for the host lapses with nobody there.
    await first.webSocketClose(host as never)
    await first.webSocketClose(friend as never)
    vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
    await first.alarm()
    // The friend comes back and a second request arrives and waits.
    const back = new FakeSocket()
    const late = new FakeSocket()
    ;(first as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [back, late]
    await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
    await say(first, late, { type: 'join_room', protocolVersion: 1, participantId: 'participant_late', name: 'Sam', code: CODE, media: null })
    // Saved by code that did not re-arm the recovery.
    ;(store.get('room') as { pendingController: unknown }).pendingController = null
    // The friend's socket survives the restart with one that has not joined,
    // and that one can be read the first time it is asked and not the second.
    const noise = new FakeSocket()
    let reads = 0
    const readable = noise.deserializeAttachment.bind(noise)
    noise.deserializeAttachment = () => {
      reads += 1
      if (reads === 2)
        throw new Error('attachment storage hiccup')
      return readable()
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = back.sent.length

    const restarted = await restored(objectOver(store, [noise, back]))

    expect(inspect(restarted).coordinator?.snapshot().pendingJoinRequests).toEqual([])
    expect(back.sent.slice(before)).toContainEqual(expect.objectContaining({ type: 'room_snapshot', reason: 'join_cancelled' }))
    // The recovery is armed in the same pass.
    expect((inspect(restarted) as unknown as { pendingController: unknown }).pendingController).not.toBeNull()
    expect(logged).not.toHaveBeenCalled()
    logged.mockRestore()
  })

  it('serves the restored room and announces nothing when the restore cannot be saved', async () => {
    const { store, host } = await roomWithHostAndRequest()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const set = store.set.bind(store)
    store.set = () => { throw new Error(`storage is unavailable for room ${CODE}`) }
    const before = host.sent.length

    // The requester's socket did not survive, so restoring has a repair to make.
    const restarted = await restored(objectOver(store, [host]))

    // The repaired state is served from memory but not announced as if it were
    // saved, and only the error's name is logged, never what it says.
    expect(inspect(restarted).coordinator?.snapshot().pendingJoinRequests).toEqual([])
    expect(host.sent).toHaveLength(before)
    expect(logged.mock.calls).toEqual([['Restoring room state could not be saved.', 'Error']])
    await say(restarted, host, { type: 'ping', id: 'ping_after_restore', sentAtLocalMs: 1 })
    expect(host.last()).toMatchObject({ type: 'pong', id: 'ping_after_restore' })

    // The next write saves what restoring derived, so a later restore has
    // nothing left to repair or announce.
    store.set = set
    await say(restarted, host, { type: 'client_metrics', roundTripMs: 20 })
    const sentBefore = host.sent.length
    await restored(objectOver(store, [host]))
    expect(host.sent).toHaveLength(sentBefore)
    logged.mockRestore()
  })

  describe('a restore whose save failed', () => {
    // A client that only pings never makes the object write, and the alarm
    // that carries the lifetime limit and controller recovery is set by the
    // same save, so the next frame of any kind (a ping included) tries again.
    async function failedRestore() {
      const alarms: number[] = []
      const { store, host } = await roomWithHostAndRequest()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const set = store.set.bind(store)
      store.set = () => { throw new Error('storage is unavailable') }
      const restarted = await restored(objectOver(store, [host], alarms))
      store.set = set
      return { store, host, restarted, alarms, logged }
    }

    it('is tried again on the next ping, once the retry delay has passed, and the repair is announced then', async () => {
      const { store, host, restarted, alarms, logged } = await failedRestore()
      expect(alarms).toEqual([])
      const before = host.sent.length

      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_retry', sentAtLocalMs: 1 })

      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      const sent = host.sent.slice(before)
      expect(sent).toContainEqual(expect.objectContaining({ type: 'room_snapshot', snapshot: expect.objectContaining({ pendingJoinRequests: [] }) }))
      expect(sent).toContainEqual(expect.objectContaining({ type: 'pong', id: 'ping_retry' }))
      // Saved: a later restore has nothing left to repair or announce.
      const sentBefore = host.sent.length
      await restored(objectOver(store, [host]))
      expect(host.sent).toHaveLength(sentBefore)
      logged.mockRestore()
    })

    it('is not tried on every frame, only after the retry delay', async () => {
      const { host, restarted, alarms, logged } = await failedRestore()

      await say(restarted, host, { type: 'ping', id: 'ping_too_soon', sentAtLocalMs: 1 })
      expect(alarms).toEqual([])

      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_after_delay', sentAtLocalMs: 2 })
      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      logged.mockRestore()
    })

    it('is settled by any other save, which writes the same state, so nothing is written again', async () => {
      const { host, restarted, alarms, logged } = await failedRestore()

      await say(restarted, host, { type: 'client_metrics', roundTripMs: 20 })
      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])

      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_after_save', sentAtLocalMs: 1 })
      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      logged.mockRestore()
    })

    it('tells the members of the repair when a save that is not followed by a broadcast of its own settles it', async () => {
      const { host, restarted, alarms, logged } = await failedRestore()
      const before = host.sent.length

      // The extension pings every few seconds and reports its metrics after
      // each pong. The metrics report saves and broadcasts nothing, and it
      // can come before the retry delay has passed.
      vi.setSystemTime(startMs + 2_000)
      await say(restarted, host, { type: 'ping', id: 'ping_early', sentAtLocalMs: 1 })
      await say(restarted, host, { type: 'client_metrics', roundTripMs: 20 })

      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      const repairs = host.sent.slice(before).filter(message => message.type === 'room_snapshot')
      expect(repairs).toEqual([expect.objectContaining({ reason: 'join_cancelled', snapshot: expect.objectContaining({ pendingJoinRequests: [] }) })])
      logged.mockRestore()
    })

    it('waits the whole interval after an attempt that failed, however many frames come', async () => {
      const { store, host, restarted, logged } = await failedRestore()
      const set = store.set.bind(store)
      let attempts = 0
      store.set = () => {
        attempts += 1
        throw new Error('storage is still unavailable')
      }

      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_attempt', sentAtLocalMs: 1 })
      expect(attempts).toBe(1)

      for (const at of [5_001, 7_500, 9_999]) {
        vi.setSystemTime(startMs + at)
        await say(restarted, host, { type: 'ping', id: `ping_${at}`, sentAtLocalMs: at })
      }
      expect(attempts).toBe(1)

      vi.setSystemTime(startMs + 10_000)
      await say(restarted, host, { type: 'ping', id: 'ping_next_interval', sentAtLocalMs: 2 })
      expect(attempts).toBe(2)
      store.set = set
      logged.mockRestore()
    })

    it('sets the alarm on a later frame when the write went through and only the alarm could not be set, without telling the members again', async () => {
      const alarms: number[] = []
      let alarmsAvailable = false
      const flakyAlarms = Object.assign([] as number[], {
        push: (at: number) => {
          if (!alarmsAvailable)
            throw new Error('alarm storage is unavailable')
          return alarms.push(at)
        },
      })
      const { store, host } = await roomWithHostAndRequest()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

      const restarted = await restored(objectOver(store, [host], flakyAlarms))
      expect(alarms).toEqual([])
      const told = host.sent.filter(message => message.type === 'room_snapshot' && message.reason === 'join_cancelled').length
      expect(told).toBe(1)

      alarmsAvailable = true
      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_alarm_back', sentAtLocalMs: 1 })

      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      expect(host.sent.filter(message => message.type === 'room_snapshot' && message.reason === 'join_cancelled')).toHaveLength(told)
      logged.mockRestore()
    })

    it('announces at once when the write went through and only the alarm could not be set, so a restart before the retry cannot lose it', async () => {
      const alarms: number[] = []
      let alarmsAvailable = false
      const flakyAlarms = Object.assign([] as number[], {
        push: (at: number) => {
          if (!alarmsAvailable)
            throw new Error('alarm storage is unavailable')
          return alarms.push(at)
        },
      })
      const { store, host } = await roomWithHostAndRequest()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const before = host.sent.length

      await restored(objectOver(store, [host], flakyAlarms))

      // The room was written, so the repair is durable and is told now; only
      // the alarm is outstanding.
      expect(host.sent.slice(before)).toContainEqual(expect.objectContaining({ type: 'room_snapshot', reason: 'join_cancelled' }))
      // A restart before any retry finds nothing to repair, and nothing is lost.
      const afterAnnounce = host.sent.length
      alarmsAvailable = true
      await restored(objectOver(store, [host], alarms))
      expect(host.sent).toHaveLength(afterAnnounce)
      logged.mockRestore()
    })

    it('keeps the repair for a member whose attachment could not be read, and tells it on a later save', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      const late = new FakeSocket()
      ;(first as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [host, friend, late]
      await say(first, late, { type: 'join_room', protocolVersion: 1, participantId: 'participant_late', name: 'Sam', code: CODE, media: null })
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const set = store.set.bind(store)
      store.set = () => { throw new Error('storage is unavailable') }
      // The friend's attachment cannot be read for now.
      let readable = false
      const real = friend.deserializeAttachment.bind(friend)
      friend.deserializeAttachment = () => {
        if (!readable && inspectUnreadable)
          throw new Error('attachment storage hiccup')
        return real()
      }
      let inspectUnreadable = false
      const restarted = await restored(objectOver(store, [host, friend]))
      store.set = set
      const hostBefore = host.sent.length
      const friendBefore = friend.sent.length

      inspectUnreadable = true
      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_unreadable_member', sentAtLocalMs: 1 })
      expect(host.sent.slice(hostBefore)).toContainEqual(expect.objectContaining({ type: 'room_snapshot', reason: 'join_cancelled' }))
      expect(friend.sent.slice(friendBefore)).toEqual([])

      readable = true
      vi.setSystemTime(startMs + 10_000)
      await say(restarted, host, { type: 'ping', id: 'ping_member_readable', sentAtLocalMs: 2 })
      expect(friend.sent.slice(friendBefore)).toContainEqual(expect.objectContaining({ type: 'room_snapshot', reason: 'join_cancelled' }))
      logged.mockRestore()
    })

    it('gives up announcing to a member that stays unreadable, after a few tries', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      const late = new FakeSocket()
      ;(first as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [host, friend, late]
      await say(first, late, { type: 'join_room', protocolVersion: 1, participantId: 'participant_late', name: 'Sam', code: CODE, media: null })
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const set = store.set.bind(store)
      store.set = () => { throw new Error('storage is unavailable') }
      let armed = false
      const real = friend.deserializeAttachment.bind(friend)
      friend.deserializeAttachment = () => {
        if (armed)
          throw new Error('attachment storage hiccup')
        return real()
      }
      const restarted = await restored(objectOver(store, [host, friend]))
      store.set = set
      armed = true
      const hostBefore = host.sent.length

      for (let i = 1; i <= 8; i += 1) {
        vi.setSystemTime(startMs + i * 5_000)
        await say(restarted, host, { type: 'ping', id: `ping_${i}`, sentAtLocalMs: i })
      }

      const repairs = host.sent.slice(hostBefore).filter(message => message.type === 'room_snapshot' && message.reason === 'join_cancelled')
      expect(repairs.length).toBeGreaterThan(0)
      expect(repairs.length).toBeLessThanOrEqual(3)
      logged.mockRestore()
    })

    it('does not use up its announcement attempts on saves that come in quick succession', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      const late = new FakeSocket()
      ;(first as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [host, friend, late]
      await say(first, late, { type: 'join_room', protocolVersion: 1, participantId: 'participant_late', name: 'Sam', code: CODE, media: null })
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const set = store.set.bind(store)
      store.set = () => { throw new Error('storage is unavailable') }
      let unreadable = false
      const real = friend.deserializeAttachment.bind(friend)
      friend.deserializeAttachment = () => {
        if (unreadable)
          throw new Error('attachment storage hiccup')
        return real()
      }
      const restarted = await restored(objectOver(store, [host, friend]))
      store.set = set
      const friendBefore = friend.sent.length

      // The friend cannot be read for a moment, and several saves land in it.
      unreadable = true
      for (let i = 0; i < 6; i += 1)
        await say(restarted, host, { type: 'client_metrics', roundTripMs: 20 + i })
      unreadable = false
      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_friend_readable', sentAtLocalMs: 1 })

      expect(friend.sent.slice(friendBefore)).toContainEqual(expect.objectContaining({ type: 'room_snapshot', reason: 'join_cancelled' }))
      logged.mockRestore()
    })

    it('retries a failed save that had nothing to announce, once, and then stops writing', async () => {
      const alarms: number[] = []
      const { store, host, friend, first } = await hostAndApprovedFriend()
      void first
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const set = store.set.bind(store)
      let writes = 0
      store.set = () => { throw new Error('storage is unavailable') }
      // Both sockets are attached: restoring finds nothing to repair.
      const restarted = await restored(objectOver(store, [host, friend], alarms))
      store.set = (key, value) => {
        writes += 1
        return set(key, value)
      }

      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_nothing_to_repair', sentAtLocalMs: 1 })
      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      expect(writes).toBe(1)

      for (const at of [10_000, 15_000, 20_000]) {
        vi.setSystemTime(startMs + at)
        await say(restarted, host, { type: 'ping', id: `ping_${at}`, sentAtLocalMs: at })
      }
      expect(writes).toBe(1)
      logged.mockRestore()
    })

    it('answers the frame before it spends the interval on a write, and makes one attempt for overlapping frames', async () => {
      const { host, restarted, logged } = await failedRestore()
      let releaseWrite: () => void = () => {}
      const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
      const storage = (restarted as unknown as { ctx: { storage: { put: (key: string, value: unknown) => Promise<void> } } }).ctx.storage
      const put = storage.put.bind(storage)
      let writes = 0
      storage.put = async (key, value) => {
        writes += 1
        await gate
        return put(key, value)
      }

      vi.setSystemTime(startMs + 5_000)
      const first = say(restarted, host, { type: 'ping', id: 'ping_first', sentAtLocalMs: 1 })
      const second = say(restarted, host, { type: 'ping', id: 'ping_second', sentAtLocalMs: 2 })
      await Promise.resolve()
      await Promise.resolve()

      // Both pongs went out while the retry's write is still waiting.
      expect(host.sent.filter(message => message.type === 'pong' && (message.id === 'ping_first' || message.id === 'ping_second'))).toHaveLength(2)
      releaseWrite()
      await Promise.all([first, second])
      expect(writes).toBe(1)
      logged.mockRestore()
    })

    it('retries when the clock has stepped back, instead of waiting for it to catch up', async () => {
      const { host, restarted, alarms, logged } = await failedRestore()

      vi.setSystemTime(startMs - 60 * 60_000)
      await say(restarted, host, { type: 'ping', id: 'ping_clock_back', sentAtLocalMs: 1 })

      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      logged.mockRestore()
    })

    it.each([
      ['the six-hour lifetime limit', MAX_ROOM_LIFETIME_MS + 1_000],
      ['the empty-room expiry', 31 * 60_000],
    ])('does not tell a later room about a repair of a room deleted by %s', async (_name, afterMs) => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      const late = new FakeSocket()
      ;(first as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => [host, friend, late]
      await say(first, late, { type: 'join_room', protocolVersion: 1, participantId: 'participant_late', name: 'Sam', code: CODE, media: null })
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const set = store.set.bind(store)
      store.set = () => { throw new Error('storage is unavailable') }
      // Nobody is attached, so the room is repaired and then empty.
      const sockets: FakeSocket[] = []
      const restarted = await restored(objectOver(store, sockets))
      store.set = set

      vi.setSystemTime(startMs + afterMs)
      await restarted.alarm()
      expect(inspect(restarted).coordinator).toBeNull()

      // A new room on the same object.
      const creator = new FakeSocket()
      sockets.push(creator)
      await say(restarted, creator, { type: 'create_room', protocolVersion: 1, participantId: 'participant_new_host', name: 'New', code: CODE, media: MEDIA })

      expect(creator.sent.map(message => message.type)).toEqual(['room_joined'])
      logged.mockRestore()
    })

    it('stays pending while the save keeps failing, and is tried again later', async () => {
      const { store, host, restarted, alarms, logged } = await failedRestore()
      const set = store.set.bind(store)
      store.set = () => { throw new Error('storage is still unavailable') }

      vi.setSystemTime(startMs + 5_000)
      await say(restarted, host, { type: 'ping', id: 'ping_still_failing', sentAtLocalMs: 1 })
      expect(host.last()).toMatchObject({ type: 'pong', id: 'ping_still_failing' })
      expect(alarms).toEqual([])

      store.set = set
      vi.setSystemTime(startMs + 10_000)
      await say(restarted, host, { type: 'ping', id: 'ping_recovered', sentAtLocalMs: 2 })
      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      logged.mockRestore()
    })
  })

  it('clears a stale empty-room clock on restore when a member is still attached', async () => {
    const { store, host } = await roomWithHostAndRequest()
    ;(store.get('room') as { emptySinceMs: number | null }).emptySinceMs = startMs - EMPTY_ROOM_TTL_MS * 2

    const restarted = await restored(objectOver(store, [host]))

    expect(inspect(restarted).emptySinceMs).toBeNull()
    expect((store.get('room') as { emptySinceMs: number | null }).emptySinceMs).toBeNull()
  })

  it('does not expire a room under connected members even if the clock was left running', async () => {
    const { host, first } = await roomWithHostAndRequest()
    // A path that forgot to clear the clock: the alarm must not trust it.
    inspect(first).emptySinceMs = startMs

    vi.setSystemTime(startMs + EMPTY_ROOM_TTL_MS + 60_000)
    await first.alarm()

    expect(inspect(first).coordinator).not.toBeNull()
    expect(inspect(first).emptySinceMs).toBeNull()
    expect(host.closed).toBeNull()
  })

  it('starts a missing clock for an empty room so it still expires', async () => {
    const { store } = await roomWithHostAndRequest()
    const restarted = await restored(objectOver(store, []))
    // Whatever the stored clock said, an empty room has one running.
    inspect(restarted).emptySinceMs = null

    await restarted.alarm()
    expect(inspect(restarted).emptySinceMs).toBe(startMs)

    vi.setSystemTime(startMs + EMPTY_ROOM_TTL_MS + 1_000)
    await restarted.alarm()

    expect(inspect(restarted).coordinator).toBeNull()
    expect(store.has('room')).toBe(false)
  })

  it('finishes expiring a room even when closing one socket throws', async () => {
    const { store, friend } = await roomWithHostAndRequest()
    // Nobody is a member any more: only the request's socket and a socket that
    // throws when closed remain, and the throwing one is listed first.
    const stubborn = new FakeSocket()
    stubborn.close = () => { throw new Error('socket is already closing') }
    const emptied = await restored(objectOver(store, [stubborn, friend]))
    expect(inspect(emptied).emptySinceMs).toBe(startMs)

    vi.setSystemTime(startMs + EMPTY_ROOM_TTL_MS + 1_000)
    await emptied.alarm()

    expect(inspect(emptied).coordinator).toBeNull()
    expect(store.has('room')).toBe(false)
    expect(friend.closed).toEqual({ code: 1000, reason: 'room_expired' })
  })

  it('schedules the six-hour lifetime limit instead of relying on another alarm to fire', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: startMs })
    const alarms: number[] = []
    const host = new FakeSocket()
    const room = objectOver(new Map(), [host], alarms)

    await say(room, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA })

    expect(alarms.at(-1)).toBe(startMs + MAX_ROOM_LIFETIME_MS)
  })

  it('schedules the lifetime limit when restoring a room that needed no repair', async () => {
    const { store, host, friend } = await roomWithHostAndRequest()
    const alarms: number[] = []

    // Every stored connection still has its socket and the clock is
    // consistent, so restoring changes nothing. The room was last written by a
    // version that never scheduled the limit, and no alarm is set for it.
    await restored(objectOver(store, [host, friend], alarms))

    expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
  })

  it('does not trust an existing alarm that is later than the lifetime limit', async () => {
    const { store, host, friend } = await roomWithHostAndRequest()
    const alarms: number[] = []

    // An alarm from an earlier version can be later than a deadline this
    // version has; having one set is not the same as having the right one.
    await restored(objectOver(store, [host, friend], alarms, startMs + 2 * MAX_ROOM_LIFETIME_MS))

    expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
  })

  it('anchors the lifetime limit of a restored room to when the room was created', async () => {
    const { store, host, friend } = await roomWithHostAndRequest()
    const alarms: number[] = []

    // Woken an hour after the room was created: the limit is still six hours
    // after creation, not six hours after this wake.
    vi.setSystemTime(startMs + 60 * 60_000)
    await restored(objectOver(store, [host, friend], alarms))

    expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
  })

  it('gives a stored room with no creation time one on its first restore and keeps it after that', async () => {
    const { store, host, friend } = await roomWithHostAndRequest()
    delete (store.get('room') as { createdAtMs?: number }).createdAtMs
    const alarms: number[] = []
    const firstWakeMs = startMs + 60 * 60_000

    // Without the stamp the limit would move to six hours after every wake and
    // a room that is woken often would never reach it.
    vi.setSystemTime(firstWakeMs)
    await restored(objectOver(store, [host, friend], alarms))
    vi.setSystemTime(firstWakeMs + 60 * 60_000)
    await restored(objectOver(store, [host, friend], alarms))

    expect(alarms).toEqual([firstWakeMs + MAX_ROOM_LIFETIME_MS, firstWakeMs + MAX_ROOM_LIFETIME_MS])
  })

  it('schedules the empty-room expiry when restoring a room nobody is connected to', async () => {
    const { store } = await roomWithHostAndRequest()
    // Nobody is a member and no controller recovery is planned any more, so the
    // expiry is the only deadline besides the lifetime limit.
    const stored = store.get('room') as { coordinator: { participants: Array<{ connected: boolean }> }, pendingController: unknown, emptySinceMs: number | null }
    for (const participant of stored.coordinator.participants)
      participant.connected = false
    stored.pendingController = null
    stored.emptySinceMs = startMs
    const alarms: number[] = []

    await restored(objectOver(store, [], alarms))

    expect(alarms).toEqual([startMs + EMPTY_ROOM_TTL_MS])
  })

  it('schedules the controller recovery that restoring plans', async () => {
    const { store } = await roomWithHostAndRequest()
    const alarms: number[] = []

    await restored(objectOver(store, [], alarms))

    expect(alarms).toEqual([startMs + CONTROLLER_GRACE_MS])
  })

  it('makes a repair durable before telling the members that kept their socket', async () => {
    const { store, host } = await roomWithHostAndRequest()
    const order: string[] = []
    const set = store.set.bind(store)
    store.set = (key, value) => {
      order.push('put')
      return set(key, value)
    }
    const send = host.send.bind(host)
    host.send = (data: string) => {
      order.push('send')
      send(data)
    }

    await restored(objectOver(store, [host]))

    expect(order).toEqual(['put', 'send'])
  })

  it('does not tell the members about a repair before its write has completed', async () => {
    const { store, host } = await roomWithHostAndRequest()
    let completeWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { completeWrite = resolve })
    const before = host.sent.length

    // The requester's socket did not survive, so there is a repair to save,
    // and the save is held back.
    const restarted = objectOver(store, [host], [], null, writeGate)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(host.sent).toHaveLength(before)

    completeWrite()
    await restored(restarted)
    expect(host.sent).toHaveLength(before + 1)
    expect(host.last()).toMatchObject({ type: 'room_snapshot', reason: 'join_cancelled' })
  })

  it('clears and saves a stale empty-room clock when every stored connection still has its socket', async () => {
    const { store, host, friend } = await roomWithHostAndRequest()
    ;(store.get('room') as { emptySinceMs: number | null }).emptySinceMs = startMs - EMPTY_ROOM_TTL_MS * 2

    // The clock is the only thing wrong, so it is not covered by a request
    // being withdrawn or a member being marked disconnected.
    const restarted = await restored(objectOver(store, [host, friend]))

    expect(inspect(restarted).emptySinceMs).toBeNull()
    expect((store.get('room') as { emptySinceMs: number | null }).emptySinceMs).toBeNull()
  })

  describe('deadlines a restored room is scheduled for', () => {
    const SEEK_BARRIER_MAX_WAIT_MS = 3_000
    const revisionOf = (room: InstanceType<typeof RoomDurableObject>) => inspect(room).coordinator!.snapshot().revision

    it('schedules the deadline of a pending seek', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await say(first, host, { type: 'control', actionId: 'action_seek', basedOnRevision: revisionOf(first), leaseEpoch: 1, kind: 'seek', positionSeconds: 30 })
      expect(host.last()).toMatchObject({ type: 'room_snapshot', reason: 'control_seek_pending' })
      const alarms: number[] = []

      await restored(objectOver(store, [host, friend], alarms))

      expect(alarms).toEqual([startMs + SEEK_BARRIER_MAX_WAIT_MS])
    })

    it('schedules the deadline of an operation that is preparing', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: startMs })
      const store = new Map<string, unknown>()
      const host = new FakeSocket()
      const friend = new FakeSocket()
      const first = objectOver(store, [host, friend])
      // Both clients advertise what a transactional room needs.
      const capabilities = CURRENT_CLIENT_CAPABILITIES
      await say(first, host, { type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, capabilities })
      await say(first, friend, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, capabilities })
      await say(first, host, approve)
      await say(first, host, { type: 'set_ready', ready: true, media: MEDIA })
      await say(first, friend, { type: 'set_ready', ready: true, media: MEDIA })
      await say(first, host, { type: 'control', actionId: 'action_play', basedOnRevision: revisionOf(first), leaseEpoch: 1, kind: 'play', positionSeconds: 0 })
      expect(host.last()).toMatchObject({ type: 'room_snapshot', reason: 'control_play_pending' })
      const alarms: number[] = []

      await restored(objectOver(store, [host, friend], alarms))

      expect(alarms).toEqual([startMs + SEEK_BARRIER_MAX_WAIT_MS])
    })

    it('schedules the health check of a room that is playing', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await say(first, host, { type: 'set_ready', ready: true, media: MEDIA })
      await say(first, friend, { type: 'set_ready', ready: true, media: MEDIA })
      await say(first, host, { type: 'control', actionId: 'action_play', basedOnRevision: revisionOf(first), leaseEpoch: 1, kind: 'play', positionSeconds: 0 })
      expect(host.last()).toMatchObject({ type: 'room_snapshot', reason: 'control_play' })
      const healthDeadlineMs = inspect(first).coordinator!.nextHealthDeadlineMs()
      expect(healthDeadlineMs).toBeLessThan(startMs + MAX_ROOM_LIFETIME_MS)
      const alarms: number[] = []

      await restored(objectOver(store, [host, friend], alarms))

      expect(alarms).toEqual([healthDeadlineMs])
    })
  })

  describe('controller recovery', () => {
    const controllerOf = (room: InstanceType<typeof RoomDurableObject>) => inspect(room).coordinator?.snapshot().controller.participantId
    const sessionTokenOf = (socket: FakeSocket) => {
      const joined = socket.sent.find(message => message.type === 'room_joined')
      if (joined?.type !== 'room_joined')
        throw new Error('Expected the socket to have joined')
      return joined.sessionToken
    }
    const attach = (room: InstanceType<typeof RoomDurableObject>, sockets: FakeSocket[]) => {
      ;(room as unknown as { ctx: { getWebSockets: () => FakeSocket[] } }).ctx.getWebSockets = () => sockets
    }

    it('hands control to a connected member when the controller does not return in time', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()

      await first.webSocketClose(host as never)
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()

      expect(controllerOf(first)).toBe('participant_friend')
      expect(friend.last()).toMatchObject({ type: 'room_snapshot', reason: 'controller_recovered' })
    })

    it('keeps control with a controller that returns within the grace period', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const hostToken = sessionTokenOf(host)

      await first.webSocketClose(host as never)
      const back = new FakeSocket()
      attach(first, [back, friend])
      vi.setSystemTime(startMs + 5_000)
      await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, sessionToken: hostToken })
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()

      expect(controllerOf(first)).toBe('participant_host')
    })

    it('hands control to a member that returns after the grace period lapsed with nobody connected', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)

      // Every connection drops at once, as in a deploy, and the grace period
      // runs out with nobody there to hand control to.
      await first.webSocketClose(host as never)
      await first.webSocketClose(friend as never)
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_host')

      // The member comes back; the host does not.
      const back = new FakeSocket()
      attach(first, [back])
      await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      expect(back.last()).toMatchObject({ type: 'room_joined' })
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000 + CONTROLLER_REARM_GRACE_MS + 1_000)
      await first.alarm()

      expect(controllerOf(first)).toBe('participant_friend')
      expect(back.last()).toMatchObject({ type: 'room_snapshot', reason: 'controller_recovered' })
    })

    it('gives the host the full re-arm window when its plan ran out while nobody was connected and the alarm was late', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)

      // Every connection drops at once and the alarm for the host's plan is
      // delivered late, after a member has come back.
      await first.webSocketClose(host as never)
      await first.webSocketClose(friend as never)
      const returnedAtMs = startMs + CONTROLLER_GRACE_MS + 5_000
      vi.setSystemTime(returnedAtMs)
      const back = new FakeSocket()
      attach(first, [back])
      await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      expect(back.last()).toMatchObject({ type: 'room_joined' })

      // The late alarm runs now: the plan ran out with nobody there, so it has
      // lapsed and the host keeps control for the re-arm window.
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_host')

      vi.setSystemTime(returnedAtMs + CONTROLLER_REARM_GRACE_MS + 1_000)
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_friend')
    })

    it('admits a returning member although another socket cannot be read, and leaves the recovery to be made later', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)
      await first.webSocketClose(host as never)
      await first.webSocketClose(friend as never)
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()

      const back = new FakeSocket()
      const unreadable = new FakeSocket()
      unreadable.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [unreadable, back])
      await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })

      expect(back.last()).toMatchObject({ type: 'room_joined' })
      // A socket that cannot be verified is not left open beside the admitted
      // one: it may be the member's own earlier connection, and it cannot be
      // served anyway. It is closed and its client reconnects.
      expect(unreadable.closed).toMatchObject({ code: 1011 })

      // The socket stays unreadable (a closed socket is still listed until its
      // handler returns). It cannot be served, so it is not an attached
      // participant; the next save derives the recovery that the join could
      // not, and the absent host does not keep control.
      const joinedAtMs = startMs + CONTROLLER_GRACE_MS + 1_000
      await say(first, back, { type: 'client_metrics', roundTripMs: 20 })
      // The plan is in what was saved, not only in memory, so a restart before
      // another write keeps its deadline instead of starting a new window.
      const savedPlan = (store.get('room') as { pendingController: { participantId: string, recoverAtMs: number } | null }).pendingController
      expect(savedPlan).toMatchObject({ participantId: 'participant_host', recoverAtMs: startMs + CONTROLLER_GRACE_MS + 1_000 + CONTROLLER_REARM_GRACE_MS })
      vi.setSystemTime(joinedAtMs + CONTROLLER_REARM_GRACE_MS + 1_000)
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_friend')
    })

    it('closes a socket that cannot be read when it restores, so that its client reconnects and is connected again', async () => {
      const { store, host, friend } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      friend.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }

      const restarted = await restored(objectOver(store, [host, friend]))

      // Restore cannot tell that the friend has a socket, so the friend is
      // recorded as disconnected, and the socket that cannot be served is closed.
      expect(friend.closed).toMatchObject({ code: 1011 })
      const connectedOf = (id: string) => inspect(restarted).coordinator?.snapshot().participants.find(participant => participant.id === id)?.connected
      expect(connectedOf('participant_friend')).toBe(false)

      // The client reconnects on a fresh socket with its session token and is
      // connected again: the room accepts the member back after a restore that
      // could not see its socket.
      const back = new FakeSocket()
      attach(restarted, [host, back])
      await say(restarted, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      expect(back.last()).toMatchObject({ type: 'room_joined' })
      expect(connectedOf('participant_friend')).toBe(true)
      logged.mockRestore()
    })

    it('still handles a close, and a denial, while another socket cannot be read', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const late = new FakeSocket()
      const unreadable = new FakeSocket()
      unreadable.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [host, friend, late, unreadable])
      await say(first, late, { type: 'join_room', protocolVersion: 1, participantId: 'participant_late', name: 'Sam', code: CODE, media: null })

      await say(first, host, { type: 'respond_to_join', participantId: 'participant_late', approve: false, actionId: 'action_deny_late', basedOnRevision: 0, leaseEpoch: 1 })
      expect(late.last()).toMatchObject({ type: 'command_rejected', code: 'join_denied' })

      await first.webSocketClose(host as never)
      expect(controllerOf(first)).toBe('participant_host')
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_friend')
    })

    it('accepts a connection while another socket cannot be read', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const unreadable = new FakeSocket()
      unreadable.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [host, friend, unreadable])
      vi.stubGlobal('WebSocketPair', class {
        constructor() { throw new Error('pair reached') }
      })

      await expect(first.fetch(new Request('https://rooms.test/rooms?code=ABCD2345', { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } })))
        .rejects.toThrow('pair reached')
      vi.unstubAllGlobals()
    })

    it('closes a socket that cannot be read when it counts the pending connections, instead of leaving it uncounted and open', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const unreadable = new FakeSocket()
      unreadable.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [host, friend, unreadable])
      vi.stubGlobal('WebSocketPair', class {
        constructor() { throw new Error('pair reached') }
      })

      await expect(first.fetch(new Request('https://rooms.test/rooms?code=ABCD2345', { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } })))
        .rejects.toThrow('pair reached')
      vi.unstubAllGlobals()

      // It cannot be served, so it is not allowed to sit beside the pending
      // connections the cap counts; its client reconnects with a fresh attachment.
      expect(unreadable.closed).toMatchObject({ code: 1011 })
      expect(host.closed).toBeNull()
      expect(friend.closed).toBeNull()
    })

    it('reconciles when the socket that closes is one whose attachment cannot be read, instead of throwing and leaving its member connected', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      host.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [host, friend])
      const heardBefore = friend.sent.length

      await first.webSocketClose(host as never)

      // Which participant the socket belonged to cannot be read from it, so the
      // members are compared with the sockets that can be read: the host has
      // none, the friend has one. The host was the controller, so its absence
      // is planned for like any other departure.
      const snapshot = inspect(first).coordinator?.snapshot()
      expect(snapshot?.participants.find(participant => participant.id === 'participant_host')?.connected).toBe(false)
      expect(snapshot?.participants.find(participant => participant.id === 'participant_friend')?.connected).toBe(true)
      expect(inspect(first).pendingController).toMatchObject({ participantId: 'participant_host' })
      // The other member is told, and what was reconciled is saved: a restart
      // before the next write finds the host disconnected and the plan made.
      expect(friend.sent.length).toBeGreaterThan(heardBefore)
      expect(friend.last()).toMatchObject({ type: 'room_snapshot', reason: 'participant_disconnected' })
      const saved = store.get('room') as { coordinator: { participants: Array<{ id: string, connected: boolean }> }, pendingController: { participantId: string } | null }
      expect(saved.coordinator.participants.find(participant => participant.id === 'participant_host')?.connected).toBe(false)
      expect(saved.pendingController).toMatchObject({ participantId: 'participant_host' })
      expect(host.closed).toMatchObject({ code: 1011 })
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_friend')
    })

    it('does the same when the runtime reports an error on a socket that cannot be read, and closes it even if the room is gone', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      host.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [host, friend])

      await first.webSocketError(host as never)

      expect(host.closed).toMatchObject({ code: 1011 })
      const snapshot = inspect(first).coordinator?.snapshot()
      expect(snapshot?.participants.find(participant => participant.id === 'participant_host')?.connected).toBe(false)

      // With no room to reconcile (it expired), the socket is still not left open.
      const stray = new FakeSocket()
      stray.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      const empty = createRoomObject([stray])
      await empty.webSocketError(stray as never)
      expect(stray.closed).toMatchObject({ code: 1011 })
    })

    it('closes a socket that cannot be read when a frame arrives on it, so its client reconnects instead of waiting for a reply', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const unreadable = new FakeSocket()
      unreadable.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [host, friend, unreadable])

      await say(first, unreadable, { type: 'ping', id: 'ping_unreadable', sentAtLocalMs: 1 })

      expect(unreadable.closed).toMatchObject({ code: 1011 })
      expect(unreadable.sent).toEqual([])
    })

    it('treats a socket with no attachment at all like one that cannot be read', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const bare = new FakeSocket()
      bare.attachment = null
      attach(first, [host, friend, bare])

      await say(first, bare, { type: 'ping', id: 'ping_bare', sentAtLocalMs: 1 })
      expect(bare.closed).toMatchObject({ code: 1011 })

      const other = new FakeSocket()
      other.attachment = null
      attach(first, [host, friend, other])
      vi.stubGlobal('WebSocketPair', class {
        constructor() { throw new Error('pair reached') }
      })
      await expect(first.fetch(new Request('https://rooms.test/rooms?code=ABCD2345', { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } })))
        .rejects.toThrow('pair reached')
      vi.unstubAllGlobals()
      expect(other.closed).toMatchObject({ code: 1011 })
    })

    it('closes a socket that cannot be read when it broadcasts', async () => {
      const { host, friend, first } = await roomWithHostAndRequest()
      const unreadable = new FakeSocket()
      unreadable.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [unreadable, host, friend])

      // Approving the request broadcasts to the members.
      await say(first, host, approve)
      expect(unreadable.closed).toMatchObject({ code: 1011 })
      expect(friend.last()).toMatchObject({ type: 'room_snapshot' })
    })

    it('closes a socket that becomes unreadable by the time a member reports to the controller, in the scan that finds the controller', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const { socket: flaky, breakIt } = socketThatBreaksLater()
      attach(first, [flaky, host, friend])
      await say(first, host, { type: 'request_diagnostics', reportId: 'report_flaky_scan' })
      breakIt()

      // The response is delivered to the controller and nothing is broadcast
      // afterwards, so only the scan for the controller can close it.
      await say(first, friend, {
        type: 'diagnostics_response',
        reportId: 'report_flaky_scan',
        report: {
          extensionVersion: '0.2.6', generatedAtLocalMs: 10_000, userAgent: 'Chrome test', connection: 'connected',
          roomRevision: 1, playbackStatus: 'paused', playerFrameId: 0, playerAreaPixels: 500_000, playerLastSeenAtMs: 9_900,
          mediaService: null, mediaCanonicalId: null, mediaPageUrl: null, sample: null,
          events: [{ atLocalMs: 9_900, category: 'room', message: 'room_joined', details: { revision: 1 } }],
        },
      })
      expect(flaky.closed).toMatchObject({ code: 1011 })
      expect(host.last()).toMatchObject({ type: 'diagnostics_response', participantId: 'participant_friend' })
    })

    it('closes the earlier socket of a returning member before it admits the new one, not only when the room is announced afterwards', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)
      const { socket: flaky, breakIt } = socketThatBreaksLater()
      const back = new FakeSocket()
      attach(first, [host, flaky, back])
      breakIt()
      const heardBefore = host.sent.length
      let heardWhenClosed = -1
      onFirstClose(flaky, () => { heardWhenClosed = host.sent.length })

      await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })

      expect(back.last()).toMatchObject({ type: 'room_joined' })
      expect(flaky.closed).toMatchObject({ code: 1011 })
      // The room's announcement to the host comes after the join scan.
      expect(heardWhenClosed).toBe(heardBefore)
    })

    it('closes a socket that cannot be read in the close handler\'s own scan, before the departure is announced', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const { socket: flaky, breakIt } = socketThatBreaksLater()
      attach(first, [flaky, host, friend])
      breakIt()
      let friendConnectedWhenClosed: boolean | undefined
      onFirstClose(flaky, () => {
        friendConnectedWhenClosed = inspect(first).coordinator?.snapshot().participants.find(participant => participant.id === 'participant_friend')?.connected
      })

      await first.webSocketClose(friend as never)

      expect(flaky.closed).toMatchObject({ code: 1011 })
      // The scan runs before the friend is recorded as disconnected; the
      // announcement that follows would find it already recorded.
      expect(friendConnectedWhenClosed).toBe(true)
    })

    it('closes a socket that cannot be read in the denial loop, before the denied request is announced', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const { socket: flaky, breakIt } = socketThatBreaksLater()
      const late = new FakeSocket()
      attach(first, [flaky, host, friend, late])
      await say(first, late, { type: 'join_room', protocolVersion: 1, participantId: 'participant_late', name: 'Sam', code: CODE, media: null })
      breakIt()
      let deniedClosedWhenClosed: unknown = 'not recorded'
      onFirstClose(flaky, () => { deniedClosedWhenClosed = late.closed })

      await say(first, host, { type: 'respond_to_join', participantId: 'participant_late', approve: false, actionId: 'action_deny_late_scan', basedOnRevision: 0, leaseEpoch: 1 })

      expect(flaky.closed).toMatchObject({ code: 1011 })
      // The loop reaches the unreadable socket first; the denied socket is
      // closed after it, and the broadcast that follows the loop after both.
      expect(deniedClosedWhenClosed).toBeNull()
    })

    it('counts only the connections that can be served toward the pending cap, and closes the one that cannot be read', async () => {
      const { first } = await hostAndApprovedFriend()
      const pending = Array.from({ length: 19 }, () => new FakeSocket())
      const unreadable = new FakeSocket()
      unreadable.deserializeAttachment = () => { throw new Error('attachment storage hiccup') }
      attach(first, [...pending, unreadable])
      vi.stubGlobal('WebSocketPair', class {
        constructor() { throw new Error('pair reached') }
      })
      const upgrade = () => first.fetch(new Request('https://rooms.test/rooms?code=ABCD2345', { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } }))

      // 19 pending connections and one that cannot be read: not at the cap.
      await expect(upgrade()).rejects.toThrow('pair reached')
      expect(unreadable.closed).toMatchObject({ code: 1011 })

      // The 20th pending connection reaches the cap; the unreadable one did not count.
      attach(first, [...pending, new FakeSocket()])
      const refused = await upgrade()
      expect(refused.status).toBe(429)
      vi.unstubAllGlobals()
    })

    it('gives the host the re-arm window when the last member\'s close was never delivered and the plan had run out', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)
      // The host leaves, and the object is lost before the friend's close is
      // delivered: nobody is attached when it is rebuilt after the plan's time.
      await first.webSocketClose(host as never)
      const restoredAtMs = startMs + CONTROLLER_GRACE_MS + 5_000
      vi.setSystemTime(restoredAtMs)
      const restarted = await restored(objectOver(store, []))

      const back = new FakeSocket()
      attach(restarted, [back])
      await say(restarted, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      expect(back.last()).toMatchObject({ type: 'room_joined' })

      // The alarm that was due is delivered now: the plan ran out with nobody
      // there, so the host keeps control for the re-arm window.
      await restarted.alarm()
      expect(controllerOf(restarted)).toBe('participant_host')
      vi.setSystemTime(restoredAtMs + CONTROLLER_REARM_GRACE_MS + 1_000)
      await restarted.alarm()
      expect(controllerOf(restarted)).toBe('participant_friend')
    })

    it('schedules an alarm for the recovery it re-arms and gives the host a full grace period', async () => {
      const alarms: number[] = []
      const { host, friend, first } = await hostAndApprovedFriend(alarms)
      const friendToken = sessionTokenOf(friend)

      await first.webSocketClose(host as never)
      expect(alarms.at(-1)).toBe(startMs + CONTROLLER_GRACE_MS)
      await first.webSocketClose(friend as never)
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()

      const returnedAtMs = startMs + CONTROLLER_GRACE_MS + 1_000
      const back = new FakeSocket()
      attach(first, [back])
      await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      expect(alarms.at(-1)).toBe(returnedAtMs + CONTROLLER_REARM_GRACE_MS)

      // An alarm that is delivered before the grace period is over changes nothing.
      vi.setSystemTime(returnedAtMs + CONTROLLER_REARM_GRACE_MS - 1_000)
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_host')

      vi.setSystemTime(returnedAtMs + CONTROLLER_REARM_GRACE_MS + 1_000)
      await first.alarm()
      expect(controllerOf(first)).toBe('participant_friend')
    })

    it('keeps control with a host that returns after its longest reconnect backoff', async () => {
      const alarms: number[] = []
      const { host, friend, first } = await hostAndApprovedFriend(alarms)
      const hostToken = sessionTokenOf(host)
      const friendToken = sessionTokenOf(friend)

      // Every connection drops and the grace period runs out with nobody there.
      await first.webSocketClose(host as never)
      await first.webSocketClose(friend as never)
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()

      // The member is back first. The host has been backing off since the
      // outage and is back at the end of its longest delay.
      const memberBackAtMs = startMs + 60_000
      vi.setSystemTime(memberBackAtMs)
      const memberBack = new FakeSocket()
      attach(first, [memberBack])
      await say(first, memberBack, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      const hostBack = new FakeSocket()
      attach(first, [memberBack, hostBack])

      // The alarm is delivered when it is due; the host reconnects when its
      // backoff ends. Whichever comes first happens first.
      const steps = [
        { atMs: alarms.at(-1)!, run: () => first.alarm() },
        { atMs: memberBackAtMs + LONGEST_RECONNECT_BACKOFF_MS, run: () => say(first, hostBack, { type: 'join_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: CODE, media: MEDIA, sessionToken: hostToken }) },
      ].sort((a, b) => a.atMs - b.atMs)
      for (const step of steps) {
        vi.setSystemTime(step.atMs)
        await step.run()
      }

      expect(hostBack.last()).toMatchObject({ type: 'room_joined' })
      expect(controllerOf(first)).toBe('participant_host')
    })

    it('plans the recovery a stored room is missing when restoring it with the host gone and a member attached', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await first.webSocketClose(host as never)
      // The plan lapsed under code that did not re-arm it, and was saved so.
      ;(store.get('room') as { pendingController: unknown }).pendingController = null
      const restoredAtMs = startMs + 60_000
      vi.setSystemTime(restoredAtMs)
      const alarms: number[] = []

      const restarted = await restored(objectOver(store, [friend], alarms))

      expect(inspect(restarted).pendingController).toMatchObject({ participantId: 'participant_host', recoverAtMs: restoredAtMs + CONTROLLER_REARM_GRACE_MS })
      expect(alarms).toEqual([restoredAtMs + CONTROLLER_REARM_GRACE_MS])
      expect((store.get('room') as { pendingController: unknown }).pendingController).toMatchObject({ participantId: 'participant_host' })
      vi.setSystemTime(restoredAtMs + CONTROLLER_REARM_GRACE_MS + 1_000)
      await restarted.alarm()
      expect(controllerOf(restarted)).toBe('participant_friend')
    })

    it('plans no recovery on restore when nobody is connected to hand control to', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await first.webSocketClose(host as never)
      await first.webSocketClose(friend as never)
      ;(store.get('room') as { pendingController: unknown }).pendingController = null

      const restarted = await restored(objectOver(store, []))

      expect(inspect(restarted).pendingController).toBeNull()
    })

    it('plans no recovery on restore for a controller that still has its socket', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await first.webSocketClose(host as never)
      // The host's join was not saved: the room says it is disconnected while
      // its socket is attached, and no plan is pending.
      ;(store.get('room') as { pendingController: unknown }).pendingController = null

      const restarted = await restored(objectOver(store, [host, friend]))

      expect(inspect(restarted).pendingController).toBeNull()
    })

    it('plans no recovery when a member returns while the controller still has its socket', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)
      await first.webSocketClose(host as never)
      // The host's join was not saved: the room says it is disconnected while
      // its socket is attached, and no plan is pending.
      ;(store.get('room') as { pendingController: unknown }).pendingController = null
      const alarms: number[] = []
      const restarted = await restored(objectOver(store, [host, friend], alarms))

      // The member's connection drops and comes back; the host's never did.
      attach(restarted, [host])
      await restarted.webSocketClose(friend as never)
      const back = new FakeSocket()
      attach(restarted, [host, back])
      await say(restarted, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      expect(back.last()).toMatchObject({ type: 'room_joined' })

      expect(inspect(restarted).pendingController).toBeNull()
      expect(alarms.at(-1)).toBe(startMs + MAX_ROOM_LIFETIME_MS)
      vi.setSystemTime(startMs + CONTROLLER_REARM_GRACE_MS + 1_000)
      await restarted.alarm()
      expect(controllerOf(restarted)).toBe('participant_host')
    })

    it('plans the recovery when a controller stored as disconnected then loses its socket', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await first.webSocketClose(host as never)
      // The host's join was not saved: the room says it is disconnected while
      // its socket is attached, and no plan is pending.
      ;(store.get('room') as { pendingController: unknown }).pendingController = null
      const alarms: number[] = []
      const restarted = await restored(objectOver(store, [host, friend], alarms))
      expect(inspect(restarted).pendingController).toBeNull()

      // The socket really goes away now. The room has nothing to disconnect,
      // but nobody is acting for it, so a recovery must be planned.
      await restarted.webSocketClose(host as never)

      expect(inspect(restarted).pendingController).toMatchObject({ participantId: 'participant_host', recoverAtMs: startMs + CONTROLLER_GRACE_MS })
      expect(alarms.at(-1)).toBe(startMs + CONTROLLER_GRACE_MS)
      attach(restarted, [friend])
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await restarted.alarm()
      expect(controllerOf(restarted)).toBe('participant_friend')
    })

    it('plans no recovery when a member returns while the controller is connected', async () => {
      const alarms: number[] = []
      const { host, friend, first } = await hostAndApprovedFriend(alarms)
      const friendToken = sessionTokenOf(friend)

      await first.webSocketClose(friend as never)
      const back = new FakeSocket()
      attach(first, [host, back])
      await say(first, back, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      expect(back.last()).toMatchObject({ type: 'room_joined' })

      // Nothing is planned and nothing is scheduled besides the lifetime
      // limit, so no alarm wakes the room for a controller that is there.
      expect(inspect(first).pendingController).toBeNull()
      expect(alarms.at(-1)).toBe(startMs + MAX_ROOM_LIFETIME_MS)
    })

    it('drops a stored recovery plan on restore when its controller still has its socket', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await first.webSocketClose(host as never)
      // The host's join was not saved: the room says it is disconnected and
      // holds the plan made when it left, while its socket is attached.
      const alarms: number[] = []

      const restarted = await restored(objectOver(store, [host, friend], alarms))

      expect(inspect(restarted).pendingController).toBeNull()
      expect((store.get('room') as { pendingController: unknown }).pendingController).toBeNull()
      expect(alarms).toEqual([startMs + MAX_ROOM_LIFETIME_MS])
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await restarted.alarm()
      expect(controllerOf(restarted)).toBe('participant_host')
    })

    it('keeps a stored recovery plan on restore when its controller has no socket', async () => {
      const { store, host, friend, first } = await hostAndApprovedFriend()
      await first.webSocketClose(host as never)

      const restarted = await restored(objectOver(store, [friend]))

      // The plan keeps the deadline it was made with.
      expect(inspect(restarted).pendingController).toEqual({ participantId: 'participant_host', recoverAtMs: startMs + CONTROLLER_GRACE_MS })
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await restarted.alarm()
      expect(controllerOf(restarted)).toBe('participant_friend')
    })

    it('does not postpone a recovery that is already pending when a member reconnects', async () => {
      const { host, friend, first } = await hostAndApprovedFriend()
      const friendToken = sessionTokenOf(friend)

      await first.webSocketClose(host as never)
      const again = new FakeSocket()
      attach(first, [again])
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS - 1_000)
      await say(first, again, { type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: CODE, media: null, sessionToken: friendToken })
      vi.setSystemTime(startMs + CONTROLLER_GRACE_MS + 1_000)
      await first.alarm()

      expect(controllerOf(first)).toBe('participant_friend')
    })
  })
})
