import { describe, expect, it } from 'vitest'
import { bindMediaToSharedPage, canonicalMediaId, serviceName } from './media-fingerprint.ts'

describe('streaming media fingerprints', () => {
  it('binds a deeply nested player to the shared page instead of a temporary wrapper URL', () => {
    const nested = {
      service: 'html5',
      canonicalId: 'page:https://drive.google.com/file/example/preview',
      title: 'Google Drive player',
      durationSeconds: 120,
      pageUrl: 'https://eta.animerco.org/jwplayer/?pnonce=temporary-client-token',
    }
    expect(bindMediaToSharedPage(nested, 'https://eta.animerco.org/episodes/example/')).toMatchObject({
      pageUrl: 'https://eta.animerco.org/episodes/example',
    })
  })

  it('uses the Crunchyroll episode ID across host, locale, and slug variants', () => {
    const variants = [
      'https://crunchyroll.com/watch/GE00345558JAJP/from-now-on',
      'https://www.crunchyroll.com/watch/GE00345558JAJP/from-now-on',
      'https://www.crunchyroll.com/ar/watch/GE00345558JAJP/un-titre-localise',
    ]

    expect(variants.map(value => canonicalMediaId('crunchyroll', new URL(value))))
      .toEqual(Array.from({ length: 3 }, () => 'crunchyroll:GE00345558JAJP'))
  })

  it('normalizes common hostnames and Netflix watch IDs', () => {
    expect(serviceName('www.crunchyroll.com')).toBe('crunchyroll')
    expect(canonicalMediaId('netflix', new URL('https://www.netflix.com/watch/81712345?trackId=1')))
      .toBe('netflix:81712345')
  })
})
