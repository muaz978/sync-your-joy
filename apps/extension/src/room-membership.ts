import type { ExtensionState } from './internal.ts'

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
