import type { PlaybackState, PlayerSample } from '@syncyourjoy/protocol'

export const PLAYBACK_STARTUP_GRACE_MS = 2_500
export const PLAYBACK_APPLICATION_GRACE_MS = 500
export const PLAYBACK_PROGRESS_TIMEOUT_MS = 1_800
// A player can have a pending play() promise while it loads segments or a DRM
// license. Give it a bounded startup window without mislabeling that delay as
// a browser gesture rejection.
export const PLAYBACK_STARTUP_TIMEOUT_MS = 10_000
// A player that was reporting status and then goes completely silent cannot
// be distinguished from a frozen or disconnected player after this interval.
// Keep this separate from the shorter progress deadline, which is evaluated
// only while status reports are still arriving.
export const PLAYBACK_REPORT_SILENCE_TIMEOUT_MS = 5_000
// A participant's player can rebuffer for a moment while an adaptive stream
// changes quality or a segment is slow. The room pauses for everyone only when
// one participant has reported buffering continuously for this long, so a
// short rebuffer does not stop the others (#141). Reports arrive about once a
// second, so a gap longer than the second constant means the buffering was not
// observed in between and the period starts again.
export const PLAYBACK_BUFFERING_GRACE_MS = 3_000
export const PLAYBACK_BUFFERING_REPORT_GAP_MS = 2_500
// Automatic resume (#141). After the room paused itself because a player
// buffered or stalled, it starts playback again once every player has been able
// to play for the stability window, and gives up after a bounded number of
// attempts or window, so a player that cannot play never causes a loop.
// A participant whose connection drops while the room is playing is waited for
// this long before the room pauses for everyone. A short network or browser
// hiccup (the 0.2.11 report of 2026-10-22: about one second) then costs
// nothing, where it used to pause the room and make everybody press Play. A
// participant who leaves on purpose still pauses the room at once.
export const DISCONNECT_PAUSE_GRACE_MS = 8_000
/** Close reasons the extension gives when it leaves a room on purpose. */
export const INTENTIONAL_LEAVE_REASONS: readonly string[] = ['left_room', 'new_room']

export function isIntentionalLeave(closeReason: string | undefined | null): boolean {
  return typeof closeReason === 'string' && INTENTIONAL_LEAVE_REASONS.includes(closeReason)
}

export const AUTO_RESUME_STABLE_MS = 1_500
export const AUTO_RESUME_WINDOW_MS = 120_000
export const AUTO_RESUME_MAX_ATTEMPTS = 3
/** The wait after the first and after the second failed start; the third failure gives up. */
export const AUTO_RESUME_BACKOFF_MS: readonly number[] = [2_000, 5_000]
/**
 * A player this far from the room position cannot be expected to prepare for
 * the Play within its window (it stalled behind, or is stuck elsewhere). A
 * player a few seconds behind, as the room runs ahead of a stalled one for the
 * length of the buffering grace, is normal.
 */
export const AUTO_RESUME_MAX_OFFSET_SECONDS = 15
export const AUTO_RESUME_POLL_MS = 1_000
export const AUTO_RESUME_SAMPLE_FRESH_MS = 2_500
/** At most this many automatic resumes are armed inside `AUTO_RESUME_WINDOW_MS`, so a flapping connection cannot pause and resume forever. */
export const AUTO_RESUME_ARM_LIMIT = 3

/**
 * The least a position must move for the coordinator to take the player as
 * having moved on, both for progress (when a report does not say) and to tell
 * a late delivery from a client clock that stepped back (`isStaleSample`).
 */
export const PLAYBACK_POSITION_ADVANCE_SECONDS = 0.12

/**
 * Whether `next` is the report the coordinator already holds, delivered again:
 * every field the same. Only a whole-report duplicate counts. Two different
 * reports can share a millisecond (the same instant sampled twice, or two
 * events in one tick), so the timestamp alone does not identify a report.
 */
export function isDuplicateSample(recorded: PlayerSample, next: PlayerSample): boolean {
  const keys = new Set([...Object.keys(recorded), ...Object.keys(next)]) as Set<keyof PlayerSample>
  for (const key of keys) {
    if (recorded[key] !== next[key])
      return false
  }
  return true
}

/**
 * Whether `next` is a late delivery of an older report. Reports carry the
 * client's own clock, which can step (a clock set from the network, a machine
 * waking up) and so cannot order reports on its own: after a step back every
 * report would look old, the coordinator would drop a healthy player's reports
 * and then pause the room for a stall. A report stamped earlier than the
 * recorded one is therefore only late when its position is not further along.
 * A late delivery cannot be ahead of the report it was overtaken by, apart
 * from a seek backwards, and the revision rule already rejects a report from
 * before a seek.
 */
export function isStaleSample(recorded: PlayerSample, next: PlayerSample): boolean {
  return next.sampledAtLocalMs < recorded.sampledAtLocalMs
    && next.positionSeconds - recorded.positionSeconds < PLAYBACK_POSITION_ADVANCE_SECONDS
}

export function playbackStartupDeadlineMs(playback: PlaybackState): number {
  return playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
}

export function playbackProgressDeadlineMs(playback: PlaybackState, lastProgressAtServerMs: number): number {
  return Math.max(
    playback.effectiveAtServerMs + PLAYBACK_PROGRESS_TIMEOUT_MS,
    lastProgressAtServerMs + PLAYBACK_PROGRESS_TIMEOUT_MS,
  )
}

export function playbackReportSilenceDeadlineMs(playback: PlaybackState, lastSampleReceivedAtMs: number): number {
  return Math.max(
    playback.effectiveAtServerMs,
    lastSampleReceivedAtMs,
  ) + PLAYBACK_REPORT_SILENCE_TIMEOUT_MS
}

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
    && serverNowMs >= playbackProgressDeadlineMs(playback, lastProgressAtServerMs)
}

export function hasPlaybackStartupTimedOut(playback: PlaybackState, playbackStarted: boolean | undefined, serverNowMs: number): boolean {
  return playback.status === 'playing'
    && playbackStarted === false
    && serverNowMs >= playbackStartupDeadlineMs(playback)
}
