import type {
  ClientCapabilities,
  ControlKind,
  MediaFingerprint,
  OperationAcknowledgement,
  OperationObservationIdentity,
  RoomContractSnapshot,
  RoomOperation,
  ParticipantState,
  PlaybackState,
  PlayerSample,
  RoomSnapshot,
  SharedSeek,
  SharedNavigation,
} from '@syncyourjoy/protocol'
import {
  isCurrentOperation,
  isRoomContractSnapshot,
  mediaMatches,
  mediaMatchesPageUrl,
  negotiateRoomMode,
  normalizeClientCapabilities,
  normalizePageUrl,
  normalizeRoomContractSnapshot,
  supportsTransactionalOperations,
} from '@syncyourjoy/protocol'
import { expectedPosition } from './clock.ts'
import { hasPlaybackProgressStalled, hasPlaybackStartupTimedOut, isPlaybackPastStartupGrace, playbackProgressDeadlineMs, playbackReportSilenceDeadlineMs, playbackStartupDeadlineMs, PLAYBACK_PROGRESS_TIMEOUT_MS, PLAYBACK_STARTUP_GRACE_MS, PLAYBACK_STARTUP_TIMEOUT_MS } from './playback-health.ts'
import { participantPlaybackStatus } from './participant-status.ts'
import { isSeekAligned, SEEK_BARRIER_MAX_WAIT_MS } from './seek-barrier.ts'

export interface InternalParticipant extends ParticipantState {
  joinedAtMs: number
  /** Random capability used only to resume this participant session. */
  sessionToken?: string
  media: MediaFingerprint | null
  lastSample: PlayerSample | null
  lastSampleReceivedAtMs?: number
  lastProgressAtServerMs?: number
  /** Optional for migration: old persisted participants predate CR-B02. */
  capabilities?: ClientCapabilities
  lastOperationObservation?: OperationObservationIdentity
}

export interface RoomIdentity {
  roomId: string
  code: string
}

export interface InternalPendingJoinRequest {
  id: string
  name: string
  media: MediaFingerprint | null
  /** Random capability the eventual approved participant record will carry. */
  sessionToken?: string
  capabilities?: ClientCapabilities
  requestedAtMs: number
}

export interface RoomCoordinatorState {
  /** Version 2 is the first state shape with an explicit contract boundary. */
  stateVersion?: number
  identity: RoomIdentity
  revision: number
  leaseEpoch: number
  controllerId: string
  media: MediaFingerprint | null
  playback: PlaybackState
  participants: Array<InternalParticipant>
  actionIds: string[]
  navigation?: SharedNavigation | null
  controlRevisionFloor?: number
  pendingSeek?: SharedSeek | null
  pendingJoinRequests?: InternalPendingJoinRequest[]
  contract?: RoomContractSnapshot
}

export const ROOM_STATE_VERSION = 2

export interface ControlIntent {
  actionId: string
  basedOnRevision: number
  leaseEpoch: number
  kind: ControlKind
  positionSeconds: number
}

export interface OpenLinkIntent {
  actionId: string
  basedOnRevision: number
  leaseEpoch: number
  url: string
}

export type RoomResult =
  | { ok: true; snapshot: RoomSnapshot; reason: string }
  | { ok: false; code: string; message: string; snapshot: RoomSnapshot }

export class RoomCoordinator {
  private readonly identity: RoomIdentity
  private readonly now: () => number
  private revision = 0
  private leaseEpoch = 1
  private controllerId: string
  private media: MediaFingerprint | null
  private playback: PlaybackState
  private readonly participants = new Map<string, InternalParticipant>()
  private readonly pendingJoinRequests = new Map<string, InternalPendingJoinRequest>()
  private readonly actionIds = new Set<string>()
  private navigation: SharedNavigation | null = null
  private controlRevisionFloor = 0
  private pendingSeek: SharedSeek | null = null
  private contract: RoomContractSnapshot

