import type { ServerMessage } from '@syncyourjoy/protocol'
import { describe, expect, it, vi } from 'vitest'

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
      media: null,
      navigation: null,
      seek: null,
      participants: [],
      playback: { status: 'paused', positionSeconds: 0 },
      pendingJoinRequests: [expect.objectContaining({ id: 'participant_friend', name: 'Rana' })],
    })
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
