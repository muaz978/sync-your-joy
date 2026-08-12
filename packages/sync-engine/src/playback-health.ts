import type { PlaybackState } from '@syncyourjoy/protocol'

export const PLAYBACK_STARTUP_GRACE_MS = 2_500

export function isPlaybackPastStartupGrace(playback: PlaybackState, serverNowMs: number): boolean {
  return playback.status === 'playing'
    && serverNowMs >= playback.effectiveAtServerMs + PLAYBACK_STARTUP_GRACE_MS
}
