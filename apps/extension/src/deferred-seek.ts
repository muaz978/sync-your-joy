import type { ControlKind, ParticipantState } from '@syncyourjoy/protocol'

/**
 * How long a scrub that the room refused because someone was not ready keeps
 * waiting for them. After that the controller's player returns to the room
 * position, as it always did.
 */
export const DEFERRED_SEEK_MS = 45_000

/** A refusal this long after the seek was sent is not about that seek. */
export const DEFERRED_SEEK_REJECTION_WINDOW_MS = 5_000

export interface SentControl {
  kind: ControlKind
  positionSeconds: number
  atMs: number
  /** Set on a retry, so that a second refusal does not restart the wait. */
  carryExpiresAtMs?: number | undefined
}

/**
 * The room refuses a seek while any connected participant is not ready. The
 * controller's own player has already moved to the scrubbed position by then,
 * so letting it return to the room position is a long jump to data the player
 * threw away, which Crunchyroll's player did not recover from (the 0.2.10
 * report of 2026-10-21). The scrub is kept and sent again once everyone is
 * ready.
 */
export function shouldDeferRejectedSeek(options: {
  code: string
  last: SentControl | null
  nowMs: number
  isController: boolean
}): boolean {
  return options.isController
    && options.code === 'participants_not_ready'
    && options.last?.kind === 'seek'
    && options.nowMs - options.last.atMs <= DEFERRED_SEEK_REJECTION_WINDOW_MS
}

export function everyoneConnectedIsReady(participants: readonly ParticipantState[]): boolean {
  const connected = participants.filter(participant => participant.connected)
  return connected.length > 0 && connected.every(participant => participant.ready && participant.mediaMatches)
}
