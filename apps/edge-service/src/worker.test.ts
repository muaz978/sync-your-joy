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
