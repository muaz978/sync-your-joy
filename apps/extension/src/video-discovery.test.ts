import { describe, expect, it } from 'vitest'
import { discoverOpenShadowRoots, discoverVideoElements } from './video-discovery.ts'

interface FakeRoot {
  querySelectorAll: (selector: string) => FakeElement[]
}

interface FakeElement extends FakeRoot {
  localName: string
  shadowRoot: FakeRoot | null
}

function root(...elements: FakeElement[]): FakeRoot {
  return { querySelectorAll: () => elements }
}

function element(localName: string, shadowRoot: FakeRoot | null = null, ...children: FakeElement[]): FakeElement {
  return {
    localName,
    shadowRoot,
    querySelectorAll: () => children,
  }
}

describe('generic video discovery', () => {
  it('finds light-DOM and nested open-Shadow-DOM video elements', () => {
    const nestedVideo = element('video')
    const nestedRoot = root(nestedVideo)
    const host = element('x-player', nestedRoot)
    const lightVideo = element('video')
    const documentRoot = root(lightVideo, host)

    expect(discoverVideoElements(documentRoot as unknown as Document)).toEqual([lightVideo, nestedVideo])
    expect(discoverOpenShadowRoots(documentRoot as unknown as Document)).toEqual([nestedRoot])
  })

  it('does not revisit a shared open root or duplicate a video', () => {
    const sharedVideo = element('video')
    const sharedRoot = root(sharedVideo)
    const firstHost = element('x-player', sharedRoot)
    const secondHost = element('x-player', sharedRoot)
    const documentRoot = root(firstHost, secondHost)

    expect(discoverVideoElements(documentRoot as unknown as Document)).toEqual([sharedVideo])
    expect(discoverOpenShadowRoots(documentRoot as unknown as Document)).toEqual([sharedRoot])
  })
})
