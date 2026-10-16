import type { AddressInfo } from 'node:net'
import type { ClientMessage, MediaFingerprint, ServerMessage } from '@syncyourjoy/protocol'
import type { RoomResult } from '@syncyourjoy/sync-engine'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { generateRoomCode, isAllowedOrigin, parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { isEmptyRoomExpired, reconcileEmptyClock, RoomCoordinator } from '@syncyourjoy/sync-engine'
import { WebSocket, WebSocketServer } from 'ws'

const MAX_MESSAGE_BYTES = 16_384
const CONTROLLER_GRACE_MS = 10_000
// A re-armed recovery (a member returned) waits on a host that has been
// backing off since an outage: the extension's reconnect delay reaches 15 s
// plus up to 250 ms of jitter, so it gets more than that.
const CONTROLLER_REARM_GRACE_MS = 20_000
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
  // Sockets whose join request has not been approved. They stay in `sockets`
  // so their lifetime is tracked, but they are never a broadcast target: an
  // unapproved requester must learn nothing about the room until the
  // controller approves it.
  pending: Set<WebSocket>
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
  /**
   * Read-only view of one room's lifecycle state, or null if there is no such
   * room. For tests that need to observe expiry deterministically instead of
   * sleeping; it exposes no participant data.
   */
  inspectRoom: (code: string) => { connectedParticipants: boolean; pendingRequests: number; sockets: number; emptySinceMs: number | null } | null
}

export interface RoomServiceOptions {
  port?: number
  host?: string
  testControlToken?: string
  /**
   * Clock for room lifetime and empty-room expiry, in milliseconds. Tests
   * supply one so expiry can be exercised without waiting in real time or
   * faking the global Date.
   */
  now?: () => number
  /** How often rooms are checked for deadlines and expiry. Defaults to 100 ms. */
  cleanupIntervalMs?: number
  /**
   * How long a disconnected controller is given to come back before control
   * passes to a connected member, both when it leaves and when a returning
   * member re-arms a recovery that lapsed. Defaults to 10 and 20 seconds;
   * tests shorten it.
   */
  controllerGraceMs?: number
}

