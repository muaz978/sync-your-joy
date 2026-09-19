import type {
  ControlKind,
  MediaFingerprint,
  ParticipantState,
  PlaybackState,
  PlayerSample,
  RoomSnapshot,
  SharedSeek,
  SharedNavigation,
} from '@syncyourjoy/protocol'
import { mediaMatches, normalizePageUrl } from '@syncyourjoy/protocol'
import { expectedPosition } from './clock.ts'
import { hasPlaybackProgressStalled, hasPlaybackStartupTimedOut, isPlaybackPastStartupGrace, PLAYBACK_STARTUP_TIMEOUT_MS } from './playback-health.ts'
import { isSeekAligned, SEEK_BARRIER_MAX_WAIT_MS } from './seek-barrier.ts'

export interface InternalParticipant extends ParticipantState {
  joinedAtMs: number
  /** Random capability used only to resume this participant session. */
  sessionToken?: string
  media: MediaFingerprint | null
  lastSample: PlayerSample | null
  lastSampleReceivedAtMs?: number
  lastProgressAtServerMs?: number
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
  requestedAtMs: number
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
  navigation?: SharedNavigation | null
  controlRevisionFloor?: number
  pendingSeek?: SharedSeek | null
  pendingJoinRequests?: InternalPendingJoinRequest[]
}

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

  constructor(
    identity: RoomIdentity,
    controller: { id: string; name: string; media: MediaFingerprint | null; sessionToken?: string },
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
      for (const participant of restoredState.participants)
        this.participants.set(participant.id, structuredClone(participant))
      for (const actionId of restoredState.actionIds)
        this.actionIds.add(actionId)
      this.navigation = restoredState.navigation ?? null
      this.controlRevisionFloor = restoredState.controlRevisionFloor ?? restoredState.revision
      this.pendingSeek = restoredState.pendingSeek ? structuredClone(restoredState.pendingSeek) : null
      for (const request of restoredState.pendingJoinRequests ?? [])
        this.pendingJoinRequests.set(request.id, structuredClone(request))
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
      ...(controller.sessionToken ? { sessionToken: controller.sessionToken } : {}),
      lastSample: null,
      lastSampleReceivedAtMs: this.now(),
      lastProgressAtServerMs: this.now(),
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
      navigation: this.navigation ? { ...this.navigation } : null,
      controlRevisionFloor: this.controlRevisionFloor,
      pendingSeek: this.pendingSeek ? structuredClone(this.pendingSeek) : null,
      pendingJoinRequests: [...this.pendingJoinRequests.values()].map(request => structuredClone(request)),
    }
  }

  join(participant: { id: string; name: string; media: MediaFingerprint | null; sessionToken?: string }): RoomResult {
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
      if (participant.sessionToken)
        existing.sessionToken = participant.sessionToken
      existing.ready = wasReady && existing.mediaMatches
      this.pauseForMembershipChange()
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
      ...(pending.sessionToken ? { sessionToken: pending.sessionToken } : {}),
      lastSample: null,
      lastSampleReceivedAtMs: this.now(),
      lastProgressAtServerMs: this.now(),
    })
    this.pauseForMembershipChange()
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
    if (participant.ready === previousReady && participant.mediaMatches === previousMediaMatches)
      return this.success('readiness_unchanged')
    if (!participant.ready)
      this.pauseForMembershipChange()
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

    this.rememberAction(intent.actionId)

    const nowMs = this.now()
    const positionSeconds = this.clampToMediaDuration(Math.max(0, intent.positionSeconds))
    const leadMs = this.commandLeadMs()

    if (intent.kind === 'pause') {
      this.pendingSeek = null
      this.playback = {
        status: 'paused',
        positionSeconds,
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
    }
    else if (intent.kind === 'play') {
      this.pendingSeek = null
      this.playback = {
        status: 'playing',
        positionSeconds,
        effectiveAtServerMs: nowMs + leadMs,
        playbackRate: 1,
      }
      for (const participant of this.participants.values()) {
        participant.lastProgressAtServerMs = this.playback.effectiveAtServerMs
      }
    }
    else {
      const resumeWhenReady = this.pendingSeek?.resumeWhenReady ?? this.playback.status === 'playing'
      this.playback = {
        status: 'paused',
        positionSeconds,
        effectiveAtServerMs: nowMs,
        playbackRate: 1,
      }
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
      return this.success('control_seek_pending')
    }

    this.revision += 1
    return this.success(`control_${intent.kind}`)
  }

  acknowledgeSeek(participantId: string, revision: number, positionSeconds: number): RoomResult | null {
    const pending = this.pendingSeek
    const participant = this.participants.get(participantId)
    if (!pending || revision !== pending.revision || !participant)
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
    this.revision += 1
    this.markStateBarrier()
    return this.success('seek_timeout_paused')
  }

  pendingSeekDeadlineMs(): number | null {
    return this.pendingSeek?.deadlineAtServerMs ?? null
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

    this.rememberAction(intent.actionId)
    this.pauseForMembershipChange()
    for (const participant of this.participants.values()) {
      participant.ready = false
      participant.mediaMatches = false
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
    // Explicit progress evidence is authoritative. currentTime can advance
    // due to correction seeks even when an adaptive player decodes no frames.
    // Keep the positional fallback only for clients that omit this field.
    const progressed = sample.progressed ?? (priorSample !== null
      && Math.abs(sample.positionSeconds - priorSample.positionSeconds) >= 0.12)
    participant.lastSample = sample
    participant.lastSampleReceivedAtMs = nowMs
    if (progressed || participant.lastProgressAtServerMs === undefined)
      participant.lastProgressAtServerMs = nowMs
    const stalled = !sample.paused
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
      this.playback = {
        status: 'paused',
        positionSeconds: this.clampToMediaDuration(Math.max(0, sample.positionSeconds)),
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
      return this.success(explicitPlaybackFailure
        ? 'participant_playback_blocked'
        : startupTimedOut ? 'participant_playback_startup_timeout'
          : stalled ? 'participant_playback_stalled' : 'participant_buffering')
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

    this.pauseForMembershipChange()

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
        .map(({ joinedAtMs: _joinedAtMs, sessionToken: _sessionToken, media: _media, lastSample: _lastSample, lastSampleReceivedAtMs: _lastSampleReceivedAtMs, lastProgressAtServerMs: _lastProgressAtServerMs, ...participant }) => ({ ...participant })),
      // Deliberately excludes `media` and `sessionToken`, matching the same
      // minimal-exposure discipline as the participants mapping above.
      pendingJoinRequests: [...this.pendingJoinRequests.values()].map(request => ({
        id: request.id,
        name: request.name,
        requestedAtMs: request.requestedAtMs,
      })),
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

  private pauseForMembershipChange(): void {
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
