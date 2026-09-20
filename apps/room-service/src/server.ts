import type { AddressInfo } from 'node:net'
import type { ClientMessage, MediaFingerprint, ServerMessage } from '@syncyourjoy/protocol'
import type { RoomResult } from '@syncyourjoy/sync-engine'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { generateRoomCode, isAllowedOrigin, parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_MESSAGE_BYTES = 16_384
const CONTROLLER_GRACE_MS = 10_000
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000
const MAX_ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
// Scoped per remote IP, not per room: an unauthenticated socket has not yet
// told us which room it wants, so this is the earliest point we can bound
// abuse without letting one source exhaust the cap for every other client.
const MAX_PENDING_CONNECTIONS_PER_IP = 20
const MAX_UPGRADE_ATTEMPTS_PER_IP = 30
const UPGRADE_ATTEMPT_WINDOW_MS = 60_000
// This process holds every room in memory for up to MAX_ROOM_LIFETIME_MS, so
// unlike the edge Worker (one isolated Durable Object per room, with no
// shared in-memory structure to exhaust), an unbounded create_room rate from
// one IP -- or in aggregate -- can grow this process's memory without limit
// even though each individual room is otherwise well-behaved.
const MAX_ROOMS_PER_IP = 20
const MAX_TOTAL_ROOMS = 1_000
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
  createdAtMs: number
  // The IP that created this room, so its slot in roomCountByIp can be
  // released when the room is cleaned up.
  creatorIp: string
  // reportId -> participant ids that have already sent a diagnostics_response
  // for it. Bounds diagnostics_response to reports the controller actually
  // requested, and to at most one response per participant per report.
  pendingDiagnosticsRequests: Map<string, Set<string>>
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
  const socketRemoteAddresses = new WeakMap<WebSocket, string>()
  const roomCountByIp = new Map<string, number>()

  function releaseRoomIpSlot(ip: string): void {
    const count = roomCountByIp.get(ip)
    if (count === undefined)
      return
    if (count <= 1)
      roomCountByIp.delete(ip)
    else
      roomCountByIp.set(ip, count - 1)
  }

  // MAX_PENDING_CONNECTIONS_PER_IP only bounds how many *concurrently open*
  // unauthenticated sockets one IP can hold; a client that opens and closes
  // sockets quickly to enumerate/brute-force room codes never accumulates
  // pending connections. This tracks upgrade attempts per IP over a rolling
  // window regardless of how briefly each socket stays open. Scoped to this
  // service instance, not module-level, so separate createRoomService()
  // instances (e.g. in tests) never share attempt counts.
  const upgradeAttemptsByIp = new Map<string, { windowStartedAt: number; count: number }>()

  function isUpgradeRateLimited(ip: string): boolean {
    const nowMs = Date.now()
    for (const [key, entry] of upgradeAttemptsByIp) {
      if (nowMs - entry.windowStartedAt > UPGRADE_ATTEMPT_WINDOW_MS)
        upgradeAttemptsByIp.delete(key)
    }
    const entry = upgradeAttemptsByIp.get(ip)
    if (!entry) {
      upgradeAttemptsByIp.set(ip, { windowStartedAt: nowMs, count: 1 })
      return false
    }
    entry.count += 1
    return entry.count > MAX_UPGRADE_ATTEMPTS_PER_IP
  }

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

    const remoteAddress = request.socket.remoteAddress ?? 'unknown'
    if (isUpgradeRateLimited(remoteAddress)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }

    const pendingConnections = [...webSocketServer.clients].filter((candidate) =>
      !clients.has(candidate) && socketRemoteAddresses.get(candidate) === remoteAddress).length
    if (pendingConnections >= MAX_PENDING_CONNECTIONS_PER_IP) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit('connection', webSocket, request)
    })
  })

  webSocketServer.on('connection', (socket, request) => {
    socketRemoteAddresses.set(socket, request.socket.remoteAddress ?? 'unknown')
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
      const stillConnected = [...room.sockets].some((candidate) => {
        const candidateClient = clients.get(candidate)
        return candidateClient?.participantId === client.participantId
      })
      if (stillConnected)
        return
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

      if (rooms.size >= MAX_TOTAL_ROOMS) {
        send(socket, { type: 'error', code: 'rate_limited', message: 'This server is at capacity. Try again shortly.' })
        return
      }

      const remoteAddress = socketRemoteAddresses.get(socket) ?? 'unknown'
      if ((roomCountByIp.get(remoteAddress) ?? 0) >= MAX_ROOMS_PER_IP) {
        send(socket, { type: 'error', code: 'rate_limited', message: 'Too many rooms created from this connection. Close an existing room first.' })
        return
      }

      // The room code is the bearer secret that protects the room (join_room
      // trusts it alone for a brand-new participant), so it must always come
      // from the server's own CSPRNG rather than the client-supplied value --
      // otherwise a direct WebSocket client could mint a low-entropy code.
      const code = createUniqueCode(rooms)
      const coordinator = new RoomCoordinator(
        { roomId: randomUUID(), code },
        { id: message.participantId, name: message.name, media: message.media, sessionToken: randomBytes(16).toString('base64url') },
      )
      const entry: RoomEntry = { coordinator, sockets: new Set([socket]), emptySinceMs: null, createdAtMs: Date.now(), creatorIp: remoteAddress, pendingDiagnosticsRequests: new Map() }
      rooms.set(code, entry)
      roomCountByIp.set(remoteAddress, (roomCountByIp.get(remoteAddress) ?? 0) + 1)
      clients.set(socket, { socket, participantId: message.participantId, roomCode: code })
      const sessionToken = coordinator.exportState().participants.find(item => item.id === message.participantId)?.sessionToken
      send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        sessionToken: sessionToken ?? '',
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

      const existing = entry.coordinator.exportState().participants.find(item => item.id === message.participantId)
      const sessionToken = existing
        ? existing.sessionToken ? message.sessionToken : randomBytes(16).toString('base64url')
        : randomBytes(16).toString('base64url')
      if (!sessionToken) {
        send(socket, { type: 'command_rejected', actionId: null, code: 'session_invalid', message: 'This participant session is no longer valid. Reconnect from the original browser session.', snapshot: entry.coordinator.snapshot() })
        return
      }
      const result = entry.coordinator.join({ id: message.participantId, name: message.name, media: message.media, sessionToken })
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
      for (const priorSocket of entry.sockets) {
        if (priorSocket === socket)
          continue
        if (clients.get(priorSocket)?.participantId === message.participantId)
          priorSocket.close(1000, 'session_replaced')
      }
      send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        sessionToken,
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
      room.pendingDiagnosticsRequests.set(message.reportId, new Set())
      broadcast(room, { type: 'diagnostics_requested', reportId: message.reportId })
      return
    }

    if (message.type === 'diagnostics_response') {
      const respondedParticipantIds = room.pendingDiagnosticsRequests.get(message.reportId)
      if (!respondedParticipantIds || respondedParticipantIds.has(client.participantId))
        return

      const snapshot = room.coordinator.snapshot()
      const participant = snapshot.participants.find(item => item.id === client.participantId)
      const controllerClient = [...clients.values()].find(item => item.roomCode === client.roomCode && item.participantId === snapshot.controller.participantId)
      if (participant && controllerClient) {
        respondedParticipantIds.add(client.participantId)
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

    if (message.type === 'respond_to_join') {
      // The controller's identity comes from the sender's own tracked
      // socket (client.participantId), never from a client-asserted field
      // -- the same pattern transfer_control and open_link already use.
      const result = room.coordinator.respondToJoin(client.participantId, message.leaseEpoch, message.participantId, message.approve)
      if (!result.ok) {
        sendResult(socket, message.actionId, result)
        return
      }

      if (!message.approve) {
        // Tell the denied participant's own socket, and only that socket,
        // then stop tracking it as part of the room -- before broadcasting
        // the updated snapshot to everyone who remains, so the denied
        // client never also receives a snapshot for a room it is being
        // removed from.
        for (const deniedSocket of [...room.sockets]) {
          const deniedClient = clients.get(deniedSocket)
          if (deniedClient?.participantId !== message.participantId)
            continue
          send(deniedSocket, {
            type: 'command_rejected',
            actionId: message.actionId,
            code: 'join_denied',
            message: 'The host declined to let you join this room.',
            snapshot: null,
          })
          room.sockets.delete(deniedSocket)
          clients.delete(deniedSocket)
          deniedSocket.close(1000, 'join_denied')
        }
      }

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
      const health = room.coordinator.evaluateHealth(nowMs)
      if (health?.ok)
        broadcast(room, { type: 'room_snapshot', reason: health.reason, snapshot: health.snapshot })
      if (room.emptySinceMs !== null && nowMs - room.emptySinceMs >= EMPTY_ROOM_TTL_MS) {
        rooms.delete(code)
        releaseRoomIpSlot(room.creatorIp)
      }
      else if (nowMs - room.createdAtMs >= MAX_ROOM_LIFETIME_MS) {
        for (const socket of room.sockets)
          socket.close(1000, 'room_expired')
        rooms.delete(code)
        releaseRoomIpSlot(room.creatorIp)
      }
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
    const code = generateRoomCode()
    if (!rooms.has(code))
      return code
  }
}

function originAllowed(request: IncomingMessage): boolean {
  return isAllowedOrigin(request.headers.origin)
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
