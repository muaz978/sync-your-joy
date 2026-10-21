import type { DiagnosticEvent, DiagnosticsReport, PlaybackState } from '@syncyourjoy/protocol'
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
])

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
  let best = -1
  let bestRank = Number.POSITIVE_INFINITY
  events.forEach((event, index) => {
    const rank = evictionRank(event)
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