  constructor(
    identity: RoomIdentity,
    controller: { id: string; name: string; media: MediaFingerprint | null; sessionToken?: string; capabilities?: ClientCapabilities },
    now: () => number = Date.now,
    restoredState?: RoomCoordinatorState,
  ) {
    this.identity = identity
    this.now = now

    if (restoredState) {
      this.revision = restoredState.revision
      this.leaseEpoch = restoredState.leaseEpoch
      this.controllerId = restoredState.controllerId
      this.media = restoredState.media
      this.playback = restoredState.playback
      for (const participant of restoredState.participants) {
        const restored = structuredClone(participant)
        restored.playbackStatus = restored.playbackStatus ?? (restored.connected
          ? restored.mediaMatches
            ? restored.ready ? 'ready' : 'preparing'
            : 'wrong-media'
          : 'unknown')
        this.participants.set(participant.id, restored)
      }
      for (const actionId of restoredState.actionIds)
        this.actionIds.add(actionId)
      this.navigation = restoredState.navigation ?? null
      this.controlRevisionFloor = restoredState.controlRevisionFloor ?? restoredState.revision
      const restoredPendingSeek = normalizeRestoredPendingSeek(restoredState.pendingSeek)
      for (const request of restoredState.pendingJoinRequests ?? [])
        this.pendingJoinRequests.set(request.id, structuredClone(request))
      const hasValidContractBoundary = isRoomContractSnapshot(restoredState.contract)
      this.contract = normalizeRoomContractSnapshot(restoredState.contract)
      this.pendingSeek = hasValidContractBoundary ? restoredPendingSeek : null
      if (!hasValidContractBoundary)
        this.migratePreContractState(restoredPendingSeek)
      this.refreshNegotiation()
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
      ready: false,
      connected: true,
      mediaMatches: controller.media !== null,
      latencyMs: null,
      joinedAtMs: this.now(),
      media: controller.media,
      playbackStatus: 'preparing',
      ...(controller.sessionToken ? { sessionToken: controller.sessionToken } : {}),
      capabilities: normalizeClientCapabilities(controller.capabilities),
      lastSample: null,
      lastSampleReceivedAtMs: this.now(),
      lastProgressAtServerMs: this.now(),
    })
    this.contract = normalizeRoomContractSnapshot(undefined)
    this.refreshNegotiation()
  }

  static fromState(state: RoomCoordinatorState, now: () => number = Date.now): RoomCoordinator {
    const controller = state.participants.find(participant => participant.id === state.controllerId)
    if (!controller)
      throw new Error('Stored room controller is missing.')
    return new RoomCoordinator(
      state.identity,
      {
        id: controller.id,
        name: controller.name,
        media: controller.media,
        ...(controller.capabilities ? { capabilities: controller.capabilities } : {}),
      },
      now,
      state,
    )
  }

  exportState(): RoomCoordinatorState {
    return {
      stateVersion: ROOM_STATE_VERSION,
      identity: { ...this.identity },
      revision: this.revision,
      leaseEpoch: this.leaseEpoch,
      controllerId: this.controllerId,
      media: this.media ? { ...this.media } : null,
      playback: { ...this.playback },
      participants: [...this.participants.values()].map(participant => structuredClone(participant)),
      actionIds: [...this.actionIds],
      navigation: this.navigation ? { ...this.navigation } : null,
      controlRevisionFloor: this.controlRevisionFloor,
      pendingSeek: this.pendingSeek ? structuredClone(this.pendingSeek) : null,
      pendingJoinRequests: [...this.pendingJoinRequests.values()].map(request => structuredClone(request)),
      contract: structuredClone(this.contract),
    }
  }

  join(participant: { id: string; name: string; media: MediaFingerprint | null; sessionToken?: string; capabilities?: ClientCapabilities }): RoomResult {
    const capabilities = normalizeClientCapabilities(participant.capabilities)
    const existing = this.participants.get(participant.id)
    if (existing) {
      // Unconditional equality, not "only reject when existing already had a
      // token": a participant record created without one must never be
      // reconnectable by anyone presenting an arbitrary token, or worse, by
      // silently trusting undefined-vs-defined as a match.
      if (existing.sessionToken !== participant.sessionToken)
        return this.failure('session_invalid', 'This participant session is no longer valid. Join again with a new room identity.')
      // Only a currently-disconnected participant reconnecting increases the
      // connected count; re-check the same cap the new-participant branch
      // below enforces, or a full room could be pushed past 10 connected by
      // reconnecting someone who still holds a valid session token.
      if (!existing.connected) {
        const connectedCount = [...this.participants.values()].filter(item => item.connected).length
        if (connectedCount >= 10)
          return this.failure('room_full', 'This room already has 10 participants.')
      }
      const wasReady = existing.ready
      existing.connected = true
      existing.name = participant.name
      existing.media = participant.media
      existing.mediaMatches = mediaMatches(this.media, participant.media)
      existing.capabilities = capabilities
      if (participant.sessionToken)
        existing.sessionToken = participant.sessionToken
      existing.ready = wasReady && existing.mediaMatches
      existing.playbackStatus = existing.mediaMatches
        ? existing.ready ? this.playback.status === 'playing' ? 'preparing' : 'ready' : 'preparing'
        : 'wrong-media'
      this.pauseForMembershipChange()
      this.refreshNegotiation()
      this.revision += 1
      this.markStateBarrier()
      return this.success('participant_reconnected')
    }

    // Count both currently-connected participants and requests already
    // pending approval against the same cap of 10, so a flood of brand-new
    // join requests can't bypass it by staying "merely pending" forever.
    const connectedCount = [...this.participants.values()].filter(item => item.connected).length
    if (connectedCount + this.pendingJoinRequests.size >= 10)
      return this.failure('room_full', 'This room already has 10 participants.')

    // A brand-new participant identity no longer joins immediately (see
    // docs/CODE_AUDIT.md SYJ-AUD-003): it becomes a pending request the
    // controller must explicitly approve or deny via respondToJoin(). This
    // has no effect on anyone's readiness/membership set yet, so unlike an
    // approved join it does not pause an in-progress playback.
    this.pendingJoinRequests.set(participant.id, {
      id: participant.id,
      name: participant.name,
      media: participant.media,
      ...(participant.sessionToken ? { sessionToken: participant.sessionToken } : {}),
      capabilities,
      requestedAtMs: this.now(),
    })
    this.revision += 1
    this.markStateBarrier()
    return this.success('join_pending')
  }

  respondToJoin(controllerId: string, leaseEpoch: number, participantId: string, approve: boolean): RoomResult {
    if (controllerId !== this.controllerId || leaseEpoch !== this.leaseEpoch)
      return this.failure('controller_only', 'Only the current controller can respond to join requests.')

    const pending = this.pendingJoinRequests.get(participantId)
    if (!pending)
      return this.failure('not_found', 'That join request is no longer pending.')

    this.pendingJoinRequests.delete(participantId)

    if (!approve) {
      this.revision += 1
      this.markStateBarrier()
      return this.success('join_denied')
    }

    const matches = mediaMatches(this.media, pending.media)
    this.participants.set(pending.id, {
      id: pending.id,
      name: pending.name,
      role: 'member',
      ready: false,
      connected: true,
      mediaMatches: matches,
      latencyMs: null,
      joinedAtMs: this.now(),
      media: pending.media,
      playbackStatus: matches ? 'preparing' : 'wrong-media',
      ...(pending.sessionToken ? { sessionToken: pending.sessionToken } : {}),
      ...(pending.capabilities ? { capabilities: pending.capabilities } : {}),
      lastSample: null,
      lastSampleReceivedAtMs: this.now(),
      lastProgressAtServerMs: this.now(),
    })
    this.pauseForMembershipChange()
    this.refreshNegotiation()
    this.revision += 1
    this.markStateBarrier()
    return this.success('join_approved')
  }

  setReady(participantId: string, ready: boolean, media: MediaFingerprint | null): RoomResult {
    const participant = this.participants.get(participantId)
    if (!participant)
      return this.failure('participant_missing', 'You are no longer part of this room.')

    const previousReady = participant.ready
    const previousMediaMatches = participant.mediaMatches
    participant.media = media
    participant.mediaMatches = mediaMatches(this.media, media)
    participant.ready = ready && participant.mediaMatches
    participant.playbackStatus = !participant.mediaMatches
      ? 'wrong-media'
      : participant.ready
        ? this.playback.status === 'playing' ? 'preparing' : 'ready'
        : 'preparing'
    if (participant.ready === previousReady && participant.mediaMatches === previousMediaMatches)
      return this.success('readiness_unchanged')
    if (!participant.ready)
      this.pauseForMembershipChange('participant-not-ready')
    this.revision += 1
    this.markStateBarrier()
    return this.success(participant.ready ? 'participant_ready' : 'participant_not_ready')
  }

  control(participantId: string, intent: ControlIntent): RoomResult {
    if (this.actionIds.has(intent.actionId))
      return this.success('duplicate_action')

    if (participantId !== this.controllerId)
      return this.failure('controller_only', 'Only the controller can change playback.')

    if (intent.leaseEpoch !== this.leaseEpoch)
      return this.failure('stale_lease', 'Control changed hands. Refreshing room state.')

    if (intent.basedOnRevision > this.revision)
      return this.failure('future_revision', 'The control referenced room state that has not arrived yet.')
    if (intent.basedOnRevision < this.controlRevisionFloor)
      return this.failure('stale_context', 'The room changed before this control was applied.')

    if (intent.kind === 'play' && !this.everyoneReady())
      return this.failure('participants_not_ready', 'Everyone must be ready before playback starts.')
    if (intent.kind === 'play' && this.pendingSeek)
      return this.failure('seek_in_progress', 'Wait for every player to finish the current seek before starting playback.')
    if (this.contract.mode === 'transactional' && intent.kind !== 'pause' && !this.everyoneReady())
      return this.failure('participants_not_ready', 'Everyone must be ready before a transactional operation starts.')

    this.rememberAction(intent.actionId)

    const nowMs = this.now()
    const positionSeconds = this.clampToMediaDuration(Math.max(0, intent.positionSeconds))
    const leadMs = this.commandLeadMs()

    if (this.contract.mode === 'transactional')
      return this.controlTransactional(intent.kind, positionSeconds, nowMs, leadMs)

    if (intent.kind === 'pause') {
      this.pendingSeek = null
      this.playback = {
        status: 'paused',
        positionSeconds,
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
      this.markParticipantStatuses('ready')
    }
    else if (intent.kind === 'play') {
      this.pendingSeek = null
      this.playback = {
        status: 'playing',
        positionSeconds,
        effectiveAtServerMs: nowMs + leadMs,
        playbackRate: 1,
      }
      this.resetPlaybackHealth(this.playback.effectiveAtServerMs)
      this.markParticipantStatuses('preparing')
    }
    else {
      const resumeWhenReady = this.pendingSeek?.resumeWhenReady ?? this.playback.status === 'playing'
      this.playback = {
        status: 'paused',
        positionSeconds,
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
      this.markParticipantStatuses('ready')
      this.revision += 1
      this.pendingSeek = {
        revision: this.revision,
        positionSeconds,
        resumeWhenReady,
        deadlineAtServerMs: nowMs + SEEK_BARRIER_MAX_WAIT_MS,
        // A scrub or skip button can report its target before the controller
        // finishes fetching and decoding the target segment. Every player,
        // including the controller, must confirm that its seek completed.
        acknowledgedParticipantIds: [],
      }
      this.markParticipantStatuses('seeking')
      return this.success('control_seek_pending')
    }

    this.revision += 1
    return this.success(`control_${intent.kind}`)
  }

  /**
   * Records a prepare or observed-start acknowledgement for the active
   * transactional operation. The caller must already have authenticated the
   * socket; the participant id in the payload is checked as an additional
   * consistency guard and is never used as authorization by itself.
   */
  acknowledgeOperation(participantId: string, acknowledgement: OperationAcknowledgement): RoomResult | null {
    const operation = this.contract.operation
    if (this.contract.mode !== 'transactional' || !operation)
      return null

    const nowMs = this.now()
    if (nowMs >= operation.deadlineAtServerMs)
      return this.releaseExpiredOperation(nowMs)
    if (acknowledgement.participantId !== participantId
      || !isCurrentOperation(operation, acknowledgement)
      || !supportsTransactionalOperations(this.participantCapabilities(participantId).capabilities))
      return null
    if (operation.phase === 'cancelled' || operation.phase === 'failed')
      return null

    const participant = this.participants.get(participantId)
    if (!participant || !participant.connected || !participant.ready || !participant.mediaMatches
      || !operation.requiredParticipantIds.includes(participantId))
      return null

    const priorObservation = participant.lastOperationObservation
    if (priorObservation
      && isCurrentOperation(priorObservation, acknowledgement)
      && (priorObservation.bindingId !== acknowledgement.bindingId
        || priorObservation.sourceGeneration !== acknowledgement.sourceGeneration)) {
      this.cancelOperation('binding-changed', nowMs)
      this.revision += 1
      this.markStateBarrier()
      return this.success('operation_binding_changed')
    }
    if (priorObservation
      && isCurrentOperation(priorObservation, acknowledgement)
      && (acknowledgement.sourceGeneration < priorObservation.sourceGeneration
        || (acknowledgement.sourceGeneration === priorObservation.sourceGeneration
          && acknowledgement.sampleSequence < priorObservation.sampleSequence)))
      return null
    participant.lastOperationObservation = {
      mediaEpoch: acknowledgement.mediaEpoch,
      operationId: acknowledgement.operationId,
      bindingId: acknowledgement.bindingId,
      sourceGeneration: acknowledgement.sourceGeneration,
      sampleSequence: acknowledgement.sampleSequence,
    }

    if (acknowledgement.phase === 'prepared') {
      if (operation.phase !== 'preparing' && operation.phase !== 'prepared')
        return operation.preparedParticipantIds.includes(participantId)
          ? this.success('operation_prepare_duplicate')
          : null
      if (!isSeekAligned(acknowledgement.observedPositionSeconds, operation.targetPositionSeconds ?? 0))
        return null
      if (operation.preparedParticipantIds.includes(participantId))
        return this.success('operation_prepare_duplicate')
      if (!operation.preparedParticipantIds.includes(participantId))
        operation.preparedParticipantIds.push(participantId)
      if (operation.preparedParticipantIds.length < operation.requiredParticipantIds.length)
        return this.success('operation_participant_prepared')

      operation.phase = 'prepared'
      operation.effectiveAtServerMs = nowMs + this.commandLeadMs()
      if (operation.kind === 'seek' && operation.resumeWhenReady === false) {
        operation.phase = 'committed'
        this.playback = {
          status: 'paused',
          positionSeconds: operation.targetPositionSeconds ?? 0,
          effectiveAtServerMs: operation.effectiveAtServerMs,
          playbackRate: 1,
        }
        this.markParticipantStatuses('ready')
        this.revision += 1
        return this.success('operation_seek_committed_paused')
      }

      // Preparation uses the short seek barrier, but a browser needs a
      // separate bounded window after the scheduled commit to load, start
      // rendering and report real progress. Reusing the preparation deadline
      // would fail a valid operation before CR-B03 can send `started`.
      operation.deadlineAtServerMs = operation.effectiveAtServerMs
        + PLAYBACK_STARTUP_GRACE_MS
        + PLAYBACK_PROGRESS_TIMEOUT_MS
      this.playback = {
        status: 'playing',
        positionSeconds: operation.targetPositionSeconds ?? 0,
        effectiveAtServerMs: operation.effectiveAtServerMs,
        playbackRate: 1,
      }
      this.resetPlaybackHealth(operation.effectiveAtServerMs)
      this.markParticipantStatuses('preparing')
      operation.phase = 'committed'
      this.revision += 1
      return this.success('operation_committed')
    }

    if (operation.phase !== 'committed' && operation.phase !== 'started')
      return null
    if (operation.startedParticipantIds.includes(participantId))
      return this.success('operation_start_duplicate')
    if (operation.effectiveAtServerMs === null || nowMs < operation.effectiveAtServerMs)
      return null
    if (!isSeekAligned(acknowledgement.observedPositionSeconds, this.expectedOperationPosition(operation, nowMs)))
      return null

    operation.startedParticipantIds.push(participantId)
    participant.playbackStatus = 'playing'
    if (operation.startedParticipantIds.length === operation.requiredParticipantIds.length)
      operation.phase = 'started'
    this.revision += 1
    return this.success(operation.phase === 'started' ? 'operation_started' : 'operation_participant_started')
  }

  releaseExpiredOperation(nowMs: number = this.now()): RoomResult | null {
    const operation = this.contract.operation
    if (this.contract.mode !== 'transactional' || !operation || nowMs < operation.deadlineAtServerMs)
      return null
    if (operation.phase === 'cancelled' || operation.phase === 'failed')
      return null
    const previousPhase = operation.phase
    operation.phase = 'failed'
    operation.reason = previousPhase === 'committed' || previousPhase === 'started'
      ? 'start-timeout'
      : 'deadline-expired'
    this.pauseAtOperationTarget(operation, nowMs)
    this.markParticipantStatuses('recovery-required')
    this.revision += 1
    this.markStateBarrier()
    return this.success('operation_timeout_paused')
  }

  operationDeadlineMs(): number | null {
    const operation = this.contract.operation
    return this.contract.mode === 'transactional' && operation
      && operation.phase !== 'cancelled' && operation.phase !== 'failed'
      ? operation.deadlineAtServerMs
      : null
  }

  acknowledgeSeek(participantId: string, revision: number, positionSeconds: number): RoomResult | null {
    const pending = this.pendingSeek
    if (!pending || revision !== pending.revision)
      return null
    // The alarm is a delivery mechanism, not the correctness boundary. A
    // packet that arrives at or after the deadline must not revive the
    // operation merely because the scheduler has not run its callback yet.
    const nowMs = this.now()
    if (nowMs >= pending.deadlineAtServerMs)
      return this.releaseExpiredSeek(nowMs)

    const participant = this.participants.get(participantId)
    if (!participant)
      return null
    if (!participant.connected || !participant.ready || !participant.mediaMatches)
      return null
    if (!isSeekAligned(positionSeconds, pending.positionSeconds))
      return null
    if (!pending.acknowledgedParticipantIds.includes(participantId))
      pending.acknowledgedParticipantIds.push(participantId)

    const required = [...this.participants.values()]
      .filter(item => item.connected && item.ready && item.mediaMatches)
      .map(item => item.id)
    if (!required.every(id => pending.acknowledgedParticipantIds.includes(id)))
      return this.success('seek_participant_aligned')

    this.pendingSeek = null
    if (pending.resumeWhenReady) {
      this.playback = {
        status: 'playing',
        positionSeconds: pending.positionSeconds,
        effectiveAtServerMs: this.now() + this.commandLeadMs(),
        playbackRate: 1,
      }
      this.resetPlaybackHealth(this.playback.effectiveAtServerMs)
      this.markParticipantStatuses('preparing')
    }
    else {
      this.markParticipantStatuses('ready')
    }
    this.revision += 1
    return this.success(pending.resumeWhenReady ? 'seek_aligned_play_scheduled' : 'seek_aligned_paused')
  }

  releaseExpiredSeek(nowMs: number = this.now()): RoomResult | null {
    const pending = this.pendingSeek
    if (!pending || nowMs < pending.deadlineAtServerMs)
      return null
    this.pendingSeek = null
    this.playback = {
      status: 'paused',
      positionSeconds: pending.positionSeconds,
      effectiveAtServerMs: nowMs,
      playbackRate: 1,
    }
    this.markParticipantStatuses('recovery-required')
    this.revision += 1
    this.markStateBarrier()
    return this.success('seek_timeout_paused')
  }

  pendingSeekDeadlineMs(): number | null {
    return this.pendingSeek?.deadlineAtServerMs ?? null
  }

  nextHealthDeadlineMs(): number | null {
    if (this.playback.status !== 'playing')
      return null

    let nextDeadlineMs: number | null = null
    for (const participant of this.participants.values()) {
      if (!participant.connected || !participant.ready || !participant.mediaMatches)
        continue

      const deadlineMs = this.participantHealthDeadlineMs(participant)
      if (deadlineMs === null)
        continue
      if (nextDeadlineMs === null || deadlineMs < nextDeadlineMs)
        nextDeadlineMs = deadlineMs
    }
    return nextDeadlineMs
  }

  evaluateHealth(nowMs: number = this.now()): RoomResult | null {
    if (this.playback.status !== 'playing')
      return null

    for (const participant of this.participants.values()) {
      if (!participant.connected || !participant.ready || !participant.mediaMatches)
        continue

      const failureReason = this.participantHealthFailureReason(participant, nowMs)
      if (failureReason === null)
        continue

      const activeOperation = this.contract.mode === 'transactional'
        && this.contract.operation
        && this.contract.operation.phase !== 'cancelled'
        && this.contract.operation.phase !== 'failed'
        ? this.contract.operation
        : null
      const recoveryPosition = activeOperation?.phase === 'started'
        ? expectedPosition(this.playback, nowMs, this.media?.durationSeconds ?? null)
        : activeOperation?.targetPositionSeconds ?? expectedPosition(this.playback, nowMs, this.media?.durationSeconds ?? null)
      if (activeOperation)
        this.cancelOperation('manual-recovery', nowMs, false)
      this.playback = {
        status: 'paused',
        positionSeconds: this.clampToMediaDuration(Math.max(0, recoveryPosition)),
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
      for (const other of this.participants.values()) {
        if (!other.connected)
          other.playbackStatus = 'unknown'
        else if (!other.mediaMatches)
          other.playbackStatus = 'wrong-media'
        else if (other.id === participant.id)
          other.playbackStatus = failureReason === 'participant_playback_silent' ? 'silent' : 'recovery-required'
        else
          other.playbackStatus = other.ready ? 'ready' : 'preparing'
      }
      this.revision += 1
      this.markStateBarrier()
      return this.success(failureReason)
    }

    return null
  }

  private participantHealthDeadlineMs(participant: InternalParticipant): number | null {
    if (participant.lastSample === null || participant.lastSample.playbackStarted === false)
      return playbackStartupDeadlineMs(this.playback)

    const deadlines = [playbackReportSilenceDeadlineMs(
      this.playback,
      participant.lastSampleReceivedAtMs ?? this.playback.effectiveAtServerMs,
    )]
    if (!participant.lastSample.paused && !participant.lastSample.buffering) {
      const lastProgressAtServerMs = participant.lastProgressAtServerMs ?? this.playback.effectiveAtServerMs
      let progressDeadlineMs = playbackProgressDeadlineMs(this.playback, lastProgressAtServerMs)
      if (this.isAwaitingTransactionalStart(participant.id))
        progressDeadlineMs = Math.max(progressDeadlineMs, this.playback.effectiveAtServerMs + PLAYBACK_STARTUP_GRACE_MS)
      deadlines.push(progressDeadlineMs)
    }
    return Math.min(...deadlines)
  }

  private participantHealthFailureReason(participant: InternalParticipant, nowMs: number): string | null {
    if (participant.lastSample === null)
      return nowMs >= playbackStartupDeadlineMs(this.playback) ? 'participant_playback_silent' : null
    if (participant.lastSample.playbackStarted === false)
      return nowMs >= playbackStartupDeadlineMs(this.playback) ? 'participant_playback_startup_timeout' : null

    const lastSampleReceivedAtMs = participant.lastSampleReceivedAtMs ?? this.playback.effectiveAtServerMs
    if (nowMs >= playbackReportSilenceDeadlineMs(this.playback, lastSampleReceivedAtMs)
      && (participant.lastSample.paused || participant.lastSample.buffering))
      return 'participant_playback_silent'

    if (!participant.lastSample.paused && !participant.lastSample.buffering) {
      const lastProgressAtServerMs = participant.lastProgressAtServerMs ?? this.playback.effectiveAtServerMs
      const progressDeadlineMs = this.isAwaitingTransactionalStart(participant.id)
        ? Math.max(playbackProgressDeadlineMs(this.playback, lastProgressAtServerMs), this.playback.effectiveAtServerMs + PLAYBACK_STARTUP_GRACE_MS)
        : playbackProgressDeadlineMs(this.playback, lastProgressAtServerMs)
      if (nowMs >= progressDeadlineMs)
        return 'participant_playback_stalled'
    }

    return nowMs >= playbackReportSilenceDeadlineMs(this.playback, lastSampleReceivedAtMs)
      ? 'participant_playback_silent'
      : null
  }

  private isAwaitingTransactionalStart(participantId: string): boolean {
    const operation = this.contract.operation
    return this.contract.mode === 'transactional'
      && operation?.phase === 'committed'
      && !operation.startedParticipantIds.includes(participantId)
  }

  transferControl(fromParticipantId: string, toParticipantId: string, leaseEpoch: number): RoomResult {
    if (fromParticipantId !== this.controllerId || leaseEpoch !== this.leaseEpoch)
      return this.failure('controller_only', 'Only the current controller can pass control.')

    const nextController = this.participants.get(toParticipantId)
    if (!nextController || !nextController.connected)
      return this.failure('participant_unavailable', 'That participant is not connected.')

    // A controller lease change invalidates the operation authority that
    // created a pending seek. Cancel that barrier before changing the lease,
    // otherwise its old revision could still collect acknowledgements and
    // resume playback after control has moved to another participant.
    if (this.pendingSeek || this.hasActiveOperation())
      this.pauseForMembershipChange('superseded')

    const current = this.participants.get(this.controllerId)
    if (current)
      current.role = 'member'

    this.controllerId = nextController.id
    nextController.role = 'controller'
    this.leaseEpoch += 1
    this.revision += 1
    this.markStateBarrier()
    return this.success('control_transferred')
  }

  openLink(participantId: string, intent: OpenLinkIntent): RoomResult {
    if (this.actionIds.has(intent.actionId))
      return this.success('duplicate_action')
    if (participantId !== this.controllerId)
      return this.failure('controller_only', 'Only the controller can open a link for the room.')
    if (intent.leaseEpoch !== this.leaseEpoch)
      return this.failure('stale_lease', 'Control changed hands. Refreshing room state.')
    if (intent.basedOnRevision > this.revision)
      return this.failure('future_revision', 'The link referenced room state that has not arrived yet.')
    if (intent.basedOnRevision < this.controlRevisionFloor)
      return this.failure('stale_context', 'The room changed before this link was applied.')

    const url = normalizePageUrl(intent.url)
    if (!url)
      return this.failure('invalid_url', 'Enter a valid HTTP or HTTPS video page link.')

    // A localized Crunchyroll route can change its title or path while still
    // identifying the same strong watch ID. Reopening that page would cancel
    // valid readiness and needlessly advance the media epoch, so treat it as
    // a confirmed no-op. Weak identities are only a no-op when their
    // normalized page URL is unchanged.
    if (mediaMatchesPageUrl(this.media, url)
      || (this.navigation !== null && normalizePageUrl(this.navigation.url) === url)) {
      this.rememberAction(intent.actionId)
      return this.success('navigation_unchanged')
    }

    this.rememberAction(intent.actionId)
    this.pauseForMembershipChange('media-changed')
    this.contract.mediaEpoch += 1
    this.contract.operation = null
    for (const participant of this.participants.values()) {
      participant.ready = false
      participant.mediaMatches = false
      participant.playbackStatus = participant.connected ? 'wrong-media' : 'unknown'
    }
    this.media = {
      service: 'shared-link',
      canonicalId: `page:${url}`,
      title: new URL(url).hostname,
      durationSeconds: null,
      pageUrl: url,
    }
    // pauseForMembershipChange() just extrapolated the PREVIOUS media's
    // position forward in time -- correct for a membership change mid-video,
    // but wrong here: a newly shared link is an unrelated video, never a
    // continuation of whatever the room was previously watching. Left as-is,
    // an episode transition would authoritatively "pause" the brand-new
    // episode wherever the old one happened to be (a real bug a friend hit:
    // switching episodes started the new one seconds from its own end).
    this.playback = {
      status: 'paused',
      positionSeconds: 0,
      effectiveAtServerMs: this.now(),
      playbackRate: 1,
    }
    this.revision += 1
    this.markStateBarrier()
    this.navigation = {
      revision: this.revision,
      url,
      effectiveAtServerMs: this.now() + Math.max(500, this.commandLeadMs()),
    }
    return this.success('link_opened')
  }

  updatePlayerStatus(participantId: string, basedOnRevision: number, sample: PlayerSample): RoomResult | null {
    const participant = this.participants.get(participantId)
    // A queued report from a superseded command must not overwrite the
    // current sample or reset the progress deadline before it is rejected.
    if (!participant || basedOnRevision !== this.revision)
      return null

    const priorSample = participant.lastSample
    if (priorSample !== null && sample.sampledAtLocalMs < priorSample.sampledAtLocalMs)
      return null

    const nowMs = this.now()
    const previousStatus = participant.playbackStatus ?? this.participantPlaybackStatus(participant, nowMs)
    const activeTransactionalOperation = this.contract.mode === 'transactional'
      && this.contract.operation
      && this.contract.operation.phase !== 'cancelled'
      && this.contract.operation.phase !== 'failed'
      ? this.contract.operation
      : null
    const waitingForTransactionalStart = activeTransactionalOperation?.phase === 'committed'
      && !activeTransactionalOperation.startedParticipantIds.includes(participantId)
    // Explicit progress evidence is authoritative. currentTime can advance
    // due to correction seeks even when an adaptive player decodes no frames.
    // Keep the positional fallback only for clients that omit this field.
    const progressed = sample.progressed ?? (priorSample !== null
      && Math.abs(sample.positionSeconds - priorSample.positionSeconds) >= 0.12)
    participant.lastSample = sample
    participant.lastSampleReceivedAtMs = nowMs
    if (progressed || participant.lastProgressAtServerMs === undefined)
      participant.lastProgressAtServerMs = nowMs
    participant.playbackStatus = this.participantPlaybackStatus(participant, nowMs)
    const stallWatchdogActive = !waitingForTransactionalStart
      || isPlaybackPastStartupGrace(this.playback, nowMs)
    const stalled = stallWatchdogActive
      && !sample.paused
      && !sample.buffering
      && sample.playbackStarted !== false
      && hasPlaybackProgressStalled(this.playback, participant.lastProgressAtServerMs, nowMs)
    const startupTimedOut = !progressed
      && hasPlaybackStartupTimedOut(this.playback, sample.playbackStarted, nowMs)
      && nowMs - participant.lastProgressAtServerMs >= PLAYBACK_STARTUP_TIMEOUT_MS
    const explicitPlaybackFailure = sample.playbackStartFailed === true
    if (basedOnRevision === this.revision
      && participant.connected
      && participant.ready
      && participant.mediaMatches
      && (explicitPlaybackFailure
        || (sample.buffering && sample.playbackStarted !== false && isPlaybackPastStartupGrace(this.playback, nowMs))
        || stalled
        || startupTimedOut)) {
      const failedSeekTarget = this.pendingSeek?.revision === basedOnRevision
        ? this.pendingSeek.positionSeconds
        : null
      // A required member that explicitly failed cannot be removed from the
      // seek quorum while the old operation remains live. Cancel the barrier
      // and preserve its fixed target, so late ACKs become stale and cannot
      // restart the room with a smaller membership set.
      if (failedSeekTarget !== null)
        this.pendingSeek = null
      const expectedRecoveryPosition = activeTransactionalOperation
        ? (activeTransactionalOperation.phase === 'started'
          ? expectedPosition(this.playback, nowMs, this.media?.durationSeconds ?? null)
          : activeTransactionalOperation.targetPositionSeconds)
        : null
      if (activeTransactionalOperation)
        this.cancelOperation(explicitPlaybackFailure ? 'start-rejected' : startupTimedOut ? 'start-timeout' : 'manual-recovery', nowMs, false)
      this.playback = {
        status: 'paused',
        positionSeconds: this.clampToMediaDuration(Math.max(0, expectedRecoveryPosition ?? failedSeekTarget ?? sample.positionSeconds)),
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
      this.revision += 1
      this.markStateBarrier()
      // A rejected play() call means this participant's browser won't start
      // without a fresh user gesture -- nothing else in the room state
      // reflects that. Without clearing readiness here, everyoneReady()
      // still reports true, so a controller who immediately presses play
      // again re-triggers the identical rejection, and the room now has no
      // record of who caused the pause or why it keeps recurring. Buffering
      // and stall reports are left alone: those usually resolve on their
      // own without a click.
      if (explicitPlaybackFailure)
        participant.ready = false
      participant.playbackStatus = explicitPlaybackFailure ? 'blocked' : 'recovery-required'
      return this.success(explicitPlaybackFailure
        ? 'participant_playback_blocked'
        : startupTimedOut ? 'participant_playback_startup_timeout'
          : stalled ? 'participant_playback_stalled' : 'participant_buffering')
    }

    if (participant.playbackStatus !== previousStatus)
      return this.success('participant_status_changed')

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
    participant.playbackStatus = 'unknown'

    this.pauseForMembershipChange('participant-disconnected')

    this.revision += 1
    this.markStateBarrier()
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

    if (this.hasActiveOperation())
      this.pauseForMembershipChange('participant-disconnected')
    if (current)
      current.role = 'member'
    next.role = 'controller'
    this.controllerId = next.id
    this.leaseEpoch += 1
    this.revision += 1
    this.markStateBarrier()
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
      seek: this.pendingSeek ? structuredClone(this.pendingSeek) : null,
      navigation: this.navigation ? { ...this.navigation } : null,
      participants: [...this.participants.values()]
        .sort((a, b) => a.joinedAtMs - b.joinedAtMs)
        .map((participant) => {
          const {
            joinedAtMs: _joinedAtMs,
            sessionToken: _sessionToken,
            media: _media,
            lastSample: _lastSample,
            lastSampleReceivedAtMs: _lastSampleReceivedAtMs,
            lastProgressAtServerMs: _lastProgressAtServerMs,
            capabilities: _capabilities,
            lastOperationObservation: _lastOperationObservation,
            ...publicParticipant
          } = participant
          return { ...publicParticipant }
        }),
      // Deliberately excludes media, sessionToken, capability advertisements,
      // and observation bookkeeping, matching the minimal-exposure discipline
      // used by the rest of the room snapshot.
      pendingJoinRequests: [...this.pendingJoinRequests.values()].map(request => ({
        id: request.id,
        name: request.name,
        requestedAtMs: request.requestedAtMs,
      })),
      policy: { buffering: 'pause-all' },
      contract: structuredClone(this.contract),
    }
  }

  private participantPlaybackStatus(participant: InternalParticipant, nowMs: number) {
    return participantPlaybackStatus({
      connected: participant.connected,
      ready: participant.ready,
      mediaMatches: participant.mediaMatches,
      playback: this.playback,
      operation: this.contract.operation,
      pendingSeek: this.pendingSeek !== null,
      sample: participant.lastSample,
      lastSampleReceivedAtMs: participant.lastSampleReceivedAtMs,
      lastProgressAtServerMs: participant.lastProgressAtServerMs,
      nowMs,
    })
  }

  private markParticipantStatuses(status: 'preparing' | 'seeking' | 'ready' | 'recovery-required'): void {
    for (const participant of this.participants.values()) {
      if (!participant.connected)
        participant.playbackStatus = 'unknown'
      else if (!participant.mediaMatches)
        participant.playbackStatus = 'wrong-media'
      else if (!participant.ready)
        participant.playbackStatus = 'preparing'
      else
        participant.playbackStatus = status
    }
  }

  private everyoneReady(): boolean {
    const connected = [...this.participants.values()].filter(participant => participant.connected)
    return connected.length > 0 && connected.every(participant => participant.ready && participant.mediaMatches)
  }

  private controlTransactional(kind: ControlKind, positionSeconds: number, nowMs: number, leadMs: number): RoomResult {
    if (kind === 'pause') {
      this.cancelOperation('controller-request', nowMs, false)
      this.pendingSeek = null
      this.playback = {
        status: 'paused',
        positionSeconds,
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
      this.revision += 1
      return this.success('control_pause')
    }

    const resumeWhenReady = kind === 'seek' && this.playback.status === 'playing'
    this.cancelOperation('superseded', nowMs)
    this.pendingSeek = null
    const operation: RoomOperation = {
      mediaEpoch: this.contract.mediaEpoch,
      operationId: `operation_${crypto.randomUUID().replaceAll('-', '')}`,
      kind,
      phase: 'preparing',
      requiredParticipantIds: this.requiredParticipantIds(),
      preparedParticipantIds: [],
      startedParticipantIds: [],
      targetPositionSeconds: positionSeconds,
      resumeWhenReady: kind === 'seek' ? resumeWhenReady : true,
      effectiveAtServerMs: null,
      deadlineAtServerMs: nowMs + SEEK_BARRIER_MAX_WAIT_MS,
    }
    this.contract.operation = operation
    this.playback = {
      status: 'paused',
      positionSeconds,
      effectiveAtServerMs: nowMs + (kind === 'play' ? leadMs : 0),
      playbackRate: 1,
    }
    this.markParticipantStatuses(kind === 'seek' ? 'seeking' : 'preparing')
    this.revision += 1
    return this.success(kind === 'seek' ? 'control_seek_pending' : 'control_play_pending')
  }

  private requiredParticipantIds(): string[] {
    return [...this.participants.values()]
      .filter(participant => participant.connected && participant.ready && participant.mediaMatches)
      .sort((a, b) => a.joinedAtMs - b.joinedAtMs)
      .map(participant => participant.id)
  }

  private hasActiveOperation(): boolean {
    const operation = this.contract.operation
    return operation !== null && operation.phase !== 'cancelled' && operation.phase !== 'failed'
  }

  private participantCapabilities(participantId: string): ClientCapabilities {
    return normalizeClientCapabilities(this.participants.get(participantId)?.capabilities)
  }

  private expectedOperationPosition(operation: RoomOperation, nowMs: number): number {
    if (operation.targetPositionSeconds !== null && (operation.phase === 'preparing' || operation.phase === 'prepared'))
      return operation.targetPositionSeconds
    return expectedPosition(this.playback, nowMs, this.media?.durationSeconds ?? null)
  }

  private pauseAtOperationTarget(operation: RoomOperation, nowMs: number): void {
    const positionSeconds = operation.targetPositionSeconds !== null
      ? operation.targetPositionSeconds
      : expectedPosition(this.playback, nowMs, this.media?.durationSeconds ?? null)
    this.playback = {
      status: 'paused',
      positionSeconds: this.clampToMediaDuration(Math.max(0, positionSeconds)),
      effectiveAtServerMs: nowMs,
      playbackRate: 1,
    }
  }

  private cancelOperation(reason: NonNullable<RoomOperation['reason']>, nowMs: number, preserveTarget = true): void {
    const operation = this.contract.operation
    if (!operation || operation.phase === 'cancelled' || operation.phase === 'failed')
      return
    if (preserveTarget)
      this.pauseAtOperationTarget(operation, nowMs)
    operation.phase = 'cancelled'
    operation.reason = reason
    operation.effectiveAtServerMs = null
  }

  private refreshNegotiation(): void {
    const advertisements = [...this.participants.values()]
      .filter(participant => participant.connected)
      .map(participant => ({
        participantId: participant.id,
        capabilities: normalizeClientCapabilities(participant.capabilities),
      }))
    const negotiation = negotiateRoomMode(advertisements)
    const activeOperation = this.contract.operation
    this.contract = {
      mode: negotiation.mode,
      mediaEpoch: this.contract.mediaEpoch,
      sharedCapabilities: [...negotiation.sharedCapabilities],
      operation: activeOperation,
    }
    if (negotiation.mode !== 'transactional' && activeOperation
      && activeOperation.phase !== 'cancelled' && activeOperation.phase !== 'failed') {
      this.cancelOperation('legacy-peer', this.now())
      this.revision += 1
      this.markStateBarrier()
    }
  }

  /**
   * State written before CR-B02 had no contract section, but it could still
   * contain a legacy pending seek. That seek's acknowledgement list is
   * historical evidence from the old state machine, not preparation evidence
   * for a new operation. Drop the barrier and resume paused at its fixed
   * target so neither a late ACK nor a mixed-version client can restart it.
   */
  private migratePreContractState(restoredPendingSeek: SharedSeek | null): void {
    const positionSeconds = restoredPendingSeek?.positionSeconds ?? this.playback.positionSeconds
    this.pendingSeek = null
    this.playback = {
      status: 'paused',
      positionSeconds: this.clampToMediaDuration(Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0),
      effectiveAtServerMs: this.now(),
      playbackRate: 1,
    }
    this.revision += 1
    this.markStateBarrier()
  }

  private commandLeadMs(): number {
    const latencies = [...this.participants.values()]
      .filter(participant => participant.connected && participant.latencyMs !== null)
      .map(participant => participant.latencyMs as number)

    const slowestRoundTripMs = latencies.length > 0 ? Math.max(...latencies) : 120
    return Math.round(Math.max(140, Math.min(500, slowestRoundTripMs / 2 + 80)))
  }

  private pauseForMembershipChange(reason: RoomOperation['reason'] = 'participant-disconnected'): void {
    if (this.contract.mode === 'transactional')
      this.cancelOperation(reason, this.now())
    this.pendingSeek = null
    if (this.playback.status !== 'playing')
      return
    const nowMs = this.now()
    this.playback = {
      status: 'paused',
      positionSeconds: expectedPosition(this.playback, nowMs, this.media?.durationSeconds ?? null),
      effectiveAtServerMs: nowMs,
      playbackRate: 1,
    }
  }

  private resetPlaybackHealth(effectiveAtServerMs: number): void {
    for (const participant of this.participants.values()) {
      participant.lastSample = null
      participant.lastSampleReceivedAtMs = effectiveAtServerMs
      participant.lastProgressAtServerMs = effectiveAtServerMs
    }
  }

  private clampToMediaDuration(positionSeconds: number): number {
    const durationSeconds = this.media?.durationSeconds
    return typeof durationSeconds === 'number' ? Math.min(positionSeconds, durationSeconds) : positionSeconds
  }

  private markStateBarrier(): void {
    this.controlRevisionFloor = this.revision
  }

  private rememberAction(actionId: string): void {
    this.actionIds.add(actionId)
    if (this.actionIds.size <= 500)
      return
    const oldest = this.actionIds.values().next().value
    if (typeof oldest === 'string')
      this.actionIds.delete(oldest)
  }

  private success(reason: string): RoomResult {
    return { ok: true, reason, snapshot: this.snapshot() }
  }

  private failure(code: string, message: string): RoomResult {
    return { ok: false, code, message, snapshot: this.snapshot() }
  }
}

function normalizeRestoredPendingSeek(value: unknown): SharedSeek | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.revision) || typeof candidate.revision !== 'number' || candidate.revision < 0
    || typeof candidate.positionSeconds !== 'number' || !Number.isFinite(candidate.positionSeconds) || candidate.positionSeconds < 0
    || typeof candidate.resumeWhenReady !== 'boolean'
    || typeof candidate.deadlineAtServerMs !== 'number' || !Number.isFinite(candidate.deadlineAtServerMs) || candidate.deadlineAtServerMs < 0
    || !Array.isArray(candidate.acknowledgedParticipantIds)
    || !candidate.acknowledgedParticipantIds.every(participantId => typeof participantId === 'string'))
    return null
  return {
    revision: candidate.revision,
    positionSeconds: candidate.positionSeconds,
    resumeWhenReady: candidate.resumeWhenReady,
    deadlineAtServerMs: candidate.deadlineAtServerMs,
    acknowledgedParticipantIds: [...candidate.acknowledgedParticipantIds],
  }
}
