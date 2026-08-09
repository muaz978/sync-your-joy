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
})

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
