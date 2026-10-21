import type { ControlKind, ParticipantState, RoomSnapshot } from '@syncyourjoy/protocol'

/**
 * How long a scrub that the room refused because someone was not ready keeps
 * waiting for them. After that the controller's player returns to the room
 * position, as it always did.
 */
export const DEFERRED_SEEK_MS = 45_000

/**
 * A refusal this long after the seek was sent is not deferred. A refusal
 * normally comes back within a round trip; the page protects its player for
 * LOCAL_INTENT_HOLD_MS (2.5 s) after a scrub, so a refusal later than that has
 * found the player already taken back, and a deferral could not undo it.
 */
export const DEFERRED_SEEK_REJECTION_WINDOW_MS = 2_000

/** How long the page keeps the controller's player where it is for a scrub sent again, or replaced by a newer control, until the room has answered. */
export const SCRUB_ANSWER_HOLD_MS = 10_000
export const SUPERSEDED_SCRUB_HOLD_MS = 3_000

/** The position a retried scrub has to reach before the room is taken to have accepted it. */
export const SCRUB_ACCEPTED_WITHIN_SECONDS = 1

export interface SentControl {
  actionId: string
  kind: ControlKind
  positionSeconds: number
  atMs: number
  /** Set on a retry, so that a second refusal does not restart the wait. */
  carryExpiresAtMs?: number | undefined
}

/** A refused scrub that is being kept, and where it has got to. */
export interface PendingScrub {
  positionSeconds: number
  expiresAtMs: number
  /** The room and the video it was scrubbed in: it is not sent anywhere else. */
  roomId: string
  mediaId: string | null
  /** `waiting` for everyone to be ready, or `sent` again and waiting for the room's answer. */
  phase: 'waiting' | 'sent'
  actionId: string | null
}

/**
 * The room refuses a seek while any connected participant is not ready. The
 * controller's own player has already moved to the scrubbed position by then,
 * so letting it return to the room position is a long jump to data the player
 * threw away, which Crunchyroll's player did not recover from (the 0.2.10
 * report of 2026-10-21). The scrub is kept and sent again once everyone is
 * ready. Only the refusal of the control that was sent last counts.
 */
export function shouldDeferRejectedSeek(options: {
  code: string
  actionId: string
  last: SentControl | null
  nowMs: number
  isController: boolean
}): boolean {
  return options.isController
    && options.code === 'participants_not_ready'
    && options.last?.kind === 'seek'
    && options.last.actionId === options.actionId
    && options.nowMs - options.last.atMs <= DEFERRED_SEEK_REJECTION_WINDOW_MS
}

export function everyoneConnectedIsReady(participants: readonly ParticipantState[]): boolean {
  const connected = participants.filter(participant => participant.connected)
  return connected.length > 0 && connected.every(participant => participant.ready && participant.mediaMatches)
}

/** The room has taken the scrub: its seek or its position is where the scrub went. */
export function roomHasAcceptedScrub(snapshot: RoomSnapshot, positionSeconds: number): boolean {
  const target = snapshot.seek?.positionSeconds ?? snapshot.playback.positionSeconds
  return Math.abs(target - positionSeconds) <= SCRUB_ACCEPTED_WITHIN_SECONDS
}

/** Whether a scrub kept in one room and video may be sent in this one. */
export function scrubBelongsTo(pending: PendingScrub, snapshot: RoomSnapshot): boolean {
  return pending.roomId === snapshot.roomId && pending.mediaId === (snapshot.media?.canonicalId ?? null)
}

/**
 * Who stood in the way, for the report: for each connected participant that is
 * not ready, the end of its id and whether it is ready (r or n) and shows the
 * right video (m or x). Ids are opaque, and the report names each participant
 * by the same id.
 */
export function notReadySummary(participants: readonly ParticipantState[]): string {
  return participants
    .filter(participant => participant.connected && !(participant.ready && participant.mediaMatches))
    .map(participant => `${participant.id.slice(-6)}:${participant.ready ? 'r' : 'n'}${participant.mediaMatches ? 'm' : 'x'}`)
    .join(',')
}
