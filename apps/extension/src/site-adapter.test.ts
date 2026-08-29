import { describe, expect, it } from 'vitest'
import { hasUsableVideoSource, isLikelyAdvertisingUrl, shouldBootstrapClickToLoadPlayer } from './site-adapter.ts'

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

  it('rejects visible decoy video elements that have no media source', () => {
    expect(hasUsableVideoSource('', null, null, false)).toBe(false)
    expect(hasUsableVideoSource('blob:https://player.example/id', null, null, false)).toBe(true)
    expect(hasUsableVideoSource('', '/movie.m3u8', null, false)).toBe(true)
    expect(hasUsableVideoSource('', null, '/movie.mp4', false)).toBe(true)
    expect(hasUsableVideoSource('', null, null, true)).toBe(true)
    expect(hasUsableVideoSource('', null, null, false, 1, 2)).toBe(true)
    expect(hasUsableVideoSource('', null, null, false, 0, 2)).toBe(false)
  })
})
