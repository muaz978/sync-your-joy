export const SEEK_ALIGNMENT_TOLERANCE_SECONDS = 0.5
export const SEEK_INTENT_DEBOUNCE_MS = 60
export const SEEK_COMPLETION_PROBE_MS = 80
export const SEEK_ACK_RETRY_MS = 250
export const SEEK_INTENT_DEDUP_MS = 1_000
export const SEEK_BARRIER_MAX_WAIT_MS = 1_800
export const LOCAL_SEEK_MAX_WAIT_MS = 1_500

export function isSeekAligned(currentSeconds: number, targetSeconds: number): boolean {
  return Number.isFinite(currentSeconds)
    && Number.isFinite(targetSeconds)
    && Math.abs(currentSeconds - targetSeconds) <= SEEK_ALIGNMENT_TOLERANCE_SECONDS
}

export function canConfirmSeek(options: {
  currentSeconds: number
  targetSeconds: number
  seeking: boolean
}): boolean {
  return !options.seeking && isSeekAligned(options.currentSeconds, options.targetSeconds)
}

export function isDuplicateSeekIntent(options: {
  positionSeconds: number
  lastPositionSeconds: number | null
  nowMs: number
  lastSentAtMs: number
}): boolean {
  return options.lastPositionSeconds !== null
    && isSeekAligned(options.positionSeconds, options.lastPositionSeconds)
    && options.nowMs - options.lastSentAtMs < SEEK_INTENT_DEDUP_MS
}
