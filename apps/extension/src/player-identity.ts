import type { MediaFingerprint } from '@syncyourjoy/protocol'
import { mediaMatches } from '@syncyourjoy/protocol'

export type PlayerIdentityDecision = 'match' | 'mismatch' | 'unknown'

const STRONG_CANONICAL_PREFIXES = ['youtube:', 'crunchyroll:', 'netflix:', 'disney-plus:', 'qfilm:']

/**
 * Generic nested frames often expose only an intermediate wrapper URL. The
 * worker's accepted outer-tab binding is therefore the authority for those
 * frames, while stable provider IDs remain strong local evidence.
 */
export function hasStrongLocalIdentity(media: MediaFingerprint, nested: boolean): boolean {
  if (STRONG_CANONICAL_PREFIXES.some(prefix => media.canonicalId.toLowerCase().startsWith(prefix)))
    return true
  return !nested
}

export function decidePlayerIdentity(options: {
  roomMedia: MediaFingerprint | null
  localMedia: MediaFingerprint
  workerBoundMedia: MediaFingerprint | null
  nested: boolean
}): PlayerIdentityDecision {
  const { roomMedia, localMedia, workerBoundMedia, nested } = options
  if (!roomMedia)
    return 'unknown'

  // A worker binding that no longer matches the room is a known mismatch even
  // if the content script is itself nested and cannot identify its wrapper.
  if (workerBoundMedia && !mediaMatches(roomMedia, workerBoundMedia))
    return 'mismatch'

  if (hasStrongLocalIdentity(localMedia, nested))
    return mediaMatches(roomMedia, localMedia) ? 'match' : 'mismatch'

  // An unresolved local identity is safe only when the worker has already
  // acknowledged a bound player that matches the room.
  if (workerBoundMedia && mediaMatches(roomMedia, workerBoundMedia))
    return 'match'

  return 'unknown'
}
