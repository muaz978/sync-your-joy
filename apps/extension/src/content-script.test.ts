import type { MediaFingerprint } from '@syncyourjoy/protocol'
import type { ExtensionState, RuntimeEvent, RuntimeRequest } from './internal.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Exercise the actual content-script listeners and timers. The fake media
// element lets us reproduce async provider races without an account or DRM.
class FakeElement extends EventTarget {
  style: Record<string, string> = {}
  id = ''
  innerHTML = ''
  textContent = ''
  hidden = false
  localName = 'div'
  shadowRoot = null
  append() {}
  attachShadow() { return new FakeElement() }
  querySelector() { return null }
  querySelectorAll() { return [] }
}

class FakeVideo extends FakeElement {
  static HAVE_NOTHING = 0
  static HAVE_METADATA = 1
  static HAVE_CURRENT_DATA = 2
  localName = 'video'
  isConnected = true
  currentSrc = 'blob:fixture-episode'
  srcObject = null
  clientWidth = 960
  clientHeight = 540
  readyState = 4
  networkState = 1
  duration = 1420
  paused = true
  ended = false
  seeking = false
  playbackRate = 1
  position = 0
  writes: number[] = []
  seekable = { length: 1, start: () => 0, end: () => 1420 }
  totalFrames = 10
  droppedFrames = 0
  play = vi.fn<() => Promise<void>>(() => {
    this.paused = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  pause = vi.fn(() => {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
  get currentTime() { return this.position }
  set currentTime(value: number) {
    this.writes.push(value)
    this.position = value
    this.seeking = true
    this.dispatchEvent(new Event('seeking'))
  }
  getAttribute() { return null }
  getRootNode() { return document }
  getBoundingClientRect() { return { left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540 } }
  getVideoPlaybackQuality() { return { totalVideoFrames: this.totalFrames, droppedVideoFrames: this.droppedFrames } }
}

let video: FakeVideo
let state: ExtensionState
let messages: RuntimeRequest[]
let listener: (message: RuntimeEvent) => void

function apply(status: 'paused' | 'playing', positionSeconds = 0) {
  state = structuredClone(state)
  state.snapshot!.revision++
  state.snapshot!.playback = { status, positionSeconds, effectiveAtServerMs: Date.now(), playbackRate: 1 }
  listener({ type: 'APPLY_ROOM_STATE', state })
}

function statuses() {
  return messages.filter((message): message is Extract<RuntimeRequest, { type: 'PLAYER_STATUS' }> => message.type === 'PLAYER_STATUS')
}

const identityLayouts: Array<{
  name: string
  roomMedia: MediaFingerprint
  playerUrl: string
  referrer: string
  nested: boolean
  workerBoundMedia: MediaFingerprint | null
}> = [
  {
    name: 'top-document Crunchyroll',
    roomMedia: {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00365016JAJP',
      title: 'Episode',
      durationSeconds: 1420,
      pageUrl: 'https://www.crunchyroll.com/watch/GE00365016JAJP/episode',
    },
    playerUrl: 'https://www.crunchyroll.com/watch/GE00365016JAJP/episode',
    referrer: '',
    nested: false,
    workerBoundMedia: null,
  },
  {
    name: 'origin-only Crunchyroll iframe',
    roomMedia: {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00365016JAJP',
      title: 'Episode',
      durationSeconds: 1420,
      pageUrl: 'https://www.crunchyroll.com/watch/GE00365016JAJP/episode',
    },
    playerUrl: 'https://static.crunchyroll.com/player/frame.html',
    referrer: 'https://www.crunchyroll.com/',
    nested: true,
    workerBoundMedia: {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00365016JAJP',
      title: 'Episode',
      durationSeconds: 1420,
      pageUrl: 'https://www.crunchyroll.com/watch/GE00365016JAJP/episode',
    },
  },
  {
    name: 'generic nested embed',
    roomMedia: {
      service: 'html5',
      canonicalId: 'page:https://watch.example/episode/42',
      title: 'Episode 42',
      durationSeconds: 120,
      pageUrl: 'https://watch.example/episode/42',
    },
    playerUrl: 'https://player.example/embed/client-wrapper',
    referrer: 'https://player.example/',
    nested: true,
    workerBoundMedia: {
      service: 'html5',
      canonicalId: 'page:https://watch.example/episode/42',
      title: 'Episode 42',
      durationSeconds: 120,
      pageUrl: 'https://watch.example/episode/42',
    },
  },
  {
    name: 'nested Qfilm player',
    roomMedia: {
      service: 'qfilm',
      canonicalId: 'qfilm:a0821a41c',
      title: 'Qfilm movie',
      durationSeconds: 120,
      pageUrl: 'https://a.qfilm.tv/play.php?vid=a0821a41c',
    },
    playerUrl: 'https://player.qfilm.tv/embed.php?vid=a0821a41c',
    referrer: 'https://a.qfilm.tv/play.php?vid=a0821a41c',
    nested: true,
    workerBoundMedia: null,
  },
]

function configureIdentityLayout(layout: typeof identityLayouts[number]): void {
  state.snapshot!.media = layout.roomMedia
  state.currentMedia = layout.workerBoundMedia
  vi.stubGlobal('location', new URL(layout.playerUrl))
  Object.defineProperty(document, 'referrer', { configurable: true, value: layout.referrer })
  Object.defineProperty(window, 'top', { configurable: true, value: layout.nested ? {} : window })
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
  video = new FakeVideo()
  messages = []
  state = {
    participantId: 'guest', connection: 'connected', serverOffsetMs: 0,
    sessionToken: null, clockUncertaintyMs: 0, lastError: null,
    displayName: 'Guest', playerTabId: 1, playerFrameId: 0, playerAreaPixels: 518400, playerLastSeenAtMs: Date.now(),
    currentMedia: null, playerDiagnostics: null, lastPlayerSample: null, lastOpenedNavigationRevision: 0,
    connectionQuality: 'good', roundTripMs: 0, lastPongAtMs: Date.now(),
    snapshot: {
      roomId: 'room', code: 'TESTCODE', revision: 1,
      controller: { participantId: 'host', leaseEpoch: 1 },
      media: { service: 'crunchyroll', canonicalId: 'crunchyroll:GE00365016JAJP', title: 'Episode', durationSeconds: 1420 },
      playback: { status: 'paused', positionSeconds: 0, effectiveAtServerMs: Date.now(), playbackRate: 1 },
      navigation: null, seek: null,
      participants: [{ id: 'guest', name: 'Guest', role: 'member', ready: true, mediaMatches: true, connected: true, latencyMs: 0 }],
      pendingJoinRequests: [], policy: { buffering: 'pause-all' },
    },
  }
  const fakeDocument = Object.assign(new FakeElement(), {
    documentElement: new FakeElement(), visibilityState: 'visible', title: 'Episode - Watch on Crunchyroll', referrer: '',
    createElement: () => new FakeElement(), querySelectorAll: () => [video],
  })
  const fakeWindow = Object.assign(new EventTarget(), { top: null as unknown })
  fakeWindow.top = fakeWindow
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('location', new URL('https://www.crunchyroll.com/watch/GE00365016JAJP/episode'))
  vi.stubGlobal('innerWidth', 1200)
  vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('HTMLVideoElement', FakeVideo)
  vi.stubGlobal('HTMLMediaElement', FakeVideo)
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('ShadowRoot', class {})
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible', opacity: '1' }))
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
    runtime: {
      id: 'fixture-extension',
      onMessage: { addListener: (callback: typeof listener) => { listener = callback } },
      sendMessage: vi.fn(async (request: RuntimeRequest) => { messages.push(request); return { ok: true, state } }),
    },
  })
  await import('./content-script.ts')
  await Promise.resolve()
  messages.length = 0
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('adaptive player lifecycle', () => {
  it('learns the worker binding token from media detection and propagates it to later status messages', async () => {
    const sendMessage = (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>)
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      messages.push(request)
      return request.type === 'MEDIA_DETECTED'
        ? { ok: true, state, playerBindingId: 'binding_content_document' }
        : { ok: true, state }
    })
    messages.length = 0

    video.dispatchEvent(new Event('loadstart'))
    await Promise.resolve()
    await Promise.resolve()
    expect(messages).toContainEqual(expect.objectContaining({ type: 'MEDIA_DETECTED' }))

    await vi.advanceTimersByTimeAsync(1_000)
    const status = messages.find((message): message is Extract<RuntimeRequest, { type: 'PLAYER_STATUS' }> => message.type === 'PLAYER_STATUS')
    expect(status?.bindingId).toBe('binding_content_document')
  })

  it.each(identityLayouts)('keeps playback commands and samples bound to the $name identity', async (layout) => {
    configureIdentityLayout(layout)
    video.position = 120
    apply('playing', 120)
    await Promise.resolve()
    await Promise.resolve()

    expect(video.play).toHaveBeenCalledOnce()
    expect(statuses().some(message => message.sample.positionSeconds >= 0)).toBe(true)
  })

  it.each(identityLayouts)('keeps controller play, pause and seek intents on the $name identity', async (layout) => {
    configureIdentityLayout(layout)
    state.participantId = 'host'
    apply('paused')
    messages.length = 0

    video.play()
    video.pause()
    video.currentTime = 210
    await vi.advanceTimersByTimeAsync(300)

    expect(messages.filter(message => message.type === 'PLAYER_INTENT')).toEqual(expect.arrayContaining([
      { type: 'PLAYER_INTENT', kind: 'play', positionSeconds: expect.any(Number) },
      { type: 'PLAYER_INTENT', kind: 'pause', positionSeconds: expect.any(Number) },
      { type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: 210 },
    ]))
  })

  it.each(identityLayouts)('emits a seek acknowledgement only after the $name identity is confirmed', async (layout) => {
    configureIdentityLayout(layout)
    state.snapshot!.seek = {
      revision: 2,
      positionSeconds: 120,
      acknowledgedParticipantIds: [],
      resumeWhenReady: true,
      deadlineAtServerMs: Date.now() + 1_800,
    }
    video.position = 120
    apply('paused', 120)
    await Promise.resolve()
    await Promise.resolve()

    expect(messages.filter(message => message.type === 'SEEK_APPLIED')).toEqual([
      { type: 'SEEK_APPLIED', revision: 2, positionSeconds: 120 },
    ])
  })

  it('does not repeatedly restart an in-flight seek as the room clock advances', async () => {
    apply('playing', 120)
    expect(video.writes).toEqual([120])
    await vi.advanceTimersByTimeAsync(1000)
    // A new moving target each second cancels the segment/decode work that
    // the first seek is still waiting for.
    expect(video.writes).toEqual([120])
  })

  it('does not call a play interruption an autoplay rejection', async () => {
    video.play.mockRejectedValue(new DOMException('Interrupted by load', 'AbortError'))
    apply('playing')
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses().some(message => message.sample.playbackStartFailed)).toBe(false)
  })

  it('ignores a stale play rejection after a newer pause', async () => {
    let reject!: (error: Error) => void
    video.play.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    apply('playing')
    apply('paused')
    reject(new DOMException('Old request failed', 'NotAllowedError'))
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses().some(message => message.sample.playbackStartFailed)).toBe(false)
  })

