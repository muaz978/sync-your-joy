/// <reference types="@cloudflare/workers-types" />

import type { ClientMessage, ServerMessage } from '@syncyourjoy/protocol'
import type { RoomCoordinatorState, RoomResult } from '@syncyourjoy/sync-engine'
import { DurableObject } from 'cloudflare:workers'
import { isAllowedOrigin, parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { isEmptyRoomExpired, reconcileEmptyClock, RoomCoordinator } from '@syncyourjoy/sync-engine'
import { applyEarliestDueDeadline, persistRoomAndSchedule, persistThenObserve } from './alarm.ts'

const MAX_MESSAGE_BYTES = 16_384
const CONTROLLER_GRACE_MS = 10_000
// A re-armed recovery (a member returned, or the room was restored) waits on a
// host that has been backing off since an outage: the extension's reconnect
// delay reaches 15 s plus up to 250 ms of jitter, so it gets more than that.
// The extension also registers that reconnect as a chrome.alarms alarm for a
// service worker that was suspended (scheduleReconnect in
// apps/extension/src/service-worker.ts), and Chrome limits an installed
// extension's alarms to one every 30 s (an unpacked one is exempt). A host
// whose service worker was suspended can therefore still come back after this
// period and find control moved. That is accepted, and the value stays: it is
// still a member and can be given control back.
const CONTROLLER_REARM_GRACE_MS = 20_000
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000
const MAX_ROOM_LIFETIME_MS = 6 * 60 * 60 * 1000
// A restore whose save failed is tried again on a later frame, at most this
// often, so a storage outage costs one write attempt per interval and not one
// per frame from every connected client.
const RESTORE_SAVE_RETRY_MS = 5_000
// A repair that could not be told to every member (an attachment that could not
// be read) is offered again on later frames, this many times in all.
const MAX_REPAIR_ANNOUNCEMENTS = 3
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
  // What restoring derived and has not finished: `alarmPending` until the save
  // (the alarm included) has gone through, and `reason`, the repair that is told
  // to the members once the room is durable, until every member that can be
  // read has been told. Null when there is nothing outstanding.
  private unsavedRestore: { reason: string | null, alarmPending: boolean, announcements: number, nextAttemptAtMs: number } | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<StoredRoom>('room')
      if (stored) {
        this.coordinator = RoomCoordinator.fromState(stored.coordinator)
        this.pendingController = stored.pendingController
        this.emptySinceMs = stored.emptySinceMs
        this.createdAtMs = stored.createdAtMs ?? Date.now()

        // Reconciling and saving the result are repairs, never preconditions:
        // if either throws, this constructor would throw with it, the object
        // would be reset and every later request for the room would fail the
        // same way. Serving the restored state as it is (what this code did
        // before it existed) is better than a room that can no longer be
        // reached.
        // What was repaired is recorded as it happens, so a step that throws
        // afterwards cannot leave a repair that is saved and never announced.
        const repair: { reason: string | null } = { reason: null }
        try {
          this.healRestoredState(repair)
        }
        catch (error) {
          console.error('Restoring room state could not be reconciled with its sockets.', error instanceof Error ? error.name : 'unknown error')
        }
        // Every restore re-derives the alarm, not only one that repaired
        // something: the alarm that is set belongs to whichever code last wrote
        // the room and can lack a deadline this code has (the lifetime limit)
        // or sit after it, and a client that sends nothing that writes would
        // never make this object write again. The price is one write per wake;
        // trusting getAlarm() would save it and keep a stale alarm.
        //
        // A member that kept its socket across the restart still holds the
        // picture from before it: it would keep showing a participant as
        // connected, or a request as waiting, until some unrelated message. The
        // repair is told as soon as the room is durable (see
        // announceWithheldRepair), and not before: a repair that was not saved
        // is not announced as if it were.
        this.unsavedRestore = {
          reason: repair.reason,
          alarmPending: true,
          announcements: 0,
          nextAttemptAtMs: Date.now() + RESTORE_SAVE_RETRY_MS,
        }
        try {
          await this.persistAndSchedule()
        }
        catch (error) {
          // What is outstanding stays in unsavedRestore: the next frame from a
          // client tries it again (retryUnsavedRestore), and so does any later
          // write or alarm.
          console.error('Restoring room state could not be saved.', error instanceof Error ? error.name : 'unknown error')
        }
      }
    })
  }

  /**
   * Brings stored state back in line with the sockets that are actually
   * attached after this object was rebuilt (a restart, an eviction, a code
   * update). A socket closing normally withdraws its pending request and marks
   * its member disconnected; if the previous instance went away before that
   * happened, or never delivered the close, the stored state still describes
   * connections that no longer exist: a request that can be approved into a
   * member with no connection, a member shown as connected forever, an empty
   * room whose expiry clock was never started, and a controller that is gone
   * with nothing planned to replace it.
   *
   * Hibernating sockets stay attached across a restart with their attachment,
   * so a participant that still has a socket is never touched. The reason to
   * tell the members that are still attached when the room's membership
   * changed (a request withdrawn or a member marked disconnected) is recorded
   * in `repair` as it is made, so a step that throws afterwards does not lose
   * it; it stays null when nothing changed.
   */
  private healRestoredState(repair: { reason: string | null }): void {
    const coordinator = this.coordinator
    if (!coordinator)
      return

    this.dropLapsedControllerPlan(Date.now(), false)
    const attached = this.attachedParticipantIds()

    // A plan that is stored for a participant that has its socket is stale:
    // it was made when the host left, and the join that followed was not saved.
    // alarm() reads the stored connected flag, so it would carry the plan out
    // against a host that is there.
    if (this.pendingController && attached.has(this.pendingController.participantId))
      this.pendingController = null

    const snapshot = coordinator.snapshot()
    for (const request of snapshot.pendingJoinRequests) {
      if (attached.has(request.id))
        continue
      const withdrawn = coordinator.cancelPendingJoin(request.id)
      if (withdrawn?.ok)
        repair.reason = withdrawn.reason
    }
    for (const participant of snapshot.participants) {
      if (!participant.connected || attached.has(participant.id))
        continue
      const disconnected = coordinator.disconnect(participant.id)
      if (disconnected?.ok) {
        repair.reason = disconnected.reason
        if (coordinator.snapshot().controller.participantId === participant.id) {
          this.pendingController = {
            participantId: participant.id,
            recoverAtMs: Date.now() + CONTROLLER_GRACE_MS,
          }
        }
      }
    }
    // Derived like the empty-room clock below: a room last written with its
    // controller gone, a member attached and no recovery pending (a lapsed
    // plan, saved by code that did not re-arm it) would otherwise leave the
    // absent controller in control until a member joined.
    this.dropLapsedControllerPlan(Date.now(), !coordinator.hasConnectedParticipants())
    this.armControllerRecovery(attached)

    const clock = reconcileEmptyClock({
      emptySinceMs: this.emptySinceMs,
      hasConnectedParticipants: coordinator.hasConnectedParticipants(),
      nowMs: Date.now(),
    })
    this.emptySinceMs = clock
  }

  /**
   * Controller recovery is derived from membership, like the empty-room
   * clock: while the controller is disconnected and somebody is connected, a
   * recovery must be pending. The plan made when the controller left is
   * dropped by the alarm if its grace period ran out with nobody connected, so
   * one is made again when a member comes back, and when a room is restored;
   * otherwise a host that is no longer there would keep control of the room
   * for as long as the members stay.
   */
  /**
   * A recovery plan whose time ran out while nobody was connected has lapsed,
   * which is how alarm() treats it when it is delivered on time: there was
   * nobody to hand control to. When the alarm is late and a member comes back
   * first, the plan must not survive to hand control away the moment the alarm
   * runs, with the host given no window at all: the room was empty from before
   * the deadline until now, so it is dropped and a new one is made for the
   * member that returned.
   */
  private dropLapsedControllerPlan(nowMs: number, roomEmptyNow: boolean): void {
    const plan = this.pendingController
    if (!plan || nowMs < plan.recoverAtMs)
      return
    // Empty from before the deadline (the clock says so), or found empty when
    // restoring after it: a close that was never delivered leaves no clock to
    // say when the room emptied, but nobody is there now to hand control to.
    if (roomEmptyNow || (this.emptySinceMs !== null && this.emptySinceMs <= plan.recoverAtMs))
      this.pendingController = null
  }

  private armControllerRecovery(attachedNow?: Set<string>): void {
    const coordinator = this.coordinator
    if (!coordinator || this.pendingController)
      return

    const snapshot = coordinator.snapshot()
    const controller = snapshot.participants.find(participant => participant.id === snapshot.controller.participantId)
    if (!controller || controller.connected || !coordinator.hasConnectedParticipants())
      return
    // A controller that still has its socket is not gone, whatever the stored
    // flag says (a join whose write was lost): handing its control away would
    // take it from a host that is there. Asked on every call, so a member that
    // returns is held to it as well as a restore.
    if ((attachedNow ?? this.attachedParticipantIds()).has(controller.id))
      return

    this.pendingController = {
      participantId: controller.id,
      recoverAtMs: Date.now() + CONTROLLER_REARM_GRACE_MS,
    }
  }

  private attachedParticipantIds(): Set<string> {
    const attached = new Set<string>()
    for (const socket of this.ctx.getWebSockets()) {
      let attachment: SocketAttachment | null
      try {
        attachment = socket.deserializeAttachment() as SocketAttachment | null
      }
      catch {
        // A socket whose attachment cannot be read cannot be served (every
        // frame would fail the same way), so it does not count as attached:
        // counting it, or throwing, would keep a controller that cannot act
        // in control, or keep recovery from being derived, for as long as it
        // stays open.
        continue
      }
      if (attachment?.participantId)
        attached.add(attachment.participantId)
    }
    return attached
  }

  /**
   * Closes sockets best effort. close() can throw for a socket that is
   * already closing; one failure must not abort an expiry before the room's
   * storage is deleted or leave the remaining sockets unnotified.
   */
  private closeSockets(reason: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1000, reason)
      }
      catch {
        // Already closing or closed; webSocketClose handles the cleanup.
      }
    }
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

  /**
   * Restoring that could not finish leaves the room without the alarm that
   * carries its lifetime limit and controller recovery, and with a repair the
   * members were not told. A client that sends nothing that writes (the
   * extension's own `client_metrics` does, after each pong; other clients need
   * not) would never make this object save again, so a frame from any client
   * finishes what is outstanding once the previous attempt is
   * RESTORE_SAVE_RETRY_MS old: the save if it has not gone through, otherwise
   * the announcement to the members that could not be reached.
   *
   * This runs after the frame has been handled and can never fail it: it is a
   * repair, like the restore itself, and the next frame tries again.
   */
  private async retryUnsavedRestore(): Promise<void> {
    const pending = this.unsavedRestore
    if (!pending || !this.coordinator)
      return
    const nowMs = Date.now()
    // A clock that has stepped back must not hold the retry until it catches up.
    if (nowMs < pending.nextAttemptAtMs && pending.nextAttemptAtMs - nowMs <= RESTORE_SAVE_RETRY_MS)
      return
    // Claimed before the attempt, so frames that overlap it do not each make
    // one and a failed attempt waits the whole interval.
    pending.nextAttemptAtMs = nowMs + RESTORE_SAVE_RETRY_MS
    if (!pending.alarmPending) {
      this.announceWithheldRepair(true)
      this.finishRestoreIfSettled()
      return
    }
    try {
      await this.persistAndSchedule()
    }
    catch (error) {
      console.error('Restoring room state could not be saved.', error instanceof Error ? error.name : 'unknown error')
    }
  }

  /**
   * Tells the attached members the repair that restoring withheld. Called once
   * the room is durable: right after the write, whether or not the alarm could
   * be set after it, because a restart before a retry would otherwise find the
   * repaired state and nothing left to announce. A repair that could not reach a
   * member whose attachment could not be read is kept and offered again, up to
   * MAX_REPAIR_ANNOUNCEMENTS times.
   */
  private announceWithheldRepair(force = false): void {
    const pending = this.unsavedRestore
    if (!pending?.reason || !this.coordinator)
      return
    // After an attempt that could not reach everyone, the next one waits the
    // same interval as a save retry, so saves that come in quick succession do
    // not use up the attempts while the member is still unreadable.
    const nowMs = Date.now()
    if (!force && pending.announcements > 0 && nowMs < pending.nextAttemptAtMs && pending.nextAttemptAtMs - nowMs <= RESTORE_SAVE_RETRY_MS)
      return
    pending.announcements += 1
    pending.nextAttemptAtMs = nowMs + RESTORE_SAVE_RETRY_MS
    let complete = false
    try {
      complete = this.broadcast({ type: 'room_snapshot', reason: pending.reason, snapshot: this.coordinator.snapshot() })
    }
    catch {
      complete = false
    }
    if (complete || pending.announcements >= MAX_REPAIR_ANNOUNCEMENTS)
      pending.reason = null
  }

  /** Clears what restoring had outstanding once nothing of it is left. */
  private finishRestoreIfSettled(): void {
    const pending = this.unsavedRestore
    if (pending && !pending.alarmPending && pending.reason === null)
      this.unsavedRestore = null
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    await this.initialized
    try {
      await this.handleFrame(socket, rawMessage)
    }
    finally {
      await this.retryUnsavedRestore()
    }
  }

  private async handleFrame(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
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

    // A requester that disappears before the controller decides must not
    // stay approvable: approving it would create a connected member that
    // has no socket. Withdraw the request instead of disconnecting.
    const withdrawn = this.coordinator.cancelPendingJoin(attachment.participantId)
    if (withdrawn?.ok) {
      // The empty-room clock starts once, when the last member leaves. A
      // withdrawn request is not a member, so it must not restart the clock:
      // anyone who knows the code could otherwise keep an empty room (and its
      // storage and alarm) alive until its lifetime limit by opening and
      // closing requests less than the TTL apart.
      if (this.emptySinceMs === null && !this.coordinator.hasConnectedParticipants())
        this.emptySinceMs = Date.now()
      await this.persistAndObserve(() => {
        this.broadcast({ type: 'room_snapshot', reason: withdrawn.reason, snapshot: withdrawn.snapshot })
      })
      return
    }

    const result = this.coordinator.disconnect(attachment.participantId)
    if (!result?.ok) {
      // A controller already stored as disconnected (a join whose write was
      // lost across a restart) has nothing left to disconnect, but its socket
      // going away still leaves a room that nobody is acting for. The local
      // service plans the recovery on every close of the controller, so do
      // the same here.
      const gone = this.coordinator.snapshot().controller.participantId === attachment.participantId
      if (gone && !this.pendingController && this.coordinator.hasConnectedParticipants()) {
        this.pendingController = {
          participantId: attachment.participantId,
          recoverAtMs: Date.now() + CONTROLLER_GRACE_MS,
        }
        await this.persistAndSchedule()
      }
      return
    }

    if (this.coordinator.snapshot().controller.participantId === attachment.participantId) {
      this.pendingController = {
        participantId: attachment.participantId,
        recoverAtMs: Date.now() + CONTROLLER_GRACE_MS,
      }
    }
    if (this.emptySinceMs === null && !this.coordinator.hasConnectedParticipants())
      this.emptySinceMs = Date.now()

    await this.persistAndObserve(() => {
      this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
    })
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket)
  }

  async alarm(): Promise<void> {
    await this.initialized
    if (!this.coordinator)
      return

    const nowMs = Date.now()
    if (nowMs - this.createdAtMs >= MAX_ROOM_LIFETIME_MS) {
      this.closeSockets('room_expired')
      await this.ctx.storage.deleteAll()
      this.coordinator = null
      this.pendingController = null
      this.emptySinceMs = null
      this.unsavedRestore = null
      return
    }

    // The empty-room clock is derived from membership, so enforce that here
    // instead of trusting every code path to keep it in step: someone is
    // connected -> no clock; nobody is connected -> a clock must be running. A
    // stale clock would otherwise expire a room under active members, and a
    // missing one would keep an empty room alive.
    this.emptySinceMs = reconcileEmptyClock({
      emptySinceMs: this.emptySinceMs,
      hasConnectedParticipants: this.coordinator.hasConnectedParticipants(),
      nowMs,
    })

    if (isEmptyRoomExpired(this.emptySinceMs, nowMs, EMPTY_ROOM_TTL_MS)) {
      // A request still waiting in an empty room no longer holds the room
      // open, so tell it the room is gone, as the lifetime branch above does.
      // Without this its waiting view stays up for a room that no longer
      // exists.
      this.closeSockets('room_expired')
      await this.ctx.storage.deleteAll()
      this.coordinator = null
      this.pendingController = null
      this.emptySinceMs = null
      this.unsavedRestore = null
      return
    }

    const broadcasts: Array<{ type: 'room_snapshot'; reason: string; snapshot: ReturnType<RoomCoordinator['snapshot']> }> = []
    const deadline = applyEarliestDueDeadline(this.coordinator, nowMs)
    if (deadline?.result.ok)
      broadcasts.push({ type: 'room_snapshot', reason: deadline.result.reason, snapshot: deadline.result.snapshot })
    else if (this.pendingController && nowMs >= this.pendingController.recoverAtMs) {
      const controller = this.coordinator.snapshot().participants.find(
        participant => participant.id === this.pendingController?.participantId,
      )
      if (!controller?.connected) {
        const recovery = this.coordinator.transferDisconnectedController()
        if (recovery?.ok)
          broadcasts.push({ type: 'room_snapshot', reason: recovery.reason, snapshot: recovery.snapshot })
      }
      this.pendingController = null
    }

    await this.persistAndSchedule()
    for (const message of broadcasts)
      this.broadcast(message)
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
      const snapshot = this.coordinator.snapshot()
      await this.persistAndObserve(() => {
        this.send(socket, {
          type: 'room_joined',
          participantId: message.participantId,
          sessionToken: sessionToken ?? '',
          snapshot,
        })
      })
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
      // A request that is already pending is bound to the token issued for
      // it: only the client holding that token may re-attach. Everyone else
      // who merely knows the participant id is rejected below (fail closed).
      const sessionToken = existing
        ? existing.sessionToken ? message.sessionToken : randomToken()
        : this.coordinator.hasPendingJoin(message.participantId)
          ? this.coordinator.pendingJoinSessionToken(message.participantId) === message.sessionToken ? message.sessionToken : undefined
          : randomToken()
      if (!sessionToken) {
        this.send(socket, { type: 'command_rejected', actionId: null, code: 'session_invalid', message: 'This participant session is no longer valid. Reconnect from the original browser session.', snapshot: null })
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
        // The sender has not been admitted, so the rejection must not carry
        // the room's state (a full room or a refused token would otherwise
        // hand a stranger the whole snapshot).
        this.sendResult(socket, null, result, false)
        return
      }

      attachment.participantId = message.participantId
      socket.serializeAttachment(attachment)
      this.closePriorParticipantSocket(message.participantId, socket)
      if (this.pendingController?.participantId === message.participantId)
        this.pendingController = null
      // A pending request is not a member, so it must not cancel the
      // empty-room expiry: otherwise one unapproved request keeps an
      // otherwise empty room alive.
      const pendingRequest = result.reason === 'join_pending'
      if (!pendingRequest) {
        this.dropLapsedControllerPlan(Date.now(), false)
        this.emptySinceMs = null
        try {
          this.armControllerRecovery()
        }
        catch (error) {
          // Derived like the empty-room clock, so it is made again at the next
          // join or restore; a socket that cannot be read must not stop this
          // member from being admitted.
          console.error('Controller recovery could not be derived for a join.', error instanceof Error ? error.name : 'unknown error')
        }
      }
      await this.persistAndObserve(() => {
        this.send(socket, {
          type: 'room_joined',
          participantId: message.participantId,
          sessionToken,
          // An unapproved requester gets a snapshot that carries nothing
          // about the room, only its own pending entry.
          snapshot: pendingRequest ? this.coordinator!.pendingSnapshot(message.participantId) : result.snapshot,
        })
        this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot }, socket)
      })
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
        await this.persistAndObserve(() => {
          this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
        })
      }
      return
    }

    if (message.type === 'seek_applied') {
      const result = this.coordinator.acknowledgeSeek(attachment.participantId, message.revision, message.positionSeconds)
      if (result?.ok) {
        await this.persistAndObserve(() => {
          this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
        })
      }
      return
    }

    if (message.type === 'operation_ack') {
      const result = this.coordinator.acknowledgeOperation(attachment.participantId, message.acknowledgement)
      if (result?.ok) {
        await this.persistAndObserve(() => {
          this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
        })
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
        this.sendResult(socket, message.actionId, result, this.coordinator.hasParticipant(attachment.participantId))
        return
      }

      await this.persistAndObserve(() => {
        if (!message.approve) {
          // Tell the denied participant's own socket, and only that socket,
          // after the denial has been persisted. The denied client never also
          // receives a snapshot for a room it is being removed from.
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
      })
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
      this.sendResult(socket, message.type === 'control' || message.type === 'open_link' ? message.actionId : null, result, this.coordinator.hasParticipant(attachment.participantId))
      return
    }

    await this.persistAndObserve(() => {
      this.broadcast({ type: 'room_snapshot', reason: result.reason, snapshot: result.snapshot })
    })
  }

  private async persistAndSchedule(): Promise<void> {
    if (!this.coordinator)
      return

    // Derived like the empty-room clock, so that any save settles it: a plan
    // that a join could not make (a socket that could not be read) is made by
    // the next save, and the alarm below is derived from it.
    try {
      this.armControllerRecovery()
    }
    catch {
      // Tried again by the next save.
    }

    const storedRoom: StoredRoom = {
      coordinator: this.coordinator.exportState(),
      pendingController: this.pendingController,
      emptySinceMs: this.emptySinceMs,
      createdAtMs: this.createdAtMs,
    }

    const alarmCandidates: Array<number | null | undefined> = []
    if (this.pendingController)
      alarmCandidates.push(this.pendingController.recoverAtMs)
    if (this.emptySinceMs !== null)
      alarmCandidates.push(this.emptySinceMs + EMPTY_ROOM_TTL_MS)
    // The lifetime limit is enforced by the alarm, so it must be scheduled:
    // without it a room whose members stay connected, or that was pinned open
    // by other activity, only met the limit if some unrelated alarm happened
    // to fire after it.
    alarmCandidates.push(this.createdAtMs + MAX_ROOM_LIFETIME_MS)
    const seekDeadlineMs = this.coordinator.pendingSeekDeadlineMs()
    if (seekDeadlineMs !== null)
      alarmCandidates.push(seekDeadlineMs)
    const operationDeadlineMs = this.coordinator.operationDeadlineMs()
    if (operationDeadlineMs !== null)
      alarmCandidates.push(operationDeadlineMs)
    const healthDeadlineMs = this.coordinator.nextHealthDeadlineMs()
    if (healthDeadlineMs !== null)
      alarmCandidates.push(healthDeadlineMs)

    await persistRoomAndSchedule(this.ctx.storage, storedRoom, alarmCandidates, () => this.announceWithheldRepair())
    // Any save does what a retried restore save would: it writes the room as it
    // is now and derives the alarm from it.
    if (this.unsavedRestore) {
      this.unsavedRestore.alarmPending = false
      this.finishRestoreIfSettled()
    }
  }

  private async persistAndObserve(observe: () => void): Promise<void> {
    await persistThenObserve(() => this.persistAndSchedule(), observe)
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    }
    catch {
      // The peer disconnected between snapshot creation and broadcast.
    }
  }

  /** Returns false when a socket was skipped because its attachment could not be read. */
  private broadcast(message: ServerMessage, except?: WebSocket): boolean {
    let complete = true
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except)
        continue
      // Only approved members receive room broadcasts. A socket that has not
      // joined at all (participantId null) or whose join request is still
      // pending must learn nothing about the room: the controller's
      // approval is the only thing that grants access to its state.
      let attachment: SocketAttachment | null
      try {
        attachment = socket.deserializeAttachment() as SocketAttachment | null
      }
      catch {
        // One socket whose attachment cannot be read is skipped; the others
        // still hear it, and the caller can tell that one did not.
        complete = false
        continue
      }
      if (!attachment?.participantId || !this.coordinator?.hasParticipant(attachment.participantId))
        continue
      this.send(socket, message)
    }
    return complete
  }

  private sendToParticipant(participantId: string, message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      let attachment: SocketAttachment | null
      try {
        attachment = socket.deserializeAttachment() as SocketAttachment | null
      }
      catch {
        continue
      }
      if (attachment?.participantId === participantId) {
        this.send(socket, message)
        return
      }
    }
  }

  private sendResult(socket: WebSocket, actionId: string | null, result: RoomResult, senderIsMember: boolean): void {
    if (result.ok)
      return
    this.send(socket, {
      type: 'command_rejected',
      actionId,
      code: result.code,
      message: result.message,
      // Only an admitted member may be told the room's state in a rejection.
      snapshot: senderIsMember ? result.snapshot : null,
    })
  }

  private closePriorParticipantSocket(participantId: string, current: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === current)
        continue
      // Best effort, socket by socket: one that cannot be read or closed must
      // not stop the member that is joining from being admitted.
      let attachment: SocketAttachment | null
      try {
        attachment = socket.deserializeAttachment() as SocketAttachment | null
      }
      catch {
        // It cannot be told whether this is the member's own earlier connection,
        // and it cannot be served either (every frame would fail to read its
        // attachment), so it is not left open beside the one being admitted.
        // Its client reconnects with a fresh attachment.
        try {
          socket.close(1011, 'attachment_unreadable')
        }
        catch {
          // Already closing.
        }
        continue
      }
      try {
        if (attachment?.participantId === participantId)
          socket.close(1000, 'session_replaced')
      }
      catch {
        // Already closing or closed.
      }
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
