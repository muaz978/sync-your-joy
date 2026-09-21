import type { ProgressEvidenceQuality } from '@syncyourjoy/protocol'

export interface PlayerHealthBaselineInput {
  nowMs: number
  positionSeconds: number
  frames: number | null
}

export interface PlayerHealthObservation extends PlayerHealthBaselineInput {
  paused: boolean
  seeking: boolean
  localSeeking: boolean
  roomPlaying: boolean
  playShouldHaveStarted: boolean
  lacksPlayableData: boolean
  explicitlyBuffering: boolean
  localIntentHold: boolean
}

/**
 * This is the one local health snapshot used by periodic reports, context
 * refreshes and diagnostics. It contains only playback state and evidence
 * quality, never media bytes, credentials or provider-specific data.
 */
export interface PlayerHealthState {
  observedAtMs: number
  observedPositionSeconds: number
  observedFrames: number | null
  buffering: boolean
  progressed: boolean
  progressEvidence: ProgressEvidenceQuality
  lastProgressAtMs: number
  lastProgressPositionSeconds: number
  lastProgressFrames: number | null
  hasRealPlaybackProgress: boolean
  unexpectedPauseSinceMs: number
  playbackStartFailed: boolean
}

export function createPlayerHealthState(input: PlayerHealthBaselineInput): PlayerHealthState {
  const baseline = normalizedBaseline(input)
  return {
    observedAtMs: baseline.nowMs,
    observedPositionSeconds: baseline.positionSeconds,
    observedFrames: baseline.frames,
    buffering: false,
    progressed: false,
    progressEvidence: 'unknown',
    lastProgressAtMs: baseline.nowMs,
    lastProgressPositionSeconds: baseline.positionSeconds,
    lastProgressFrames: baseline.frames,
    hasRealPlaybackProgress: false,
    unexpectedPauseSinceMs: 0,
    playbackStartFailed: false,
  }
}

/**
 * Rebase the observation cursors without pretending that a video advanced.
 * Visibility restoration preserves already-known health signals, while a
 * source or command reset clears them for the new playback operation.
 */
export function resetPlayerHealthBaseline(
  previous: PlayerHealthState,
  input: PlayerHealthBaselineInput,
  preserveCurrentSignal = false,
): PlayerHealthState {
  const baseline = normalizedBaseline(input)
  const next: PlayerHealthState = {
    ...previous,
    observedAtMs: baseline.nowMs,
    observedPositionSeconds: baseline.positionSeconds,
    observedFrames: baseline.frames,
    progressed: false,
    unexpectedPauseSinceMs: 0,
  }
  if (preserveCurrentSignal)
    return next
  return {
    ...next,
    buffering: false,
    progressEvidence: 'unknown',
    lastProgressAtMs: baseline.nowMs,
    lastProgressPositionSeconds: baseline.positionSeconds,
    lastProgressFrames: baseline.frames,
    hasRealPlaybackProgress: false,
    playbackStartFailed: false,
  }
}

export function markPlayerHealthBuffering(previous: PlayerHealthState): PlayerHealthState {
  return {
    ...previous,
    buffering: true,
    progressed: false,
  }
}

export function markPlaybackStartFailed(previous: PlayerHealthState): PlayerHealthState {
  return { ...previous, playbackStartFailed: true }
}

export function clearPlaybackStartFailed(previous: PlayerHealthState): PlayerHealthState {
  return { ...previous, playbackStartFailed: false }
}

export function observePlayerHealth(previous: PlayerHealthState, input: PlayerHealthObservation): PlayerHealthState {
  const observation = normalizedObservation(input)
  const next: PlayerHealthState = {
    ...previous,
    observedAtMs: observation.nowMs,
    observedPositionSeconds: observation.positionSeconds,
    observedFrames: observation.frames,
    progressed: false,
  }

  if (observation.roomPlaying && !observation.playShouldHaveStarted) {
    next.unexpectedPauseSinceMs = 0
    next.buffering = false
    // A transactional player can render real frames before the server's
    // startup grace boundary. Keep that evidence so the extension can send
    // its started acknowledgement before the coordinator's first bounded
    // no-progress deadline. The grace window still suppresses failure
    // classification on the coordinator; it must not suppress proof that
    // native playback has actually begun.
    if (!observation.paused && !observation.seeking && !observation.localSeeking && !observation.lacksPlayableData) {
      const evidence = compareProgress(previous, observation)
      next.progressEvidence = evidence.quality
      if (evidence.advanced) {
        next.progressed = true
        next.lastProgressAtMs = observation.nowMs
        next.lastProgressPositionSeconds = observation.positionSeconds
        next.lastProgressFrames = observation.frames
        next.hasRealPlaybackProgress = true
        return next
      }
    }
    next.lastProgressAtMs = observation.nowMs
    next.lastProgressPositionSeconds = observation.positionSeconds
    next.lastProgressFrames = observation.frames
    return next
  }

  if (observation.playShouldHaveStarted
    && (observation.paused || observation.lacksPlayableData)
    && !observation.localIntentHold) {
    if (next.unexpectedPauseSinceMs === 0)
      next.unexpectedPauseSinceMs = observation.nowMs
    next.buffering = observation.explicitlyBuffering
      || observation.nowMs - next.unexpectedPauseSinceMs >= 1_500
    return next
  }

  next.unexpectedPauseSinceMs = 0
  if (!observation.roomPlaying || observation.paused || observation.seeking || observation.localSeeking) {
    next.buffering = observation.explicitlyBuffering
    next.progressed = false
    next.progressEvidence = 'unknown'
    next.lastProgressAtMs = observation.nowMs
    next.lastProgressPositionSeconds = observation.positionSeconds
    next.lastProgressFrames = observation.frames
    return next
  }

  const evidence = compareProgress(previous, observation)
  next.progressEvidence = evidence.quality
  if (evidence.counterReset) {
    next.buffering = observation.explicitlyBuffering
    return next
  }

  if (evidence.advanced) {
    next.progressed = true
    next.buffering = false
    next.lastProgressAtMs = observation.nowMs
    next.lastProgressPositionSeconds = observation.positionSeconds
    next.lastProgressFrames = observation.frames
    next.hasRealPlaybackProgress = true
  }
  else {
    next.buffering = observation.explicitlyBuffering
      || observation.nowMs - next.lastProgressAtMs >= 2_500
  }
  return next
}

function compareProgress(previous: PlayerHealthState, observation: PlayerHealthObservation): {
  advanced: boolean
  counterReset: boolean
  quality: ProgressEvidenceQuality
} {
  if (observation.frames !== null && previous.observedFrames !== null) {
    if (observation.frames < previous.observedFrames)
      return { advanced: false, counterReset: true, quality: 'unknown' }
    return {
      advanced: observation.frames > previous.observedFrames,
      counterReset: false,
      quality: 'frames',
    }
  }

  return {
    advanced: observation.positionSeconds - previous.observedPositionSeconds >= 0.12,
    counterReset: false,
    quality: 'clock',
  }
}

function normalizedBaseline(input: PlayerHealthBaselineInput): PlayerHealthBaselineInput {
  return {
    nowMs: finiteOrZero(input.nowMs),
    positionSeconds: finiteOrZero(input.positionSeconds),
    frames: normalizeFrames(input.frames),
  }
}

function normalizedObservation(input: PlayerHealthObservation): PlayerHealthObservation {
  return {
    ...input,
    ...normalizedBaseline(input),
  }
}

function normalizeFrames(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}
