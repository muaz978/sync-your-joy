import type { DiagnosticsReport } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_MESSAGE_BUDGET_BYTES, diagnosticEvictionIndex, fitDiagnosticsReport, roomPositionJump, serializedDiagnosticsBytes } from './diagnostics-budget.ts'

function report(eventCount: number): DiagnosticsReport {
  return {
    extensionVersion: '0.1.22',
    generatedAtLocalMs: 1_725_000_000_000,
    userAgent: 'Mozilla/5.0 Chrome',
    connection: 'connected',
    roomRevision: 12,
    playbackStatus: 'playing',
    playerFrameId: 0,
    playerAreaPixels: 500_000,
    playerLastSeenAtMs: 1_725_000_000_000,
    mediaService: 'html5',
    mediaCanonicalId: 'page:https://example.com/watch',
    mediaPageUrl: 'https://example.com/watch',
    playerOrigin: 'light-dom',
    playerReadyState: 4,
    playerNetworkState: 1,
    playerCurrentSrcKind: 'blob',
    playerHasSourceObject: false,
    sample: {
      positionSeconds: 137,
      durationSeconds: 1_000,
      paused: false,
      buffering: false,
      sampledAtLocalMs: 1_725_000_000_000,
      progressed: true,
      playbackStarted: true,
    },
    events: Array.from({ length: eventCount }, (_, index) => ({
      atLocalMs: 1_725_000_000_000 + index * 1_000,
      category: 'playback',
      message: 'player_status',
      details: { revision: 12, positionSeconds: 137.12, paused: false, buffering: false },
    })),
  }
}

describe('diagnostics message budget', () => {
  it('keeps long reports below the room transport limit', () => {
    const fitted = fitDiagnosticsReport(report(120))
    expect(serializedDiagnosticsBytes(fitted)).toBeLessThanOrEqual(DIAGNOSTIC_MESSAGE_BUDGET_BYTES)
    expect(fitted.events.length).toBeLessThan(120)
  })

  it('preserves the newest events when trimming', () => {
    const fitted = fitDiagnosticsReport(report(120))
    expect(fitted.events.at(-1)?.atLocalMs).toBe(1_725_000_000_000 + 119_000)
  })

  it('retains critical transitions and reports explicit truncation evidence', () => {
    const fitted = fitDiagnosticsReport({
      ...report(120),
      events: [{
        atLocalMs: 1_725_000_000_000,
        category: 'error',
        message: 'server_error',
        critical: true,
        details: { code: 'provider-error', explanation: 'x'.repeat(300) },
      }, ...report(120).events],
    })
    expect(fitted.events.some(event => event.critical === true && event.message === 'server_error')).toBe(true)
    expect(fitted.eventsDropped).toBeGreaterThan(0)
    expect(fitted.payloadTruncated).toBe(true)
  })

  it('spends a bounded number of bytes on the media-element evidence, even at its largest', () => {
    const without = report(0)
    const largest: DiagnosticsReport = {
      ...without,
      playerSeeking: true,
      playerErrorCode: 4,
      playerBufferedRangeCount: 10_000,
      playerBufferedRanges: [1_234_567.8, 1_234_567.9, 2_234_567.8, 2_234_567.9, 3_234_567.8, 3_234_567.9, 4_234_567.8, 4_234_567.9],
      playerSeekableRangeCount: 10_000,
      playerSeekableRanges: [1_234_567.8, 9_234_567.9, 9_234_567.8, 9_999_999.9],
      playerBufferedAheadSeconds: 9_999_999.9,
      playerPendingSeekAgeMs: 3_600_000,
      playerHasMediaKeys: true,
    }
    const cost = serializedDiagnosticsBytes(largest) - serializedDiagnosticsBytes(without)
    // 375 bytes at the worst, about 250 for a typical stalled player. The cap
    // keeps a future field from quietly eating the event budget that the start
    // of a failure depends on.
    expect(cost).toBeLessThanOrEqual(400)
    expect(serializedDiagnosticsBytes(fitDiagnosticsReport({ ...largest, events: report(120).events }))).toBeLessThanOrEqual(DIAGNOSTIC_MESSAGE_BUDGET_BYTES)
  })
})

describe('which diagnostic event is dropped first', () => {
  const event = (message: string, details: Record<string, string | number> = {}, critical = true) => ({
    atLocalMs: 1,
    category: 'room',
    message,
    details,
    ...(critical ? { critical: true as const } : {}),
  })

  it('drops an ordinary event before a repeated one, a repeated one before a critical one, and a critical one before a pinned one', () => {
    expect(diagnosticEvictionIndex([
      event('room_position_changed'),
      event('room_snapshot', { reason: 'control_play_pending' }),
      event('room_snapshot', { reason: 'participant_status_changed' }),
      event('heartbeat', {}, false),
    ])).toBe(3)
    expect(diagnosticEvictionIndex([
      event('room_position_changed'),
      event('room_snapshot', { reason: 'control_play_pending' }),
      event('room_snapshot', { reason: 'participant_status_changed' }),
    ])).toBe(2)
    expect(diagnosticEvictionIndex([
      event('room_position_changed'),
      event('room_snapshot', { reason: 'control_play_pending' }),
    ])).toBe(1)
  })

  it('drops the oldest of the lowest rank and says -1 for nothing', () => {
    expect(diagnosticEvictionIndex([event('player_status'), event('media_detected'), event('room_position_changed')])).toBe(0)
    expect(diagnosticEvictionIndex([event('media_detected'), event('room_snapshot', { reason: 'participant_status_changed' }), event('room_snapshot', { reason: 'participant_status_changed' })])).toBe(1)
    expect(diagnosticEvictionIndex([])).toBe(-1)
  })

  it('keeps a pinned event through a report trimmed to the byte budget', () => {
    const base = report(0)
    const events = [
      { atLocalMs: 1, category: 'room', message: 'room_position_changed', details: { fromSeconds: 676, toSeconds: 395.6 }, critical: true as const },
      ...Array.from({ length: 200 }, (_, index) => ({
        atLocalMs: 2 + index,
        category: 'room',
        message: 'room_snapshot',
        details: { reason: 'participant_status_changed', revision: index, status: 'paused', positionSeconds: 395.6, aligning: false },
        critical: true as const,
      })),
    ]
    const fitted = fitDiagnosticsReport({ ...base, events })
    expect(fitted.payloadTruncated).toBe(true)
    expect(fitted.events[0]?.message).toBe('room_position_changed')
  })
})

describe('roomPositionJump', () => {
  const paused = (positionSeconds: number) => ({ status: 'paused' as const, positionSeconds, effectiveAtServerMs: 0, playbackRate: 1 as const })

  it('reports a seek of several minutes with rounded positions', () => {
    expect(roomPositionJump(paused(676.04), paused(395.63325), 10_000)).toEqual({ fromSeconds: 676, toSeconds: 395.6 })
  })

  it('does not report playback advancing, a small move, or a first snapshot', () => {
    const playing = { status: 'playing' as const, positionSeconds: 100, effectiveAtServerMs: 0, playbackRate: 1 as const }
    expect(roomPositionJump(playing, paused(110), 10_000)).toBeNull()
    expect(roomPositionJump(paused(100), paused(102.9), 10_000)).toBeNull()
    expect(roomPositionJump(null, paused(500), 10_000)).toBeNull()
  })
})
