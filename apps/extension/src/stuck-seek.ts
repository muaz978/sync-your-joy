/**
 * Automatic recovery for a seek the player never finishes (#138). The element
 * reports the target as its position while it is stuck, so the page cannot
 * tell a slow load from a wedged one; time is the only evidence. Each step is
 * tried once the previous one has had `STUCK_SEEK_STEP_MS` to work:
 *
 * 1. ask for the position again (what the Sync button does),
 * 2. seek to a buffered point and back, so the player sees a real transition,
 * 3. reload the tab after a visible countdown, which the room survives.
 */
export const STUCK_SEEK_STEP_MS = 6_000
export const STUCK_SEEK_TICK_MS = 1_000
/** Idle time after the last step before the reload countdown starts. */
export const STUCK_SEEK_RELOAD_DELAY_MS = 8_000
export const STUCK_SEEK_RELOAD_COUNTDOWN_MS = 20_000
/** A tab is reloaded automatically at most once in this long. */
export const STUCK_SEEK_AUTO_RELOAD_COOLDOWN_MS = 10 * 60_000
/** How long the buffered point is held before the real target is asked for. */
export const STUCK_SEEK_NUDGE_SETTLE_MS = 400
/** Steps before the page gives up on seeking and advises (then performs) a reload. */
export const STUCK_SEEK_RELOAD_AFTER = 2

export type StuckSeekStep = 'reissue' | 'nudge' | 'reload_countdown' | 'reload_cancelled' | 'reload_declined' | 'reload'

export interface StuckSeekLadderState {
  reissues: number
  lastActionAt: number
  reloadAt: number | null
  reloadCancelled: boolean
}

export type StuckSeekAction
  = | { kind: 'none' }
    | { kind: 'reissue' }
    | { kind: 'nudge' }
    | { kind: 'start_reload' }
    | { kind: 'countdown'; remainingSeconds: number }
    | { kind: 'reload' }

/** What the ladder should do now, given only its own bookkeeping and the clock. */
export function nextStuckSeekAction(state: StuckSeekLadderState, nowMs: number): StuckSeekAction {
  if (state.reloadAt !== null) {
    const remainingMs = state.reloadAt - nowMs
    return remainingMs <= 0
      ? { kind: 'reload' }
      : { kind: 'countdown', remainingSeconds: Math.ceil(remainingMs / 1_000) }
  }
  const idleMs = nowMs - state.lastActionAt
  if (state.reissues < STUCK_SEEK_RELOAD_AFTER)
    return idleMs >= STUCK_SEEK_STEP_MS ? { kind: state.reissues === 0 ? 'reissue' : 'nudge' } : { kind: 'none' }
  return !state.reloadCancelled && idleMs >= STUCK_SEEK_RELOAD_DELAY_MS ? { kind: 'start_reload' } : { kind: 'none' }
}

/** Whether a tab that was last reloaded automatically at `lastReloadAtMs` may be reloaded again. */
export function mayAutoReload(lastReloadAtMs: number | null, nowMs: number): boolean {
  return lastReloadAtMs === null || !Number.isFinite(lastReloadAtMs) || nowMs - lastReloadAtMs >= STUCK_SEEK_AUTO_RELOAD_COOLDOWN_MS
}

export interface BufferedRange { start: number; end: number }

/**
 * A position inside a buffered range, to seek to first. Ranges are tried
 * nearest to the target first and the first one that offers a usable point
 * wins; null when none does. A usable point sits half a second inside the
 * range at its near edge, or at the other edge or the middle when that would be
 * within a second of the target (a seek that does not move the player shows it
 * nothing); a range shorter than a second offers only its middle.
 */
export function nearestBufferedPoint(ranges: readonly BufferedRange[], targetSeconds: number): number | null {
  const usable = ranges
    .filter(range => range.end > range.start && Number.isFinite(range.start) && Number.isFinite(range.end))
    .map(range => ({
      range,
      distance: targetSeconds < range.start ? range.start - targetSeconds : targetSeconds > range.end ? targetSeconds - range.end : 0,
    }))
    .sort((left, right) => left.distance - right.distance)
  for (const { range } of usable) {
    const length = range.end - range.start
    const nearEdge = targetSeconds < range.start ? range.start + 0.5 : range.end - 0.5
    const farEdge = targetSeconds < range.start ? range.end - 0.5 : range.start + 0.5
    const candidates = length < 1 ? [range.start + length / 2] : [nearEdge, farEdge, range.start + length / 2]
    const point = candidates.find(candidate => Math.abs(candidate - targetSeconds) >= 1)
    if (point !== undefined)
      return point
  }
  return null
}
