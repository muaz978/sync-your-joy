export const SEEK_ALIGNMENT_TOLERANCE_SECONDS = 0.5
export const SEEK_INTENT_DEBOUNCE_MS = 60
export const SEEK_COMPLETION_PROBE_MS = 80
export const SEEK_ACK_RETRY_MS = 250

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