  it('still reports a current autoplay policy rejection', async () => {
    video.play.mockRejectedValue(new DOMException('User activation required', 'NotAllowedError'))
    apply('playing')
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses().some(message => message.sample.playbackStartFailed)).toBe(true)
  })

  it('does not acknowledge a seek until data at the target can play', () => {
    video.position = 120
    video.readyState = 1
    state.snapshot!.seek = { revision: 2, positionSeconds: 120, acknowledgedParticipantIds: [], resumeWhenReady: true, deadlineAtServerMs: Date.now() + 1800 }
    apply('paused', 120)
    expect(messages.some(message => message.type === 'SEEK_APPLIED')).toBe(false)
  })

  it('accepts a generic nested player when the worker-bound outer tab matches the room', () => {
    state.currentMedia = state.snapshot!.media
    Object.defineProperty(window, 'top', { configurable: true, value: {} })
    vi.stubGlobal('location', new URL('https://player.example/embed/client-wrapper'))
    video.position = 120
    apply('playing', 120)

    expect(video.play).toHaveBeenCalledOnce()
  })

  it('detects frozen frames even if the media clock advances', async () => {
    apply('playing')
    for (let i = 1; i <= 5; i++) {
      video.position = i
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(statuses().some(message => message.sample.buffering)).toBe(true)
    expect(statuses().some(message => message.sample.progressed)).toBe(false)
  })

  it('starts playback after a slow correction before trying another hard seek', async () => {
    apply('playing', 120)
    await vi.advanceTimersByTimeAsync(1200)
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    await Promise.resolve()
    expect(video.writes).toEqual([120])
    expect(video.play).toHaveBeenCalledOnce()
  })

  it.each([800, 1_200, 2_000])('bounds hard corrections during a %sms seek and 30 seconds of stalled playback', async (delayMs) => {
    apply('playing', 120)
    await vi.advanceTimersByTimeAsync(delayMs)
    video.seeking = false
    video.position = 120
    video.dispatchEvent(new Event('seeked'))
    for (let elapsed = delayMs; elapsed < 30_000; elapsed += 100) {
      await vi.advanceTimersByTimeAsync(100)
      if (video.seeking) {
        video.seeking = false
        video.dispatchEvent(new Event('seeked'))
      }
    }

    expect(video.writes.length).toBeLessThanOrEqual(2)
    expect(statuses().some(message => message.sample.buffering)).toBe(true)
  })

  it('retains a timed-out native seek instead of restarting it on each paused heartbeat', async () => {
    apply('paused', 120)
    await vi.advanceTimersByTimeAsync(4000)
    expect(video.writes).toEqual([120])
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    expect(video.writes).toEqual([120])
  })

  it('finishes a timed-out seek from late readiness without another native write', async () => {
    apply('paused', 120)
    await vi.advanceTimersByTimeAsync(4000)
    expect(video.writes).toEqual([120])

    video.seeking = false
    video.dispatchEvent(new Event('canplay'))
    expect(video.writes).toEqual([120])

    apply('playing', 120)
    expect(video.play).toHaveBeenCalledOnce()
  })

  it('supersedes a pending seek when a newer room target arrives', () => {
    apply('paused', 120)
    apply('paused', 400)
    expect(video.writes).toEqual([120, 400])
  })

  it('waits for seekability rather than assigning a target during source loading', () => {
    video.seekable.length = 0
    apply('paused', 120)
    expect(video.writes).toEqual([])
    video.seekable.length = 1
    video.dispatchEvent(new Event('loadeddata'))
    expect(video.writes).toEqual([120])
  })

  it('acknowledges a ready seek after data arrives', () => {
    video.position = 120
    video.readyState = 1
    state.snapshot!.seek = { revision: 2, positionSeconds: 120, acknowledgedParticipantIds: [], resumeWhenReady: true, deadlineAtServerMs: Date.now() + 1800 }
    apply('paused', 120)
    video.readyState = 4
    video.dispatchEvent(new Event('canplay'))
    expect(messages.filter(message => message.type === 'SEEK_APPLIED')).toHaveLength(1)
  })

  it('reports healthy rendered frames as progress', async () => {
    apply('playing')
    for (let i = 1; i <= 5; i++) {
      video.position = i
      video.totalFrames += 24
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(statuses().some(message => message.sample.buffering)).toBe(false)
    expect(statuses().some(message => message.sample.progressed)).toBe(true)
  })

  it('does not mistake suspended background rendering for a freeze', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    apply('playing')
    for (let i = 1; i <= 5; i++) {
      video.position = i
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(statuses().some(message => message.sample.buffering)).toBe(false)
    expect(statuses().some(message => message.sample.progressed)).toBe(true)
  })

  it('does not apply old room commands or send new-episode intent before the navigation poll', async () => {
    state.participantId = 'host'
    apply('paused')
    messages.length = 0
    vi.stubGlobal('location', new URL('https://www.crunchyroll.com/watch/GE00365018JAJP/next-episode'))
    video.position = 3
    video.dispatchEvent(new Event('play'))
    video.dispatchEvent(new Event('pause'))
    video.dispatchEvent(new Event('seeking'))
    video.dispatchEvent(new Event('ended'))
    apply('playing', 500)
    await vi.advanceTimersByTimeAsync(1000)
    expect(video.writes).toEqual([])
    expect(messages.some(message => message.type === 'PLAYER_INTENT' || message.type === 'PLAYER_STATUS')).toBe(false)
  })

  it('blocks old room operations after leaving Crunchyroll entirely', async () => {
    state.participantId = 'host'
    apply('paused')
    messages.length = 0
    vi.stubGlobal('location', new URL('https://video.example/watch/other'))
    video.position = 4
    video.dispatchEvent(new Event('play'))
    video.dispatchEvent(new Event('pause'))
    apply('playing', 500)
    await vi.advanceTimersByTimeAsync(1000)
    expect(video.writes).toEqual([])
    expect(messages.some(message => message.type === 'PLAYER_INTENT' || message.type === 'PLAYER_STATUS')).toBe(false)
  })

  it('invalidates pending play failures on same-element source reload', async () => {
    let reject!: (error: Error) => void
    video.play.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    apply('playing')
    video.currentSrc = 'blob:replacement'
    video.dispatchEvent(new Event('emptied'))
    reject(new DOMException('Old source failed', 'NotAllowedError'))
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses().some(message => message.sample.playbackStartFailed)).toBe(false)
  })

  it('keeps late correction completion from becoming a controller seek', async () => {
    state.participantId = 'host'
    apply('paused', 120)
    await vi.advanceTimersByTimeAsync(4500)
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    await vi.advanceTimersByTimeAsync(100)
    expect(messages.some(message => message.type === 'PLAYER_INTENT' && message.kind === 'seek')).toBe(false)
  })

  it('does not turn a late native completion into a new seek after the room barrier expires', async () => {
    state.participantId = 'host'
    state.snapshot!.seek = {
      revision: 2,
      positionSeconds: 120,
      acknowledgedParticipantIds: [],
      resumeWhenReady: true,
      deadlineAtServerMs: Date.now() + 1_800,
    }
    apply('paused', 120)
    await vi.advanceTimersByTimeAsync(2_000)

    // The coordinator has released the shared barrier while the browser's
    // native seek is still finishing. The late event must retain its old
    // operation attribution rather than becoming fresh controller intent.
    state.snapshot!.seek = null
    apply('paused', 120)
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    await vi.advanceTimersByTimeAsync(100)

    expect(messages.some(message => message.type === 'PLAYER_INTENT' && message.kind === 'seek')).toBe(false)
  })

  it('propagates a real Skip Intro that supersedes an expected correction', async () => {
    state.participantId = 'host'
    apply('paused', 120)
    video.currentTime = 210
    await vi.advanceTimersByTimeAsync(100)
    expect(messages.filter(message => message.type === 'PLAYER_INTENT' && message.kind === 'seek')).toEqual([
      { type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: 210 },
    ])
  })

  it('adopts the controller native seek when the barrier arrives without restarting it', () => {
    state.participantId = 'host'
    video.position = 120
    video.seeking = true
    state.snapshot!.seek = { revision: 2, positionSeconds: 120, acknowledgedParticipantIds: [], resumeWhenReady: true, deadlineAtServerMs: Date.now() + 1800 }
    apply('paused', 120)
    expect(video.writes).toEqual([])
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    expect(messages.some(message => message.type === 'SEEK_APPLIED')).toBe(true)
  })

  it('ignores pending play failure after immediate local pause before a server reply', async () => {
    state.participantId = 'host'
    let reject!: (error: Error) => void
    video.play.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    apply('playing')
    listener({ type: 'PAUSE_LOCAL' })
    reject(new DOMException('Old play request', 'NotAllowedError'))
    await Promise.resolve()
    await Promise.resolve()
    expect(statuses().some(message => message.sample.playbackStartFailed)).toBe(false)
  })

  it('cancels a debounced controller seek when a newer room command arrives', async () => {
    state.participantId = 'host'
    video.position = 210
    video.seeking = true
    video.dispatchEvent(new Event('seeking'))

    apply('playing', 0)
    await vi.advanceTimersByTimeAsync(100)

    expect(messages.some(message => message.type === 'PLAYER_INTENT' && message.kind === 'seek')).toBe(false)
  })

  it('does not turn a late seek completion into intent after local pause retires it', async () => {
    state.participantId = 'host'
    apply('paused', 120)
    listener({ type: 'PAUSE_LOCAL' })
    messages.length = 0

    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    await vi.advanceTimersByTimeAsync(100)

    expect(messages.some(message => message.type === 'PLAYER_INTENT' && message.kind === 'seek')).toBe(false)
  })

  it('releases a timed-out seek when a newer room play command arrives', () => {
    apply('paused', 120)
    vi.advanceTimersByTime(2000)
    video.seeking = false
    apply('playing', 120)
    expect(video.play).toHaveBeenCalledOnce()
  })
})
