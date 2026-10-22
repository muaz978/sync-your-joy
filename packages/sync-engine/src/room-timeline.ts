import type { RoomTimelineEntry } from '@syncyourjoy/protocol'

/** Entries the coordinator keeps; the oldest go first and are counted as dropped. */
export const ROOM_TIMELINE_LIMIT = 300

type VisibleState = Pick<RoomTimelineEntry, 'playbackStatus' | 'positionSeconds' | 'controllerId' | 'operation' | 'participants' | 'pendingJoinIds' | 'pendingSeekAcknowledged'>

/** What else a change can alter that an entry does not show: the stored playback, the media and the shared link. */
export interface TimelineStateExtras {
  playbackPositionSeconds: number
  playbackEffectiveAtServerMs: number
  mediaEpoch: number
  navigationRevision: number | null
}

/**
 * Everything an entry shows except when it happened, its revision and what it
 * was called. Two changes with the same key look identical in a report, so the
 * second is not worth an entry: a player status report that changed nothing is
 * most of what the coordinator hears. A playing room's position moves on its own
 * and is left out; a paused room's is part of its state.
 */
export function timelineStateKey(state: VisibleState, extras?: TimelineStateExtras): string {
  return JSON.stringify([
    state.playbackStatus,
    state.playbackStatus === 'paused' ? Math.round(state.positionSeconds * 10) / 10 : null,
    state.controllerId,
    state.operation === null
      ? null
      : [state.operation.kind, state.operation.phase, state.operation.reason, state.operation.targetPositionSeconds, state.operation.prepared, state.operation.started, state.operation.required],
    state.pendingJoinIds,
    state.pendingSeekAcknowledged,
    // A command that moves a playing room changes where it was stored from, though the position moves on its own.
    extras === undefined ? null : [extras.playbackPositionSeconds, extras.playbackEffectiveAtServerMs, extras.mediaEpoch, extras.navigationRevision],
    state.participants.map(participant => [participant.id, participant.connected, participant.ready, participant.mediaMatches, participant.status]),
  ])
}

/** Participants an entry lists; a room has at most ten connected, and members who left stay in the list. */
export const TIMELINE_PARTICIPANT_LIMIT = 20

/** The reasons this project's own code closes a socket with. */
const KNOWN_CLOSE_REASONS: ReadonlySet<string> = new Set([
  'join_denied',
  'left_room',
  'new_room',
  'session_replaced',
  'rate_limited',
  'message_too_large',
  'attachment_unreadable',
  'heartbeat_timeout',
  'test_disconnect',
  'room_expired',
])

/**
 * A close reason can be written by whoever closed the socket, so only the ones this project's
 * own code uses are kept; anything else is `other`, however harmless it looks.
 */
export function safeCloseReason(reason: string | undefined | null): string {
  if (typeof reason !== 'string' || reason === '')
    return 'none'
  return KNOWN_CLOSE_REASONS.has(reason) ? reason : 'other'
}
