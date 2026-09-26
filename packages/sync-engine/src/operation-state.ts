import type { RoomOperation } from '@syncyourjoy/protocol'

/**
 * A paused seek has no start phase. Once every required participant has
 * prepared at the target it is complete, although its wire phase stays
 * `committed` (see docs/CR_B03_EXTENSION_ACK_REPORT.md: it "aligns and remains
 * paused without sending a started acknowledgement"). The coordinator keeps it
 * in the snapshot until its window closes, then clears it. In the meantime
 * deadlines, health, participant status and a player's own operation handling
 * must never treat it as awaiting a start.
 */
export function isSettledPausedSeek(operation: RoomOperation | null | undefined): boolean {
  return operation?.kind === 'seek'
    && operation.resumeWhenReady === false
    && operation.phase === 'committed'
}
