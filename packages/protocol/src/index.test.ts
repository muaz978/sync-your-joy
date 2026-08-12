import type { MediaFingerprint } from './index.ts'
import { describe, expect, it } from 'vitest'
import { mediaMatches, normalizeCanonicalId, normalizePageUrl, parseClientMessage } from './index.ts'

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

  it('treats identical normalized page links as a strong match on generic sites', () => {
    const host: MediaFingerprint = {
      service: 'html5', canonicalId: 'page:host-variant', title: 'Host title', durationSeconds: 100,
      pageUrl: 'https://video.example/watch?id=42&utm_source=chat',
    }
    const guest: MediaFingerprint = {
      service: 'html5', canonicalId: 'page:guest-variant', title: 'Guest title', durationSeconds: 120,
      pageUrl: 'https://video.example/watch?id=42',
    }
    expect(mediaMatches(host, guest)).toBe(true)
  })

  it('allows only normalized HTTP and HTTPS room links', () => {
    expect(normalizePageUrl('https://Example.com/watch/?b=2&a=1#player')).toBe('https://example.com/watch?a=1&b=2')
    expect(normalizePageUrl('javascript:alert(1)')).toBeNull()
    expect(normalizePageUrl('file:///tmp/video.mp4')).toBeNull()
    expect(normalizePageUrl('https://user:secret@example.com/watch')).toBeNull()
    expect(normalizePageUrl(`https://example.com/${'x'.repeat(2_100)}`)).toBeNull()
    expect(parseClientMessage({
      type: 'open_link',
      actionId: 'action_open_safe',
      basedOnRevision: 1,
      leaseEpoch: 1,
      url: 'javascript:alert(1)',
    })).toBeNull()
  })
})
