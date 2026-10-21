import type { ParticipantState, RoomSnapshot } from '@syncyourjoy/protocol'
import type { PendingScrub } from './deferred-seek.ts'
import { describe, expect, it } from 'vitest'
import { DEFERRED_SEEK_REJECTION_WINDOW_MS, everyoneConnectedIsReady, notReadySummary, roomHasAcceptedScrub, scrubBelongsTo, shouldDeferRejectedSeek } from './deferred-seek.ts'

const seek = { actionId: 'action_seek', kind: 'seek', positionSeconds: 126, atMs: 1_000 } as const
const refused = { code: 'participants_not_ready', actionId: 'action_seek', last: seek, nowMs: 1_100, isController: true }

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

  it('does not defer the refusal of an older control, which is not about the seek that was sent last', () => {
    expect(shouldDeferRejectedSeek({ ...refused, actionId: 'action_older_seek' })).toBe(false)
    expect(shouldDeferRejectedSeek({ ...refused, actionId: '' })).toBe(false)
  })

  it('waits for a refusal no longer than the page protects its player for', () => {
    expect(DEFERRED_SEEK_REJECTION_WINDOW_MS).toBeLessThan(2_500)
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

describe('a kept scrub and the room it was made in', () => {
  const pending: PendingScrub = { positionSeconds: 126, expiresAtMs: 50_000, roomId: 'room_a', mediaId: 'crunchyroll:ONE', phase: 'sent', actionId: 'action_retry' }
  const room = (overrides: Partial<RoomSnapshot>): RoomSnapshot => ({
    roomId: 'room_a',
    media: { service: 'crunchyroll', canonicalId: 'crunchyroll:ONE', pageUrl: 'https://www.crunchyroll.com/watch/ONE/x', title: 'x', durationSeconds: 1400 },
    playback: { status: 'paused', positionSeconds: 2.68, effectiveAtServerMs: 0, playbackRate: 1 },
    seek: null,
    ...overrides,
  }) as RoomSnapshot

  it('is only for the same room and the same video', () => {
    expect(scrubBelongsTo(pending, room({}))).toBe(true)
    expect(scrubBelongsTo(pending, room({ roomId: 'room_b' }))).toBe(false)
    expect(scrubBelongsTo(pending, room({ media: null }))).toBe(false)
    expect(scrubBelongsTo({ ...pending, mediaId: null }, room({ media: null }))).toBe(true)
  })

  it('is accepted when the room has the seek or sits at the scrubbed position, and not while it still shows the old one', () => {
    expect(roomHasAcceptedScrub(room({}), 126)).toBe(false)
    expect(roomHasAcceptedScrub(room({ playback: { status: 'paused', positionSeconds: 126, effectiveAtServerMs: 0, playbackRate: 1 } }), 126)).toBe(true)
    expect(roomHasAcceptedScrub(room({ seek: { revision: 9, positionSeconds: 126, acknowledgedParticipantIds: [], resumeWhenReady: false, deadlineAtServerMs: 0 } }), 126)).toBe(true)
  })
})

describe('who stood in the way', () => {
  const person = (id: string, overrides: Partial<ParticipantState>): ParticipantState =>
    ({ id, name: 'P', role: 'member', ready: true, connected: true, mediaMatches: true, latencyMs: null, ...overrides }) as ParticipantState

  it('names each connected participant that is not ready, by the end of its id, and what is missing', () => {
    expect(notReadySummary([
      person('participant_aaaaaa', {}),
      person('participant_bbbbbb', { ready: false }),
      person('participant_cccccc', { mediaMatches: false }),
      person('participant_dddddd', { ready: false, mediaMatches: false }),
      person('participant_eeeeee', { connected: false, ready: false }),
    ])).toBe('bbbbbb:nm,cccccc:rx,dddddd:nx')
  })

  it('is empty when everyone is ready', () => {
    expect(notReadySummary([person('participant_aaaaaa', {})])).toBe('')
  })
})
