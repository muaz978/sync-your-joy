import type { DiagnosticsReport } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_MESSAGE_BUDGET_BYTES, fitDiagnosticsReport, serializedDiagnosticsBytes } from './diagnostics-budget.ts'

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
})
