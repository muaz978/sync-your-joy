import { describe, expect, it } from 'vitest'
import { mediaLossGraceMs, READY_MEDIA_LOSS_GRACE_MS, READY_MEDIA_MISMATCH_CONFIRMATION_MS, shouldConfirmMediaMismatch, shouldPublishMediaMatchChange, UNREADY_MEDIA_LOSS_GRACE_MS } from './readiness-state.ts'

describe('shouldPublishMediaMatchChange', () => {
  it('does not send a not-ready update for an unchanged matching media heartbeat', () => {
    expect(shouldPublishMediaMatchChange(true, true)).toBe(false)
  })

  it('publishes actual transitions between matching and mismatching media', () => {
    expect(shouldPublishMediaMatchChange(true, false)).toBe(true)
    expect(shouldPublishMediaMatchChange(false, true)).toBe(true)
  })

  it('waits for the participant to appear in the room snapshot', () => {
    expect(shouldPublishMediaMatchChange(undefined, true)).toBe(false)
  })

  it('debounces a mismatch while a matching participant is ready', () => {
    expect(shouldConfirmMediaMismatch({
      participantReady: true,
      currentMatches: true,
      nextMatches: false,
      mismatchObservedAtMs: 1_000,
      nowMs: 1_000 + READY_MEDIA_MISMATCH_CONFIRMATION_MS - 1,
    })).toBe(false)
    expect(shouldConfirmMediaMismatch({
      participantReady: true,
      currentMatches: true,
      nextMatches: false,
      mismatchObservedAtMs: 1_000,
      nowMs: 1_000 + READY_MEDIA_MISMATCH_CONFIRMATION_MS,
    })).toBe(true)
  })

  it('publishes an initial match or a non-ready mismatch immediately', () => {
    expect(shouldConfirmMediaMismatch({
      participantReady: false,
      currentMatches: false,
      nextMatches: true,
      mismatchObservedAtMs: null,
      nowMs: 1_000,
    })).toBe(true)
    expect(shouldConfirmMediaMismatch({
      participantReady: false,
      currentMatches: true,
      nextMatches: false,
      mismatchObservedAtMs: null,
      nowMs: 1_000,
    })).toBe(true)
  })

  it('gives a ready player more time to survive provider replacement', () => {
    expect(mediaLossGraceMs(true)).toBe(READY_MEDIA_LOSS_GRACE_MS)
    expect(mediaLossGraceMs(false)).toBe(UNREADY_MEDIA_LOSS_GRACE_MS)
    expect(READY_MEDIA_LOSS_GRACE_MS).toBeGreaterThan(UNREADY_MEDIA_LOSS_GRACE_MS)
  })
})
