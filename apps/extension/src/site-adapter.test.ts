import { describe, expect, it } from 'vitest'
import { isLikelyAdvertisingUrl, shouldBootstrapClickToLoadPlayer } from './site-adapter.ts'

describe('generic site adapter guards', () => {
  it('boots the Animerco click-to-load player only on the shared top-level page', () => {
    expect(shouldBootstrapClickToLoadPlayer('eta.animerco.org', true, true)).toBe(true)
    expect(shouldBootstrapClickToLoadPlayer('eta.animerco.org', false, true)).toBe(false)
    expect(shouldBootstrapClickToLoadPlayer('eta.animerco.org', true, false)).toBe(false)
    expect(shouldBootstrapClickToLoadPlayer('example.org', true, true)).toBe(false)
  })

  it('rejects known advertising frames without overmatching ordinary player hosts', () => {
    expect(isLikelyAdvertisingUrl('https://acceptable.a-ads.com/2429603/')).toBe(true)
    expect(isLikelyAdvertisingUrl('https://video.example.org/embed/42')).toBe(false)
    expect(isLikelyAdvertisingUrl('not a URL')).toBe(false)
  })
})
