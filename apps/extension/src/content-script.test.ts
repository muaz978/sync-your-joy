import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import type { MediaFingerprint } from '@syncyourjoy/protocol'
import type { ContentRequest, ExtensionState, RuntimeEvent, RuntimeRequest } from './internal.ts'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'
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
  // The only element the content script gives a shadow root is the pill's
  // host, so this is where the test gets hold of the pill.
  attachShadow() {
    pillHost = this
    pillShadow = new FakePillShadowRoot()
    return pillShadow
  }
  querySelector(_selector?: string): FakeElement | null { return null }
  querySelectorAll() { return [] }
}

// Stand-ins for the elements of the pill, which lives in a closed shadow root
// and so cannot be read from a real browser test.
class FakePillElement extends FakeElement {
  disabled = false
}

const PILL_SELECTORS = ['.pill', '#syj-status', '#syj-meta', '#syj-notice', '#syj-actions', '#syj-playback', '#syj-sync', '#syj-room', '#syj-hide', '#syj-restore']

class FakePillShadowRoot extends FakeElement {
  readonly elements = new Map<string, FakePillElement>(PILL_SELECTORS.map(selector => [selector, new FakePillElement()]))
  querySelector(selector?: string) { return (selector ? this.elements.get(selector) : undefined) ?? null }
}

let pillHost: FakeElement
let pillShadow: FakePillShadowRoot
const pill = (selector: typeof PILL_SELECTORS[number]) => pillShadow.elements.get(selector)!

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
  rateMode: 'accept' | 'ignore' | 'reset' = 'accept'
  private appliedPlaybackRate = 1
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
  get playbackRate() { return this.appliedPlaybackRate }
  set playbackRate(value: number) {
    if (this.rateMode === 'ignore')
      return
    this.appliedPlaybackRate = this.rateMode === 'reset' ? 1 : value
  }
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
let listener: (message: RuntimeEvent | ContentRequest, sender?: unknown, sendResponse?: (response: unknown) => void) => void

function apply(status: 'paused' | 'playing', positionSeconds = 0) {
  state = structuredClone(state)
  state.snapshot!.revision++
  state.snapshot!.playback = { status, positionSeconds, effectiveAtServerMs: Date.now(), playbackRate: 1 }
  listener({ type: 'APPLY_ROOM_STATE', state })
}

function statuses() {
  return messages.filter((message): message is Extract<RuntimeRequest, { type: 'PLAYER_STATUS' }> => message.type === 'PLAYER_STATUS')
}

