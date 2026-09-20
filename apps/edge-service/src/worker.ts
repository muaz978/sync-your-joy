/// <reference types="@cloudflare/workers-types" />

import type { ClientMessage, ServerMessage } from '@syncyourjoy/protocol'
import type { RoomCoordinatorState, RoomResult } from '@syncyourjoy/sync-engine'
import { DurableObject } from 'cloudflare:workers'
import { isAllowedOrigin, parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'

const MAX_MESSAGE_BYTES = 16_384
const CONTROLLER_GRACE_MS = 10_000
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000
const MAX_ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
const MAX_PENDING_CONNECTIONS_PER_ROOM = 20
const MAX_UPGRADE_ATTEMPTS_PER_IP = 30
const UPGRADE_ATTEMPT_WINDOW_MS = 60_000

// Scoped to this Worker isolate: MAX_PENDING_CONNECTIONS_PER_ROOM only throttles
// repeated attempts against one already-targeted room (it lives inside a single
// Durable Object). This tracks upgrade attempts per client IP across every room
// code routed through this isolate, so enumerating/brute-forcing room codes or
// mass-creating rooms from one IP is throttled before it ever reaches a Durable
// Object.
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

interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>
}

interface SocketAttachment {
  participantId: string | null
  roomCode: string
  messageWindowStartedAt: number
  messageCount: number
}

interface StoredRoom {
  coordinator: RoomCoordinatorState
  pendingController: {
    participantId: string
    recoverAtMs: number
  } | null
  emptySinceMs: number | null
  createdAtMs: number
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'sync-your-joy-rooms',
        region: request.cf?.colo ?? 'unknown',
      })
    }

    if (url.pathname === '/') {
      return Response.json({
        name: 'SyncYourJoy room service',
        status: 'ready',
        mediaTransport: false,
      })
    }

    if (url.pathname !== '/rooms' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return Response.json({ error: 'not_found' }, { status: 404 })

    // Reject a disallowed origin here, before routing to the Durable Object:
    // env.ROOMS.get(id).fetch() wakes/instantiates that DO (including a
    // storage read on cold start), so checking origin only inside the DO's
    // own fetch() still pays that cost for traffic we are about to reject.
    if (!originAllowed(request))
      return new Response('Forbidden', { status: 403 })

    const clientIp = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    if (isUpgradeRateLimited(clientIp))
      return Response.json({ error: 'rate_limited' }, { status: 429 })

    const code = url.searchParams.get('code')?.toUpperCase()
    if (!code || !/^[A-Z0-9]{8}$/.test(code))
      return Response.json({ error: 'invalid_room_code' }, { status: 400 })

    const id = env.ROOMS.idFromName(code)
    return env.ROOMS.get(id).fetch(request)
  },
} satisfies ExportedHandler<Env>

