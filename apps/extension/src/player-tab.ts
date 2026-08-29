import { normalizePageUrl } from '@syncyourjoy/protocol'

export const PLAYER_CONTEXT_STALE_MS = 2_500

export function shouldReusePlayerTabForNavigation(
  playerTabId: number | null,
  currentPageUrl: string | undefined,
  navigationUrl: string,
): boolean {
  if (playerTabId === null || !currentPageUrl)
    return false
  const current = normalizePageUrl(currentPageUrl)
  const navigation = normalizePageUrl(navigationUrl)
  return current !== null && navigation !== null && current === navigation
}

export function shouldAcceptPlayerContext(options: {
  hasRoom: boolean
  boundTabId: number | null
  boundFrameId: number | null
  boundAreaPixels: number
  boundLastSeenAtMs: number
  participantReady: boolean
  senderTabId: number
  senderFrameId: number
  senderIsActive: boolean
  senderAreaPixels: number
  senderMediaMatchesRoom: boolean
  nowMs: number
}): boolean {
  if (!options.hasRoom)
    return options.senderIsActive && (
      options.boundTabId !== options.senderTabId
      || options.boundFrameId === null
      || options.boundFrameId === options.senderFrameId
      || options.senderAreaPixels > options.boundAreaPixels
    )

  if (options.boundTabId === null)
    return options.senderIsActive
  if (options.senderTabId !== options.boundTabId)
    return false
  if (options.boundFrameId === null || options.boundFrameId === options.senderFrameId)
    return true
  if (!options.participantReady)
    return options.senderAreaPixels > options.boundAreaPixels
  const boundIsStale = options.nowMs - options.boundLastSeenAtMs >= PLAYER_CONTEXT_STALE_MS
  const replacementIsLargeEnough = options.boundAreaPixels === 0
    || options.senderAreaPixels >= options.boundAreaPixels * 0.5
  return boundIsStale && options.senderMediaMatchesRoom && replacementIsLargeEnough
}
