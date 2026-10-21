import type { ParticipantState } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { DEFERRED_SEEK_REJECTION_WINDOW_MS, everyoneConnectedIsReady, shouldDeferRejectedSeek } from './deferred-seek.ts'

const seek = { kind: 'seek', positionSeconds: 126, atMs: 1_000 } as const
const refused = { code: 'participants_not_ready', last: seek, nowMs: 1_100, isController: true }

describe('deferring a refused scrub', () => {
  it('defers a seek refused because someone was not ready', () => {
    expect(shouldDeferRejectedSeek(refused)).toBe(true)
  })

  it('does not defer other refusals, other controls, a late refusal or a non-controller', () => {
    expect(shouldDeferRejectedSeek({ ...refused, code: 'stale_context' })).toBe(false)
    expect(shouldDeferRejectedSeek({ ...refused, last: { ...seek, kind: 'play' } })).toBe(false)
    expect(shouldDeferRejectedSeek({ ...refused, last: null })).toBe(false)
    expect(shouldDeferRejectedSeek({ ...refused, nowMs: seek.atMs + DEFERRED_SEEK_REJECTION_WINDOW_MS + 1 })).toBe(false)
    expect(shouldDeferRejectedSeek({ ...refused, isController: false })).toBe(false)
  })
})

describe('everyone connected is ready', () => {
  const person = (overrides: Partial<ParticipantState>): ParticipantState =>
    ({ id: 'p', name: 'P', role: 'member', ready: true, connected: true, mediaMatches: true, latencyMs: null, ...overrides }) as ParticipantState

  it('needs readiness and matching media from every connected participant', () => {
    expect(everyoneConnectedIsReady([person({}), person({})])).toBe(true)
    expect(everyoneConnectedIsReady([person({}), person({ ready: false })])).toBe(false)
    expect(everyoneConnectedIsReady([person({}), person({ mediaMatches: false })])).toBe(false)
  })

  it('ignores a participant who is not connected, and an empty room is not ready', () => {
    expect(everyoneConnectedIsReady([person({}), person({ connected: false, ready: false })])).toBe(true)
    expect(everyoneConnectedIsReady([])).toBe(false)
  })
})
