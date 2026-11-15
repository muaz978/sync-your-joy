import type { ParticipantPlaybackStatus, ProgressEvidenceQuality } from '@syncyourjoy/protocol'

export interface LocalPlaybackStatusInput {
  connected: boolean
  hasVideo: boolean
  mediaMatches: boolean
  ready: boolean
  roomPlaying: boolean
  pendingSeek: boolean
  operationKind?: 'play' | 'seek' | 'navigation' | 'recovery' | null
  paused: boolean | null
  buffering: boolean
  playbackStartFailed: boolean
  playbackStarted: boolean | null
  progressed: boolean
  /**
   * What the progress was measured with. Only `frames` confirms playback; the
   * media clock alone does not (owner decision on #53). A caller that omits it
   * keeps the earlier behaviour, in which progress confirms playback.
   */
  progressEvidence?: ProgressEvidenceQuality
  drifted?: boolean
  progressAgeMs: number | null
  statusAgeMs: number | null
  nowMs: number
}

export interface PlaybackStatusCopy {
  label: string
  detail: string
  action: string
}

export interface LocalPlaybackClassification {
  status: ParticipantPlaybackStatus
  /**
   * The player is playing and its clock advances, but no frame counter confirms
   * rendered video. The status is then `preparing`, never `playing`, and the
   * person should be told why with `CLOCK_ONLY_PLAYBACK_COPY`.
   */
  clockOnly: boolean
}

/** Shown instead of "Playing, confirmed" for a player whose progress is measured by the media clock alone. */
export const CLOCK_ONLY_PLAYBACK_COPY: PlaybackStatusCopy = {
  label: 'Playing, not frame-confirmed',
  detail: 'No rendered-frame counter is available, so only the media clock shows progress.',
  action: 'Check that the video is moving',
}

const SILENCE_TIMEOUT_MS = 5_000
const PROGRESS_TIMEOUT_MS = 1_800

/**
 * Classifies only bounded state already owned by the extension. It never
 * reads provider internals, media bytes or credentials.
 */
export function localPlaybackStatus(input: LocalPlaybackStatusInput): ParticipantPlaybackStatus {
  return classifyLocalPlayback(input).status
}

export function classifyLocalPlayback(input: LocalPlaybackStatusInput): LocalPlaybackClassification {
  const plain = (status: ParticipantPlaybackStatus): LocalPlaybackClassification => ({ status, clockOnly: false })
  if (!input.connected)
    return plain('unknown')
  if (!input.hasVideo)
    return plain('preparing')
  if (!input.mediaMatches)
    return plain('wrong-media')
  if (input.playbackStartFailed)
    return plain('blocked')
  if (input.pendingSeek || input.operationKind === 'seek')
    return plain('seeking')
  if (!input.roomPlaying) {
    if (!input.ready)
      return plain('preparing')
    return plain(input.buffering ? 'buffering' : 'ready')
  }
  if (input.statusAgeMs !== null && input.statusAgeMs >= SILENCE_TIMEOUT_MS)
    return plain('silent')
  if (input.buffering)
    return plain('buffering')
  if (input.paused === true)
    return plain('recovery-required')
  if (input.drifted)
    return plain('recovery-required')
  if (input.playbackStarted === false)
    return plain('preparing')
  if (input.progressAgeMs !== null && input.progressAgeMs >= PROGRESS_TIMEOUT_MS)
    return plain('recovery-required')
  if (input.progressed) {
    if (input.progressEvidence === undefined || input.progressEvidence === 'frames')
      return plain('playing')
    return { status: 'preparing', clockOnly: true }
  }
  return plain('preparing')
}

/**
 * Replaces the generic "Preparing" text of a pill with `CLOCK_ONLY_PLAYBACK_COPY`. Any other
 * text (reconnecting, a seek count) is left as it is.
 */
export function withClockOnlyPillText(pill: { status: string; meta: string }, controller: boolean): { status: string; meta: string } {
  const preparing = playbackStatusCopy('preparing', controller)
  if (pill.status !== preparing.label)
    return pill
  return { status: CLOCK_ONLY_PLAYBACK_COPY.label, meta: pill.meta.replace(preparing.detail, CLOCK_ONLY_PLAYBACK_COPY.detail) }
}

export function playbackStatusCopy(status: ParticipantPlaybackStatus, controller: boolean): PlaybackStatusCopy {
  switch (status) {
    case 'preparing':
      return { label: 'Preparing', detail: 'Waiting for the selected player to be ready.', action: 'Retry preparation' }
    case 'ready':
      return { label: 'Ready, not playing', detail: 'The player is ready but has not confirmed native progress.', action: 'Play when everyone is ready' }
    case 'playing':
      return { label: 'Playing, confirmed', detail: 'Native playback progress is advancing.', action: 'Pause or seek from the controller' }
    case 'seeking':
      return { label: 'Seeking', detail: 'Waiting for the selected player to reach the shared position.', action: 'Retry seek' }
    case 'blocked':
      return { label: 'Playback blocked', detail: 'Use one local gesture to allow playback, then sync again.', action: 'Sync me now' }
    case 'buffering':
      return { label: 'Buffering', detail: 'The player is waiting for data before it can play.', action: 'Retry after buffering' }
    case 'silent':
      return { label: 'No player report', detail: 'The player stopped reporting. Redetect it or reopen the shared page.', action: 'Redetect player' }
    case 'wrong-media':
      return controller
        ? { label: 'Different episode', detail: 'This player does not match the shared episode.', action: 'Open the current episode for everyone' }
        : { label: 'Different episode', detail: 'This player does not match the shared episode.', action: 'Ask the host to share the current episode' }
    case 'recovery-required':
      return { label: 'Needs recovery', detail: 'The room paused because native playback did not progress.', action: 'Sync me now' }
    case 'unknown':
      return { label: 'Connection unclear', detail: 'Reconnect before starting or recovering playback.', action: 'Reconnect' }
  }
}
