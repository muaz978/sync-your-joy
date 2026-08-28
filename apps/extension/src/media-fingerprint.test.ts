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
      service: 'html5',
      canonicalId: 'page:https://eta.animerco.org/episodes/example',
      pageUrl: 'https://eta.animerco.org/episodes/example',
    })
  })

  it('recovers Qfilm identity from the outer tab when the player suppresses its referrer', () => {
    const nested = {
      service: 'html5',
      canonicalId: 'page:https://wwa.liiivideo.com/embed-temporary.html',
      title: 'Untitled video',
      durationSeconds: null,
      pageUrl: 'https://wwa.liiivideo.com/embed-temporary.html',
    }

    expect(bindMediaToSharedPage(nested, 'https://a.qfilm.tv/play.php?vid=a0821a41c')).toMatchObject({
      service: 'qfilm',
      canonicalId: 'qfilm:a0821a41c',
      pageUrl: 'https://a.qfilm.tv/play.php?vid=a0821a41c',
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

  it('uses the stable Qfilm video ID across page and embed variants', () => {
    const variants = [
      'https://a.qfilm.tv/play.php?vid=a0821a41c',
      'https://a.qfilm.tv/watch.php?vid=a0821a41c',
      'https://a.qfilm.tv/embed.php?vid=A0821A41C',
    ]

    expect(serviceName('a.qfilm.tv')).toBe('qfilm')
    expect(variants.map(value => canonicalMediaId('qfilm', new URL(value))))
      .toEqual(Array.from({ length: 3 }, () => 'qfilm:a0821a41c'))
  })
})
