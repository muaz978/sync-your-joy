import type {
  ControlKind,
  MediaFingerprint,
  ParticipantState,
  PlaybackState,
  PlayerSample,
  RoomSnapshot,
} from '@syncyourjoy/protocol'
import { mediaMatches } from '@syncyourjoy/protocol'
import { expectedPosition } from './clock.ts'

export interface InternalParticipant extends ParticipantState {
  joinedAtMs: number
  media: MediaFingerprint | null
  lastSample: PlayerSample | null
}

export interface RoomIdentity {
  roomId: string
  code: string
  inviteToken: string
}

export interface RoomCoordinatorState {
  identity: RoomIdentity
  revision: number
  leaseEpoch: number
  controllerId: string
  media: MediaFingerprint | null
  playback: PlaybackState
  participants: Array<InternalParticipant>
  actionIds: string[]
}

export interface ControlIntent {
  actionId: string
  basedOnRevision: number
  leaseEpoch: number
  kind: ControlKind
  positionSeconds: number
}

export type RoomResult =
  | { ok: true; snapshot: RoomSnapshot; reason: string }
  | { ok: false; code: string; message: string; snapshot: RoomSnapshot }

export class RoomCoordinator {
  readonly inviteToken: string
  private readonly identity: RoomIdentity
  private readonly now: () => number
  private revision = 0
  private leaseEpoch = 1
  private controllerId: string
  private media: MediaFingerprint | null
  private playback: PlaybackState
  private readonly participants = new Map<string, InternalParticipant>()
  private readonly actionIds = new Set<string>()

  constructor(
    identity: RoomIdentity,
    controller: { id: string; name: string; media: MediaFingerprint | null },
    now: () => number = Date.now,
    restoredState?: RoomCoordinatorState,
  ) {
    this.identity = identity
    this.now = now
    this.inviteToken = identity.inviteToken

    if (restoredState) {
      this.revision = restoredState.revision
      this.leaseEpoch = restoredState.leaseEpoch
      this.controllerId = restoredState.controllerId
      this.media = restoredState.media
      this.playback = restoredState.playback
      for (const participant of restoredState.participants)
        this.participants.set(participant.id, structuredClone(participant))
      for (const actionId of restoredState.actionIds)
        this.actionIds.add(actionId)
      return
    }

    this.controllerId = controller.id
    this.media = controller.media
    this.playback = {
      status: 'paused',
      positionSeconds: 0,
      effectiveAtServerMs: this.now(),
      playbackRate: 1,
    }
    this.participants.set(controller.id, {
      id: controller.id,
      name: controller.name,
      role: 'controller',
      ready: controller.media !== null,
      connected: true,
      mediaMatches: controller.media !== null,
      latencyMs: null,
      joinedAtMs: this.now(),
      media: controller.media,
      lastSample: null,
    })
  }

  static fromState(state: RoomCoordinatorState, now: () => number = Date.now): RoomCoordinator {
    const controller = state.participants.find(participant => participant.id === state.controllerId)
    if (!controller)
      throw new Error('Stored room controller is missing.')
    return new RoomCoordinator(
      state.identity,
      { id: controller.id, name: controller.name, media: controller.media },
      now,
      state,
    )
  }

  exportState(): RoomCoordinatorState {
    return {
      identity: { ...this.identity },
      revision: this.revision,
      leaseEpoch: this.leaseEpoch,
      controllerId: this.controllerId,
      media: this.media ? { ...this.media } : null,
      playback: { ...this.playback },
      participants: [...this.participants.values()].map(participant => structuredClone(participant)),
      actionIds: [...this.actionIds],
    }
  }

  join(participant: { id: string; name: string; media: MediaFingerprint | null }): RoomResult {
    const existing = this.participants.get(participant.id)
    if (existing) {
      existing.connected = true
      existing.name = participant.name
      existing.media = participant.media
      existing.mediaMatches = mediaMatches(this.media, participant.media)
      existing.ready = existing.id === this.controllerId ? existing.mediaMatches : false
      this.revision += 1
      return this.success('participant_reconnected')
    }

    if (this.participants.size >= 10)
      return this.failure('room_full', 'This room already has 10 participants.')

    const matches = mediaMatches(this.media, participant.media)
    this.participants.set(participant.id, {
      id: participant.id,
      name: participant.name,
      role: 'member',
      ready: false,
      connected: true,
      mediaMatches: matches,
      latencyMs: null,
      joinedAtMs: this.now(),
      media: participant.media,
      lastSample: null,
    })
    this.revision += 1
    return this.success('participant_joined')
  }

  setReady(participantId: string, ready: boolean, media: MediaFingerprint | null): RoomResult {
    const participant = this.participants.get(participantId)
    if (!participant)
      return this.failure('participant_missing', 'You are no longer part of this room.')

    participant.media = media
    participant.mediaMatches = mediaMatches(this.media, media)
    participant.ready = ready && participant.mediaMatches
    this.revision += 1
    return this.success(participant.ready ? 'participant_ready' : 'participant_not_ready')
  }

