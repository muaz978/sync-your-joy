export const SEEK_ALIGNMENT_TOLERANCE_SECONDS = 0.5

export function isSeekAligned(currentSeconds: number, targetSeconds: number): boolean {
  return Number.isFinite(currentSeconds)
    && Number.isFinite(targetSeconds)
    && Math.abs(currentSeconds - targetSeconds) <= SEEK_ALIGNMENT_TOLERANCE_SECONDS
}
