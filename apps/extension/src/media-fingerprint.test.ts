import { describe, expect, it } from 'vitest'
import { canonicalMediaId, serviceName } from './media-fingerprint.ts'

describe('streaming media fingerprints', () => {
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
