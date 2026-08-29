import { describe, expect, it } from 'vitest'
import { connectionQuality } from './connection-quality.ts'

describe('connection quality', () => {
  it('reports a healthy control channel for a fresh low-latency pong', () => {
    expect(connectionQuality({ connection: 'connected', roundTripMs: 48, clockUncertaintyMs: 30, lastPongAtMs: 10_000, nowMs: 10_500 })).toBe('good')
  })

  it('separates degraded control latency from offline state', () => {
    expect(connectionQuality({ connection: 'connected', roundTripMs: 420, clockUncertaintyMs: 80, lastPongAtMs: 10_000, nowMs: 10_500 })).toBe('degraded')
    expect(connectionQuality({ connection: 'connected', roundTripMs: 48, clockUncertaintyMs: 30, lastPongAtMs: 10_000, nowMs: 25_001 })).toBe('offline')
  })
})