export async function createRoomService(options: RoomServiceOptions = {}): Promise<RoomService> {
  const now = options.now ?? (() => Date.now())
  const rooms = new Map<string, RoomEntry>()
  const clients = new Map<WebSocket, ConnectedClient>()
  const recoveryTimers = new Map<string, NodeJS.Timeout>()
  const socketRemoteAddresses = new WeakMap<WebSocket, string>()
  const roomCountByIp = new Map<string, number>()
  const testControlToken = options.testControlToken?.trim() || null

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
    const url = new URL(request.url ?? '/', 'https://syncyourjoy.invalid')

    // This route is intentionally absent unless an in-process test supplies
    // an unpredictable token. It lets the local browser matrix sever one
    // participant's real WebSocket, which browser-context offline emulation
    // cannot reliably do for an MV3 service-worker target. Production and
    // deployed room-service instances never pass testControlToken.
    if (request.method === 'POST' && url.pathname === '/__test/disconnect' && testControlToken !== null) {
      if (request.headers['x-syncyourjoy-test-token'] !== testControlToken) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      }

      const roomCode = url.searchParams.get('room')
      const participantId = url.searchParams.get('participant')
      const room = roomCode ? rooms.get(roomCode) : undefined
      if (!room || !participantId) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'not_found' }))
        return
      }

      let closedSockets = 0
      for (const socket of room.sockets) {
        if (clients.get(socket)?.participantId !== participantId)
          continue
        closedSockets += 1
        socket.close(4002, 'test_disconnect')
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, closedSockets }))
      return
    }

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
    // ws starts the close handshake with the status code that matches the
    // failure (1009 for a frame over maxPayload, 1007 for invalid UTF-8, 1002
    // for a protocol violation) and only then emits 'error'. Without a
    // listener that emit is thrown, which takes down the whole process and
    // every room it holds, on one frame from any client that passes the
    // Origin check. The 'close' handler below does the cleanup.
    socket.on('error', () => {})
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
      // ws already enforces maxPayload on the raw frame, so this only fires
      // when decoding grows the payload: a binary frame of invalid UTF-8
      // becomes three bytes per replacement character.
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
      room.pending.delete(socket)
      const stillConnected = [...room.sockets].some((candidate) => {
        const candidateClient = clients.get(candidate)
        return candidateClient?.participantId === client.participantId
      })
      if (stillConnected)
        return
      // A requester that disappears before the controller decides must not
      // stay approvable: approving it would create a connected member that
      // has no socket. Withdraw the request instead of disconnecting.
      const withdrawn = room.coordinator.cancelPendingJoin(client.participantId)
      if (withdrawn?.ok) {
        broadcast(room, { type: 'room_snapshot', reason: withdrawn.reason, snapshot: withdrawn.snapshot })
        // The empty-room clock starts once, when the last member leaves. A
        // withdrawn request is not a member, so it must not restart the
        // clock: anyone who knows the code could otherwise keep an empty room
        // alive until its lifetime limit by opening and closing requests less
        // than the TTL apart.
        if (room.emptySinceMs === null && !room.coordinator.hasConnectedParticipants())
          room.emptySinceMs = now()
        return
      }
      const result = room.coordinator.disconnect(client.participantId)
      if (result?.ok)
        broadcast(room, { type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })

      const snapshot = room.coordinator.snapshot()
      if (snapshot.controller.participantId === client.participantId)
        scheduleControllerRecovery(room, client.roomCode, client.participantId, options.controllerGraceMs ?? CONTROLLER_GRACE_MS)

      if (room.emptySinceMs === null && !room.coordinator.hasConnectedParticipants())
        room.emptySinceMs = now()
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
        {
          id: message.participantId,
          name: message.name,
          media: message.media,
          sessionToken: randomBytes(16).toString('base64url'),
          ...(message.capabilities ? { capabilities: message.capabilities } : {}),
        },
        // The same clock the cleanup loop and the room entries use, so that
        // deadlines and participant timestamps cannot disagree under an
        // injected clock.
        now,
      )
      const entry: RoomEntry = { coordinator, sockets: new Set([socket]), pending: new Set(), emptySinceMs: null, createdAtMs: now(), creatorIp: remoteAddress, pendingDiagnosticsRequests: new Map() }
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
      // A request that is already pending is bound to the token issued for
      // it: only the client holding that token may re-attach. Everyone else
      // who merely knows the participant id is rejected below (fail closed).
      const sessionToken = existing
        ? existing.sessionToken ? message.sessionToken : randomBytes(16).toString('base64url')
        : entry.coordinator.hasPendingJoin(message.participantId)
          ? entry.coordinator.pendingJoinSessionToken(message.participantId) === message.sessionToken ? message.sessionToken : undefined
          : randomBytes(16).toString('base64url')
      if (!sessionToken) {
        send(socket, { type: 'command_rejected', actionId: null, code: 'session_invalid', message: 'This participant session is no longer valid. Reconnect from the original browser session.', snapshot: null })
        return
      }
      const result = entry.coordinator.join({
        id: message.participantId,
        name: message.name,
        media: message.media,
        sessionToken,
        ...(message.capabilities ? { capabilities: message.capabilities } : {}),
      })
      if (!result.ok) {
        // The sender has not been admitted, so the rejection must not carry
        // the room's state (a full room or a refused token would otherwise
        // hand a stranger the whole snapshot).
        sendResult(socket, null, result, false)
        return
      }

      const timerKey = `${message.code}:${message.participantId}`
      const recoveryTimer = recoveryTimers.get(timerKey)
      if (recoveryTimer) {
        clearTimeout(recoveryTimer)
        recoveryTimers.delete(timerKey)
      }

      const pendingRequest = result.reason === 'join_pending'
      entry.sockets.add(socket)
      if (pendingRequest) {
        entry.pending.add(socket)
      }
      else {
        entry.emptySinceMs = null
        armControllerRecovery(entry, message.code)
      }
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
        // An unapproved requester gets a snapshot that carries nothing about
        // the room, only its own pending entry.
        snapshot: pendingRequest ? entry.coordinator.pendingSnapshot(message.participantId) : result.snapshot,
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

    if (message.type === 'operation_ack') {
      const result = room.coordinator.acknowledgeOperation(client.participantId, message.acknowledgement)
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
        sendResult(socket, message.actionId, result, room.coordinator.hasParticipant(client.participantId))
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
          room.pending.delete(deniedSocket)
          clients.delete(deniedSocket)
          deniedSocket.close(1000, 'join_denied')
        }
      }

      if (message.approve) {
        // The requester is a member now: from here on it receives every
        // broadcast, starting with the snapshot that announces its approval.
        for (const approvedSocket of [...room.pending]) {
          if (clients.get(approvedSocket)?.participantId === message.participantId)
            room.pending.delete(approvedSocket)
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
      sendResult(socket, message.type === 'control' || message.type === 'open_link' ? message.actionId : null, result, room.coordinator.hasParticipant(client.participantId))
      return
    }

    broadcast(room, { type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
  }

  // A socket that is already closing can make close() throw. One failing
  // close must not stop the room from being removed or the other sockets from
  // being told, so every close here is best effort.
  function closeAll(sockets: Iterable<WebSocket>, reason: string): void {
    for (const socket of sockets) {
      try {
        socket.close(1000, reason)
      }
      catch {
        // Already closing or closed; the 'close' handler cleans up either way.
      }
    }
  }

  // Gives a disconnected controller a grace period to come back, then hands
  // control to the longest-connected member. If nobody is connected when the
  // period runs out there is nobody to hand control to and the plan lapses;
  // armControllerRecovery() makes a new one when somebody returns.
  function scheduleControllerRecovery(room: RoomEntry, code: string, controllerId: string, graceMs: number): void {
    const timerKey = `${code}:${controllerId}`
    const priorTimer = recoveryTimers.get(timerKey)
    if (priorTimer)
      clearTimeout(priorTimer)

    recoveryTimers.set(timerKey, setTimeout(() => { // DevSkim: ignore DS172411
      recoveryTimers.delete(timerKey)
      // The room may have been removed since the plan was made.
      if (rooms.get(code) !== room)
        return
      const recovery = room.coordinator.transferDisconnectedController()
      if (recovery?.ok)
        broadcast(room, { type: 'room_snapshot', reason: recovery.reason, snapshot: recovery.snapshot })
    }, graceMs))
  }

  // A room that is removed takes its recovery plans with it.
  function clearRecoveryTimers(code: string): void {
    for (const [key, timer] of recoveryTimers) {
      if (key.startsWith(`${code}:`)) {
        clearTimeout(timer)
        recoveryTimers.delete(key)
      }
    }
  }

  // Controller recovery is derived from membership, like the empty-room
  // clock: while the controller is disconnected and somebody is connected, a
  // recovery must be pending. The plan made when the controller left lapses if
  // its grace period ran out with nobody connected, so one is made again when
  // a member comes back; otherwise a host that is no longer there would keep
  // control of the room for as long as the members stay.
  function armControllerRecovery(room: RoomEntry, code: string): void {
    const snapshot = room.coordinator.snapshot()
    const controller = snapshot.participants.find(participant => participant.id === snapshot.controller.participantId)
    if (!controller || controller.connected || !room.coordinator.hasConnectedParticipants())
      return
    if (recoveryTimers.has(`${code}:${controller.id}`))
      return
    scheduleControllerRecovery(room, code, controller.id, options.controllerGraceMs ?? CONTROLLER_REARM_GRACE_MS)
  }

  const cleanupTimer = setInterval(() => {
    const nowMs = now()
    for (const [code, room] of rooms) {
      // Deadline methods are ordered by the state transition they may cause.
      // Once one expires, the resulting snapshot is authoritative for this
      // timer turn, so do not evaluate or broadcast a second transition from
      // the same room before the next scheduled tick.
      const deadlineResult = room.coordinator.releaseExpiredSeek(nowMs)
        ?? room.coordinator.releaseExpiredOperation(nowMs)
        ?? room.coordinator.evaluateHealth(nowMs)
      if (deadlineResult?.ok)
        broadcast(room, { type: 'room_snapshot', reason: deadlineResult.reason, snapshot: deadlineResult.snapshot })

      // The empty-room clock is derived from membership, so enforce that here
      // instead of trusting every code path to keep it in step: someone is
      // connected -> no clock; nobody is connected -> a clock must be running.
      // A stale clock would otherwise expire a room under active members, and
      // a missing one would keep an empty room alive.
      room.emptySinceMs = reconcileEmptyClock({
        emptySinceMs: room.emptySinceMs,
        hasConnectedParticipants: room.coordinator.hasConnectedParticipants(),
        nowMs,
      })

      if (isEmptyRoomExpired(room.emptySinceMs, nowMs, EMPTY_ROOM_TTL_MS)) {
        // A request still waiting in an empty room no longer holds the room
        // open, so tell it the room is gone. Without this its waiting view
        // stays up for a room that no longer exists.
        closeAll(room.sockets, 'room_expired')
        rooms.delete(code)
        clearRecoveryTimers(code)
        releaseRoomIpSlot(room.creatorIp)
      }
      else if (nowMs - room.createdAtMs >= MAX_ROOM_LIFETIME_MS) {
        closeAll(room.sockets, 'room_expired')
        rooms.delete(code)
        clearRecoveryTimers(code)
        releaseRoomIpSlot(room.creatorIp)
      }
    }
  }, options.cleanupIntervalMs ?? 100)
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
    inspectRoom: (code) => {
      const room = rooms.get(code)
      if (!room)
        return null
      return {
        connectedParticipants: room.coordinator.hasConnectedParticipants(),
        pendingRequests: room.pending.size,
        sockets: room.sockets.size,
        emptySinceMs: room.emptySinceMs,
      }
    },
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
    if (socket !== except && !room.pending.has(socket))
      send(socket, message)
  }
}

function sendResult(socket: WebSocket, actionId: string | null, result: RoomResult, senderIsMember: boolean): void {
  if (result.ok)
    return
  send(socket, {
    type: 'command_rejected',
    actionId,
    code: result.code,
    message: result.message,
    // Only an admitted member may be told the room's state in a rejection.
    snapshot: senderIsMember ? result.snapshot : null,
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
