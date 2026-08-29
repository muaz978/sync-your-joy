export function shouldPublishMediaMatchChange(currentMatches: boolean | undefined, nextMatches: boolean): boolean {
  return currentMatches !== undefined && currentMatches !== nextMatches
}

export const READY_MEDIA_MISMATCH_CONFIRMATION_MS = 3_000
export const UNREADY_MEDIA_LOSS_GRACE_MS = 3_000
export const READY_MEDIA_LOSS_GRACE_MS = 10_000

export function mediaLossGraceMs(participantReady: boolean): number {
  return participantReady ? READY_MEDIA_LOSS_GRACE_MS : UNREADY_MEDIA_LOSS_GRACE_MS
}

export function shouldConfirmMediaMismatch(options: {
  participantReady: boolean
  currentMatches: boolean | undefined
  nextMatches: boolean
  mismatchObservedAtMs: number | null
  nowMs: number
}): boolean {
  if (!shouldPublishMediaMatchChange(options.currentMatches, options.nextMatches))
    return false
  if (!options.participantReady || options.currentMatches !== true || options.nextMatches)
    return true
  return options.mismatchObservedAtMs !== null
    && options.nowMs - options.mismatchObservedAtMs >= READY_MEDIA_MISMATCH_CONFIRMATION_MS
}
