/**
 * A pause the page makes when the browser window loses focus or the tab is
 * hidden (switching to another app on a Mac is the reported case) is not the
 * controller pausing. Sent to the room as one it pauses everyone, and the
 * controller has to press Play on coming back.
 *
 * Only a pause that comes right after the page was left, and while it is
 * still left, counts: a click on the player puts focus back in the page
 * first, and a pause long after leaving it (a media key) is a decision.
 */
export const AUTOMATIC_PAUSE_WINDOW_MS = 2_000

export interface PauseContext {
  roomPlaying: boolean
  visibilityState: string
  focused: boolean
  /** Milliseconds since the page was last left (blur or hidden), or null if never. */
  msSinceAway: number | null
}

export function isAutomaticPause(context: PauseContext): boolean {
  if (!context.roomPlaying || context.msSinceAway === null)
    return false
  const left = context.visibilityState === 'hidden' || !context.focused
  return left && context.msSinceAway >= 0 && context.msSinceAway <= AUTOMATIC_PAUSE_WINDOW_MS
}

/** Worth a diagnostics event: the page was not in front when it paused. */
export function isPauseWhileAway(context: PauseContext): boolean {
  return context.roomPlaying && (context.visibilityState === 'hidden' || !context.focused)
}
