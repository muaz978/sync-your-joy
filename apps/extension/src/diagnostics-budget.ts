import type { DiagnosticEvent, DiagnosticReason, DiagnosticsReport, ParticipantState, PlaybackState } from '@syncyourjoy/protocol'
import { expectedPosition } from '@syncyourjoy/sync-engine'

export const DIAGNOSTIC_MESSAGE_BUDGET_BYTES = 12_000

/**
 * Events that explain how an incident began or what was done about it. They are
 * the last to be dropped: a stall that lasts minutes repeats the same room and
 * status events every few seconds and used to push out the one event, a
 * position change or a seek that never finished, that said what went wrong.
 */
export const PINNED_DIAGNOSTIC_MESSAGES: ReadonlySet<string> = new Set([
  'room_position_changed',
  'stuck_seek_step',
  'manual_sync',
  'room_control',
  'native_player_intent',
  'native_pause_context',
  'seek_deferred',
  'seek_deferred_retry',
  'seek_deferred_accepted',
  'seek_deferred_expired',
  'join_denied',
  'command_rejected',
  'server_error',
  'room_gone',
  // The connection's own history: why and when the socket dropped, and how its health changed.
  'socket_opened',
  'socket_closed',
  'room_rejoined',
  'heartbeat_timeout',
  'reconnect_scheduled',
  'connection_quality',
  'worker_started',
])

/**
 * How many of each pinned message are kept before the older ones are dropped like
 * ordinary events. A burst of one kind (scrubbing through the first minutes of an
 * episode sends a seek and a position change every few seconds) must not crowd out
 * the single drop or stall that the report is for.
 */
export const PINNED_KEEP_NEWEST_PER_MESSAGE = 10
const SURPLUS_PINNED_RANK = 1.5

function isKeptEvent(event: DiagnosticEvent): boolean {
  return event.critical === true && (PINNED_DIAGNOSTIC_MESSAGES.has(event.message) || event.message === 'room_status_changed')
}

/** Lower is dropped first; the oldest event of the lowest rank goes. */
function evictionRank(event: DiagnosticEvent): number {
  if (event.critical !== true)
    return 0
  if (PINNED_DIAGNOSTIC_MESSAGES.has(event.message))
    return 3
  // Why the room paused or resumed. Worth keeping over ordinary events, but a
  // failing Play repeats it every few seconds, so it never outranks the events
  // above, which say what began the incident.
  if (event.message === 'room_status_changed')
    return 2.5
  // Each refused Play repeats this snapshot about four times; coalesced
  // heartbeats and statuses are single events and stay in the ordinary rank.
  return event.message === 'room_snapshot' && event.details.reason === 'participant_status_changed' ? 1 : 2
}

/** Index of the event to drop next, or -1 when there is none. */
export function diagnosticEvictionIndex(events: readonly DiagnosticEvent[]): number {
  const keptSoFar = new Map<string, number>()
  const surplus = new Set<number>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (!isKeptEvent(event))
      continue
    const count = (keptSoFar.get(event.message) ?? 0) + 1
    keptSoFar.set(event.message, count)
    if (count > PINNED_KEEP_NEWEST_PER_MESSAGE)
      surplus.add(index)
  }
  let best = -1
  let bestRank = Number.POSITIVE_INFINITY
  events.forEach((event, index) => {
    const rank = surplus.has(index) ? SURPLUS_PINNED_RANK : evictionRank(event)
    if (rank < bestRank) {
      best = index
      bestRank = rank
    }
  })
  return best
}

export function fitDiagnosticsReport(report: DiagnosticsReport): DiagnosticsReport {
  let candidate: DiagnosticsReport = {
    ...report,
    eventsDropped: report.eventsDropped ?? 0,
    payloadTruncated: report.payloadTruncated ?? false,
  }
  while (serializedDiagnosticsBytes(candidate) > DIAGNOSTIC_MESSAGE_BUDGET_BYTES && candidate.events.length > 0) {
    const removeIndex = diagnosticEvictionIndex(candidate.events)
    candidate = {
      ...candidate,
      events: candidate.events.filter((_event, index) => index !== removeIndex),
      eventsDropped: (candidate.eventsDropped ?? 0) + 1,
      payloadTruncated: true,
    }
  }
  if (serializedDiagnosticsBytes(candidate) <= DIAGNOSTIC_MESSAGE_BUDGET_BYTES)
    return candidate
  return {
    ...candidate,
    mediaCanonicalId: candidate.mediaCanonicalId?.slice(0, 120) ?? null,
    mediaPageUrl: candidate.mediaPageUrl?.slice(0, 512) ?? null,
    userAgent: candidate.userAgent.slice(0, 160),
    events: [],
    eventsDropped: (candidate.eventsDropped ?? 0) + candidate.events.length,
    payloadTruncated: true,
  }
}

