import { normalizePageUrl } from '@syncyourjoy/protocol'
import { canonicalMediaId } from './media-fingerprint.ts'

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
  if (current === null || navigation === null)
    return false
  if (current === navigation)
    return true
  // Crunchyroll localizes the path and title independently of the episode.
  // Reopening the same episode discards the user's initialized player and
  // chosen language, even though both pages identify the same media.
  const currentUrl = new URL(current)
  const navigationUrlObject = new URL(navigation)
  const isCrunchyroll = (hostname: string) => hostname === 'crunchyroll.com' || hostname.endsWith('.crunchyroll.com')
  if (!isCrunchyroll(currentUrl.hostname) || !isCrunchyroll(navigationUrlObject.hostname))
    return false
  const currentId = canonicalMediaId('crunchyroll', currentUrl)
  return currentId.startsWith('crunchyroll:') && currentId === canonicalMediaId('crunchyroll', navigationUrlObject)
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
  const boundIsStale = options.nowMs - options.boundLastSeenAtMs >= PLAYER_CONTEXT_STALE_MS
  const replacementIsLargeEnough = options.boundAreaPixels === 0
    || options.senderAreaPixels >= options.boundAreaPixels * 0.5
  if (!options.hasRoom)
    return options.senderIsActive && (
      options.boundTabId !== options.senderTabId
      || options.boundFrameId === null
      || options.boundFrameId === options.senderFrameId
      || options.senderAreaPixels > options.boundAreaPixels
      || (boundIsStale && replacementIsLargeEnough)
    )

  if (options.boundTabId === null)
    return options.senderIsActive
  if (options.senderTabId !== options.boundTabId)
    return false
  if (options.boundFrameId === null || options.boundFrameId === options.senderFrameId)
    return true
  if (!options.participantReady && options.senderAreaPixels > options.boundAreaPixels)
    return true
  // A disappearing player makes the participant unready. That must not
  // disable stale-frame recovery for an equally sized replacement.
  return boundIsStale && options.senderMediaMatchesRoom && replacementIsLargeEnough
}
