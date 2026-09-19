import type { PlaybackState } from '@syncyourjoy/protocol'

export const PLAYBACK_STARTUP_GRACE_MS = 2_500
export const PLAYBACK_APPLICATION_GRACE_MS = 500
export const PLAYBACK_PROGRESS_TIMEOUT_MS = 1_800
// A player can have a pending play() promise while it loads segments or a DRM
// license. Give it a bounded startup window without mislabeling that delay as
// a browser gesture rejection.
export const PLAYBACK_STARTUP_TIMEOUT_MS = 10_000

export function isPlaybackPastStartupGrace(playback: PlaybackState, serverNowMs: number): boolean {
  return playback.status === 'playing'
    && serverNowMs >= playback.effectiveAtServerMs + PLAYBACK_STARTUP_GRACE_MS
}

export function hasPlaybackApplicationFailed(playback: PlaybackState, paused: boolean, serverNowMs: number): boolean {
  return playback.status === 'playing'
    && paused
    && serverNowMs >= playback.effectiveAtServerMs + PLAYBACK_APPLICATION_GRACE_MS
}

export function hasPlaybackProgressStalled(playback: PlaybackState, lastProgressAtServerMs: number, serverNowMs: number): boolean {
  return playback.status === 'playing'
    && serverNowMs >= playback.effectiveAtServerMs + PLAYBACK_PROGRESS_TIMEOUT_MS
    && serverNowMs - lastProgressAtServerMs >= PLAYBACK_PROGRESS_TIMEOUT_MS
}

export function hasPlaybackStartupTimedOut(playback: PlaybackState, playbackStarted: boolean | undefined, serverNowMs: number): boolean {
  return playback.status === 'playing'
    && playbackStarted === false
    && serverNowMs >= playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
}
