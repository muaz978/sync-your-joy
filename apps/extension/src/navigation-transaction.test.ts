import type { MediaFingerprint } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { strongCrunchyrollNavigationKey, shouldFollowControllerNavigation } from './navigation-transaction.ts'

const currentEpisode: MediaFingerprint = {
  service: 'crunchyroll',
  canonicalId: 'crunchyroll:GE00365016JAJP',
  title: 'Episode 1',
  durationSeconds: 1_440,
  pageUrl: 'https://www.crunchyroll.com/watch/GE00365016JAJP/episode-1',
}

const nextEpisode: MediaFingerprint = {
  ...currentEpisode,
  canonicalId: 'crunchyroll:GE00365017JAJP',
  pageUrl: 'https://www.crunchyroll.com/watch/GE00365017JAJP/episode-2',
}

describe('controller-follow navigation policy', () => {
  it('requires a strong Crunchyroll watch identity and rejects guest or login pages', () => {
    expect(strongCrunchyrollNavigationKey(currentEpisode)).toBe('crunchyroll:GE00365016JAJP')
    expect(strongCrunchyrollNavigationKey({
      ...nextEpisode,
      pageUrl: 'https://www.crunchyroll.com/login',
    })).toBeNull()
    expect(strongCrunchyrollNavigationKey({
      ...nextEpisode,
      canonicalId: 'page:https://www.crunchyroll.com/watch/GE00365017JAJP',
    })).toBeNull()
    expect(strongCrunchyrollNavigationKey({
      ...nextEpisode,
      pageUrl: 'https://video.example/watch/GE00365017JAJP',
    })).toBeNull()
  })

  it('stays disabled until explicitly enabled and never follows a member', () => {
    const input = {
      enabled: false,
      isController: true,
      hasCurrentLease: true,
      currentRoomMedia: currentEpisode,
      observedMedia: nextEpisode,
      lastActionKey: null,
    }
    expect(shouldFollowControllerNavigation(input)).toBe(false)
    expect(shouldFollowControllerNavigation({ ...input, enabled: true, isController: false })).toBe(false)
    expect(shouldFollowControllerNavigation({ ...input, enabled: true, hasCurrentLease: false })).toBe(false)
  })

  it('follows only a new strong episode and deduplicates the same identity', () => {
    const input = {
      enabled: true,
      isController: true,
      hasCurrentLease: true,
      currentRoomMedia: currentEpisode,
      observedMedia: nextEpisode,
      lastActionKey: null,
    }
    expect(shouldFollowControllerNavigation(input)).toBe(true)
    expect(shouldFollowControllerNavigation({
      ...input,
      lastActionKey: strongCrunchyrollNavigationKey(nextEpisode),
    })).toBe(false)
    expect(shouldFollowControllerNavigation({
      ...input,
      observedMedia: { ...currentEpisode, title: 'Localized title' },
    })).toBe(false)
  })
})