  control(participantId: string, intent: ControlIntent): RoomResult {
    if (this.actionIds.has(intent.actionId))
      return this.success('duplicate_action')

    if (participantId !== this.controllerId)
      return this.failure('controller_only', 'Only the controller can change playback.')

    if (intent.leaseEpoch !== this.leaseEpoch)
      return this.failure('stale_lease', 'Control changed hands. Refreshing room state.')

    if (intent.basedOnRevision !== this.revision)
      return this.failure('stale_revision', 'The room changed before this control was applied. Try again.')

    if (intent.kind === 'play' && !this.everyoneReady())
      return this.failure('participants_not_ready', 'Everyone must be ready before playback starts.')

    this.actionIds.add(intent.actionId)
    if (this.actionIds.size > 500) {
      const oldest = this.actionIds.values().next().value
      if (typeof oldest === 'string')
        this.actionIds.delete(oldest)
    }

    const nowMs = this.now()
    const positionSeconds = Math.max(0, intent.positionSeconds)
    const leadMs = this.commandLeadMs()

    if (intent.kind === 'pause') {
      this.playback = {
        status: 'paused',
        positionSeconds,
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
    }
    else if (intent.kind === 'play') {
      this.playback = {
        status: 'playing',
        positionSeconds,
        effectiveAtServerMs: nowMs + leadMs,
        playbackRate: 1,
      }
    }
    else {
      this.playback = {
        status: this.playback.status,
        positionSeconds,
        effectiveAtServerMs: this.playback.status === 'playing' ? nowMs + leadMs : nowMs,
        playbackRate: 1,
      }
    }

    this.revision += 1
    return this.success(`control_${intent.kind}`)
  }

  transferControl(fromParticipantId: string, toParticipantId: string, leaseEpoch: number): RoomResult {
    if (fromParticipantId !== this.controllerId || leaseEpoch !== this.leaseEpoch)
      return this.failure('controller_only', 'Only the current controller can pass control.')

    const nextController = this.participants.get(toParticipantId)
    if (!nextController || !nextController.connected)
      return this.failure('participant_unavailable', 'That participant is not connected.')

    const current = this.participants.get(this.controllerId)
    if (current)
      current.role = 'member'

    this.controllerId = nextController.id
    nextController.role = 'controller'
    this.leaseEpoch += 1
    this.revision += 1
    return this.success('control_transferred')
  }

  updatePlayerStatus(participantId: string, sample: PlayerSample): RoomResult | null {
    const participant = this.participants.get(participantId)
    if (!participant)
      return null

    participant.lastSample = sample
    if (sample.buffering && this.playback.status === 'playing') {
      const nowMs = this.now()
      this.playback = {
        status: 'paused',
        positionSeconds: expectedPosition(this.playback, nowMs),
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
      this.revision += 1
      return this.success('participant_buffering')
    }

    return null
  }

  recordLatency(participantId: string, roundTripMs: number): void {
    const participant = this.participants.get(participantId)
    if (participant)
      participant.latencyMs = Math.round(Math.max(0, Math.min(roundTripMs, 10_000)))
  }

  disconnect(participantId: string): RoomResult | null {
    const participant = this.participants.get(participantId)
    if (!participant || !participant.connected)
      return null

    participant.connected = false
    participant.ready = false

    if (participantId === this.controllerId && this.playback.status === 'playing') {
      const nowMs = this.now()
      this.playback = {
        status: 'paused',
        positionSeconds: expectedPosition(this.playback, nowMs),
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
    }

    this.revision += 1
    return this.success('participant_disconnected')
  }

  transferDisconnectedController(): RoomResult | null {
    const current = this.participants.get(this.controllerId)
    if (current?.connected)
      return null

    const next = [...this.participants.values()]
      .filter(participant => participant.connected)
      .sort((a, b) => a.joinedAtMs - b.joinedAtMs)[0]

    if (!next)
      return null

    if (current)
      current.role = 'member'
    next.role = 'controller'
    this.controllerId = next.id
    this.leaseEpoch += 1
    this.revision += 1
    return this.success('controller_recovered')
  }

  hasConnectedParticipants(): boolean {
    return [...this.participants.values()].some(participant => participant.connected)
  }

  snapshot(): RoomSnapshot {
    return {
      roomId: this.identity.roomId,
      code: this.identity.code,
      revision: this.revision,
      controller: {
        participantId: this.controllerId,
        leaseEpoch: this.leaseEpoch,
      },
      media: this.media ? { ...this.media } : null,
      playback: { ...this.playback },
      participants: [...this.participants.values()]
        .sort((a, b) => a.joinedAtMs - b.joinedAtMs)
        .map(({ joinedAtMs: _joinedAtMs, media: _media, lastSample: _lastSample, ...participant }) => ({ ...participant })),
      policy: { buffering: 'pause-all' },
    }
  }

  private everyoneReady(): boolean {
    const connected = [...this.participants.values()].filter(participant => participant.connected)
    return connected.length > 0 && connected.every(participant => participant.ready && participant.mediaMatches)
  }

  private commandLeadMs(): number {
    const latencies = [...this.participants.values()]
      .filter(participant => participant.connected && participant.latencyMs !== null)
      .map(participant => participant.latencyMs as number)

    const slowestRoundTripMs = latencies.length > 0 ? Math.max(...latencies) : 120
    return Math.round(Math.max(140, Math.min(500, slowestRoundTripMs / 2 + 80)))
  }

  private success(reason: string): RoomResult {
    return { ok: true, reason, snapshot: this.snapshot() }
  }

  private failure(code: string, message: string): RoomResult {
    return { ok: false, code, message, snapshot: this.snapshot() }
  }
}
