/// <reference types="@cloudflare/workers-types" />

import type { ClientMessage, ServerMessage } from '@syncyourjoy/protocol'
import type { RoomCoordinatorState, RoomResult } from '@syncyourjoy/sync-engine'
import { DurableObject } from 'cloudflare:workers'
import { parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'

const MAX_MESSAGE_BYTES = 16_384
const CONTROLLER_GRACE_MS = 10_000
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000

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
  private readonly initialized: Promise<void>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<StoredRoom>('room')
      if (stored) {
        this.coordinator = RoomCoordinator.fromState(stored.coordinator)
        this.pendingController = stored.pendingController
        this.emptySinceMs = stored.emptySinceMs
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
          inviteToken: randomToken(),
        },
        { id: message.participantId, name: message.name, media: message.media },
      )
      attachment.participantId = message.participantId
      socket.serializeAttachment(attachment)
      this.emptySinceMs = null
      this.send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        inviteToken: this.coordinator.inviteToken,
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

      const result = this.coordinator.join({ id: message.participantId, name: message.name, media: message.media })
      if (!result.ok) {
        this.sendResult(socket, null, result)
        return
      }

      this.closePriorParticipantSocket(message.participantId, socket)
      attachment.participantId = message.participantId
      socket.serializeAttachment(attachment)
      if (this.pendingController?.participantId === message.participantId)
        this.pendingController = null
      this.emptySinceMs = null
      this.send(socket, {
        type: 'room_joined',
        participantId: message.participantId,
        inviteToken: this.coordinator.inviteToken,
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
    })

    const alarmCandidates: number[] = []
    if (this.pendingController)
      alarmCandidates.push(this.pendingController.recoverAtMs)
    if (this.emptySinceMs !== null)
      alarmCandidates.push(this.emptySinceMs + EMPTY_ROOM_TTL_MS)

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
  const origin = request.headers.get('Origin')
  return origin === null
    || origin.startsWith('chrome-extension://')
    || origin.startsWith('http://127.0.0.1')
    || origin.startsWith('http://localhost')
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
