import type { RoomTimelineEntry } from '@syncyourjoy/protocol'

/** Entries the coordinator keeps; the oldest go first and are counted as dropped. */
export const ROOM_TIMELINE_LIMIT = 300

type VisibleState = Pick<RoomTimelineEntry, 'playbackStatus' | 'positionSeconds' | 'controllerId' | 'operation' | 'participants'>

/**
 * Everything an entry shows except when it happened, its revision and what it
 * was called. Two changes with the same key look identical in a report, so the
 * second is not worth an entry: a player status report that changed nothing is
 * most of what the coordinator hears. A playing room's position moves on its own
 * and is left out; a paused room's is part of its state.
 */
export function timelineStateKey(state: VisibleState): string {
  return JSON.stringify([
    state.playbackStatus,
    state.playbackStatus === 'paused' ? Math.round(state.positionSeconds * 10) / 10 : null,
    state.controllerId,
    state.operation === null
      ? null
      : [state.operation.kind, state.operation.phase, state.operation.reason, state.operation.prepared, state.operation.started, state.operation.required],
    state.participants.map(participant => [participant.id, participant.connected, participant.ready, participant.mediaMatches, participant.status]),
  ])
}

/**
 * A close reason comes from the client. Only a short code of lower-case words
 * is kept (`left_room`, `heartbeat_timeout`); anything else is `other`.
 */
export function safeCloseReason(reason: string | undefined | null): string {
  if (typeof reason !== 'string' || reason === '')
    return 'none'
  return /^[a-z][a-z0-9_-]{1,79}$/.test(reason) ? reason : 'other'
}
