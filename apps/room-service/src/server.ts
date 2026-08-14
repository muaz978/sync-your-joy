import type { AddressInfo } from 'node:net'
import type { ClientMessage, MediaFingerprint, ServerMessage } from '@syncyourjoy/protocol'
import type { RoomResult } from '@syncyourjoy/sync-engine'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'
import { WebSocket, WebSocketServer } from 'ws'

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_MESSAGE_BYTES = 16_384
const CONTROLLER_GRACE_MS = 10_000
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000
const testPlayerHtml = await readFile(new URL('../static/test-player.html', import.meta.url), 'utf8')

interface ConnectedClient {
  socket: WebSocket
  participantId: string
  roomCode: string
}

interface RoomEntry {
  coordinator: RoomCoordinator
  sockets: Set<WebSocket>
  emptySinceMs: number | null
}

export interface RoomService {
  httpServer: HttpServer
  url: string
  close: () => Promise<void>
}

export async function createRoomService(options: { port?: number; host?: string } = {}): Promise<RoomService> {
  const rooms = new Map<string, RoomEntry>()
  const clients = new Map<WebSocket, ConnectedClient>()
  const recoveryTimers = new Map<string, NodeJS.Timeout>()
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })

  const httpServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }))
      return
    }

    if (request.method === 'GET' && request.url === '/test-player') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(testPlayerHtml)
      return
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: 'not_found' }))
  })

  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/rooms' || !originAllowed(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request)
    })
  })

  webSocketServer.on('connection', (socket) => {
    let messageWindowStartedAt = Date.now()
    let messageCount = 0

    socket.on('message', (rawData) => {
      const nowMs = Date.now()
      if (nowMs - messageWindowStartedAt > 10_000) {
        messageWindowStartedAt = nowMs
        messageCount = 0
      }
      messageCount += 1
      if (messageCount > 120) {
        send(socket, { type: 'error', code: 'rate_limited', message: 'Too many room messages. Reconnecting may help.' })
        socket.close(1008, 'rate_limited')
        return
      }

      const rawText = rawData.toString()
      if (Buffer.byteLength(rawText) > MAX_MESSAGE_BYTES) {
        socket.close(1009, 'message_too_large')
        return
      }

      const message = parseClientMessage(safeJsonParse(rawText))
      if (!message) {
        send(socket, { type: 'error', code: 'invalid_message', message: 'The room message was not valid.' })
        return
      }

      handleMessage(socket, message)
    })

    socket.on('close', () => {
      const client = clients.get(socket)
      if (!client)
        return

      clients.delete(socket)
      const room = rooms.get(client.roomCode)
      if (!room)
        return

      room.sockets.delete(socket)
      const result = room.coordinator.disconnect(client.participantId)
      if (result?.ok)
        broadcast(room, { type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })

      const snapshot = room.coordinator.snapshot()
      if (snapshot.controller.participantId === client.participantId) {
        const timerKey = `${client.roomCode}:${client.participantId}`
        const priorTimer = recoveryTimers.get(timerKey)
        if (priorTimer)
          clearTimeout(priorTimer)

        recoveryTimers.set(timerKey, setTimeout(() => {
          recoveryTimers.delete(timerKey)
          const recovery = room.coordinator.transferDisconnectedController()
          if (recovery?.ok)
            broadcast(room, { type: 'room_snapshot', reason: recovery.reason, snapshot: recovery.snapshot })
        }, CONTROLLER_GRACE_MS))
      }

      if (!room.coordinator.hasConnectedParticipants())
        room.emptySinceMs = Date.now()
    })
  })

  function handleMessage(socket: WebSocket, message: ClientMessage): void {
    if (message.type === 'create_room') {
      if (clients.has(socket)) {
        send(socket, { type: 'error', code: 'already_joined', message: 'Leave the current room before creating another.' })
        return
      }

      const code = rooms.has(message.code) ? createUniqueCode(rooms) : message.code
      const coordinator = new RoomCoordinator(
        { roomId: randomUUID(), code, inviteToken: randomBytes(16).toString('base64url') },
        { id: message.participantId, name: message.name, media: message.media },
      )
      const entry: RoomEntry = { coordinator, sockets: new Set([socket]), emptySinceMs: null }
      rooms.set(code, entry)
      clients.set(socket, { socket, participantId: message.participantId, roomCode: code })
      send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        inviteToken: coordinator.inviteToken,
        snapshot: coordinator.snapshot(),
      })
      return
    }

    if (message.type === 'join_room') {
      if (clients.has(socket)) {
        send(socket, { type: 'error', code: 'already_joined', message: 'You are already connected to a room.' })
        return
      }

      const entry = rooms.get(message.code)
      if (!entry) {
        send(socket, { type: 'error', code: 'room_not_found', message: 'That room code is invalid or has expired.' })
        return
      }

      const result = entry.coordinator.join({ id: message.participantId, name: message.name, media: message.media })
      if (!result.ok) {
        sendResult(socket, null, result)
        return
      }

      const timerKey = `${message.code}:${message.participantId}`
      const recoveryTimer = recoveryTimers.get(timerKey)
      if (recoveryTimer) {
        clearTimeout(recoveryTimer)
        recoveryTimers.delete(timerKey)
      }

      entry.sockets.add(socket)
      entry.emptySinceMs = null
      clients.set(socket, { socket, participantId: message.participantId, roomCode: message.code })
      send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        inviteToken: entry.coordinator.inviteToken,
        snapshot: result.snapshot,
      })
      broadcast(entry, { type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot }, socket)
      return
    }

    if (message.type === 'ping') {
      send(socket, {
        type: 'pong',
        id: message.id,
        sentAtLocalMs: message.sentAtLocalMs,
        serverTimeMs: Date.now(),
      })
      return
    }

    const client = clients.get(socket)
    if (!client) {
      send(socket, { type: 'error', code: 'not_joined', message: 'Create or join a room first.' })
      return
    }

    const room = rooms.get(client.roomCode)
    if (!room) {
      send(socket, { type: 'error', code: 'room_expired', message: 'This room has expired.' })
      return
    }

    if (message.type === 'request_diagnostics') {
      if (client.participantId !== room.coordinator.snapshot().controller.participantId) {
        send(socket, { type: 'error', code: 'controller_only', message: 'Only the room controller can request detailed reports.' })
        return
      }
      broadcast(room, { type: 'diagnostics_requested', reportId: message.reportId })
      return
    }

    if (message.type === 'diagnostics_response') {
      const snapshot = room.coordinator.snapshot()
      const participant = snapshot.participants.find(item => item.id === client.participantId)
      const controllerClient = [...clients.values()].find(item => item.roomCode === client.roomCode && item.participantId === snapshot.controller.participantId)
      if (participant && controllerClient) {
        send(controllerClient.socket, {
          type: 'diagnostics_response',
          reportId: message.reportId,
          participantId: client.participantId,
          participantName: participant.name,
          report: message.report,
        })
      }
      return
    }

    if (message.type === 'client_metrics') {
      room.coordinator.recordLatency(client.participantId, message.roundTripMs)
      return
    }

    if (message.type === 'player_status') {
      const result = room.coordinator.updatePlayerStatus(client.participantId, message.basedOnRevision, message.sample)
      if (result?.ok)
        broadcast(room, { type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
      return
    }

    if (message.type === 'seek_applied') {
      const result = room.coordinator.acknowledgeSeek(client.participantId, message.revision, message.positionSeconds)
      if (result?.ok)
        broadcast(room, { type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
      return
    }

    const result = message.type === 'set_ready'
      ? room.coordinator.setReady(client.participantId, message.ready, message.media)
      : message.type === 'transfer_control'
        ? room.coordinator.transferControl(client.participantId, message.participantId, message.leaseEpoch)
        : message.type === 'open_link'
          ? room.coordinator.openLink(client.participantId, message)
          : room.coordinator.control(client.participantId, message)

    if (!result.ok) {
      sendResult(socket, message.type === 'control' || message.type === 'open_link' ? message.actionId : null, result)
      return
    }

    broadcast(room, { type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
  }

  const cleanupTimer = setInterval(() => {
    const nowMs = Date.now()
    for (const [code, room] of rooms) {
      const expiredSeek = room.coordinator.releaseExpiredSeek(nowMs)
      if (expiredSeek?.ok)
        broadcast(room, { type: 'room_snapshot', reason: expiredSeek.reason, snapshot: expiredSeek.snapshot })
      if (room.emptySinceMs !== null && nowMs - room.emptySinceMs >= EMPTY_ROOM_TTL_MS)
        rooms.delete(code)
    }
  }, 100)
  cleanupTimer.unref()

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 8787, options.host ?? '127.0.0.1', () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  const address = httpServer.address() as AddressInfo
  const url = `ws://${address.address === '::' ? '127.0.0.1' : address.address}:${address.port}/rooms`

  return {
    httpServer,
    url,
    close: async () => {
      clearInterval(cleanupTimer)
      for (const timer of recoveryTimers.values())
        clearTimeout(timer)
      for (const socket of webSocketServer.clients)
        socket.terminate()
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close(() => {
          httpServer.close(error => error ? reject(error) : resolve())
        })
      })
    },
  }
}

function createUniqueCode(rooms: Map<string, unknown>): string {
  for (;;) {
    const bytes = randomBytes(8)
    let code = ''
    for (const byte of bytes)
      code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length]
    if (!rooms.has(code))
      return code
  }
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  return origin === undefined
    || origin.startsWith('chrome-extension://')
    || origin.startsWith('http://127.0.0.1')
    || origin.startsWith('http://localhost')
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message))
}

function broadcast(room: RoomEntry, message: ServerMessage, except?: WebSocket): void {
  for (const socket of room.sockets) {
    if (socket !== except)
      send(socket, message)
  }
}

function sendResult(socket: WebSocket, actionId: string | null, result: RoomResult): void {
  if (result.ok)
    return
  send(socket, {
    type: 'command_rejected',
    actionId,
    code: result.code,
    message: result.message,
    snapshot: result.snapshot,
  })
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  createRoomService({
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '127.0.0.1',
  }).then((service) => {
    console.log(`SyncYourJoy room service listening on ${service.url}`)
  }).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
