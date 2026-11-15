import type { ProgressEvidenceQuality } from '@syncyourjoy/protocol'

/**
 * How long the verdict of a periodic sample is carried by the media-event
 * reports that follow it. The sample is taken once a second.
 */
const PERIODIC_VERDICT_FRESH_MS = 1_500

export interface PlayerHealthBaselineInput {
  nowMs: number
  positionSeconds: number
  frames: number | null
}

export interface PlayerHealthObservation extends PlayerHealthBaselineInput {
  /**
   * False for an observation triggered by a media event rather than by the
   * periodic sample. Such an observation reads the progress accumulated since
   * the last periodic sample and never moves that sample's cursor, so it can
   * neither erase the evidence the next periodic check needs nor report
   * "no progress" merely because it fell between two frames. Defaults to true.
   */
  periodic?: boolean
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
  /** When the last observation of any kind was made. */
  observedAtMs: number
  /**
   * The cursor that progress is measured from: where the last periodic sample
   * (or a reset) left the position and frame counter. Media-event observations
   * leave it alone.
   */
  observedPositionSeconds: number
  observedFrames: number | null
  buffering: boolean
  progressed: boolean
  progressEvidence: ProgressEvidenceQuality
  lastProgressAtMs: number
  /** What the last periodic sample said about progress, and when it was taken. Media-event reports carry it for a short while. */
  periodicProgressed: boolean
  periodicAtMs: number
  /** Any forward progress was seen for this source and command: a frame counter or the media clock. */
  hasRealPlaybackProgress: boolean
  /**
   * A frame counter advanced for this source and command. Only this is rendered-frame
   * evidence; the media clock alone is not (owner decision on #53).
   */
  hasRenderedFrameProgress: boolean
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
    periodicProgressed: false,
    periodicAtMs: baseline.nowMs,
    hasRealPlaybackProgress: false,
    hasRenderedFrameProgress: false,
    unexpectedPauseSinceMs: 0,
    playbackStartFailed: false,
  }
}

/**
 * Rebase the observation cursors without pretending that a video advanced.
 * Visibility restoration preserves already-known health signals, while a
 * source or command reset clears them for the new playback operation.
 *
 * A permission rejection is not a progress signal and survives both: the
 * room's own pause after a rejected play() is a command reset, and clearing
 * the fault there erased the blocked state before anyone could act on it
 * (#68). Only `clearPlaybackStartFailed` removes it.
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
    periodicProgressed: false,
    periodicAtMs: baseline.nowMs,
    unexpectedPauseSinceMs: 0,
  }
  if (preserveCurrentSignal)
    return next
  return {
    ...next,
    buffering: false,
    progressEvidence: 'unknown',
    lastProgressAtMs: baseline.nowMs,
    hasRealPlaybackProgress: false,
    hasRenderedFrameProgress: false,
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
  const next = observeAgainstCursor(previous, input)
  if (input.periodic !== false)
    return { ...next, periodicProgressed: next.progressed, periodicAtMs: next.observedAtMs }
  // A media-event observation sees the progress accumulated since the last periodic
  // sample. It keeps that sample's cursor, so the next periodic check still sees
  // the progress, and it carries a fresh periodic verdict when it falls between two
  // frames instead of reporting "no progress" for a healthy player. A stale verdict
  // is not carried, so a freeze is still reported by the events that follow it.
  const carriesPeriodicVerdict = !next.progressed
    && input.roomPlaying
    && !input.paused
    && !input.seeking
    && !input.localSeeking
    && !input.lacksPlayableData
    && previous.periodicProgressed
    && next.observedAtMs - previous.periodicAtMs < PERIODIC_VERDICT_FRESH_MS
    && !next.buffering
    && (next.progressEvidence === 'frames' || next.progressEvidence === 'clock')
  return {
    ...next,
    observedPositionSeconds: previous.observedPositionSeconds,
    observedFrames: previous.observedFrames,
    progressed: next.progressed || carriesPeriodicVerdict,
  }
}

function observeAgainstCursor(previous: PlayerHealthState, input: PlayerHealthObservation): PlayerHealthState {
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
    // A waiting latch survives the startup window; only advancing frames clear it.
    next.buffering = previous.buffering
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
        next.buffering = false
        next.lastProgressAtMs = observation.nowMs
        next.hasRealPlaybackProgress = true
        next.hasRenderedFrameProgress = previous.hasRenderedFrameProgress || evidence.quality === 'frames'
        return next
      }
    }
    next.lastProgressAtMs = observation.nowMs
    return next
  }

  if (observation.playShouldHaveStarted
    && (observation.paused || observation.lacksPlayableData)
    && !observation.localIntentHold) {
    if (next.unexpectedPauseSinceMs === 0)
      next.unexpectedPauseSinceMs = observation.nowMs
    next.buffering = observation.explicitlyBuffering
      || previous.buffering
      || observation.nowMs - next.unexpectedPauseSinceMs >= 1_500
    return next
  }

  next.unexpectedPauseSinceMs = 0
  if (!observation.roomPlaying || observation.paused || observation.seeking || observation.localSeeking) {
    next.buffering = observation.explicitlyBuffering
    next.progressed = false
    next.progressEvidence = 'unknown'
    next.lastProgressAtMs = observation.nowMs
    return next
  }

  const evidence = compareProgress(previous, observation)
  next.progressEvidence = evidence.quality
  if (evidence.counterReset) {
    next.buffering = observation.explicitlyBuffering || previous.buffering
    return next
  }

  if (evidence.advanced) {
    next.progressed = true
    next.buffering = false
    next.lastProgressAtMs = observation.nowMs
    next.hasRealPlaybackProgress = true
    next.hasRenderedFrameProgress = previous.hasRenderedFrameProgress || evidence.quality === 'frames'
  }
  else {
    // Once the element has said it is waiting, keep saying so until frames
    // advance again. Recomputing the flag from each heartbeat dropped it for the
    // first 2.5 s of a stall, which is shorter than the coordinator's 1.8 s
    // no-progress deadline plus a report interval, so the room was paused as a
    // failed player instead of waiting for the buffering grace period.
    next.buffering = observation.explicitlyBuffering
      || previous.buffering
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