function establishSoftCorrection(rateMode: FakeVideo['rateMode'] = 'accept'): void {
  video.position = 10
  video.paused = false
  apply('playing', 10)
  state.snapshot!.playback.effectiveAtServerMs = Date.now() - 3_000
  video.position = 13.2
  video.totalFrames += 12
  listener({ type: 'REPORT_PLAYER_CONTEXT' }, undefined, () => {})
  video.position = 10.2
  video.rateMode = rateMode
  state.snapshot!.playback.effectiveAtServerMs = Date.now() - 400
  listener({ type: 'APPLY_ROOM_STATE', state })
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

  describe('a player stuck at metadata during a transactional prepare', () => {
    const target = 197.442125

    async function beginPlayPrepare(): Promise<void> {
      const sendMessage = (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>)
      sendMessage.mockImplementation(async (request: RuntimeRequest) => {
        messages.push(request)
        return request.type === 'MEDIA_DETECTED'
          ? { ok: true, state, playerBindingId: 'binding_stuck' }
          : { ok: true, state }
      })
      messages.length = 0
      listener({ type: 'REPORT_PLAYER_CONTEXT' }, undefined, () => {})
      await Promise.resolve()
      await Promise.resolve()
      state.snapshot!.playback = { status: 'paused', positionSeconds: target, effectiveAtServerMs: Date.now(), playbackRate: 1 }
      state.snapshot!.contract = {
        mode: 'transactional',
        mediaEpoch: 0,
        sharedCapabilities: [...CURRENT_CLIENT_CAPABILITIES.capabilities],
        operation: {
          mediaEpoch: 0,
          operationId: 'operation_play_stuck1',
          kind: 'play',
          phase: 'preparing',
          requiredParticipantIds: ['guest'],
          preparedParticipantIds: [],
          startedParticipantIds: [],
          targetPositionSeconds: target,
          resumeWhenReady: true,
          effectiveAtServerMs: null,
          deadlineAtServerMs: Date.now() + 3_000,
        },
      }
      listener({ type: 'APPLY_ROOM_STATE', state })
      await Promise.resolve()
      await Promise.resolve()
    }

    function acknowledgements(): RuntimeRequest[] {
      return messages.filter(message => message.type === 'OPERATION_ACK')
    }

    function latestMediaDiagnostics() {
      const detections = messages.filter((message): message is Extract<RuntimeRequest, { type: 'MEDIA_DETECTED' }> => message.type === 'MEDIA_DETECTED')
      return detections.at(-1)?.diagnostics
    }

    it('never claims prepared, never starts playback and does not thrash the element while a seek never completes', async () => {
      // The observed report: readyState 1, networkState 2 (loading), a blob
      // source, and a seek that the element never finishes.
      video.readyState = FakeVideo.HAVE_METADATA
      video.networkState = 2
      Object.assign(video, { buffered: { length: 1, start: () => 0, end: () => 60.04 } })
      await beginPlayPrepare()
      expect(video.writes).toEqual([target])
      expect(video.seeking).toBe(true)

      await vi.advanceTimersByTimeAsync(4_000)
      listener({ type: 'APPLY_ROOM_STATE', state })
      await Promise.resolve()

      expect(acknowledgements()).toEqual([])
      expect(video.play).not.toHaveBeenCalled()
      // One write only: repeated snapshots adopt the pending seek instead of restarting it.
      expect(video.writes).toEqual([target])
    })

    it('reports the element state that separates a stalled fetch from a refused stream', async () => {
      video.readyState = FakeVideo.HAVE_METADATA
      video.networkState = 2
      Object.assign(video, { buffered: { length: 1, start: () => 0, end: () => 60.04 } })
      await beginPlayPrepare()
      await vi.advanceTimersByTimeAsync(2_500)

      expect(latestMediaDiagnostics()).toMatchObject({
        readyState: 1,
        networkState: 2,
        currentSrcKind: 'blob',
        seeking: true,
        errorCode: null,
        bufferedRangeCount: 1,
        bufferedRanges: [0, 60],
        seekableRangeCount: 1,
        seekableRanges: [0, 1_420],
        bufferedAheadSeconds: 0,
        hasMediaKeys: false,
      })
      expect(latestMediaDiagnostics()?.pendingSeekAgeMs).toBeGreaterThanOrEqual(1_500)

      // A decode failure surfaces as its code, and only as its code.
      Object.assign(video, { mediaKeys: {}, error: { code: 3, message: 'https://cdn.example/segment.m4s?token=never-reported' } })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(latestMediaDiagnostics()).toMatchObject({ errorCode: 3, hasMediaKeys: true })
      expect(JSON.stringify(latestMediaDiagnostics())).not.toContain('never-reported')
    })

    it('does not prepare an element that is on target but has no data yet, so a cold player never resumes on a guess', async () => {
      // The brief's original hypothesis: aligned, paused, not seeking, but only
      // HAVE_METADATA. Acknowledging here would report a player as prepared
      // that has nothing to show, which is the unsafe resume the prepared
      // gate exists to prevent (docs/CRUNCHYROLL_PREPARE_STALL_ANALYSIS.md).
      video.readyState = FakeVideo.HAVE_METADATA
      video.networkState = 2
      video.position = target
      await beginPlayPrepare()
      await vi.advanceTimersByTimeAsync(4_000)

      expect(video.writes).toEqual([])
      expect(acknowledgements()).toEqual([])
      expect(video.play).not.toHaveBeenCalled()

      // The moment data arrives the same element is prepared, without a new operation.
      video.readyState = FakeVideo.HAVE_CURRENT_DATA
      await vi.advanceTimersByTimeAsync(1_500)
      expect(acknowledgements()).toContainEqual(expect.objectContaining({
        acknowledgement: expect.objectContaining({ phase: 'prepared', operationId: 'operation_play_stuck1' }),
      }))
    })
  })

  describe('a committed paused seek that the room still holds in its snapshot', () => {
    async function holdCommittedPausedSeek(role: 'controller' | 'member'): Promise<void> {
      const sendMessage = (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>)
      sendMessage.mockImplementation(async (request: RuntimeRequest) => {
        messages.push(request)
        return request.type === 'MEDIA_DETECTED'
          ? { ok: true, state, playerBindingId: 'binding_settled' }
          : { ok: true, state }
      })
      state.participantId = 'me'
      state.snapshot!.controller = { participantId: role === 'controller' ? 'me' : 'host', leaseEpoch: 1 }
      state.snapshot!.participants = [
        { id: 'me', name: 'Me', role: role === 'controller' ? 'controller' : 'member', ready: true, mediaMatches: true, connected: true, latencyMs: 0 },
        ...(role === 'member' ? [{ id: 'host', name: 'Host', role: 'controller' as const, ready: true, mediaMatches: true, connected: true, latencyMs: 0 }] : []),
      ]
      messages.length = 0
      listener({ type: 'REPORT_PLAYER_CONTEXT' }, undefined, () => {})
      await Promise.resolve()
      await Promise.resolve()
      video.position = 60
      state.snapshot!.playback = { status: 'paused', positionSeconds: 60, effectiveAtServerMs: Date.now(), playbackRate: 1 }
      state.snapshot!.contract = {
        mode: 'transactional',
        mediaEpoch: 0,
        sharedCapabilities: [...CURRENT_CLIENT_CAPABILITIES.capabilities],
        operation: {
          mediaEpoch: 0,
          operationId: 'operation_seek_settled1',
          kind: 'seek',
          phase: 'committed',
          requiredParticipantIds: role === 'member' ? ['host', 'me'] : ['me'],
          preparedParticipantIds: role === 'member' ? ['host', 'me'] : ['me'],
          startedParticipantIds: [],
          targetPositionSeconds: 60,
          resumeWhenReady: false,
          effectiveAtServerMs: Date.now(),
          deadlineAtServerMs: Date.now() + 3_000,
        },
      }
      listener({ type: 'APPLY_ROOM_STATE', state })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(video.writes).toEqual([])
    }

    function scrubNatively(toSeconds: number): void {
      video.position = toSeconds
      video.seeking = true
      video.dispatchEvent(new Event('seeking'))
    }

    it('lets the controller scrub again instead of pulling the player back to the old target', async () => {
      // The coordinator keeps a settled paused seek in the snapshot until its
      // window closes. Treating it as a live operation would run the
      // transactional alignment every second, without the controller's
      // local-intent hold, and undo the controller's next scrub.
      await holdCommittedPausedSeek('controller')
      scrubNatively(90)
      await vi.advanceTimersByTimeAsync(1_100)

      expect(video.writes).toEqual([])
      expect(video.position).toBe(90)
      expect(messages).toContainEqual(expect.objectContaining({ type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: 90 }))
    })

    it('still pulls a guest that scrubbed by itself back to the room position', async () => {
      await holdCommittedPausedSeek('member')
      scrubNatively(90)
      video.seeking = false
      await vi.advanceTimersByTimeAsync(1_100)

      expect(video.writes).toEqual([60])
    })
  })

  it('prepares a transactional operation and confirms started only after real progress', async () => {
    const sendMessage = (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>)
    sendMessage.mockImplementation(async (request: RuntimeRequest) => {
      messages.push(request)
      return request.type === 'MEDIA_DETECTED'
        ? { ok: true, state, playerBindingId: 'binding_transactional' }
        : { ok: true, state }
    })
    messages.length = 0
    listener({ type: 'REPORT_PLAYER_CONTEXT' }, undefined, () => {})
    await Promise.resolve()
    await Promise.resolve()

    state.snapshot!.contract = {
      mode: 'transactional',
      mediaEpoch: 0,
      sharedCapabilities: [...CURRENT_CLIENT_CAPABILITIES.capabilities],
      operation: {
        mediaEpoch: 0,
        operationId: 'operation_play_123456',
        kind: 'play',
        phase: 'preparing',
        requiredParticipantIds: ['guest'],
        preparedParticipantIds: [],
        startedParticipantIds: [],
        targetPositionSeconds: 0,
        resumeWhenReady: true,
        effectiveAtServerMs: null,
        deadlineAtServerMs: Date.now() + 1_800,
      },
    }
    listener({ type: 'APPLY_ROOM_STATE', state })
    await Promise.resolve()
    await Promise.resolve()
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'OPERATION_ACK',
      acknowledgement: expect.objectContaining({
        phase: 'prepared',
        bindingId: 'binding_transactional',
        operationId: 'operation_play_123456',
      }),
    }))
    expect(messages.some(message => message.type === 'OPERATION_ACK' && message.acknowledgement.phase === 'started')).toBe(false)

    state = structuredClone(state)
    state.snapshot!.revision++
    state.snapshot!.contract!.operation = {
      ...state.snapshot!.contract!.operation!,
      phase: 'committed',
      preparedParticipantIds: ['guest'],
      effectiveAtServerMs: Date.now() - 100,
    }
    state.snapshot!.playback = { status: 'playing', positionSeconds: 0, effectiveAtServerMs: Date.now() - 100, playbackRate: 1 }
    listener({ type: 'APPLY_ROOM_STATE', state })
    await Promise.resolve()
    await Promise.resolve()
    expect(video.play).toHaveBeenCalledOnce()
    expect(messages.some(message => message.type === 'OPERATION_ACK' && message.acknowledgement.phase === 'started')).toBe(false)

    video.position = 1
    video.totalFrames += 1
    await vi.advanceTimersByTimeAsync(3_000)
    video.totalFrames += 1
    listener({ type: 'REPORT_PLAYER_CONTEXT' }, undefined, () => {})
    await Promise.resolve()
    await Promise.resolve()
    listener({ type: 'APPLY_ROOM_STATE', state })
    await Promise.resolve()
    await Promise.resolve()
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'OPERATION_ACK',
      acknowledgement: expect.objectContaining({ phase: 'started', bindingId: 'binding_transactional' }),
    }))
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

  it('retires a never-settling play request and waits for explicit Sync before retrying', async () => {
    let resolveOld!: () => void
    video.play
      .mockImplementationOnce(() => new Promise<void>(resolve => { resolveOld = resolve }))
      .mockImplementationOnce(() => {
        video.paused = false
        video.dispatchEvent(new Event('play'))
        return Promise.resolve()
      })

    apply('playing')
    expect(video.play).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(9_999)
    expect(video.play).toHaveBeenCalledOnce()
    expect(video.writes).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(video.play).toHaveBeenCalledOnce()
    expect(statuses().some(message => message.sample.buffering && message.sample.playbackStartFailed === false)).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(video.play).toHaveBeenCalledOnce()

    state.snapshot!.playback.effectiveAtServerMs = Date.now()
    listener({ type: 'FORCE_SYNC' })
    expect(video.play).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(video.paused).toBe(false)

    // The old promise resolves after the retry has taken ownership. Its late
    // completion must not settle or mutate the new attempt.
    resolveOld()
    await Promise.resolve()
    await Promise.resolve()
    expect(video.paused).toBe(false)
    expect(video.play).toHaveBeenCalledTimes(2)
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

  it('keeps a known buffering signal when the worker refreshes player context', async () => {
    apply('playing')
    state.snapshot!.playback.effectiveAtServerMs = Date.now() - 3_000
    video.dispatchEvent(new Event('waiting'))
    await vi.advanceTimersByTimeAsync(700)

    let context: unknown
    listener({ type: 'GET_PLAYER_CONTEXT' }, undefined, response => { context = response })
    expect(context).toMatchObject({
      sample: { buffering: true },
      diagnostics: { health: { buffering: true } },
    })
  })

  it('keeps a known permission failure when the worker refreshes player context', async () => {
    video.play.mockRejectedValue(new DOMException('User activation required', 'NotAllowedError'))
    apply('playing')
    await Promise.resolve()
    await Promise.resolve()

    let context: unknown
    listener({ type: 'GET_PLAYER_CONTEXT' }, undefined, response => { context = response })
    expect(context).toMatchObject({
      sample: { playbackStartFailed: true },
      diagnostics: { health: { playbackStartFailed: true } },
    })
  })

  it('switches evidence quality after hidden playback returns to visible rendering', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    apply('playing')
    state.snapshot!.playback.effectiveAtServerMs = Date.now() - 3_000
    for (let i = 1; i <= 2; i++) {
      video.position = i
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(statuses().some(message => message.sample.progressEvidence === 'clock')).toBe(true)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    let context: unknown
    listener({ type: 'GET_PLAYER_CONTEXT' }, undefined, response => { context = response })
    expect(context).toMatchObject({
      diagnostics: { health: { progressEvidence: 'clock' } },
    })
  })

  it('starts playback after a slow correction before trying another hard seek', async () => {
    apply('playing', 120)
    await vi.advanceTimersByTimeAsync(1200)
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    await Promise.resolve()
    expect(video.writes).toEqual([120])
    expect(video.play).toHaveBeenCalledOnce()

    let context: unknown
    listener({ type: 'GET_PLAYER_CONTEXT' }, undefined, response => { context = response })
    expect(context).toMatchObject({
      sample: { correctionCount: 1 },
      diagnostics: { health: { correctionCount: 1 } },
    })
  })

  it('requires recent rendered progress before applying an accepted soft rate', () => {
    video.position = 10
    video.paused = false
    apply('playing', 10)
    expect(video.playbackRate).toBe(1)

    establishSoftCorrection()

    expect(video.playbackRate).toBe(1.02)
  })

  it('stops a soft rate correction immediately when buffering starts', () => {
    establishSoftCorrection()
    expect(video.playbackRate).toBe(1.02)

    video.dispatchEvent(new Event('waiting'))

    expect(video.playbackRate).toBe(1)
  })

  it('stops a soft rate correction immediately on a native seek', () => {
    establishSoftCorrection()
    expect(video.playbackRate).toBe(1.02)

    video.dispatchEvent(new Event('seeking'))

    expect(video.playbackRate).toBe(1)
  })

  it('stops a soft rate correction when playback pauses', () => {
    establishSoftCorrection()
    expect(video.playbackRate).toBe(1.02)

    video.paused = true
    video.dispatchEvent(new Event('pause'))

    expect(video.playbackRate).toBe(1)
  })

  it('stops a soft rate correction when the media source changes', () => {
    establishSoftCorrection()
    expect(video.playbackRate).toBe(1.02)

    video.currentSrc = 'blob:replacement'
    video.dispatchEvent(new Event('emptied'))

    expect(video.playbackRate).toBe(1)
  })

  it.each([
    ['ignore', 800],
    ['ignore', 1_200],
    ['ignore', 2_000],
    ['reset', 800],
    ['reset', 1_200],
    ['reset', 2_000],
  ] as const)('falls back to one hard correction when the player %s the requested rate after a %sms seek delay', async (rateMode, delayMs) => {
    establishSoftCorrection(rateMode)

    expect(video.playbackRate).toBe(1)
    expect(video.writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(delayMs)
    video.seeking = false
    video.dispatchEvent(new Event('seeked'))
    await vi.advanceTimersByTimeAsync(30_000)

    expect(video.writes).toHaveLength(1)
    expect(video.paused).toBe(true)
    expect(statuses().some(message => message.sample.buffering)).toBe(true)
  })

  it('lets a newer room command retire the previous soft correction', () => {
    establishSoftCorrection()
    expect(video.playbackRate).toBe(1.02)

    apply('playing', 400)

    expect(video.playbackRate).toBe(1)
    expect(video.writes).toHaveLength(1)
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

describe('autoplay permission rejection (#68)', () => {
  const notAllowed = () => new DOMException('User activation required', 'NotAllowedError')

  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  function lastReport() {
    return statuses().at(-1)?.sample
  }

  async function blockAndLetRoomPause(): Promise<void> {
    video.play.mockRejectedValueOnce(notAllowed())
    apply('playing')
    await settle()
    expect(lastReport()?.playbackStartFailed).toBe(true)
    // The coordinator answers the rejection by pausing the room, which
    // reaches this player as an ordinary command change.
    apply('paused')
    await settle()
    messages.length = 0
    video.play.mockClear()
  }

  it('keeps reporting the rejection after the room pauses in response', async () => {
    await blockAndLetRoomPause()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(statuses().length).toBeGreaterThan(0)
    expect(statuses().every(message => message.sample.playbackStartFailed === true)).toBe(true)
    expect(video.play).not.toHaveBeenCalled()
  })

  it('clears the rejection once the page accepts a play gesture', async () => {
    await blockAndLetRoomPause()

    // The person clicks the video and the browser accepts playback.
    video.paused = false
    video.dispatchEvent(new Event('play'))

    expect(lastReport()?.playbackStartFailed).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(lastReport()?.playbackStartFailed).toBe(false)
  })

  it('retries the permission check from panel Sync and stays paused with the room', async () => {
    await blockAndLetRoomPause()

    listener({ type: 'FORCE_SYNC' })
    expect(video.play).toHaveBeenCalledOnce()
    await settle()

    expect(video.paused).toBe(true)
    expect(lastReport()?.playbackStartFailed).toBe(false)
  })

  it('keeps the rejection when panel Sync finds the browser still blocked', async () => {
    await blockAndLetRoomPause()
    video.play.mockRejectedValueOnce(notAllowed())

    listener({ type: 'FORCE_SYNC' })
    expect(video.play).toHaveBeenCalledOnce()
    await settle()

    expect(lastReport()?.playbackStartFailed).toBe(true)
  })

  it('does not start a play probe from panel Sync when nothing is blocked', () => {
    apply('paused')
    listener({ type: 'FORCE_SYNC' })
    expect(video.play).not.toHaveBeenCalled()
  })

  it('forgets the rejection when the player source is replaced', async () => {
    await blockAndLetRoomPause()

    video.currentSrc = 'blob:replacement'
    video.dispatchEvent(new Event('emptied'))

    let context: unknown
    listener({ type: 'GET_PLAYER_CONTEXT' }, undefined, response => { context = response })
    expect(context).toMatchObject({ sample: { playbackStartFailed: false } })
  })

  it('forgets the rejection when the room is left', async () => {
    await blockAndLetRoomPause()

    state = structuredClone(state)
    state.snapshot = null
    listener({ type: 'APPLY_ROOM_STATE', state })

    let context: unknown
    listener({ type: 'GET_PLAYER_CONTEXT' }, undefined, response => { context = response })
    expect(context).toMatchObject({ sample: { playbackStartFailed: false } })
  })
})

describe('an unapproved join request', () => {
  const localEpisode: MediaFingerprint = {
    service: 'crunchyroll', canonicalId: 'crunchyroll:GE00365016JAJP', title: 'Episode', durationSeconds: 1420,
  }
  const otherEpisode: MediaFingerprint = {
    service: 'crunchyroll', canonicalId: 'crunchyroll:GEOTHER000000', title: 'Different', durationSeconds: 1420,
  }

  function roomWithPendingFriend(hostMedia: MediaFingerprint): RoomCoordinator {
    const room = new RoomCoordinator({ roomId: 'room_123456', code: 'ABCDEFGH' }, { id: 'participant_host', name: 'Muaz', media: hostMedia }, () => Date.now())
    room.join({ id: 'participant_friend', name: 'Rana', media: localEpisode, sessionToken: 'friend-session-token-000000' })
    return room
  }

  function applyAsFriend(snapshot: NonNullable<ExtensionState['snapshot']>): void {
    state = { ...structuredClone(state), participantId: 'participant_friend', snapshot }
    listener({ type: 'APPLY_ROOM_STATE', state })
  }

  function watchingAt(seconds: number): void {
    video.paused = false
    video.position = seconds
  }

  // The coordinator answers a request with a placeholder that is paused at 0.
  // A page whose script treated that as the room's playback would pause and
  // rewind whatever the requester is watching before anyone has let them in.
  for (const [label, hostMedia] of [['a different video', otherEpisode], ['the same video', localEpisode]] as const) {
    it(`leaves the video alone when the placeholder arrives while the room is on ${label}`, () => {
      watchingAt(600)

      applyAsFriend(roomWithPendingFriend(hostMedia).pendingSnapshot('participant_friend'))

      expect(video.pause).not.toHaveBeenCalled()
      expect(video.play).not.toHaveBeenCalled()
      expect(video.writes).toEqual([])
      expect(video.position).toBe(600)
      expect(video.paused).toBe(false)
    })
  }

  it('ignores the full room state an older coordinator still sends to a pending requester', () => {
    const full = roomWithPendingFriend(localEpisode).snapshot()
    expect(full.participants.some(participant => participant.id === 'participant_friend')).toBe(false)
    expect(full.pendingJoinRequests.map(request => request.id)).toContain('participant_friend')
    watchingAt(600)

    applyAsFriend(full)

    expect(video.pause).not.toHaveBeenCalled()
    expect(video.writes).toEqual([])
    expect(video.position).toBe(600)
  })

  it('drives the video again once the request is approved', () => {
    const room = roomWithPendingFriend(localEpisode)
    room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
    watchingAt(600)

    applyAsFriend(room.snapshot())

    expect(video.pause).toHaveBeenCalled()
    expect(video.writes).toEqual([0])
  })

  describe('as the pill on the page shows it', () => {
    const pendingSnapshot = () => roomWithPendingFriend(otherEpisode).pendingSnapshot('participant_friend')

    it('says it is waiting for the host and puts the playback controls out of reach', () => {
      // Whatever the previous room state left on the pill.
      pill('#syj-playback').hidden = false
      pill('#syj-sync').disabled = false

      applyAsFriend(pendingSnapshot())

      expect(pill('#syj-status').textContent).toBe('Waiting for the host')
      expect(pill('#syj-meta').textContent).toMatch(/request to join is pending/i)
      expect(`${pill('#syj-status').textContent} ${pill('#syj-meta').textContent}`).not.toMatch(/member|0 connected/i)
      expect(pill('#syj-playback').hidden).toBe(true)
      expect(pill('#syj-sync').disabled).toBe(true)
      expect(pill('.pill').hidden).toBe(false)
    })

    it('shows the requester\'s own connection, not the host, while it is reconnecting', () => {
      state = { ...structuredClone(state), participantId: 'participant_friend', connection: 'reconnecting', snapshot: pendingSnapshot() }
      listener({ type: 'APPLY_ROOM_STATE', state })

      expect(pill('#syj-status').textContent).toBe('Reconnecting')
      expect(pill('#syj-status').textContent).not.toMatch(/waiting for the host/i)
      // The coordinator withdrew the request when this socket closed.
      expect(pill('#syj-meta').textContent).not.toMatch(/pending/i)
      expect(pill('#syj-meta').textContent).toMatch(/ask to join again/i)
      expect(pill('#syj-playback').hidden).toBe(true)
      expect(pill('#syj-sync').disabled).toBe(true)
    })

    it('shows the same request as waiting for the host again once it reconnects', () => {
      state = { ...structuredClone(state), participantId: 'participant_friend', connection: 'reconnecting', snapshot: pendingSnapshot() }
      listener({ type: 'APPLY_ROOM_STATE', state })
      state = { ...structuredClone(state), connection: 'connected' }
      listener({ type: 'APPLY_ROOM_STATE', state })

      expect(pill('#syj-status').textContent).toBe('Waiting for the host')
    })

    it('shows a member the room\'s state with member wording once the request is approved', () => {
      const room = roomWithPendingFriend(localEpisode)
      room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
      pill('#syj-sync').disabled = true

      applyAsFriend(room.snapshot())

      expect(pill('#syj-status').textContent).not.toMatch(/waiting for the host/i)
      expect(pill('#syj-meta').textContent).toMatch(/Member, 2 connected\.$/)
      expect(pill('#syj-playback').hidden).toBe(true)
      expect(pill('#syj-sync').disabled).toBe(false)
    })

    it('shows the host its playback button', () => {
      const room = roomWithPendingFriend(localEpisode)
      room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
      state = { ...structuredClone(state), participantId: 'participant_host', snapshot: room.snapshot() }
      listener({ type: 'APPLY_ROOM_STATE', state })

      expect(pill('#syj-meta').textContent).toMatch(/Controller, 2 connected\.$/)
      expect(pill('#syj-playback').hidden).toBe(false)
      expect(pill('#syj-playback').textContent).toBe('Play')
    })
  })
})

describe('a notice about a room that has ended', () => {
  const EXPIRED = 'This room has expired. Create or join another room to keep watching together.'

  // What the worker does when a room ends: the page is detached from it, then
  // told why. A page that was never in a room is sent neither.
  const endRoom = (lastError: string | null = 'This room has expired.') => {
    state = { ...structuredClone(state), connection: 'disconnected', snapshot: null, lastError }
    listener({ type: 'APPLY_ROOM_STATE', state })
  }
  const roomEndedNotice = (message = EXPIRED) => listener({ type: 'SHOW_NOTICE', message, roomEnded: true })
  // A requester's first snapshot for another room: the placeholder the
  // coordinator sends before the host has let it in, with no participants and
  // only its own request listed.
  const requestToJoinAnotherRoom = () => {
    state = { ...structuredClone(state), connection: 'connected', lastError: null }
    state.snapshot = {
      roomId: 'other', code: 'OTHERROM', revision: 0,
      controller: { participantId: '', leaseEpoch: 0 },
      media: null, playback: { status: 'paused', positionSeconds: 0, effectiveAtServerMs: 0, playbackRate: 1 },
      navigation: null, seek: null,
      participants: [],
      pendingJoinRequests: [{ id: state.participantId, name: 'Guest', requestedAtMs: 1 }],
      policy: { buffering: 'pause-all' },
    }
    listener({ type: 'APPLY_ROOM_STATE', state })
  }
  const joinAnotherRoom = () => {
    state = { ...structuredClone(state), connection: 'connected', lastError: null }
    state.snapshot = {
      roomId: 'room', code: 'NEWCODE1', revision: 1,
      controller: { participantId: 'host', leaseEpoch: 1 },
      media: null, playback: { status: 'paused', positionSeconds: 0, effectiveAtServerMs: Date.now(), playbackRate: 1 },
      navigation: null, seek: null,
      participants: [{ id: 'guest', name: 'Guest', role: 'member', ready: false, mediaMatches: false, connected: true, latencyMs: 0 }],
      pendingJoinRequests: [], policy: { buffering: 'pause-all' },
    }
    listener({ type: 'APPLY_ROOM_STATE', state })
  }

  it('is shown on the page, although there is no room to show, and then goes away', async () => {
    // The page was showing the room first.
    listener({ type: 'APPLY_ROOM_STATE', state })
    expect(pillHost.style.display).toBe('block')

    endRoom()
    expect(pillHost.style.display).toBe('none')
    roomEndedNotice()

    expect(pillHost.style.display).toBe('block')
    expect(pill('.pill').hidden).toBe(false)
    expect(pill('#syj-restore').hidden).toBe(true)
    expect(pill('#syj-status').textContent).toBe('SyncYourJoy')
    expect(pill('#syj-meta').textContent).toBe(EXPIRED)
    // Nothing to press for a room that is gone.
    expect(pill('#syj-actions').hidden).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(pillHost.style.display).toBe('none')
  })

  it('stays for the whole of its eight seconds', async () => {
    endRoom()
    roomEndedNotice()

    await vi.advanceTimersByTimeAsync(7_999)
    expect(pillHost.style.display).toBe('block')

    await vi.advanceTimersByTimeAsync(1)
    expect(pillHost.style.display).toBe('none')
  })

  it('is kept for eight seconds from the latest notice when a second one arrives', async () => {
    endRoom()
    roomEndedNotice('This room has expired.')
    await vi.advanceTimersByTimeAsync(5_000)
    roomEndedNotice('The host declined to let you join this room.')
    expect(pill('#syj-meta').textContent).toBe('The host declined to let you join this room.')

    // Eight seconds from the first notice: the first notice's timer is gone.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(pillHost.style.display).toBe('block')

    await vi.advanceTimersByTimeAsync(4_999)
    expect(pillHost.style.display).toBe('block')
    await vi.advanceTimersByTimeAsync(1)
    expect(pillHost.style.display).toBe('none')
  })

  it('is shown, and kept, when it reaches the page before the page has been detached', async () => {
    listener({ type: 'APPLY_ROOM_STATE', state })

    roomEndedNotice()
    endRoom()

    expect(pillHost.style.display).toBe('block')
    expect(pill('#syj-meta').textContent).toBe(EXPIRED)
  })

  it('does not carry the room view\'s error line along with it', () => {
    state = { ...structuredClone(state), lastError: 'Open the matching video before getting ready.' }
    listener({ type: 'APPLY_ROOM_STATE', state })
    expect(pill('#syj-notice').textContent).toBe('Open the matching video before getting ready.')

    endRoom()
    roomEndedNotice()

    expect(pill('#syj-notice').textContent).toBe('')
    expect(pill('#syj-meta').textContent).toBe(EXPIRED)
  })

  it('is not made of an ordinary notice, which has no room to be about', () => {
    endRoom(null)
    expect(pillHost.style.display).toBe('none')

    listener({ type: 'SHOW_NOTICE', message: 'The room controller owns playback.' })

    expect(pillHost.style.display).toBe('none')
    expect(pill('#syj-status').textContent).not.toBe('SyncYourJoy')
    expect(pill('#syj-meta').textContent).not.toBe('The room controller owns playback.')
  })

  it('does not take over the pill while there is a room', () => {
    listener({ type: 'APPLY_ROOM_STATE', state })
    listener({ type: 'SHOW_NOTICE', message: 'The room controller owns playback.' })

    expect(pill('#syj-notice').textContent).toBe('The room controller owns playback.')
    expect(pill('#syj-actions').hidden).toBe(false)
    expect(pill('#syj-status').textContent).not.toBe('SyncYourJoy')
  })

  it('gives the actions back when a room is joined while the notice is up', () => {
    endRoom()
    roomEndedNotice('This room has expired.')
    expect(pill('#syj-actions').hidden).toBe(true)

    joinAnotherRoom()

    expect(pill('#syj-actions').hidden).toBe(false)
    expect(pill('#syj-status').textContent).not.toBe('SyncYourJoy')
  })

  it('is not shown again when a room joined while it was up is left', async () => {
    endRoom()
    roomEndedNotice()
    await vi.advanceTimersByTimeAsync(2_000)
    joinAnotherRoom()
    await vi.advanceTimersByTimeAsync(2_000)

    endRoom(null)

    expect(pillHost.style.display).toBe('none')
    expect(pill('#syj-meta').textContent).not.toBe(EXPIRED)
  })

  it('is not shown again when a room that was only asked to join while it was up is left', async () => {
    endRoom()
    roomEndedNotice()
    await vi.advanceTimersByTimeAsync(2_000)
    requestToJoinAnotherRoom()
    // The waiting pill is what the page shows now, not the old message.
    expect(pill('#syj-status').textContent).toBe('Waiting for the host')
    await vi.advanceTimersByTimeAsync(2_000)

    endRoom(null)

    expect(pillHost.style.display).toBe('none')
    expect(pill('#syj-meta').textContent).not.toBe(EXPIRED)
  })

  it('does not write an ordinary notice under the room-ended message', () => {
    endRoom()
    roomEndedNotice()

    listener({ type: 'SHOW_NOTICE', message: 'The room controller owns playback.' })

    expect(pill('#syj-meta').textContent).toBe(EXPIRED)
    expect(pill('#syj-notice').textContent).toBe('')
  })

  it('writes ordinary notices again once the room-ended message is gone', async () => {
    endRoom()
    roomEndedNotice()
    await vi.advanceTimersByTimeAsync(8_000)
    joinAnotherRoom()

    listener({ type: 'SHOW_NOTICE', message: 'The room controller owns playback.' })

    expect(pill('#syj-notice').textContent).toBe('The room controller owns playback.')
  })

  it('hides the actions row with the hidden attribute, which the row\'s own display rule would override', () => {
    expect(pillShadow.innerHTML).toMatch(/\.actions\[hidden\][^{}]*\{[^}]*display:\s*none/)
  })
})

describe('the pill on the page for a room', () => {
  const participant = (id: string, overrides: Partial<NonNullable<ExtensionState['snapshot']>['participants'][number]> = {}) => ({
    id, name: id, role: 'member' as const, ready: true, mediaMatches: true, connected: true, latencyMs: 0, ...overrides,
  })

  function apply(changes: (current: ExtensionState) => void): void {
    state = structuredClone(state)
    changes(state)
    listener({ type: 'APPLY_ROOM_STATE', state })
  }

  it('shows the room\'s last error as the notice', () => {
    expect(pill('#syj-notice').textContent).toBe('')

    apply((current) => { current.lastError = 'Open the matching video before getting ready.' })

    expect(pill('#syj-notice').textContent).toBe('Open the matching video before getting ready.')
  })

  describe('of a host', () => {
    const asHost = (guestReady: boolean) => apply((current) => {
      current.participantId = 'host'
      current.snapshot!.controller.participantId = 'host'
      current.snapshot!.participants = [participant('host'), participant('guest', { ready: guestReady })]
    })

    it('offers Play only once everyone connected is ready', () => {
      asHost(false)
      expect(pill('#syj-playback').hidden).toBe(false)
      expect(pill('#syj-playback').disabled).toBe(true)

      asHost(true)
      expect(pill('#syj-playback').disabled).toBe(false)
    })

    it('has no playback button when the page has no video', async () => {
      asHost(true)
      expect(pill('#syj-playback').hidden).toBe(false)

      // The player goes away and the page confirms that it has.
      ;(document as unknown as { querySelectorAll: () => unknown[] }).querySelectorAll = () => []
      await vi.advanceTimersByTimeAsync(20_000)

      expect(pill('#syj-playback').hidden).toBe(true)
    })
  })

  describe('of a member', () => {
    it('says the episode is different, and disables Sync, when its media does not match the room\'s', () => {
      expect(pill('#syj-sync').disabled).toBe(false)

      apply((current) => { current.snapshot!.participants = [participant('guest', { mediaMatches: false })] })

      expect(pill('#syj-status').textContent).toBe('Different episode')
      expect(pill('#syj-sync').disabled).toBe(true)
    })

    it('says the connection is unclear, not that it is ready, while it is disconnected', () => {
      apply((current) => { current.connection = 'disconnected' })

      expect(pill('#syj-status').textContent).toBe('Connection unclear')
    })
  })
})
