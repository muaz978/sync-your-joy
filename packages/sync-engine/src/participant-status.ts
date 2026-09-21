import type { ParticipantPlaybackStatus, PlaybackState, PlayerSample, RoomOperation } from '@syncyourjoy/protocol'
import { hasPlaybackProgressStalled, hasPlaybackStartupTimedOut, playbackReportSilenceDeadlineMs, PLAYBACK_STARTUP_TIMEOUT_MS } from './playback-health.ts'

export interface ParticipantPlaybackStatusInput {
  connected: boolean
  ready: boolean
  mediaMatches: boolean
  playback: PlaybackState
  operation: RoomOperation | null
  pendingSeek: boolean
  sample: PlayerSample | null
  lastSampleReceivedAtMs: number | undefined
  lastProgressAtServerMs: number | undefined
  nowMs: number
}

/**
 * Converts internal health and operation evidence into the small status
 * vocabulary that is safe to expose to every room participant. Raw samples
 * remain coordinator-local, while the panel can still explain the next
 * useful action to a person.
 */
export function participantPlaybackStatus(input: ParticipantPlaybackStatusInput): ParticipantPlaybackStatus {
  if (!input.connected)
    return 'unknown'
  if (!input.mediaMatches)
    return 'wrong-media'
  if (input.sample?.playbackStartFailed === true)
    return 'blocked'

  const operation = input.operation && input.operation.phase !== 'cancelled' && input.operation.phase !== 'failed'
    ? input.operation
    : null
  if (input.pendingSeek || operation?.kind === 'seek' && isPreparationPhase(operation.phase))
    return 'seeking'
  if (operation && isPreparationPhase(operation.phase))
    return 'preparing'

  if (input.playback.status !== 'playing')
    return input.ready ? 'ready' : 'preparing'

  if (input.sample === null)
    return input.nowMs >= input.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS ? 'silent' : 'preparing'
  if (input.lastSampleReceivedAtMs !== undefined
    && input.nowMs >= playbackReportSilenceDeadlineMs(input.playback, input.lastSampleReceivedAtMs))
    return 'silent'
  if (input.sample.buffering)
    return 'buffering'
  if (input.sample.paused)
    return 'recovery-required'
  if (input.sample.playbackStarted === false)
    return hasPlaybackStartupTimedOut(input.playback, input.sample.playbackStarted, input.nowMs) ? 'silent' : 'preparing'
  if (input.lastProgressAtServerMs !== undefined
    && hasPlaybackProgressStalled(input.playback, input.lastProgressAtServerMs, input.nowMs))
    return 'recovery-required'
  if (input.sample.progressed === true)
    return 'playing'
  return 'preparing'
}

function isPreparationPhase(phase: RoomOperation['phase']): boolean {
  return phase === 'preparing' || phase === 'prepared' || phase === 'committed'
}
