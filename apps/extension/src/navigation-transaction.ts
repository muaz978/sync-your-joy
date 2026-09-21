import type { MediaFingerprint } from '@syncyourjoy/protocol'
import { mediaMatches, normalizeCanonicalId, normalizeMediaPageUrl } from '@syncyourjoy/protocol'

/**
 * Controller-follow is deliberately disabled until the headed provider path
 * has been validated. The policy is still explicit so a future opt-in cannot
 * accidentally follow a weak page or a guest navigation.
 */
export const CONTROLLER_FOLLOW_NAVIGATION_ENABLED = false

export interface ControllerNavigationPolicyInput {
  enabled: boolean
  isController: boolean
  hasCurrentLease: boolean
  currentRoomMedia: MediaFingerprint | null
  observedMedia: MediaFingerprint | null
  lastActionKey: string | null
}

/**
 * Produces a bounded deduplication key only for a strong Crunchyroll watch
 * identity. Login pages, guest pages, audio-only variants without a strong
 * watch identity and generic page fingerprints intentionally return null.
 */
export function strongCrunchyrollNavigationKey(media: MediaFingerprint | null): string | null {
  if (!media || media.service !== 'crunchyroll' || !media.pageUrl)
    return null
  if (media.canonicalId.startsWith('page:'))
    return null

  const canonicalId = normalizeCanonicalId(media.service, media.canonicalId)
  if (!/^crunchyroll:[A-Z0-9]+$/.test(canonicalId))
    return null

  const normalizedPageUrl = normalizeMediaPageUrl(media.pageUrl)
  if (!normalizedPageUrl)
    return null

  try {
    const url = new URL(normalizedPageUrl)
    if (!(url.hostname === 'crunchyroll.com' || url.hostname.endsWith('.crunchyroll.com')))
      return null
    if (!/\/watch\/[A-Z0-9]+(?:\/|$)/i.test(url.pathname))
      return null
  }
  catch {
    return null
  }

  return canonicalId
}

/**
 * Decides whether an observed controller navigation may become an automatic
 * shared-link action. This is fail-closed and remains false while the feature
 * flag is disabled. Manual shared-link actions do not use this policy.
 */
export function shouldFollowControllerNavigation(input: ControllerNavigationPolicyInput): boolean {
  if (!input.enabled || !input.isController || !input.hasCurrentLease)
    return false

  const observedKey = strongCrunchyrollNavigationKey(input.observedMedia)
  if (!observedKey || observedKey === input.lastActionKey)
    return false

  if (!input.currentRoomMedia || !input.observedMedia || mediaMatches(input.currentRoomMedia, input.observedMedia))
    return false

  return true
}
