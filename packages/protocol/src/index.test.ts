import type { MediaFingerprint } from './index.ts'
import { describe, expect, it } from 'vitest'
import { mediaMatches, normalizeCanonicalId } from './index.ts'

describe('media identity matching', () => {
  it('matches legacy and stable Crunchyroll IDs for the same episode', () => {
    const host: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'www.crunchyroll.com/watch/GE00345558JAJP/from-now-on',
      title: 'Localized host title',
      durationSeconds: 1_470,
    }
    const guest: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00345558JAJP',
      title: 'Different regional page title',
      durationSeconds: 1_465,
    }

    expect(mediaMatches(host, guest)).toBe(true)
    expect(normalizeCanonicalId(host.service, host.canonicalId)).toBe(guest.canonicalId)
  })

  it('does not match different Crunchyroll episode IDs', () => {
    const base: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00345558JAJP',
      title: 'Episode 12',
      durationSeconds: 1_470,
    }

    expect(mediaMatches(base, { ...base, canonicalId: 'crunchyroll:GOTHER123456' })).toBe(false)
  })
})
