import type { ParticipantPlaybackStatus } from '@syncyourjoy/protocol'

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

const SILENCE_TIMEOUT_MS = 5_000
const PROGRESS_TIMEOUT_MS = 1_800

/**
 * Classifies only bounded state already owned by the extension. It never
 * reads provider internals, media bytes or credentials.
 */
export function localPlaybackStatus(input: LocalPlaybackStatusInput): ParticipantPlaybackStatus {
  if (!input.connected)
    return 'unknown'
  if (!input.hasVideo)
    return 'preparing'
  if (!input.mediaMatches)
    return 'wrong-media'
  if (input.playbackStartFailed)
    return 'blocked'
  if (input.pendingSeek || input.operationKind === 'seek')
    return 'seeking'
  if (!input.roomPlaying)
    return input.ready ? 'ready' : 'preparing'
  if (input.statusAgeMs !== null && input.statusAgeMs >= SILENCE_TIMEOUT_MS)
    return 'silent'
  if (input.buffering)
    return 'buffering'
  if (input.paused === true)
    return 'recovery-required'
  if (input.drifted)
    return 'recovery-required'
  if (input.playbackStarted === false)
    return 'preparing'
  if (input.progressAgeMs !== null && input.progressAgeMs >= PROGRESS_TIMEOUT_MS)
    return 'recovery-required'
  if (input.progressed)
    return 'playing'
  return 'preparing'
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
      return { label: 'Buffering', detail: 'The player is waiting for data before it can confirm progress.', action: 'Retry after buffering' }
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
