import type { ExtensionState } from './internal.ts'
import { playbackStatusCopy } from './playback-status.ts'

/**
 * A brand-new join is pending until the host approves it (host-approval
 * join, docs/CODE_AUDIT.md SYJ-AUD-003): the local participant's own id can
 * appear in the snapshot's `pendingJoinRequests` while it is not yet in
 * `participants`. That distinct state gets its own view in the side panel
 * instead of the normal room UI, and the page's player must not be driven
 * by it: an unapproved requester is not a member, so nothing about the room
 * may pause, seek or start the video it is watching.
 *
 * The client never runtime-validates an incoming `room_joined`/snapshot
 * message against the protocol (it's cast straight to `ServerMessage`), so
 * `pendingJoinRequests` defends with `?? []` against an older room
 * coordinator that predates this field and simply omits it -- without this,
 * a snapshot from an unupgraded backend crashes every render.
 */
export function isAwaitingApproval(current: Pick<ExtensionState, 'participantId' | 'snapshot'>): boolean {
  const snapshot = current.snapshot
  if (!snapshot)
    return false
  const isParticipant = snapshot.participants.some(participant => participant.id === current.participantId)
  const isPending = (snapshot.pendingJoinRequests ?? []).some(request => request.id === current.participantId)
  return isPending && !isParticipant
}

/**
 * What the on-page pill says while the participant's own join request is
 * pending. Kept next to the predicate so the wording cannot drift from the
 * state it describes, and so a test can pin it.
 */
export const AWAITING_APPROVAL_PILL = {
  status: 'Waiting for the host',
  detail: 'Your request to join is pending. Nothing on this page changes until the host lets you in.',
} as const

/**
 * The pill copy for a pending request on the given connection. "Waiting for
 * the host" is only true while the request actually reached the coordinator.
 * When this client's own connection is down the coordinator has withdrawn the
 * request (it does so when the socket closes) and the browser asks again when
 * the connection is back, so the request is not pending in the meantime and
 * the host is not the one being waited for. The status is the one a member
 * sees for the same connection state.
 */
export function pendingPillCopy(connection: ExtensionState['connection']): { status: string, detail: string } {
  if (connection === 'connected')
    return AWAITING_APPROVAL_PILL
  return {
    status: connection === 'reconnecting' ? 'Reconnecting' : playbackStatusCopy('unknown', false).label,
    detail: 'This browser is not connected to the room right now. It will ask to join again when the connection is back.',
  }
}