export class RoomDurableObject extends DurableObject<Env> {
  private coordinator: RoomCoordinator | null = null
  private pendingController: StoredRoom['pendingController'] = null
  private emptySinceMs: number | null = null
  private createdAtMs = Date.now()
  // reportId -> participant ids that have already sent a diagnostics_response
  // for it. Bounds diagnostics_response to reports the controller actually
  // requested, and to at most one response per participant per report. Not
  // persisted: a cold start simply forgets any in-flight diagnostics round.
  private pendingDiagnosticsRequests = new Map<string, Set<string>>()
  private readonly initialized: Promise<void>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<StoredRoom>('room')
      if (stored) {
        this.coordinator = RoomCoordinator.fromState(stored.coordinator)
        this.pendingController = stored.pendingController
        this.emptySinceMs = stored.emptySinceMs
        this.createdAtMs = stored.createdAtMs ?? Date.now()
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialized
    if (!originAllowed(request))
      return new Response('Forbidden', { status: 403 })

    const roomCode = new URL(request.url).searchParams.get('code')?.toUpperCase()
    if (!roomCode || !/^[A-Z0-9]{8}$/.test(roomCode))
      return new Response('Invalid room code', { status: 400 })

    const pendingConnections = this.ctx.getWebSockets().filter((candidate) => {
      const attachment = candidate.deserializeAttachment() as SocketAttachment | null
      return attachment?.participantId === null
    }).length
    if (pendingConnections >= MAX_PENDING_CONNECTIONS_PER_ROOM)
      return new Response('Too many pending room connections', { status: 429 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({
      participantId: null,
      roomCode,
      messageWindowStartedAt: Date.now(),
      messageCount: 0,
    } satisfies SocketAttachment)

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    await this.initialized
    const attachment = socket.deserializeAttachment() as SocketAttachment
    const nowMs = Date.now()
    if (nowMs - attachment.messageWindowStartedAt > 10_000) {
      attachment.messageWindowStartedAt = nowMs
      attachment.messageCount = 0
    }
    attachment.messageCount += 1
    socket.serializeAttachment(attachment)

    if (attachment.messageCount > 120) {
      this.send(socket, { type: 'error', code: 'rate_limited', message: 'Too many room messages. Reconnecting may help.' })
      socket.close(1008, 'rate_limited')
      return
    }

    const text = typeof rawMessage === 'string' ? rawMessage : new TextDecoder().decode(rawMessage)
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'message_too_large')
      return
    }

    const message = parseClientMessage(safeJsonParse(text))
    if (!message) {
      this.send(socket, { type: 'error', code: 'invalid_message', message: 'The room message was not valid.' })
      return
    }

    await this.handleMessage(socket, attachment, message)
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.initialized
    const attachment = socket.deserializeAttachment() as SocketAttachment | null
    if (!attachment?.participantId || !this.coordinator)
      return

    const stillConnected = this.ctx.getWebSockets().some((candidate) => {
      if (candidate === socket)
        return false
      const candidateAttachment = candidate.deserializeAttachment() as SocketAttachment | null
      return candidateAttachment?.participantId === attachment.participantId
    })
    if (stillConnected)
      return

    const result = this.coordinator.disconnect(attachment.participantId)
    if (!result?.ok)
      return
    this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })

    if (this.coordinator.snapshot().controller.participantId === attachment.participantId) {
      this.pendingController = {
        participantId: attachment.participantId,
        recoverAtMs: Date.now() + CONTROLLER_GRACE_MS,
      }
    }
    if (!this.coordinator.hasConnectedParticipants())
      this.emptySinceMs = Date.now()

    await this.persistAndSchedule()
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket)
  }

  async alarm(): Promise<void> {
    await this.initialized
    if (!this.coordinator)
      return

    const nowMs = Date.now()
    const expiredSeek = this.coordinator.releaseExpiredSeek(nowMs)
    if (expiredSeek?.ok)
      this.broadcast({ type: 'room_snapshot', reason: expiredSeek.reason, snapshot: expiredSeek.snapshot })
    const expiredOperation = this.coordinator.releaseExpiredOperation(nowMs)
    if (expiredOperation?.ok)
      this.broadcast({ type: 'room_snapshot', reason: expiredOperation.reason, snapshot: expiredOperation.snapshot })
    const health = this.coordinator.evaluateHealth(nowMs)
    if (health?.ok)
      this.broadcast({ type: 'room_snapshot', reason: health.reason, snapshot: health.snapshot })
    if (this.pendingController && nowMs >= this.pendingController.recoverAtMs) {
      const controller = this.coordinator.snapshot().participants.find(
        participant => participant.id === this.pendingController?.participantId,
      )
      if (!controller?.connected) {
        const recovery = this.coordinator.transferDisconnectedController()
        if (recovery?.ok)
          this.broadcast({ type: 'room_snapshot', reason: recovery.reason, snapshot: recovery.snapshot })
      }
      this.pendingController = null
    }

    if (nowMs - this.createdAtMs >= MAX_ROOM_LIFETIME_MS) {
      for (const socket of this.ctx.getWebSockets())
        socket.close(1000, 'room_expired')
      await this.ctx.storage.deleteAll()
      this.coordinator = null
      this.pendingController = null
      this.emptySinceMs = null
      return
    }

    if (this.emptySinceMs !== null && nowMs - this.emptySinceMs >= EMPTY_ROOM_TTL_MS) {
      await this.ctx.storage.deleteAll()
      this.coordinator = null
      this.emptySinceMs = null
      return
    }

    await this.persistAndSchedule()
  }

  private async handleMessage(socket: WebSocket, attachment: SocketAttachment, message: ClientMessage): Promise<void> {
    if (message.type === 'create_room') {
      if (attachment.participantId) {
        this.send(socket, { type: 'error', code: 'already_joined', message: 'You are already connected to a room.' })
        return
      }
      if (message.code !== attachment.roomCode) {
        this.send(socket, { type: 'error', code: 'room_code_mismatch', message: 'The requested room code did not match.' })
        return
      }
      if (this.coordinator) {
        this.send(socket, { type: 'error', code: 'room_exists', message: 'That room code is already active. Try again.' })
        return
      }

      this.coordinator = new RoomCoordinator(
        {
          roomId: crypto.randomUUID(),
          code: message.code,
        },
        {
          id: message.participantId,
          name: message.name,
          media: message.media,
          sessionToken: randomToken(),
          ...(message.capabilities ? { capabilities: message.capabilities } : {}),
        },
      )
      this.createdAtMs = Date.now()
      const sessionToken = this.coordinator.exportState().participants.find(item => item.id === message.participantId)?.sessionToken
      attachment.participantId = message.participantId
      socket.serializeAttachment(attachment)
      this.emptySinceMs = null
      this.send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        sessionToken: sessionToken ?? '',
        snapshot: this.coordinator.snapshot(),
      })
      await this.persistAndSchedule()
      return
    }

    if (message.type === 'join_room') {
      if (attachment.participantId) {
        this.send(socket, { type: 'error', code: 'already_joined', message: 'You are already connected to a room.' })
        return
      }
      if (!this.coordinator || message.code !== attachment.roomCode) {
        this.send(socket, { type: 'error', code: 'room_not_found', message: 'That room code is invalid or has expired.' })
        return
      }

      const existing = this.coordinator.exportState().participants.find(item => item.id === message.participantId)
      const sessionToken = existing
        ? existing.sessionToken ? message.sessionToken : randomToken()
        : randomToken()
      if (!sessionToken) {
        this.send(socket, { type: 'command_rejected', actionId: null, code: 'session_invalid', message: 'This participant session is no longer valid. Reconnect from the original browser session.', snapshot: this.coordinator.snapshot() })
        return
      }
      const result = this.coordinator.join({
        id: message.participantId,
        name: message.name,
        media: message.media,
        sessionToken,
        ...(message.capabilities ? { capabilities: message.capabilities } : {}),
      })
      if (!result.ok) {
        this.sendResult(socket, null, result)
        return
      }

      attachment.participantId = message.participantId
      socket.serializeAttachment(attachment)
      this.closePriorParticipantSocket(message.participantId, socket)
      if (this.pendingController?.participantId === message.participantId)
        this.pendingController = null
      this.emptySinceMs = null
      this.send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        sessionToken,
        snapshot: result.snapshot,
      })
      this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot }, socket)
      await this.persistAndSchedule()
      return
    }

    if (message.type === 'ping') {
      this.send(socket, {
        type: 'pong',
        id: message.id,
        sentAtLocalMs: message.sentAtLocalMs,
        serverTimeMs: Date.now(),
      })
      return
    }

    if (!attachment.participantId || !this.coordinator) {
      this.send(socket, { type: 'error', code: 'not_joined', message: 'Create or join a room first.' })
      return
    }

    if (message.type === 'request_diagnostics') {
      if (attachment.participantId !== this.coordinator.snapshot().controller.participantId) {
        this.send(socket, { type: 'error', code: 'controller_only', message: 'Only the room controller can request detailed reports.' })
        return
      }
      this.pendingDiagnosticsRequests.set(message.reportId, new Set())
      this.broadcast({ type: 'diagnostics_requested', reportId: message.reportId })
      return
    }

    if (message.type === 'diagnostics_response') {
      const respondedParticipantIds = this.pendingDiagnosticsRequests.get(message.reportId)
      if (!respondedParticipantIds || respondedParticipantIds.has(attachment.participantId))
        return

      const snapshot = this.coordinator.snapshot()
      const participant = snapshot.participants.find(item => item.id === attachment.participantId)
      if (!participant)
        return
      respondedParticipantIds.add(attachment.participantId)
      this.sendToParticipant(snapshot.controller.participantId, {
        type: 'diagnostics_response',
        reportId: message.reportId,
        participantId: attachment.participantId,
        participantName: participant.name,
        report: message.report,
      })
      return
    }

    if (message.type === 'client_metrics') {
      this.coordinator.recordLatency(attachment.participantId, message.roundTripMs)
      await this.persistAndSchedule()
      return
    }

    if (message.type === 'player_status') {
      const result = this.coordinator.updatePlayerStatus(attachment.participantId, message.basedOnRevision, message.sample)
      if (result?.ok) {
        this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
        await this.persistAndSchedule()
      }
      return
    }

    if (message.type === 'seek_applied') {
      const result = this.coordinator.acknowledgeSeek(attachment.participantId, message.revision, message.positionSeconds)
      if (result?.ok) {
        this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
        await this.persistAndSchedule()
      }
      return
    }

    if (message.type === 'operation_ack') {
      const result = this.coordinator.acknowledgeOperation(attachment.participantId, message.acknowledgement)
      if (result?.ok) {
        this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
        await this.persistAndSchedule()
      }
      return
    }

    if (message.type === 'respond_to_join') {
      // The controller's identity comes from the sender's own tracked
      // socket attachment (attachment.participantId), never from a
      // client-asserted field -- the same pattern transfer_control and
      // open_link already use.
      const result = this.coordinator.respondToJoin(attachment.participantId, message.leaseEpoch, message.participantId, message.approve)
      if (!result.ok) {
        this.sendResult(socket, message.actionId, result)
        return
      }

      if (!message.approve) {
        // Tell the denied participant's own socket, and only that socket,
        // then stop tracking it as part of the room -- before broadcasting
        // the updated snapshot to everyone who remains, so the denied
        // client never also receives a snapshot for a room it is being
        // removed from.
        for (const deniedSocket of this.ctx.getWebSockets()) {
          const deniedAttachment = deniedSocket.deserializeAttachment() as SocketAttachment | null
          if (deniedAttachment?.participantId !== message.participantId)
            continue
          this.send(deniedSocket, {
            type: 'command_rejected',
            actionId: message.actionId,
            code: 'join_denied',
            message: 'The host declined to let you join this room.',
            snapshot: null,
          })
          deniedSocket.close(1000, 'join_denied')
        }
      }

      this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
      await this.persistAndSchedule()
      return
    }

    const result = message.type === 'set_ready'
      ? this.coordinator.setReady(attachment.participantId, message.ready, message.media)
      : message.type === 'transfer_control'
        ? this.coordinator.transferControl(attachment.participantId, message.participantId, message.leaseEpoch)
        : message.type === 'open_link'
          ? this.coordinator.openLink(attachment.participantId, message)
          : this.coordinator.control(attachment.participantId, message)

    if (!result.ok) {
      this.sendResult(socket, message.type === 'control' || message.type === 'open_link' ? message.actionId : null, result)
      return
    }

    this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
    await this.persistAndSchedule()
  }

  private async persistAndSchedule(): Promise<void> {
    if (!this.coordinator)
      return

    await this.ctx.storage.put<StoredRoom>('room', {
      coordinator: this.coordinator.exportState(),
      pendingController: this.pendingController,
      emptySinceMs: this.emptySinceMs,
      createdAtMs: this.createdAtMs,
    })

    const alarmCandidates: number[] = []
    if (this.pendingController)
      alarmCandidates.push(this.pendingController.recoverAtMs)
    if (this.emptySinceMs !== null)
      alarmCandidates.push(this.emptySinceMs + EMPTY_ROOM_TTL_MS)
    const seekDeadlineMs = this.coordinator.pendingSeekDeadlineMs()
    if (seekDeadlineMs !== null)
      alarmCandidates.push(seekDeadlineMs)
    const operationDeadlineMs = this.coordinator.operationDeadlineMs()
    if (operationDeadlineMs !== null)
      alarmCandidates.push(operationDeadlineMs)
    const healthDeadlineMs = this.coordinator.nextHealthDeadlineMs()
    if (healthDeadlineMs !== null)
      alarmCandidates.push(healthDeadlineMs)

    if (alarmCandidates.length > 0)
      await this.ctx.storage.setAlarm(Math.min(...alarmCandidates))
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    }
    catch {
      // The peer disconnected between snapshot creation and broadcast.
    }
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except)
        this.send(socket, message)
    }
  }

  private sendToParticipant(participantId: string, message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null
      if (attachment?.participantId === participantId) {
        this.send(socket, message)
        return
      }
    }
  }

  private sendResult(socket: WebSocket, actionId: string | null, result: RoomResult): void {
    if (result.ok)
      return
    this.send(socket, {
      type: 'command_rejected',
      actionId,
      code: result.code,
      message: result.message,
      snapshot: result.snapshot,
    })
  }

  private closePriorParticipantSocket(participantId: string, current: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === current)
        continue
      const attachment = socket.deserializeAttachment() as SocketAttachment | null
      if (attachment?.participantId === participantId)
        socket.close(1000, 'session_replaced')
    }
  }
}

function originAllowed(request: Request): boolean {
  return isAllowedOrigin(request.headers.get('Origin'))
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
