/**
 * The clock that expires a room nobody is in.
 *
 * It is a function of membership, not of events: while any participant is
 * connected there is no clock, and while nobody is connected a clock must be
 * running from the moment the room became empty. Both coordinators used to
 * maintain it by setting or clearing it on each join, leave and withdrawal
 * path, which meant a path that forgot (or a state restored after the
 * previous instance went away mid-update) left it wrong in either direction:
 * a stale clock expires a room under active members, a missing one keeps an
 * empty room alive for its whole lifetime.
 *
 * Callers apply this wherever they act on the clock (the periodic cleanup and
 * the alarm, and on restore), so the invariant is enforced in one place.
 *
 * Returns the clock the room should now have: `null` while someone is
 * connected, the existing start time while the room stays empty, and `nowMs`
 * when the room is empty and no clock was running.
 */
export function reconcileEmptyClock(options: {
  emptySinceMs: number | null
  hasConnectedParticipants: boolean
  nowMs: number
}): number | null {
  if (options.hasConnectedParticipants)
    return null
  return options.emptySinceMs ?? options.nowMs
}

/** True once an empty room has been empty for at least `ttlMs`. */
export function isEmptyRoomExpired(emptySinceMs: number | null, nowMs: number, ttlMs: number): boolean {
  return emptySinceMs !== null && nowMs - emptySinceMs >= ttlMs
}
