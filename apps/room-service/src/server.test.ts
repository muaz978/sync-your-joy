import type { ServerMessage } from '@syncyourjoy/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createRoomService, type RoomService } from './server.ts'

let service: RoomService | null = null

afterEach(async () => {
  await service?.close()
  service = null
})

describe('room service', () => {
  it('creates a room and lets a second client join it', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)

    host.send(JSON.stringify({
      type: 'create_room',
      protocolVersion: 1,
      participantId: 'participant_host',
      name: 'Muaz',
      code: 'JOY7K2MX',
      media: {
        service: 'youtube',
        canonicalId: 'youtube:abc123',
        title: 'A useful test video',
        durationSeconds: 600,
      },
    }))
    const created = await nextMessage(host)
    expect(created.type).toBe('room_joined')
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')

    friend.send(JSON.stringify({
      type: 'join_room',
      protocolVersion: 1,
      participantId: 'participant_friend',
      name: 'Rana',
      code: created.snapshot.code,
      media: created.snapshot.media,
    }))
    const joined = await nextMessage(friend)
    expect(joined.type).toBe('room_joined')
    if (joined.type === 'room_joined')
      expect(joined.snapshot.participants).toHaveLength(2)

    host.close()
    friend.close()
  })

  it('rejects malformed messages without crashing the connection', async () => {
    service = await createRoomService({ port: 0 })
    const socket = await connect(service.url)
    socket.send('{bad json')
    const response = await nextMessage(socket)
    expect(response).toMatchObject({ type: 'error', code: 'invalid_message' })
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  it('keeps a replacement connection ready and connected after closing its prior socket', async () => {
    service = await createRoomService({ port: 0 })
    const original = await connect(service.url)
    const media = {
      service: 'youtube',
      canonicalId: 'youtube:abc123',
      title: 'A useful test video',
      durationSeconds: 600,
    }
    original.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'REJOIN12', media,
    }))
    await nextMessage(original)
    original.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await nextMessage(original)

    const originalClosed = new Promise<void>((resolve) => original.once('close', () => resolve()))
    const replacement = await connect(service.url)
    replacement.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'REJOIN12', media,
    }))
    const joined = await nextMessage(replacement)
    expect(joined).toMatchObject({
      type: 'room_joined',
      snapshot: { participants: [expect.objectContaining({ id: 'participant_host', connected: true, ready: true })] },
    })
    await originalClosed

    replacement.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    const confirmed = await nextRoomSnapshot(replacement, 'readiness_unchanged')
    expect(confirmed.snapshot.participants).toEqual([
      expect.objectContaining({ id: 'participant_host', connected: true, ready: true, mediaMatches: true }),
    ])
    replacement.close()
  })

  it('collects sanitized diagnostic reports from every participant for the controller', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'LOGS1234', media: null,
    }))
    await nextMessage(host)
    const hostJoinNotice = nextMessage(host)
    friend.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: 'LOGS1234', media: null,
    }))
    await Promise.all([nextMessage(friend), hostJoinNotice])

    const hostRequest = nextMessage(host)
    const friendRequest = nextMessage(friend)
    host.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_123456' }))
    await expect(hostRequest).resolves.toMatchObject({ type: 'diagnostics_requested', reportId: 'report_123456' })
    await expect(friendRequest).resolves.toMatchObject({ type: 'diagnostics_requested', reportId: 'report_123456' })

    const report = diagnosticReport()
    const ownResponse = nextMessage(host)
    host.send(JSON.stringify({ type: 'diagnostics_response', reportId: 'report_123456', report }))
    await expect(ownResponse).resolves.toMatchObject({ type: 'diagnostics_response', participantId: 'participant_host', participantName: 'Muaz' })
    const friendResponse = nextMessage(host)
    friend.send(JSON.stringify({ type: 'diagnostics_response', reportId: 'report_123456', report }))
    await expect(friendResponse).resolves.toMatchObject({ type: 'diagnostics_response', participantId: 'participant_friend', participantName: 'Rana' })

    const rejectedMemberRequest = nextMessage(friend)
    friend.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_654321' }))
    await expect(rejectedMemberRequest).resolves.toMatchObject({ type: 'error', code: 'controller_only' })
    host.close()
    friend.close()
  })
})

function diagnosticReport() {
  return {
    extensionVersion: '0.1.11', generatedAtLocalMs: 10_000, userAgent: 'Chrome test', connection: 'connected',
    roomRevision: 1, playbackStatus: 'paused', playerFrameId: 0, playerAreaPixels: 500_000, playerLastSeenAtMs: 9_900,
    mediaService: null, mediaCanonicalId: null, mediaPageUrl: null, sample: null,
    events: [{ atLocalMs: 9_900, category: 'room', message: 'room_joined', details: { revision: 1 } }],
  }
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for server message.')), 2_000)
    socket.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()) as ServerMessage)
    })
  })
}

async function nextRoomSnapshot(socket: WebSocket, reason: string): Promise<Extract<ServerMessage, { type: 'room_snapshot' }>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const message = await nextMessage(socket)
    if (message.type === 'room_snapshot' && message.reason === reason)
      return message
  }
  throw new Error(`Timed out waiting for room snapshot: ${reason}`)
}