export function serializedDiagnosticsBytes(report: DiagnosticsReport, reportId = 'report_00000000000000000000000000000000000000000000000000000000000000000000000000000000'): number {
  return new TextEncoder().encode(JSON.stringify({
    type: 'diagnostics_response',
    reportId,
    report,
  })).byteLength
}

/** A room position that moved by more than this between two snapshots is reported. */
export const ROOM_POSITION_JUMP_SECONDS = 3

/**
 * The room position before and after a snapshot, when the new snapshot moved
 * it by more than playback explains. A seek, a Sync, a restored room or a new
 * episode all look like this, and the report has to say which one began a stall.
 */
export function roomPositionJump(
  previous: PlaybackState | null,
  next: PlaybackState,
  estimatedServerNowMs: number,
): { fromSeconds: number; toSeconds: number } | null {
  if (previous === null)
    return null
  const fromSeconds = expectedPosition(previous, estimatedServerNowMs)
  const toSeconds = expectedPosition(next, estimatedServerNowMs)
  if (Math.abs(toSeconds - fromSeconds) <= ROOM_POSITION_JUMP_SECONDS)
    return null
  return { fromSeconds: Math.round(fromSeconds * 10) / 10, toSeconds: Math.round(toSeconds * 10) / 10 }
}

/**
 * The report's `reason` is one of the codes the protocol already validates: a
 * coordinator that predates a new code drops the whole report, so this maps the
 * coordinator's own snapshot reasons (underscore strings) onto the existing
 * codes and never invents one. The coordinator's exact string stays in the
 * `room_snapshot` event beside it.
 */
const ROOM_REASON_CODES: ReadonlyMap<string, DiagnosticReason> = new Map<string, DiagnosticReason>([
  ['operation_timeout_paused', 'deadline-expired'],
  ['seek_timeout_paused', 'deadline-expired'],
  ['operation_binding_changed', 'binding-changed'],
  ['participant_not_ready', 'participant-not-ready'],
  ['participants_not_ready', 'participant-not-ready'],
  ['participant_buffering', 'waiting-for-data'],
  // A player that reports no progress, or stops reporting, is stalled as far as the room can tell.
  ['participant_playback_stalled', 'stalled'],
  ['participant_playback_silent', 'stalled'],
  ['participant_playback_startup_timeout', 'startup-timeout'],
  // The browser refused play(): it needs a click, as the local status path reports it.
  ['participant_playback_blocked', 'permission-denied'],
  ['participant_disconnected', 'participant-disconnected'],
  ['participant_disconnect_timeout', 'participant-disconnected'],
])

/** The worst coarse participant status wins: a blocked player explains more than a buffering one. */
const PARTICIPANT_STATUS_REASONS: ReadonlyArray<readonly [NonNullable<ParticipantState['playbackStatus']>, DiagnosticReason]> = [
  ['blocked', 'permission-denied'],
  ['recovery-required', 'recovery-required'],
  ['silent', 'stalled'],
  ['buffering', 'waiting-for-data'],
  ['wrong-media', 'media-changed'],
]

/**
 * The report code for why a room snapshot was sent, or undefined when the
 * snapshot does not say why anything stopped. `participant_status_changed`
 * only says that a status changed, so it is read from the statuses themselves.
 */
export function diagnosticReasonForRoomReason(reason: string, participants: readonly ParticipantState[]): DiagnosticReason | undefined {
  if (reason === 'participant_status_changed') {
    const connected = participants.filter(participant => participant.connected)
    return PARTICIPANT_STATUS_REASONS.find(([status]) => connected.some(participant => participant.playbackStatus === status))?.[1]
  }
  return ROOM_REASON_CODES.get(reason)
}
