// Focused unit coverage for the service worker's restart-resume behavior.
//
// apps/extension/src/service-worker.ts keeps all of its working state in one
// module-scope `state` object and persists the *entire* object to
// chrome.storage.session on every meaningful mutation (see `persistState`),
// restoring it wholesale on module load (see `initialize`). That whole-object
// pattern is what actually satisfies docs/ARCHITECTURE.md's requirement that
// a resumable session identifier and the latest room revision survive an
// unexpected Manifest V3 service-worker restart -- there is no per-field
// persistence to unit test separately.
//
// None of service-worker.ts's internals are exported (by design: it is a
// script, not a library), so this test drives it the same way Chrome does --
// through the module's own side effects at import time and through the
// chrome.runtime.onMessage listener it registers -- using a minimal fake
// `chrome` and `WebSocket` global. This is the "focused unit-level test for
// the persistence/restoration functions" called for when a real Playwright
// service-worker-restart simulation is impractical (see the note at the
// bottom of this file for why that path was not taken).
import type { DiagnosticsReport, RoomSnapshot } from '@syncyourjoy/protocol'
import { parseClientMessage } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'
import type { ContentRequest, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SESSION_STATE_KEY = 'syncYourJoySessionState'
const PLAYER_BINDING_KEY = 'syncYourJoyPlayerBinding'
const DISPLAY_NAME_KEY = 'syncYourJoyDisplayName'

/** Minimal fake WebSocket: enough of the browser WebSocket surface for
 * apps/extension/src/service-worker.ts's `connect()`/`sendToServer()`, with
 * hooks to drive it manually instead of a real network socket. */
class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  readonly sentMessages: unknown[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string | URL) {
    this.url = url.toString()
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type))
      this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    this.sentMessages.push(JSON.parse(data))
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', {})
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatch('open', {})
  }

  simulateMessage(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) })
  }

  /** A close initiated by the server, with the status code and reason it sent. */
  simulateClose(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', { code, reason })
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event)
  }
}

interface FakeChromeOptions {
  sessionState?: unknown
  playerBindingState?: unknown
  sessionSet?: (values: Record<string, unknown>) => Promise<void> | void
}

interface FakeChrome {
  chrome: typeof chrome
  messageListener: (request: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean
  updatedListener: (tabId: number, changeInfo: { status?: chrome.tabs.Tab['status'] }) => void
  sessionSetMock: ReturnType<typeof vi.fn>
  sendMessageMock: ReturnType<typeof vi.fn>
  downloadMock: ReturnType<typeof vi.fn>
}

/** Builds a fake `chrome` global exposing only what service-worker.ts
 * touches at import time and during the scenarios below. */
function buildFakeChrome(options: FakeChromeOptions = {}): FakeChrome {
  let messageListener: FakeChrome['messageListener'] = () => false
  let updatedListener: FakeChrome['updatedListener'] = () => {}
  const sessionSetMock = vi.fn(async (values: Record<string, unknown>) => {
    await options.sessionSet?.(values)
  })
  const sendMessageMock = vi.fn(async () => undefined)
  const downloadMock = vi.fn(async () => 1)

  const fakeChrome = {
    downloads: { download: downloadMock },
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: vi.fn((listener: FakeChrome['messageListener']) => {
          messageListener = listener
        }),
      },
      sendMessage: sendMessageMock,
      getManifest: vi.fn(() => ({ version: 'test' })),
    },
    storage: {
      session: {
        get: vi.fn(async () => ({ [SESSION_STATE_KEY]: options.sessionState, [PLAYER_BINDING_KEY]: options.playerBindingState })),
        set: sessionSetMock,
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    alarms: {
      onAlarm: { addListener: vi.fn() },
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn((listener: FakeChrome['updatedListener']) => { updatedListener = listener }) },
      sendMessage: vi.fn(async () => {
        throw new Error('no such tab in this test')
      }),
      query: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 999 })),
      update: vi.fn(async () => ({ id: 999 })),
      get: vi.fn(async () => {
        throw new Error('no such tab in this test')
      }),
      reload: vi.fn(async () => undefined),
    },
  }

  return {
    chrome: fakeChrome as unknown as typeof chrome,
    get messageListener() {
      return messageListener
    },
    get updatedListener() {
      return updatedListener
    },
    sessionSetMock,
    sendMessageMock,
    downloadMock,
  } as FakeChrome
}

function buildRoomSnapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: 'room_resumed',
    code: 'ABCDEFGH',
    revision: 5,
    controller: { participantId: 'participant_resumed', leaseEpoch: 1 },
    media: null,
    playback: { status: 'paused', positionSeconds: 0, effectiveAtServerMs: 0, playbackRate: 1 },
    seek: null,
    navigation: null,
    participants: [
      { id: 'participant_resumed', name: 'Resumed Friend', role: 'controller', ready: false, connected: true, mediaMatches: false, latencyMs: null },
    ],
    pendingJoinRequests: [],
    policy: { buffering: 'pause-all' },
    ...overrides,
  }
}

// vi.resetModules() makes the next test load a fresh copy of the worker; it
// does not stop the copy the last test loaded. That copy's timers kept
// running: a reconnect it had scheduled fired during a later test and opened a
// socket in that test's FakeWebSocket.instances, and its ping and heartbeat
// intervals ran for the life of the file. Everything a test starts through
// setTimeout or setInterval is therefore stopped when the test ends.
const startedTimers = { timeouts: new Set<ReturnType<typeof setTimeout>>(), intervals: new Set<ReturnType<typeof setInterval>>() }

beforeEach(() => {
  vi.resetModules()
  FakeWebSocket.instances = []
  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args)
    startedTimers.timeouts.add(handle)
    return handle
  }) as typeof setTimeout)
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args)
    startedTimers.intervals.add(handle)
    return handle
  }) as typeof setInterval)
})

afterEach(() => {
  for (const handle of startedTimers.timeouts)
    clearTimeout(handle)
  for (const handle of startedTimers.intervals)
    clearInterval(handle)
  startedTimers.timeouts.clear()
  startedTimers.intervals.clear()
  vi.mocked(globalThis.setTimeout).mockRestore()
  vi.mocked(globalThis.setInterval).mockRestore()
  vi.unstubAllGlobals()
})

describe('service worker restart resume', () => {
  it('restores the persisted room from chrome.storage.session and resumes the websocket via the normal reconnect path', async () => {
    const persistedSnapshot = buildRoomSnapshot()
    const { chrome: fakeChrome, sessionSetMock, sendMessageMock } = buildFakeChrome({
      sessionState: {
        connection: 'connected',
        participantId: 'participant_resumed',
        sessionToken: 'session_resumed',
        snapshot: persistedSnapshot,
        serverOffsetMs: 0,
        clockUncertaintyMs: 99_999,
        lastError: null,
        playerTabId: null,
        playerFrameId: null,
        playerAreaPixels: 0,
        playerLastSeenAtMs: 0,
        currentMedia: null,
        playerDiagnostics: null,
        lastPlayerSample: null,
        lastOpenedNavigationRevision: 3,
        connectionQuality: 'good',
        roundTripMs: 40,
        lastPongAtMs: 0,
      },
    })
    vi.stubGlobal('chrome', fakeChrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await import('./service-worker.ts')

    // A fresh module load with a persisted room must, on its own, attempt to
    // resume the connection -- exactly like a dropped connection would --
    // instead of presenting a brand-new, room-less extension.
    await vi.waitFor(() => {
      if (FakeWebSocket.instances.length !== 1)
        throw new Error('expected the service worker to open a websocket for the persisted room')
    })
    const socket = FakeWebSocket.instances[0]!
    expect(new URL(socket.url).searchParams.get('code')).toBe('ABCDEFGH')

    socket.simulateOpen()

    // The resume must use the restored identity: the same participant ID and
    // session token the room already knew this client by, not a fresh one.
    // (The socket also gets an immediate 'ping' the instant it opens, so
    // this waits for the specific join_room message rather than just any
    // message having been sent.)
    const findJoinMessage = () => socket.sentMessages.find((message): message is Record<string, unknown> =>
      typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'join_room')
    await vi.waitFor(() => {
      if (!findJoinMessage())
        throw new Error('expected a join_room message once the socket opened')
    })
    const joinMessage = findJoinMessage()
    expect(joinMessage).toMatchObject({
      type: 'join_room',
      code: 'ABCDEFGH',
      participantId: 'participant_resumed',
      sessionToken: 'session_resumed',
    })

    // The server confirming the resumed room should persist and broadcast
    // the refreshed snapshot the same way any other room update would.
    socket.simulateMessage({
      type: 'room_joined',
      participantId: 'participant_resumed',
      sessionToken: 'session_resumed',
      snapshot: buildRoomSnapshot({ revision: 6 }),
    })

    // publishState() persists (awaited) *then* broadcasts, so waiting for
    // the broadcast also guarantees the persistence has already completed.
    await vi.waitFor(() => {
      const broadcastsSoFar = sendMessageMock.mock.calls
        .map(([event]) => event as { type?: string, state?: { snapshot?: { revision?: number } } })
        .filter(event => event.type === 'ROOM_STATE_UPDATED')
      if (!broadcastsSoFar.some(event => event.state?.snapshot?.revision === 6))
        throw new Error('expected a ROOM_STATE_UPDATED broadcast for the resumed snapshot')
    })

    const finalPersistedCall = sessionSetMock.mock.calls.at(-1)![0] as Record<string, unknown>
    const finalPersistedState = finalPersistedCall[SESSION_STATE_KEY] as Record<string, unknown>
    expect(finalPersistedState.connection).toBe('connected')
    expect(finalPersistedState.participantId).toBe('participant_resumed')
    expect((finalPersistedState.snapshot as { revision?: number } | undefined)?.revision).toBe(6)
  })

  it('does not open a websocket on a fresh install with no persisted room', async () => {
    const { chrome: fakeChrome } = buildFakeChrome({ sessionState: undefined })
    vi.stubGlobal('chrome', fakeChrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await import('./service-worker.ts')

    // Give any (incorrect) eager-connect code a chance to run before
    // asserting a negative -- there is no pending timer or persisted
    // snapshot that should ever cause a socket to be created here.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(FakeWebSocket.instances.length).toBe(0)
  })
})

describe('service worker player-status persistence', () => {
  it('acknowledges PLAYER_STATUS without waiting for the chrome.storage.session write to finish', async () => {
    let resolveSessionSet: () => void = () => {}
    const sessionSetGate = new Promise<void>((resolve) => {
      resolveSessionSet = resolve
    })
    const fakeChromeResult = buildFakeChrome({
      sessionState: {
        playerTabId: 42,
        playerFrameId: 0,
      },
      playerBindingState: { id: 'binding_status', documentId: null },
      sessionSet: async () => sessionSetGate,
    })
    const { chrome: fakeChrome, sessionSetMock } = fakeChromeResult
    vi.stubGlobal('chrome', fakeChrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)

    await import('./service-worker.ts')

    // Read the listener now, after import -- chrome.runtime.onMessage's
    // real addListener call (which fills this in) only happens as part of
    // the module's own top-level side effects above.
    const messageListener = fakeChromeResult.messageListener
    const sendResponse = vi.fn()
    const sender = { tab: { id: 42 }, frameId: 0 } as chrome.runtime.MessageSender
    const keepChannelOpen = messageListener(
      {
        type: 'PLAYER_STATUS',
        basedOnRevision: 1,
        sample: { positionSeconds: 12, durationSeconds: 120, paused: false, buffering: false, sampledAtLocalMs: Date.now() },
        bindingId: 'binding_status',
      },
      sender,
      sendResponse,
    )
    expect(keepChannelOpen).toBe(true)

    // The handler must already have responded even though the storage write
    // it kicked off (chrome.storage.session.set, gated on sessionSetGate
    // above) has deliberately not resolved yet -- this is the "hot path
    // must not block on persistence" behavior this test guards. Before the
    // fix, this handler awaited that write, so sendResponse would still be
    // pending here and this assertion would time out.
    await vi.waitFor(() => {
      if (sendResponse.mock.calls.length === 0)
        throw new Error('expected PLAYER_STATUS to be acknowledged already')
    })
    expect(sessionSetMock).toHaveBeenCalledTimes(1)

    resolveSessionSet()
    await vi.waitFor(() => {
      if (!sessionSetMock.mock.results.at(-1))
        throw new Error('missing result')
    })
  })
})

describe('service worker observed episode identity', () => {
  const sharedUrl = 'https://www.crunchyroll.com/watch/GE00365016JAJP/extreme-level-3-situation'
  const nextUrl = 'https://www.crunchyroll.com/watch/GE00365017JAJP/next-episode'
  const oldMedia = {
    service: 'crunchyroll',
    canonicalId: 'crunchyroll:GE00365016JAJP',
    pageUrl: sharedUrl,
    title: 'Episode',
    durationSeconds: 1440,
  }
  const nextMedia = { ...oldMedia, canonicalId: 'crunchyroll:GE00365017JAJP', pageUrl: nextUrl }

  async function resumeAtPage(currentUrl: string) {
    const snapshot = buildRoomSnapshot({
      media: oldMedia,
      navigation: { revision: 5, url: sharedUrl, effectiveAtServerMs: 0 },
    })
    const fake = buildFakeChrome({ sessionState: {
      participantId: 'participant_resumed',
      sessionToken: 'session_resumed',
      snapshot,
      playerTabId: 42,
      playerFrameId: 0,
      playerAreaPixels: 500_000,
      currentMedia: oldMedia,
      lastOpenedNavigationRevision: 5,
    }, playerBindingState: { id: 'binding_resumed', documentId: null } })
    ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      media: currentUrl === nextUrl ? nextMedia : oldMedia,
      diagnostics: null,
      sample: null,
    })
    ;(fake.chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 42, url: currentUrl })
    vi.stubGlobal('chrome', fake.chrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('./service-worker.ts')
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0]!.simulateOpen()
    let currentBindingId = 'binding_resumed'
    const request = (message: RuntimeRequest, sender: chrome.runtime.MessageSender = {}) => {
      const bindingAware = message.type === 'MEDIA_DETECTED'
        || message.type === 'MEDIA_LOST'
        || message.type === 'PLAYER_STATUS'
        || message.type === 'SEEK_APPLIED'
        || message.type === 'OPERATION_ACK'
        || message.type === 'PLAYER_INTENT'
        || message.type === 'STUCK_SEEK_STEP'
        || message.type === 'PLAYER_PAUSE_CONTEXT'
        || message.type === 'RELOAD_PLAYER_TAB'
      const boundMessage = bindingAware && !('bindingId' in message)
        ? { ...message, bindingId: currentBindingId } as RuntimeRequest
        : message
      return new Promise<RuntimeResponse>((resolve) => {
        fake.messageListener(boundMessage, sender, response => {
          const result = response as RuntimeResponse
          if (result.playerBindingId)
            currentBindingId = result.playerBindingId
          resolve(result)
        })
      })
    }
    await request({ type: 'GET_STATE' })
    FakeWebSocket.instances[0]!.simulateMessage({
      type: 'room_joined', participantId: 'participant_resumed', sessionToken: 'session_resumed', snapshot,
    })
    await request({ type: 'GET_STATE' })
    return { fake, request }
  }

  it('keeps the observed episode when resuming a worker after native next-episode navigation', async () => {
    const { request } = await resumeAtPage(nextUrl)
    const response = await request({ type: 'GET_STATE' })
    expect(response.state.currentMedia).toMatchObject(nextMedia)
    expect(response.state.snapshot?.media).toMatchObject(oldMedia)
  })

  it('does not relabel a new episode report as the previous shared navigation target', async () => {
    const { request } = await resumeAtPage(sharedUrl)
    const response = await request({ type: 'MEDIA_DETECTED', media: nextMedia, areaPixels: 500_000 }, {
      tab: { id: 42, active: true, url: nextUrl }, frameId: 0, url: nextUrl,
    } as chrome.runtime.MessageSender)
    expect(response.state.currentMedia).toMatchObject(nextMedia)
    expect(response.state.snapshot?.media).toMatchObject(oldMedia)
  })

  it('does not auto-follow an observed new episode while controller-follow is disabled', async () => {
    const { request } = await resumeAtPage(sharedUrl)
    const socket = FakeWebSocket.instances[0]!
    const sentBefore = socket.sentMessages.length
    await request({ type: 'MEDIA_DETECTED', media: nextMedia, areaPixels: 500_000 }, {
      tab: { id: 42, active: true, url: nextUrl }, frameId: 0, url: nextUrl,
    } as chrome.runtime.MessageSender)

    expect(socket.sentMessages.slice(sentBefore)).not.toContainEqual(expect.objectContaining({ type: 'open_link' }))
    const response = await request({ type: 'GET_STATE' })
    expect(response.state.snapshot?.media).toMatchObject(oldMedia)
  })

  it('clears unreachable player state and tells the room that the player is no longer ready', async () => {
    const { fake, request } = await resumeAtPage(sharedUrl)
    ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('The frame was removed.'))
    const response = await request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000 }, {
      tab: { id: 42, active: true, url: sharedUrl }, frameId: 0, url: sharedUrl,
    } as chrome.runtime.MessageSender)
    expect(response.state.playerFrameId).toBeNull()
    expect(response.state.currentMedia).toBeNull()
    expect(response.state.playerTabId).toBe(42)
    expect(FakeWebSocket.instances[0]!.sentMessages).toContainEqual({ type: 'set_ready', ready: false, media: null })
  })

  it('ignores an old document delivery failure after a replacement binds the same tab and frame', async () => {
    const { fake, request } = await resumeAtPage(sharedUrl)
    const sendToTab = fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>
    sendToTab.mockClear()
    let rejectOldDelivery: (error: Error) => void = () => {}
    sendToTab.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectOldDelivery = reject
    }))
    const sender = { tab: { id: 42, active: true, url: sharedUrl }, frameId: 0, url: sharedUrl } as chrome.runtime.MessageSender
    const report: RuntimeRequest = { type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000 }
    const oldReport = request(report, sender)
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledTimes(1))

    // Main-frame navigations reuse frameId 0. A fresh content script can
    // report itself before Chrome rejects the old document's message port.
    await request(report, sender)
    const sentBeforeRejection = FakeWebSocket.instances[0]!.sentMessages.length
    rejectOldDelivery(new Error('The old document was removed.'))
    const response = await oldReport
    expect(response.state.playerFrameId).toBe(0)
    expect(response.state.currentMedia).toMatchObject(oldMedia)
    expect(FakeWebSocket.instances[0]!.sentMessages.slice(sentBeforeRejection))
      .not.toContainEqual({ type: 'set_ready', ready: false, media: null })
  })

  it('rejects stale same-frame status, loss, seek acknowledgement and intent messages after document replacement', async () => {
    const { fake, request } = await resumeAtPage(sharedUrl)
    const oldSender = {
      tab: { id: 42, active: true, url: sharedUrl },
      frameId: 0,
      documentId: 'document-old',
      url: sharedUrl,
    } as chrome.runtime.MessageSender
    const oldBindingResponse = await request({
      type: 'MEDIA_DETECTED',
      media: oldMedia,
      areaPixels: 500_000,
      bindingId: 'binding_resumed',
    }, oldSender)
    const oldBindingId = oldBindingResponse.playerBindingId
    expect(oldBindingId).toEqual(expect.any(String))

    const newSender = {
      tab: { id: 42, active: true, url: sharedUrl },
      frameId: 0,
      documentId: 'document-new',
      url: sharedUrl,
    } as chrome.runtime.MessageSender
    const replacement = await request({
      type: 'MEDIA_DETECTED',
      media: oldMedia,
      areaPixels: 500_000,
      bindingId: undefined,
    }, newSender)
    const newBindingId = replacement.playerBindingId
    expect(newBindingId).toEqual(expect.any(String))
    expect(newBindingId).not.toBe(oldBindingId)

    const staleSample = {
      positionSeconds: 99,
      durationSeconds: 120,
      paused: false,
      buffering: false,
      sampledAtLocalMs: Date.now(),
    }
    const socket = FakeWebSocket.instances[0]!
    const sentBeforeStaleMessages = socket.sentMessages.length
    await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: staleSample, bindingId: oldBindingId }, oldSender)
    await request({ type: 'MEDIA_LOST', bindingId: oldBindingId }, oldSender)
    await request({ type: 'SEEK_APPLIED', revision: 5, positionSeconds: 99, bindingId: oldBindingId }, oldSender)
    await request({ type: 'PLAYER_INTENT', kind: 'pause', positionSeconds: 99, bindingId: oldBindingId }, oldSender)
    const afterStaleMessages = await request({ type: 'GET_STATE' })
    expect(afterStaleMessages.state.currentMedia).toMatchObject(oldMedia)
    expect(afterStaleMessages.state.lastPlayerSample).toBeNull()
    expect(socket.sentMessages).toHaveLength(sentBeforeStaleMessages)

    await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: staleSample, bindingId: newBindingId }, newSender)
    const afterCurrentStatus = await request({ type: 'GET_STATE' })
    expect(afterCurrentStatus.state.lastPlayerSample).toMatchObject(staleSample)

    const currentOperationAcknowledgement = {
      mediaEpoch: 1,
      operationId: 'operation_play_123456',
      bindingId: newBindingId!,
      sourceGeneration: 2,
      sampleSequence: 7,
      phase: 'started' as const,
      participantId: 'participant_resumed',
      observedPositionSeconds: 12,
      observedAtLocalMs: Date.now(),
    }
    const sentBeforeAcknowledgements = socket.sentMessages.length
    await request({
      type: 'OPERATION_ACK',
      acknowledgement: { ...currentOperationAcknowledgement, bindingId: oldBindingId! },
    }, oldSender)
    expect(socket.sentMessages).toHaveLength(sentBeforeAcknowledgements)
    await request({ type: 'OPERATION_ACK', acknowledgement: currentOperationAcknowledgement }, newSender)
    expect(socket.sentMessages).toContainEqual({ type: 'operation_ack', acknowledgement: currentOperationAcknowledgement })

    ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()
    await request({ type: 'LOCK_PLAYER' })
    expect(fake.chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'LOCK_PLAYER' }, { documentId: 'document-new' })
  })

  it('keeps a fallback binding stable for heartbeats and rotates it after loading without documentId', async () => {
    const { fake, request } = await resumeAtPage(sharedUrl)
    const sender = {
      tab: { id: 42, active: true, url: sharedUrl },
      frameId: 0,
      url: sharedUrl,
    } as chrome.runtime.MessageSender
    const first = await request({
      type: 'MEDIA_DETECTED',
      media: oldMedia,
      areaPixels: 500_000,
      bindingId: 'binding_resumed',
    }, sender)
    const firstBindingId = first.playerBindingId
    const heartbeat = await request({
      type: 'MEDIA_DETECTED',
      media: oldMedia,
      areaPixels: 500_000,
      bindingId: firstBindingId,
    }, sender)
    expect(heartbeat.playerBindingId).toBe(firstBindingId)

    fake.updatedListener(42, { status: 'loading' })
    const staleAfterLoading = await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: {
      positionSeconds: 12,
      durationSeconds: 120,
      paused: false,
      buffering: false,
      sampledAtLocalMs: Date.now(),
    }, bindingId: firstBindingId }, sender)
    expect(staleAfterLoading.state.playerFrameId).toBeNull()
    expect(staleAfterLoading.state.lastPlayerSample).toBeNull()

    const replacement = await request({
      type: 'MEDIA_DETECTED',
      media: oldMedia,
      areaPixels: 500_000,
      bindingId: undefined,
    }, sender)
    expect(replacement.playerBindingId).toEqual(expect.any(String))
    expect(replacement.playerBindingId).not.toBe(firstBindingId)
  })

  it('does not restore a delayed context after the bound tab starts a new navigation', async () => {
    let resolveTab: (tab: unknown) => void = () => {}
    const tabGate = new Promise<unknown>(resolve => { resolveTab = resolve })
    const fake = buildFakeChrome({ sessionState: {
      participantId: 'participant_resumed',
      sessionToken: 'session_resumed',
      snapshot: buildRoomSnapshot({ media: oldMedia }),
      playerTabId: 42,
      playerFrameId: 0,
      playerAreaPixels: 500_000,
      playerLastSeenAtMs: Date.now(),
      currentMedia: oldMedia,
      lastOpenedNavigationRevision: 5,
    }, playerBindingState: { id: 'binding_delayed', documentId: null } })
    ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(async (_tabId: number, message: RuntimeEvent | ContentRequest) => {
      if (message.type === 'GET_PLAYER_CONTEXT')
        return { media: oldMedia, diagnostics: null, sample: null }
      return undefined
    })
    ;(fake.chrome.tabs.get as ReturnType<typeof vi.fn>).mockReturnValue(tabGate)
    vi.stubGlobal('chrome', fake.chrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('./service-worker.ts')

    await vi.waitFor(() => expect(fake.chrome.tabs.get).toHaveBeenCalledWith(42))
    fake.updatedListener(42, { status: 'loading' })
    resolveTab({ id: 42, url: nextUrl })

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0]!.simulateOpen()
    const response = await new Promise<RuntimeResponse>((resolve) => {
      fake.messageListener({ type: 'GET_STATE' }, {}, result => resolve(result as RuntimeResponse))
    })

    expect(response.state.playerFrameId).toBeNull()
    expect(response.state.currentMedia).toBeNull()
  })

  describe('what a page is told when the worker stops binding it', () => {
    // A page keeps the token the worker issued it and is refused with it once
    // it is stale; it drops the token only when told the worker has no bound
    // player at all (`bindingReleased`). A page that another document replaced
    // is detached without it, which keeps it refused.
    const pageEvents = (fake: Awaited<ReturnType<typeof resumeAtPage>>['fake']) =>
      vi.mocked(fake.chrome.tabs.sendMessage).mock.calls
        .filter(([, message]) => (message as { type?: string }).type === 'APPLY_ROOM_STATE')
        .map(([tabId, message, options]) => ({ tabId, message: message as { state: { snapshot: unknown }, bindingReleased?: boolean }, options }))

    it('releases the page when the room is left', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      vi.mocked(fake.chrome.tabs.sendMessage).mockClear()

      await request({ type: 'LEAVE_ROOM' })

      const detach = pageEvents(fake).find(event => event.message.state.snapshot === null)
      expect(detach?.tabId).toBe(42)
      expect(detach?.message.bindingReleased).toBe(true)
    })

    it('detaches the page without releasing it when another tab is asked to report, so it cannot take the binding straight back', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      ;(fake.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 43, active: true, url: 'https://other.example.test/watch' }])
      vi.mocked(fake.chrome.tabs.sendMessage).mockClear()

      await request({ type: 'RECHECK_MEDIA' })

      const detach = pageEvents(fake).find(event => event.tabId === 42)
      expect(detach?.message.state.snapshot).toBeNull()
      expect(detach?.message.bindingReleased).toBeUndefined()
      expect(vi.mocked(fake.chrome.tabs.sendMessage)).toHaveBeenCalledWith(43, { type: 'REPORT_PLAYER_CONTEXT' })
    })

    it('releases the page when its context reports no media and the worker lets the binding go', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      const sendToTab = fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>
      sendToTab.mockClear()
      sendToTab.mockImplementation(async (_tabId: number, message: RuntimeEvent | ContentRequest) => {
        if (message.type === 'GET_PLAYER_CONTEXT')
          return { media: null, diagnostics: null, sample: null }
        return undefined
      })

      await request({ type: 'UNLOCK_PLAYER' })

      const detach = pageEvents(fake).find(event => event.tabId === 42)
      expect(detach?.message.state.snapshot).toBeNull()
      expect(detach?.message.bindingReleased).toBe(true)
    })

    it('releases the page, and tells the room it is not ready, when no tab can be found to bind', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      ;(fake.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([])
      vi.mocked(fake.chrome.tabs.sendMessage).mockClear()
      const socket = FakeWebSocket.instances[0]!
      const sentBefore = socket.sentMessages.length

      await request({ type: 'RECHECK_MEDIA' })

      const detach = pageEvents(fake).find(event => event.tabId === 42)
      expect(detach?.message.bindingReleased).toBe(true)
      expect(socket.sentMessages.slice(sentBefore)).toContainEqual({ type: 'set_ready', ready: false, media: null })
    })

    it('does not release a page that another document replaced', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      const tab = { id: 42, active: true, url: sharedUrl }
      await request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000, bindingId: undefined }, { tab, frameId: 0, url: sharedUrl, documentId: 'document_old' } as chrome.runtime.MessageSender)
      vi.mocked(fake.chrome.tabs.sendMessage).mockClear()

      // The replacement is a new document in the same frame, with no token.
      const replacement = await request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000, bindingId: undefined }, { tab, frameId: 0, url: sharedUrl, documentId: 'document_new' } as chrome.runtime.MessageSender)
      expect(replacement.playerBindingId).toBeDefined()

      const detach = pageEvents(fake).find(event => (event.options as { documentId?: string } | undefined)?.documentId === 'document_old')
      expect(detach).toBeDefined()
      expect(detach!.message.state.snapshot).toBeNull()
      expect(detach!.message.bindingReleased).toBeUndefined()
    })
  })

  it('does not clear a replacement binding when an old context read returns no media', async () => {
    const { fake, request } = await resumeAtPage(sharedUrl)
    const sendToTab = fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>
    sendToTab.mockClear()
    let resolveContext: (context: unknown) => void = () => {}
    const contextGate = new Promise<unknown>(resolve => { resolveContext = resolve })
    sendToTab.mockImplementation(async (_tabId: number, message: RuntimeEvent | ContentRequest) => {
      if (message.type === 'GET_PLAYER_CONTEXT')
        return contextGate
      return undefined
    })

    const refreshPromise = request({ type: 'UNLOCK_PLAYER' })
    await vi.waitFor(() => expect(sendToTab).toHaveBeenCalledWith(42, { type: 'GET_PLAYER_CONTEXT' }, { frameId: 0 }))

    const replacement = await request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000 }, {
      tab: { id: 42, active: true, url: sharedUrl }, frameId: 0, url: sharedUrl,
    } as chrome.runtime.MessageSender)
    expect(replacement.state.playerFrameId).toBe(0)

    resolveContext({ media: null, diagnostics: null, sample: null })
    await refreshPromise

    const response = await request({ type: 'GET_STATE' })
    expect(response.state.playerFrameId).toBe(0)
    expect(response.state.currentMedia).toMatchObject(oldMedia)
  })

  it('includes playback progress and start evidence in validated diagnostic events', async () => {
    const { request } = await resumeAtPage(sharedUrl)
    vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
    const sender = { tab: { id: 42 }, frameId: 0 } as chrome.runtime.MessageSender
    const sample = { positionSeconds: 12, durationSeconds: 1440, paused: false, buffering: false, sampledAtLocalMs: Date.now() }
    await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: { ...sample, progressed: false, playbackStarted: true, playbackStartFailed: false } }, sender)
    await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample }, sender)
    const socket = FakeWebSocket.instances[0]!
    socket.simulateMessage({ type: 'diagnostics_requested', reportId: 'report_player_health' })
    expect(socket.sentMessages).toContainEqual(expect.objectContaining({
      type: 'diagnostics_response',
      reportId: 'report_player_health',
      report: expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ message: 'player_status', details: expect.objectContaining({ progressed: false, playbackStarted: true, playbackStartFailed: false }) }),
          expect.objectContaining({ message: 'player_status', details: expect.objectContaining({ progressed: null, playbackStarted: null, playbackStartFailed: null }) }),
        ]),
      }),
    }))
  })

  it('correlates diagnostic reports and redacts untrusted server error text', async () => {
    const { request } = await resumeAtPage(sharedUrl)
    const socket = FakeWebSocket.instances[0]!
    const sender = { tab: { id: 42 }, frameId: 0 } as chrome.runtime.MessageSender
    socket.simulateMessage({
      type: 'room_snapshot',
      reason: 'operation_started',
      snapshot: buildRoomSnapshot({
        contract: {
          mode: 'transactional',
          mediaEpoch: 4,
          sharedCapabilities: ['media-epoch', 'operation-identity', 'prepare-start', 'binding-sequence'],
          operation: {
            mediaEpoch: 4,
            operationId: 'operation_seek_123456',
            kind: 'seek',
            phase: 'started',
            requiredParticipantIds: ['participant_resumed'],
            preparedParticipantIds: ['participant_resumed'],
            startedParticipantIds: ['participant_resumed'],
            targetPositionSeconds: 137,
            effectiveAtServerMs: 1_000,
            deadlineAtServerMs: 10_000,
            reason: 'controller-request',
          },
        },
      }),
    })
    await request({
      type: 'PLAYER_STATUS',
      basedOnRevision: 5,
      sample: {
        positionSeconds: 135,
        durationSeconds: 1_440,
        paused: false,
        buffering: false,
        sampledAtLocalMs: Date.now() - 250,
        progressed: true,
        progressEvidence: 'frames',
        correctionCount: 3,
      },
    }, sender)
    await request({
      type: 'PLAYER_STATUS',
      basedOnRevision: 5,
      sample: {
        positionSeconds: 135,
        durationSeconds: 1_440,
        paused: false,
        buffering: false,
        sampledAtLocalMs: Date.now() - 100,
        progressed: true,
        progressEvidence: 'frames',
        correctionCount: 3,
      },
    }, sender)
    await request({
      type: 'OPERATION_ACK',
      acknowledgement: {
        operationId: 'operation_seek_123456',
        mediaEpoch: 4,
        bindingId: 'binding_resumed',
        sourceGeneration: 2,
        sampleSequence: 9,
        phase: 'started',
        participantId: 'participant_resumed',
        observedPositionSeconds: 135,
        observedAtLocalMs: Date.now(),
      },
    }, sender)
    socket.simulateMessage({
      type: 'command_rejected',
      actionId: null,
      code: 'session_invalid',
      message: 'secret-source-url-and-private-token-must-never-enter-a-report',
      snapshot: null,
    })
    socket.simulateMessage({
      type: 'error',
      code: 'provider-error',
      message: 'private-stream-url-with-token-should-not-be-copied',
    })
    socket.simulateMessage({ type: 'diagnostics_requested', reportId: 'report_correlation' })
    const response = socket.sentMessages.find(message => typeof message === 'object' && message !== null
      && (message as { type?: unknown }).type === 'diagnostics_response'
      && (message as { reportId?: unknown }).reportId === 'report_correlation') as { report: DiagnosticsReport } | undefined
    expect(response?.report).toMatchObject({
      mediaEpoch: 4,
      operationId: 'operation_seek_123456',
      operationKind: 'seek',
      operationPhase: 'started',
      bindingId: 'binding_resumed',
      sourceGeneration: 2,
      sampleSequence: 9,
      targetPositionSeconds: 137,
      observedPositionSeconds: 135,
      progressConfidence: 'frames',
      correctionCount: 3,
      reason: 'controller-request',
      eventsCoalesced: 1,
    })
    expect(JSON.stringify(response?.report)).not.toContain('secret-source-url-and-private-token')
    expect(JSON.stringify(response?.report)).not.toContain('private-stream-url-with-token')
    expect(response?.report.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'command_rejected', details: { code: 'session_invalid' } }),
      expect.objectContaining({ message: 'server_error', details: { code: 'provider-error' } }),
    ]))
  })

  describe('a scrub the room refused because someone was not ready', () => {
    const me = { id: 'participant_resumed', name: 'Me', role: 'controller', ready: true, connected: true, mediaMatches: true, latencyMs: null } as const
    const friendNotReady = { id: 'participant_friend', name: 'Friend', role: 'member', ready: false, connected: true, mediaMatches: true, latencyMs: null } as const
    const friendReady = { ...friendNotReady, ready: true }
    const playerSender = { tab: { id: 42 }, frameId: 0 } as chrome.runtime.MessageSender
    const atRoom = (positionSeconds: number) => ({ status: 'paused', positionSeconds, effectiveAtServerMs: 0, playbackRate: 1 }) as const

    function snapshotOf(revision: number, friend: typeof friendNotReady | typeof friendReady, reason = 'participant_ready', overrides: Partial<RoomSnapshot> = {}) {
      return { type: 'room_snapshot', reason, snapshot: buildRoomSnapshot({ revision, media: oldMedia, participants: [me, friend], playback: atRoom(2.68), ...overrides }) } as const
    }

    function controlsSent(socket: FakeWebSocket) {
      return socket.sentMessages.filter((message): message is { type: 'control', actionId: string, kind: string, positionSeconds: number, basedOnRevision: number } =>
        typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'control')
    }

    /** The room's refusal of the control that was sent last. */
    function refusalOfLastControl(socket: FakeWebSocket, code = 'participants_not_ready', message = 'Everyone must be ready before a transactional operation starts.') {
      return { type: 'command_rejected', actionId: controlsSent(socket).at(-1)!.actionId, code, message, snapshot: null } as const
    }

    function eventsToPage(fake: Awaited<ReturnType<typeof resumeAtPage>>['fake']) {
      return (fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1] as { type: string, [key: string]: unknown })
    }

    const holds = (fake: Awaited<ReturnType<typeof resumeAtPage>>['fake']) => eventsToPage(fake).filter(event => event.type === 'CONTROLLER_SEEK_HOLD')

    async function refusedScrub() {
      const { fake, request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      socket.simulateMessage(snapshotOf(6, friendNotReady, 'participant_not_ready'))
      await request({ type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: 126 }, playerSender)
      expect(controlsSent(socket)).toEqual([expect.objectContaining({ kind: 'seek', positionSeconds: 126 })])
      ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()
      socket.simulateMessage(refusalOfLastControl(socket))
      return { fake, request, socket }
    }

    it('keeps the scrub, holds the controller\'s player for as long as the wait and shows no error', async () => {
      const { fake, request } = await refusedScrub()

      await vi.waitFor(() => expect(holds(fake)).toContainEqual({ type: 'CONTROLLER_SEEK_HOLD', held: true, holdMs: expect.any(Number) }))
      expect((holds(fake)[0] as unknown as { holdMs: number }).holdMs).toBeGreaterThan(40_000)
      expect((await request({ type: 'GET_STATE' })).state.lastError).toBeNull()
      expect(eventsToPage(fake)).not.toContainEqual(expect.objectContaining({ type: 'SHOW_NOTICE', message: expect.stringMatching(/must be ready/i) }))
    })

    it('records who was not ready, for the refusal and for the kept scrub', async () => {
      const { socket } = await refusedScrub()
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
      socket.simulateMessage({ type: 'diagnostics_requested', reportId: 'report_who' })
      const report = (socket.sentMessages.find(message => (message as { reportId?: unknown }).reportId === 'report_who') as { report: DiagnosticsReport }).report

      expect(report.events.find(event => event.message === 'command_rejected')!.details).toMatchObject({ code: 'participants_not_ready', notReady: 'friend:nm' })
      expect(report.events.find(event => event.message === 'seek_deferred')!.details).toMatchObject({ notReady: 'friend:nm' })
    })

    it('sends the same scrub once everyone is ready, and keeps the page held until the room has the seek', async () => {
      const { fake, socket } = await refusedScrub()

      socket.simulateMessage(snapshotOf(7, friendNotReady, 'readiness_unchanged'))
      expect(controlsSent(socket)).toHaveLength(1)

      socket.simulateMessage(snapshotOf(8, friendReady))
      await vi.waitFor(() => expect(controlsSent(socket)).toHaveLength(2))
      expect(controlsSent(socket)[1]).toMatchObject({ kind: 'seek', positionSeconds: 126, basedOnRevision: 8 })
      await vi.waitFor(() => expect(holds(fake).at(-1)).toEqual({ type: 'CONTROLLER_SEEK_HOLD', held: true, holdMs: expect.any(Number) }))

      // A newer state that still shows the old position must not take the player back.
      socket.simulateMessage(snapshotOf(9, friendReady, 'participant_status_changed'))
      expect(holds(fake).some(event => event.held === false)).toBe(false)
      expect(controlsSent(socket)).toHaveLength(2)

      // The room has the seek. The page is given that state first, and only then let go.
      ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()
      socket.simulateMessage(snapshotOf(10, friendReady, 'control_seek_pending', { playback: atRoom(126) }))
      await vi.waitFor(() => expect(holds(fake).at(-1)).toEqual({ type: 'CONTROLLER_SEEK_HOLD', held: false }))
      const delivered = eventsToPage(fake)
      const stateWithSeek = delivered.findIndex(event => event.type === 'APPLY_ROOM_STATE' && (event.state as { snapshot: { revision: number } }).snapshot.revision === 10)
      expect(stateWithSeek).toBeGreaterThanOrEqual(0)
      expect(stateWithSeek).toBeLessThan(delivered.findIndex(event => event.type === 'CONTROLLER_SEEK_HOLD' && event.held === false))
      socket.simulateMessage(snapshotOf(11, friendReady, 'participant_status_changed', { playback: atRoom(126) }))
      expect(controlsSent(socket)).toHaveLength(2)
    })

    it('waits again, without starting the wait over, when the sent-again scrub is refused too', async () => {
      const { socket } = await refusedScrub()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 44_000)
        socket.simulateMessage(snapshotOf(8, friendReady))
        await vi.waitFor(() => expect(controlsSent(socket)).toHaveLength(2))
        // Refused straight away: back to waiting, with the original deadline.
        socket.simulateMessage(refusalOfLastControl(socket))
        vi.setSystemTime(Date.now() + 2_000)
        socket.simulateMessage(snapshotOf(9, friendReady, 'participant_ready'))
        expect(controlsSent(socket)).toHaveLength(2)
      }
      finally {
        vi.useRealTimers()
      }
    })

    it('does not keep the refusal of an older control', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      socket.simulateMessage(snapshotOf(6, friendNotReady, 'participant_not_ready'))
      await request({ type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: 126 }, playerSender)
      const olderRefusal = refusalOfLastControl(socket)
      await request({ type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: 200 }, playerSender)
      ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()

      socket.simulateMessage(olderRefusal)
      socket.simulateMessage(snapshotOf(8, friendReady))

      expect(holds(fake)).toEqual([])
      expect(controlsSent(socket)).toHaveLength(2)
    })

    it('drops the scrub when the controller decides something else, and keeps the page held until the room has answered', async () => {
      const { fake, request, socket } = await refusedScrub()

      await request({ type: 'CONTROL', kind: 'pause' })
      expect(holds(fake).at(-1)).toEqual({ type: 'CONTROLLER_SEEK_HOLD', held: true, holdMs: 3_000 })
      expect(holds(fake).some(event => event.held === false)).toBe(false)
      socket.simulateMessage(snapshotOf(8, friendReady))

      expect(controlsSent(socket).map(message => message.kind)).toEqual(['seek', 'pause'])
    })

    it('keeps waiting when Play is pressed and refused, since nothing was decided', async () => {
      const { request, socket } = await refusedScrub()

      const play = await request({ type: 'CONTROL', kind: 'play' })
      expect(play.ok).toBe(false)
      socket.simulateMessage(snapshotOf(8, friendReady))

      await vi.waitFor(() => expect(controlsSent(socket).map(message => message.kind)).toEqual(['seek', 'seek']))
    })

    it('drops the scrub when Sync is pressed', async () => {
      const { request, socket } = await refusedScrub()

      await request({ type: 'SYNC_NOW' })
      socket.simulateMessage(snapshotOf(8, friendReady))

      expect(controlsSent(socket)).toHaveLength(1)
    })

    it('gives up after the wait and lets the page return to the room', async () => {
      const { fake, socket } = await refusedScrub()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 46_000)
        socket.simulateMessage(snapshotOf(8, friendReady))
      }
      finally {
        vi.useRealTimers()
      }

      expect(controlsSent(socket)).toHaveLength(1)
      await vi.waitFor(() => expect(holds(fake)).toContainEqual({ type: 'CONTROLLER_SEEK_HOLD', held: false }))
      expect(eventsToPage(fake)).toContainEqual(expect.objectContaining({ type: 'SHOW_NOTICE', message: expect.stringMatching(/did not move/i) }))
    })

    it('does not send the scrub in another room or video, and lets the page go', async () => {
      for (const other of [{ roomId: 'room_other' }, { media: { ...oldMedia, canonicalId: 'crunchyroll:ANOTHER' } }] as const) {
        vi.resetModules()
        FakeWebSocket.instances = []
        const { fake, socket } = await refusedScrub()

        socket.simulateMessage(snapshotOf(8, friendReady, 'participant_ready', other))

        expect(controlsSent(socket)).toHaveLength(1)
        expect(holds(fake)).toContainEqual({ type: 'CONTROLLER_SEEK_HOLD', held: false })
      }
    })

    it('lets the page go when the room is left', async () => {
      const { fake, request } = await refusedScrub()

      await request({ type: 'LEAVE_ROOM' })

      expect(holds(fake)).toContainEqual({ type: 'CONTROLLER_SEEK_HOLD', held: false })
    })

    it('tells a page that was reloaded during the wait to hold its player', async () => {
      const { fake, request } = await refusedScrub()
      ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()

      await request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000 }, playerSender)

      expect(holds(fake)).toContainEqual({ type: 'CONTROLLER_SEEK_HOLD', held: true, holdMs: expect.any(Number) })
    })

    it('keeps waiting when the scrub could not be sent, and sends it when it can', async () => {
      const { socket } = await refusedScrub()

      socket.readyState = FakeWebSocket.CLOSED
      socket.simulateMessage(snapshotOf(8, friendReady))
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(controlsSent(socket)).toHaveLength(1)

      socket.readyState = FakeWebSocket.OPEN
      socket.simulateMessage(snapshotOf(9, friendReady, 'participant_ready'))
      await vi.waitFor(() => expect(controlsSent(socket)).toHaveLength(2))
    })

    it('does not keep a refusal for another reason', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      socket.simulateMessage(snapshotOf(6, friendReady))
      await request({ type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: 126 }, playerSender)
      ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear()

      socket.simulateMessage(refusalOfLastControl(socket, 'stale_context', 'The room changed before this control was applied.'))

      await vi.waitFor(async () => expect((await request({ type: 'GET_STATE' })).state.lastError).toBe('The room changed before this control was applied.'))
      expect(holds(fake)).toEqual([])
    })
  })

  describe('the coordinator\'s timeline in the downloaded report', () => {
    const roomTimeline = {
      generatedAtServerMs: 20_000,
      revision: 9,
      mode: 'transactional',
      coverageStartedAtServerMs: 10_000,
      entriesDropped: 0,
      entries: [{
        atServerMs: 15_000,
        revision: 8,
        kind: 'transport',
        event: 'socket_closed',
        playbackStatus: 'playing',
        positionSeconds: 812.5,
        controllerId: 'participant_resumed',
        operation: null,
        participants: [{ id: 'participant_friend', connected: false, ready: true, mediaMatches: true, status: 'playing' }],
        detail: { participantId: 'participant_friend', code: 1006, reason: 'none', participantStillConnected: false },
      }],
    }

    function downloadedReport(fake: FakeChrome) {
      const download = fake.downloadMock.mock.calls[0]![0] as { url: string }
      const [, body] = download.url.split(',', 2)
      return JSON.parse(decodeURIComponent(body!)) as { schemaVersion: number, room: unknown, participants: unknown[], collection: { complete: boolean } }
    }

    function requestedReportId(socket: FakeWebSocket): string {
      const request = socket.sentMessages.find(message => (message as { type?: string }).type === 'request_diagnostics') as { reportId: string } | undefined
      if (!request)
        throw new Error('Expected a request_diagnostics message.')
      return request.reportId
    }

    it('writes the timeline the coordinator sends into the report, for a room with only the controller in it', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })

      await request({ type: 'DOWNLOAD_DIAGNOSTICS' })
      const reportId = requestedReportId(socket)
      // Nothing is written while the timeline is still on its way, though every answer is already here.
      expect(fake.downloadMock).not.toHaveBeenCalled()

      socket.simulateMessage({ type: 'diagnostics_room', reportId, room: roomTimeline })

      await vi.waitFor(() => expect(fake.downloadMock).toHaveBeenCalledTimes(1))
      const report = downloadedReport(fake)
      expect(report.schemaVersion).toBe(2)
      expect(report.room).toEqual(roomTimeline)
      expect(report.collection.complete).toBe(true)
    })

    it('ignores a timeline for a report it did not ask for', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })

      await request({ type: 'DOWNLOAD_DIAGNOSTICS' })
      socket.simulateMessage({ type: 'diagnostics_room', reportId: 'report_someone_elses', room: roomTimeline })
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(fake.downloadMock).not.toHaveBeenCalled()
    })

    it('still writes the report, with no timeline, when the coordinator is one that does not send it', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })

      await request({ type: 'DOWNLOAD_DIAGNOSTICS' })

      await vi.waitFor(() => expect(fake.downloadMock).toHaveBeenCalledTimes(1), { timeout: 4_000 })
      const report = downloadedReport(fake)
      expect(report.schemaVersion).toBe(2)
      expect(report.room).toBeNull()
      expect(report.participants).toHaveLength(1)
    })
  })

  describe('why the room paused or resumed', () => {
    function reportEvents(socket: FakeWebSocket, reportId: string) {
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
      socket.simulateMessage({ type: 'diagnostics_requested', reportId })
      const response = socket.sentMessages.find(message => typeof message === 'object' && message !== null
        && (message as { reportId?: unknown }).reportId === reportId) as { report: DiagnosticsReport }
      return response.report.events
    }

      it('keeps a status change that arrived with a rejected command or a rejoin', async () => {
      await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      const playing = { status: 'playing', positionSeconds: 10, effectiveAtServerMs: 0, playbackRate: 1 } as const
      const paused = { ...playing, status: 'paused' } as const
      socket.simulateMessage({ type: 'room_snapshot', reason: 'operation_started', snapshot: buildRoomSnapshot({ revision: 6, playback: playing }) })
      socket.simulateMessage({ type: 'command_rejected', actionId: 'action_play', code: 'start_rejected', message: 'x', snapshot: buildRoomSnapshot({ revision: 7, playback: paused }) })
      socket.simulateMessage({ type: 'room_joined', participantId: 'participant_resumed', sessionToken: 'session_resumed', snapshot: buildRoomSnapshot({ revision: 8, playback: playing }) })
      // Refused because someone is not ready, with nothing else changed.
      socket.simulateMessage({ type: 'command_rejected', actionId: 'action_seek', code: 'participants_not_ready', message: 'x', snapshot: buildRoomSnapshot({ revision: 8, playback: playing }) })

      const changes = reportEvents(socket, 'report_other_messages').filter(event => event.message === 'room_status_changed')
      expect(changes.map(event => [event.details.from, event.details.to, event.details.reason])).toEqual([
        ['paused', 'playing', 'operation_started'],
        ['playing', 'paused', 'start_rejected'],
        ['paused', 'playing', 'room_joined'],
        ['playing', 'playing', 'participants_not_ready'],
      ])
    })

  it('keeps the reason of a status change and of an interruption that changed nothing', async () => {
      await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      const playing = { status: 'playing', positionSeconds: 10, effectiveAtServerMs: 0, playbackRate: 1 } as const
      const paused = { ...playing, status: 'paused' } as const
      socket.simulateMessage({ type: 'room_snapshot', reason: 'operation_started', snapshot: buildRoomSnapshot({ revision: 6, playback: playing }) })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'participant_buffering', snapshot: buildRoomSnapshot({ revision: 7, playback: paused }) })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'participant_not_ready', snapshot: buildRoomSnapshot({ revision: 8, playback: paused }) })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'participant_status_changed', snapshot: buildRoomSnapshot({ revision: 9, playback: paused }) })

      const changes = reportEvents(socket, 'report_why').filter(event => event.message === 'room_status_changed')
      expect(changes.map(event => [event.details.from, event.details.to, event.details.reason])).toEqual([
        ['paused', 'playing', 'operation_started'],
        ['playing', 'paused', 'participant_buffering'],
        ['paused', 'paused', 'participant_not_ready'],
      ])
    })
  })

  describe('stall evidence in diagnostic reports', () => {
    const stuckDiagnostics = {
      origin: 'light-dom',
      readyState: 1,
      networkState: 2,
      currentSrcKind: 'blob',
      hasSourceObject: false,
      seeking: true,
      errorCode: null,
      bufferedRangeCount: 1,
      bufferedRanges: [0, 60.04],
      seekableRangeCount: 1,
      seekableRanges: [0, 1_420],
      bufferedAheadSeconds: 0,
      pendingSeekAgeMs: 2_100,
      hasMediaKeys: true,
    } as const
    const stalledSample = {
      positionSeconds: 197.442125,
      durationSeconds: 1_440,
      paused: true,
      buffering: true,
      progressed: false,
      sampledAtLocalMs: 0,
    }
    const sender = { tab: { id: 42 }, frameId: 0 } as chrome.runtime.MessageSender

    function reportFor(socket: FakeWebSocket, reportId: string): DiagnosticsReport {
      socket.simulateMessage({ type: 'diagnostics_requested', reportId })
      const response = socket.sentMessages.find(message => typeof message === 'object' && message !== null
        && (message as { type?: unknown }).type === 'diagnostics_response'
        && (message as { reportId?: unknown }).reportId === reportId) as { report: DiagnosticsReport } | undefined
      if (!response)
        throw new Error(`No diagnostics response for ${reportId}`)
      return response.report
    }

    it('keeps the start of a long stall by merging identical heartbeats and statuses that interleave', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
      const socket = FakeWebSocket.instances[0]!
      // The start of the failure: a run of distinct room changes.
      for (let revision = 6; revision <= 13; revision += 1)
        socket.simulateMessage({ type: 'room_snapshot', reason: 'control_play_pending', snapshot: buildRoomSnapshot({ revision }) })

      // A long stall. Heartbeats and failing statuses alternate, so merging only
      // a status into the event right before it can never help, and each of
      // them is "critical" by default. 150 rounds is 5 minutes of a 2 s heartbeat.
      for (let round = 0; round < 150; round += 1) {
        await request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000, diagnostics: { ...stuckDiagnostics, bufferedRanges: [...stuckDiagnostics.bufferedRanges], seekableRanges: [...stuckDiagnostics.seekableRanges] } }, sender)
        await request({ type: 'PLAYER_STATUS', basedOnRevision: 13, sample: { ...stalledSample, sampledAtLocalMs: Date.now() } }, sender)
      }

      const report = reportFor(socket, 'report_long_stall')
      expect(report.events.filter(event => event.message === 'room_snapshot').map(event => event.details.revision))
        .toEqual([6, 7, 8, 9, 10, 11, 12, 13])
      expect(report.eventsDropped).toBe(0)
      expect(report.payloadTruncated).toBe(false)
      const heartbeats = report.events.filter(event => event.message === 'media_detected')
      expect(heartbeats).toHaveLength(1)
      expect(heartbeats[0]!.details).toMatchObject({ readyState: 1, seeking: true, errorCode: null, aheadBucket: 'empty', repeatCount: 150 })
      expect(heartbeats[0]!.details.firstAtLocalMs).toEqual(expect.any(Number))
      const statuses = report.events.filter(event => event.message === 'player_status')
      expect(statuses).toHaveLength(1)
      expect(statuses[0]!.details).toMatchObject({ buffering: true, progressed: false, repeatCount: 150 })
    })

    it('keeps the freshest heartbeat and status when the byte budget trims the oldest events', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
      const socket = FakeWebSocket.instances[0]!
      const heartbeat = () => request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000, diagnostics: { ...stuckDiagnostics, bufferedRanges: [...stuckDiagnostics.bufferedRanges], seekableRanges: [...stuckDiagnostics.seekableRanges] } }, sender)
      const status = () => request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: { ...stalledSample, sampledAtLocalMs: Date.now() } }, sender)
      await heartbeat()
      await status()
      // More distinct critical events than 12,000 bytes can hold, so the budget
      // has to trim from the front.
      for (let revision = 6; revision < 90; revision += 1)
        socket.simulateMessage({ type: 'room_snapshot', reason: 'control_play_pending', snapshot: buildRoomSnapshot({ revision }) })
      // The same element state and the same failing status again, moments ago.
      await heartbeat()
      await status()

      const report = reportFor(socket, 'report_trimmed_tail')
      expect(report.payloadTruncated).toBe(true)
      expect(report.events.filter(event => event.message === 'media_detected')).toEqual([expect.objectContaining({ details: expect.objectContaining({ repeatCount: 2 }) })])
      expect(report.events.filter(event => event.message === 'player_status')).toEqual([expect.objectContaining({ details: expect.objectContaining({ repeatCount: 2 }) })])
      const times = report.events.map(event => event.atLocalMs)
      expect(times).toEqual([...times].sort((left, right) => left - right))
    })

    it('keeps the room position change that began a stall when the same snapshots repeat for minutes', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
      const socket = FakeWebSocket.instances[0]!
      const at = (positionSeconds: number) => ({ status: 'paused' as const, positionSeconds, effectiveAtServerMs: 0, playbackRate: 1 as const })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'control_pause', snapshot: buildRoomSnapshot({ revision: 6, playback: at(676) }) })
      // The room jumps back by almost five minutes: the event the 0.2.9 report lost.
      socket.simulateMessage({ type: 'room_snapshot', reason: 'control_seek_pending', snapshot: buildRoomSnapshot({ revision: 7, playback: at(395.6) }) })
      // Five minutes of the same failing Play cycle, six distinct room events per cycle.
      for (let cycle = 0; cycle < 90; cycle += 1) {
        const revision = 8 + cycle * 2
        socket.simulateMessage({ type: 'room_snapshot', reason: 'control_play_pending', snapshot: buildRoomSnapshot({ revision, playback: at(395.6) }) })
        socket.simulateMessage({ type: 'room_snapshot', reason: 'operation_timeout_paused', snapshot: buildRoomSnapshot({ revision: revision + 1, playback: at(395.6) }) })
        for (let report = 0; report < 4; report += 1)
          socket.simulateMessage({ type: 'room_snapshot', reason: 'participant_status_changed', snapshot: buildRoomSnapshot({ revision: revision + 1, playback: at(395.6) }) })
        await request({ type: 'PLAYER_STATUS', basedOnRevision: revision, sample: { ...stalledSample, sampledAtLocalMs: Date.now() } }, sender)
      }

      const report = reportFor(socket, 'report_position_jump')
      expect(report.events.filter(event => event.message === 'room_position_changed')).toContainEqual(
        expect.objectContaining({ critical: true, details: { fromSeconds: 676, toSeconds: 395.6, reason: 'control_seek_pending', revision: 7 } }),
      )
      expect(report.payloadTruncated).toBe(true)
    })

    it('records each step the page takes on a stuck seek, and keeps them through a long stall', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
      const socket = FakeWebSocket.instances[0]!
      await request({ type: 'STUCK_SEEK_STEP', step: 'reissue', reissues: 1, positionSeconds: 395.6 }, sender)
      await request({ type: 'STUCK_SEEK_STEP', step: 'nudge', reissues: 2, positionSeconds: 395.6 }, sender)
      for (let revision = 6; revision < 120; revision += 1)
        socket.simulateMessage({ type: 'room_snapshot', reason: 'control_play_pending', snapshot: buildRoomSnapshot({ revision }) })

      const steps = reportFor(socket, 'report_steps').events.filter(event => event.message === 'stuck_seek_step')
      expect(steps.map(event => event.details)).toEqual([
        { step: 'reissue', reissues: 1, positionSeconds: 395.6 },
        { step: 'nudge', reissues: 2, positionSeconds: 395.6 },
      ])
    })

    it('ignores a step report from a page that is not the bound player', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      await request({ type: 'STUCK_SEEK_STEP', step: 'nudge', reissues: 2, positionSeconds: 1 }, { tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender)
      expect(reportFor(socket, 'report_foreign_step').events.filter(event => event.message === 'stuck_seek_step')).toEqual([])
    })

    it('reloads the tab the room is playing in when its page asks, and no other', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      await request({ type: 'RELOAD_PLAYER_TAB' }, { tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender)
      expect(fake.chrome.tabs.reload).not.toHaveBeenCalled()

      await request({ type: 'RELOAD_PLAYER_TAB' }, sender)
      expect(fake.chrome.tabs.reload).toHaveBeenCalledTimes(1)
      expect(fake.chrome.tabs.reload).toHaveBeenCalledWith(42)
    })

    it('tells the player page when the room resumes by itself and when it gives up', async () => {
      const { fake } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      socket.simulateMessage({ type: 'room_snapshot', reason: 'auto_resume_play_pending', snapshot: buildRoomSnapshot({ revision: 6 }) })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'auto_resume_abandoned', snapshot: buildRoomSnapshot({ revision: 6 }) })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'participant_status_changed', snapshot: buildRoomSnapshot({ revision: 6 }) })

      const shown = vi.mocked(fake.chrome.tabs.sendMessage).mock.calls
        .map(([, message]) => message as { type?: string; message?: string })
        .filter(message => message.type === 'SHOW_NOTICE')
        .map(message => message.message)
      expect(shown).toEqual([
        'Resuming playback for everyone.',
        'Could not resume automatically. The controller can press Play when everyone is ready.',
      ])
    })

    it('reports a seek made while the connection was down when the room is joined again', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      void request
      const socket = FakeWebSocket.instances[0]!
      const at = (positionSeconds: number) => ({ status: 'paused' as const, positionSeconds, effectiveAtServerMs: 0, playbackRate: 1 as const })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'control_pause', snapshot: buildRoomSnapshot({ revision: 6, playback: at(676) }) })
      socket.simulateMessage({ type: 'room_joined', participantId: 'participant_resumed', sessionToken: 'session_resumed', snapshot: buildRoomSnapshot({ revision: 9, playback: at(395.6) }) })

      expect(reportFor(socket, 'report_rejoin_jump').events.filter(event => event.message === 'room_position_changed').at(-1)?.details)
        .toEqual({ fromSeconds: 676, toSeconds: 395.6, reason: 'room_joined', revision: 9 })
    })

    it('records whether a player could play in its status events, as a transition of its own', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: { ...stalledSample, canPlay: false, sampledAtLocalMs: Date.now() } }, sender)
      await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: { ...stalledSample, canPlay: true, sampledAtLocalMs: Date.now() } }, sender)
      await request({ type: 'PLAYER_STATUS', basedOnRevision: 5, sample: { ...stalledSample, sampledAtLocalMs: Date.now() } }, sender)

      expect(reportFor(socket, 'report_can_play').events.filter(event => event.message === 'player_status').map(event => event.details.canPlay))
        .toEqual([false, true, null])
    })

    it('answers a reload request that Chrome refused with a failure, so the page does not keep the cooldown', async () => {
      const { fake, request } = await resumeAtPage(sharedUrl)
      vi.mocked(fake.chrome.tabs.reload).mockRejectedValueOnce(new Error('No tab with id'))

      const response = await request({ type: 'RELOAD_PLAYER_TAB' }, sender)

      expect(response.ok).toBe(false)
      expect(response.error).toBe('The tab could not be reloaded.')
    })

    it('does not report a position that only advanced with playback or moved less than the jump threshold', async () => {
      await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      const playing = (positionSeconds: number) => ({ status: 'playing' as const, positionSeconds, effectiveAtServerMs: Date.now(), playbackRate: 1 as const })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'control_play', snapshot: buildRoomSnapshot({ revision: 6, playback: playing(0) }) })
      socket.simulateMessage({ type: 'room_snapshot', reason: 'participant_status_changed', snapshot: buildRoomSnapshot({ revision: 7, playback: playing(1.5) }) })
      expect(reportFor(socket, 'report_no_jump').events.filter(event => event.message === 'room_position_changed')).toEqual([])
    })

    it('does not merge a heartbeat across a media loss, a reconnect or a room change', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      const heartbeat = () => request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000, diagnostics: { ...stuckDiagnostics, bufferedRanges: [...stuckDiagnostics.bufferedRanges], seekableRanges: [...stuckDiagnostics.seekableRanges] } }, sender)
      await heartbeat()
      await request({ type: 'MEDIA_LOST' }, sender)
      await heartbeat()
      socket.simulateMessage({ type: 'room_joined', snapshot: buildRoomSnapshot({ revision: 6 }) } as never)
      await heartbeat()
      const messages = reportFor(socket, 'report_boundaries').events.map(event => event.message)
      expect(messages.filter(message => message === 'media_detected')).toHaveLength(3)
      expect(messages.indexOf('media_lost')).toBeGreaterThan(messages.indexOf('media_detected'))
    })

    it('starts a fresh event once the merged one has been evicted from the ring', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      const heartbeat = () => request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000, diagnostics: { ...stuckDiagnostics, bufferedRanges: [...stuckDiagnostics.bufferedRanges], seekableRanges: [...stuckDiagnostics.seekableRanges] } }, sender)
      await heartbeat()
      // 130 distinct events push the heartbeat out of the 100-event ring.
      for (let revision = 6; revision < 136; revision += 1)
        socket.simulateMessage({ type: 'room_snapshot', reason: 'control_play_pending', snapshot: buildRoomSnapshot({ revision }) })
      await heartbeat()
      const report = reportFor(socket, 'report_evicted_heartbeat')
      expect(report.events.filter(event => event.message === 'media_detected')).toHaveLength(1)
    })

    it('starts a new event when the element state changes, so a transition keeps its own timestamp', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      const heartbeat = (diagnostics: Record<string, unknown>) => request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000, diagnostics: diagnostics as never }, sender)
      await heartbeat({ ...stuckDiagnostics, seeking: false, bufferedAheadSeconds: 30 })
      await heartbeat({ ...stuckDiagnostics, seeking: false, bufferedAheadSeconds: 25 })
      await heartbeat({ ...stuckDiagnostics, seeking: true, bufferedAheadSeconds: 0 })
      await heartbeat({ ...stuckDiagnostics, seeking: true, errorCode: 3, bufferedAheadSeconds: 0 })
      const details = reportFor(socket, 'report_transitions').events.filter(event => event.message === 'media_detected').map(event => event.details)
      expect(details).toEqual([
        expect.objectContaining({ seeking: false, errorCode: null, aheadBucket: 'ok', repeatCount: 2 }),
        expect.objectContaining({ seeking: true, errorCode: null, aheadBucket: 'empty' }),
        expect.objectContaining({ seeking: true, errorCode: 3, aheadBucket: 'empty' }),
      ])
    })

    it('reports the element evidence as bounded numbers and never as provider text', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      await request({
        type: 'MEDIA_DETECTED',
        media: oldMedia,
        areaPixels: 500_000,
        diagnostics: {
          ...stuckDiagnostics,
          errorCode: 4,
          bufferedRanges: [0, 60.04, 100, Number.POSITIVE_INFINITY, 9, 3, 200, 210, 300, 310, 400, 410],
          errorMessage: 'https://secret.example/stream.mpd?token=must-never-be-reported',
          mediaKeySystem: 'com.widevine.alpha',
        } as never,
      }, sender)
      const report = reportFor(socket, 'report_element_evidence')
      expect(report).toMatchObject({
        playerReadyState: 1,
        playerNetworkState: 2,
        playerSeeking: true,
        playerErrorCode: 4,
        playerBufferedRangeCount: 1,
        playerSeekableRangeCount: 1,
        playerSeekableRanges: [0, 1_420],
        playerBufferedAheadSeconds: 0,
        playerPendingSeekAgeMs: 2_100,
        playerHasMediaKeys: true,
      })
      // Non-finite and inverted pairs are dropped and the list is capped at four pairs.
      expect(report.playerBufferedRanges).toEqual([0, 60, 200, 210, 300, 310, 400, 410])
      // Both coordinators run the same validator, so the report must pass it.
      expect(parseClientMessage({ type: 'diagnostics_response', reportId: 'report_element_evidence', report })).not.toBeNull()
      expect(JSON.stringify(report)).not.toContain('must-never-be-reported')
      expect(JSON.stringify(report)).not.toContain('widevine')
    })

    it('leaves the new fields null when the player has not reported them yet', async () => {
      const { request } = await resumeAtPage(sharedUrl)
      const socket = FakeWebSocket.instances[0]!
      await request({ type: 'MEDIA_DETECTED', media: oldMedia, areaPixels: 500_000 }, sender)
      expect(reportFor(socket, 'report_no_evidence')).toMatchObject({
        playerSeeking: null,
        playerErrorCode: null,
        playerBufferedRangeCount: null,
        playerBufferedRanges: null,
        playerSeekableRanges: null,
        playerBufferedAheadSeconds: null,
        playerPendingSeekAgeMs: null,
        playerHasMediaKeys: null,
      })
    })
  })
})

// --- Why this is a unit test, not a Playwright service-worker restart -----
//
// Part 2's verification asked for a real Playwright simulation of a
// service-worker restart (reload/terminate the extension's service-worker
// target mid-session) if practical. That was investigated and is not
// practical with reasonable effort here: Chrome's MV3 service workers have
// no supported, deterministic "terminate me now" call reachable from
// Playwright (there is no public extension API for it, and Playwright does
// not expose a CDP hook for it either); the only real trigger is Chrome's own
// idle-suspend timer, which docs/ARCHITECTURE.md itself calls out as *not
// guaranteed* ("extended idle keepalive is not guaranteed"), making a test
// that waits for it inherently flaky and slow rather than a reliable
// regression guard. The tests above instead exercise the exact restart-time
// code path (module-load-time `initialize()` reading chrome.storage.session
// and resuming through the same `reconnectIfNeeded()` a dropped connection
// uses) directly, deterministically, and without a real browser.

describe('service worker while a join request is pending', () => {
  // The real coordinator, not a hand-written fixture, so a change to what an
  // unapproved requester receives is exercised here. The host has shared a
  // link, as it normally has by the time anyone asks to join: without one the
  // room has no navigation, and "no tab was opened" cannot fail.
  const SHARED_LINK = 'https://video.example.test/watch/42'

  function roomWithPendingFriend(): RoomCoordinator {
    const room = new RoomCoordinator(
      { roomId: 'room_pending', code: 'ABCDEFGH' },
      { id: 'participant_host', name: 'Muaz', media: { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A private title', durationSeconds: 600 } },
      () => 10_000,
    )
    const before = room.snapshot()
    room.openLink('participant_host', { actionId: 'action_share_link', basedOnRevision: before.revision, leaseEpoch: before.controller.leaseEpoch, url: SHARED_LINK })
    room.join({ id: 'participant_friend', name: 'Rana', media: null, sessionToken: 'friend-session-token-000000' })
    return room
  }

  function pendingPlaceholder(): RoomSnapshot {
    return roomWithPendingFriend().pendingSnapshot('participant_friend')
  }

  // What a coordinator that still sends the whole room to a requester sends.
  function leakedFullSnapshot(): RoomSnapshot {
    return roomWithPendingFriend().snapshot()
  }

  function approvedSnapshot(): RoomSnapshot {
    const room = roomWithPendingFriend()
    room.respondToJoin('participant_host', room.snapshot().controller.leaseEpoch, 'participant_friend', true)
    return room.snapshot()
  }

  const persistedWaitingState = () => ({
    connection: 'connected',
    participantId: 'participant_friend',
    sessionToken: 'friend-session-token-000000',
    displayName: 'Rana',
    snapshot: pendingPlaceholder(),
    serverOffsetMs: 0,
    clockUncertaintyMs: 99_999,
    lastError: null,
    playerTabId: null,
    playerFrameId: null,
    playerAreaPixels: 0,
    playerLastSeenAtMs: 0,
    currentMedia: null,
    playerDiagnostics: null,
    lastPlayerSample: null,
    lastOpenedNavigationRevision: 0,
    connectionQuality: 'good',
    roundTripMs: 40,
    lastPongAtMs: 0,
  })

  // `boundPlayer` gives the requester a tab it is already watching a video
  // in, which is how a requester is normally found: it asks to join from a
  // page with its own player.
  async function resumedWaitingWorker(options: { boundPlayer?: boolean } = {}) {
    const fake = buildFakeChrome({
      sessionState: options.boundPlayer
        ? { ...persistedWaitingState(), playerTabId: 42, playerFrameId: 0, playerAreaPixels: 500_000 }
        : persistedWaitingState(),
      ...(options.boundPlayer ? { playerBindingState: { id: 'binding_waiting', documentId: 'document_waiting' } } : {}),
    })
    if (options.boundPlayer) {
      ;(fake.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        media: { service: 'html5', canonicalId: 'html5:own-video', title: 'Own video', durationSeconds: 60 },
        diagnostics: null,
        sample: null,
      })
      ;(fake.chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 42, url: 'https://player.example.test/watch' })
    }
    vi.stubGlobal('chrome', fake.chrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('./service-worker.ts')
    await vi.waitFor(() => {
      if (FakeWebSocket.instances.length !== 1)
        throw new Error('expected the persisted waiting request to reconnect')
    })
    const socket = FakeWebSocket.instances[0]!
    socket.simulateOpen()
    await vi.waitFor(() => {
      if (!socket.sentMessages.some(message => (message as { type?: string }).type === 'join_room'))
        throw new Error('expected join_room to be re-sent with the stored token')
    })
    return { ...fake, socket }
  }

  const broadcasts = (sendMessageMock: ReturnType<typeof vi.fn>) =>
    sendMessageMock.mock.calls
      .map(([event]) => event as { type?: string, state?: { snapshot: RoomSnapshot | null, lastError: string | null, connection: string } })
      .filter(event => event.type === 'ROOM_STATE_UPDATED')

  // The notices a page was sent, whichever tab it was.
  const notices = (fakeChrome: typeof chrome) =>
    vi.mocked(fakeChrome.tabs.sendMessage).mock.calls
      .filter(([, message]) => (message as { type?: string }).type === 'SHOW_NOTICE')

  it('keeps the placeholder and its waiting entry, and opens no tab, when the coordinator re-sends it', async () => {
    const { chrome: fakeChrome, sendMessageMock, socket } = await resumedWaitingWorker()

    socket.simulateMessage({ type: 'room_joined', participantId: 'participant_friend', sessionToken: 'friend-session-token-000000', snapshot: pendingPlaceholder() })

    await vi.waitFor(() => {
      const last = broadcasts(sendMessageMock).at(-1)
      if (!last?.state?.snapshot?.pendingJoinRequests.some(request => request.id === 'participant_friend'))
        throw new Error('expected the waiting entry to be published')
    })
    const last = broadcasts(sendMessageMock).at(-1)!.state!
    expect(last.snapshot?.participants).toEqual([])
    expect(JSON.stringify(last)).not.toContain('private title')
    expect(JSON.stringify(last)).not.toContain('video.example.test')
    expect(fakeChrome.tabs.create).not.toHaveBeenCalled()
    expect(fakeChrome.tabs.update).not.toHaveBeenCalled()
  })

  it('replaces the placeholder with the full room when the host approves, whatever revision the placeholder had', async () => {
    const { sendMessageMock, socket } = await resumedWaitingWorker()
    socket.simulateMessage({ type: 'room_joined', participantId: 'participant_friend', sessionToken: 'friend-session-token-000000', snapshot: pendingPlaceholder() })

    const approved = approvedSnapshot()
    expect(pendingPlaceholder().revision).toBe(0)
    socket.simulateMessage({ type: 'room_snapshot', reason: 'join_approved', snapshot: approved })

    await vi.waitFor(() => {
      const last = broadcasts(sendMessageMock).at(-1)?.state?.snapshot
      if (!last?.participants.some(participant => participant.id === 'participant_friend'))
        throw new Error('expected the approved room to be published')
    })
    const last = broadcasts(sendMessageMock).at(-1)!.state!.snapshot!
    expect(last.navigation?.url).toBe(SHARED_LINK)
    expect(last.media?.pageUrl).toBe(SHARED_LINK)
    expect(last.pendingJoinRequests).toEqual([])
  })

  describe('and the host has shared a link', () => {
    const settle = () => new Promise(resolve => setTimeout(resolve, 60))

    it('has a shared link in the fixture, which the approved room carries', () => {
      expect(approvedSnapshot().navigation?.url).toBe(SHARED_LINK)
      expect(leakedFullSnapshot().navigation?.url).toBe(SHARED_LINK)
      expect(pendingPlaceholder().navigation).toBeNull()
    })

    it('opens no tab for the placeholder', async () => {
      const { chrome: fakeChrome, socket } = await resumedWaitingWorker()

      socket.simulateMessage({ type: 'room_joined', participantId: 'participant_friend', sessionToken: 'friend-session-token-000000', snapshot: pendingPlaceholder() })
      await settle()

      expect(fakeChrome.tabs.create).not.toHaveBeenCalled()
      expect(fakeChrome.tabs.update).not.toHaveBeenCalled()
    })

    for (const kind of ['room_joined', 'room_snapshot'] as const) {
      it(`opens no tab when a coordinator sends the whole room in a ${kind} while the request waits`, async () => {
        const { chrome: fakeChrome, socket } = await resumedWaitingWorker()
        const leaked = leakedFullSnapshot()
        expect(leaked.pendingJoinRequests.map(request => request.id)).toEqual(['participant_friend'])

        socket.simulateMessage(kind === 'room_joined'
          ? { type: 'room_joined', participantId: 'participant_friend', sessionToken: 'friend-session-token-000000', snapshot: leaked }
          : { type: 'room_snapshot', reason: 'room_updated', snapshot: { ...leaked, revision: leaked.revision + 1 } })
        await settle()

        expect(fakeChrome.tabs.create).not.toHaveBeenCalled()
        expect(fakeChrome.tabs.update).not.toHaveBeenCalled()
      })
    }

    it('opens the shared page once for a member while somebody else\'s request is waiting', async () => {
      // Only the participant's own pending request holds the page back. A room
      // with anybody else's request listed is still a room its members open the
      // host's link for.
      const { chrome: fakeChrome, socket } = await resumedWaitingWorker()
      const approved = approvedSnapshot()
      const withAnotherRequest: RoomSnapshot = { ...approved, pendingJoinRequests: [{ id: 'participant_other', name: 'Sam', requestedAtMs: 1 }] }
      expect(withAnotherRequest.participants.some(participant => participant.id === 'participant_friend')).toBe(true)

      socket.simulateMessage({ type: 'room_snapshot', reason: 'join_approved', snapshot: withAnotherRequest })
      await vi.waitFor(() => {
        if (vi.mocked(fakeChrome.tabs.create).mock.calls.length === 0)
          throw new Error('expected the shared page to be opened')
      })
      await settle()

      expect(vi.mocked(fakeChrome.tabs.create).mock.calls).toEqual([[{ url: SHARED_LINK, active: true }]])
    })

    it('opens the shared page once, after the request is approved, even if the room was sent earlier', async () => {
      const { chrome: fakeChrome, socket } = await resumedWaitingWorker()
      socket.simulateMessage({ type: 'room_joined', participantId: 'participant_friend', sessionToken: 'friend-session-token-000000', snapshot: leakedFullSnapshot() })
      await settle()
      expect(fakeChrome.tabs.create).not.toHaveBeenCalled()

      socket.simulateMessage({ type: 'room_snapshot', reason: 'join_approved', snapshot: approvedSnapshot() })
      await vi.waitFor(() => {
        if (vi.mocked(fakeChrome.tabs.create).mock.calls.length === 0)
          throw new Error('expected the shared page to be opened after approval')
      })
      await settle()

      expect(vi.mocked(fakeChrome.tabs.create).mock.calls).toEqual([[{ url: SHARED_LINK, active: true }]])
    })
  })

  // Runs `trigger` with timers faked, then lets far more time pass than the
  // longest reconnect backoff (15 s plus jitter). A check made a few
  // milliseconds later cannot see a reconnect scheduled for 500 ms or more.
  // Only setTimeout is faked, and it is faked before `trigger`, so a timer the
  // trigger schedules is one that is advanced.
  async function letThePastBackoffElapse(trigger: () => void): Promise<void> {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      trigger()
      await vi.advanceTimersByTimeAsync(20_000)
    }
    finally {
      vi.useRealTimers()
    }
  }

  it('leaves the room, with a reason, when the coordinator closes the waiting request as expired, and does not reconnect', async () => {
    const { chrome: fakeChrome, sendMessageMock, socket } = await resumedWaitingWorker()
    const alarmsBefore = vi.mocked(fakeChrome.alarms.create).mock.calls.length

    await letThePastBackoffElapse(() => socket.simulateClose(1000, 'room_expired'))

    const last = broadcasts(sendMessageMock).at(-1)!.state!
    expect(last.snapshot).toBeNull()
    expect(last.lastError).toMatch(/expired/i)
    expect(last.connection).toBe('disconnected')
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(vi.mocked(fakeChrome.alarms.create).mock.calls.length).toBe(alarmsBefore)
  })

  // The coordinators close sockets for reasons other than a room that has
  // ended: a session taken over by the same participant's newer connection, a
  // client that sent too much, a test's forced disconnect, and a plain drop.
  // Only the reason `room_expired` means the room is gone; for any other the
  // room is still there and the connection is brought back.
  for (const [code, reason] of [[1006, ''], [1000, 'session_replaced'], [1008, 'rate_limited'], [4002, 'test_disconnect']] as const) {
    it(`still reconnects after an ordinary dropped connection (${code} ${reason === '' ? 'with no reason' : reason})`, async () => {
      const { chrome: fakeChrome, sendMessageMock, socket } = await resumedWaitingWorker({ boundPlayer: true })
      vi.mocked(fakeChrome.tabs.sendMessage).mockClear()

      socket.simulateClose(code, reason)

      await vi.waitFor(() => {
        const last = broadcasts(sendMessageMock).at(-1)?.state
        if (last?.connection !== 'reconnecting')
          throw new Error('expected a reconnect to be scheduled')
      })
      expect(broadcasts(sendMessageMock).at(-1)!.state!.snapshot).not.toBeNull()
      expect(broadcasts(sendMessageMock).at(-1)!.state!.lastError).toBeNull()
      expect(fakeChrome.alarms.create).toHaveBeenCalled()
      // The page the participant is watching is not told a room has ended.
      expect(notices(fakeChrome)).toEqual([])
    })
  }

  it('leaves the room when a reconnect finds that the room no longer exists', async () => {
    const { sendMessageMock, socket } = await resumedWaitingWorker()

    socket.simulateMessage({ type: 'error', code: 'room_not_found', message: 'That room code is invalid or has expired.' })

    await vi.waitFor(() => {
      const last = broadcasts(sendMessageMock).at(-1)?.state
      if (last?.snapshot !== null)
        throw new Error('expected the room to be left')
    })
    expect(broadcasts(sendMessageMock).at(-1)!.state!.lastError).toMatch(/no longer available/i)
  })

  it('leaves the room, as expired, when the coordinator answers a message with room_expired, and does not reconnect', async () => {
    // A client whose socket survived the room's removal (closeAll could not
    // close it) is answered with this error code instead of a close.
    const { chrome: fakeChrome, sendMessageMock, socket } = await resumedWaitingWorker()
    const alarmsBefore = vi.mocked(fakeChrome.alarms.create).mock.calls.length

    await letThePastBackoffElapse(() => socket.simulateMessage({ type: 'error', code: 'room_expired', message: 'This room has expired.' }))

    const last = broadcasts(sendMessageMock).at(-1)!.state!
    expect(last.snapshot).toBeNull()
    expect(last.lastError).toMatch(/has expired/i)
    expect(last.connection).toBe('disconnected')
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(vi.mocked(fakeChrome.alarms.create).mock.calls.length).toBe(alarmsBefore)
  })

  // A first join to a wrong or expired code has no snapshot yet. It is an
  // ordinary failure to join, shown as the server's own error, not the end of
  // a room this client was in.
  for (const code of ['room_not_found', 'room_expired'] as const) {
    it(`shows a ${code} error as the plain join error while this client is not in a room`, async () => {
      const fake = buildFakeChrome({ sessionState: undefined })
      vi.stubGlobal('chrome', fake.chrome)
      vi.stubGlobal('WebSocket', FakeWebSocket)
      await import('./service-worker.ts')
      const joined = new Promise<RuntimeResponse>((resolve) => {
        fake.messageListener({ type: 'JOIN_ROOM', code: 'ABCDEFGH' }, {} as chrome.runtime.MessageSender, response => resolve(response as RuntimeResponse))
      })
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      const socket = FakeWebSocket.instances[0]!
      socket.simulateOpen()
      await joined

      socket.simulateMessage({ type: 'error', code, message: 'That room code is invalid or has expired.' })

      await vi.waitFor(() => {
        const last = broadcasts(fake.sendMessageMock).at(-1)?.state
        if (last?.lastError !== 'That room code is invalid or has expired.')
          throw new Error('expected the plain error to be published')
      })
      // Nothing was left: the server's own message, and the socket untouched.
      expect(broadcasts(fake.sendMessageMock).at(-1)!.state!.lastError).toBe('That room code is invalid or has expired.')
      expect(socket.readyState).toBe(FakeWebSocket.OPEN)
      expect(vi.mocked(fake.chrome.tabs.sendMessage)).not.toHaveBeenCalled()
    })
  }

  // A worker reports the events it recorded once it is in a room again, so
  // these tests join another room on the same worker and ask for the report.
  // The socket is found by its room code: the worker may have opened others.
  async function eventsReportedAfterJoining(fake: Awaited<ReturnType<typeof resumedWaitingWorker>>, code = 'ZZZZZZZZ') {
    vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
    const joined = new Promise<RuntimeResponse>((resolve) => {
      fake.messageListener({ type: 'JOIN_ROOM', code }, {} as chrome.runtime.MessageSender, response => resolve(response as RuntimeResponse))
    })
    const socketForRoom = () => FakeWebSocket.instances.find(candidate => new URL(candidate.url).searchParams.get('code') === code)
    await vi.waitFor(() => expect(socketForRoom()).toBeDefined(), { timeout: 3_000 })
    const next = socketForRoom()!
    next.simulateOpen()
    await joined
    next.simulateMessage({
      type: 'room_joined',
      participantId: 'participant_friend',
      sessionToken: 'friend-session-token-000000',
      snapshot: buildRoomSnapshot({ code, participants: [{ id: 'participant_friend', name: 'Rana', role: 'member', ready: false, connected: true, mediaMatches: false, latencyMs: null }] }),
    })
    next.simulateMessage({ type: 'diagnostics_requested', reportId: `report_${code}` })

    const response = next.sentMessages.find((message): message is { type: 'diagnostics_response', report: DiagnosticsReport } =>
      (message as { type?: string }).type === 'diagnostics_response')
    return response!.report.events
  }

  it('records that the server ended the room, rather than that this client closed the socket', async () => {
    const fake = await resumedWaitingWorker()
    await letThePastBackoffElapse(() => fake.socket.simulateClose(1000, 'room_expired'))

    const events = await eventsReportedAfterJoining(fake)

    const closes = events.filter(event => event.message === 'socket_closed')
    expect(closes).toHaveLength(1)
    expect(closes[0]!.details).toMatchObject({ intentional: false, serverEndedRoom: true })
  })

  it('records that the room ended, once, when the coordinator closes the socket as expired', async () => {
    const fake = await resumedWaitingWorker()
    await letThePastBackoffElapse(() => fake.socket.simulateClose(1000, 'room_expired'))

    const events = await eventsReportedAfterJoining(fake)

    expect(events.filter(event => event.category === 'connection' && event.message === 'room_gone')).toHaveLength(1)
    // The error path's own record belongs to an error the coordinator sent.
    expect(events.filter(event => event.category === 'error' && event.message === 'room_gone')).toEqual([])
  })

  it('records the code the coordinator gave, and that the room ended, when it answers with an error', async () => {
    const fake = await resumedWaitingWorker()
    fake.socket.simulateMessage({ type: 'error', code: 'room_not_found', message: 'That room code is invalid or has expired.' })
    await vi.waitFor(() => {
      if (broadcasts(fake.sendMessageMock).at(-1)?.state?.snapshot !== null)
        throw new Error('expected the room to be left')
    })

    const events = await eventsReportedAfterJoining(fake)

    expect(events.filter(event => event.category === 'error' && event.message === 'room_gone').map(event => event.details))
      .toEqual([{ code: 'room_not_found' }])
    expect(events.filter(event => event.category === 'connection' && event.message === 'room_gone')).toHaveLength(1)
  })

  it('still records an ordinary dropped connection as neither intentional nor the server ending the room', async () => {
    const fake = await resumedWaitingWorker()
    fake.socket.simulateClose(1006, '')
    await vi.waitFor(() => {
      if (broadcasts(fake.sendMessageMock).at(-1)?.state?.connection !== 'reconnecting')
        throw new Error('expected a reconnect')
    })
    vi.stubGlobal('navigator', { userAgent: 'SyncYourJoy regression test' })
    // The reconnect is the socket this worker opens after the original one.
    await vi.waitFor(() => expect(FakeWebSocket.instances.some(candidate => candidate !== fake.socket)).toBe(true), { timeout: 3_000 })
    const next = FakeWebSocket.instances.find(candidate => candidate !== fake.socket)!
    next.simulateOpen()
    await vi.waitFor(() => {
      if (!next.sentMessages.some(message => (message as { type?: string }).type === 'join_room'))
        throw new Error('expected the reconnect to rejoin')
    })
    next.simulateMessage({ type: 'room_joined', participantId: 'participant_friend', sessionToken: 'friend-session-token-000000', snapshot: pendingPlaceholder() })
    next.simulateMessage({ type: 'diagnostics_requested', reportId: 'report_dropped' })

    const response = next.sentMessages.find((message): message is { type: 'diagnostics_response', report: DiagnosticsReport } =>
      (message as { type?: string }).type === 'diagnostics_response')
    const closes = response!.report.events.filter(event => event.message === 'socket_closed')
    expect(closes[0]!.details).toMatchObject({ intentional: false })
    expect(closes[0]!.details).not.toHaveProperty('serverEndedRoom')
    expect(response!.report.events.filter(event => event.message === 'room_gone')).toEqual([])
  })

  it('leaves a first join alone when its socket is closed as expired before it is in a room', async () => {
    // No snapshot yet: there is no room to have ended, and nothing for the
    // page to be told about. The close is not turned into a "room expired".
    const fake = buildFakeChrome({ sessionState: undefined })
    vi.stubGlobal('chrome', fake.chrome)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    await import('./service-worker.ts')
    const joined = new Promise<RuntimeResponse>((resolve) => {
      fake.messageListener({ type: 'JOIN_ROOM', code: 'ABCDEFGH' }, {} as chrome.runtime.MessageSender, response => resolve(response as RuntimeResponse))
    })
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]!
    socket.simulateOpen()
    await joined

    socket.simulateClose(1000, 'room_expired')
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(broadcasts(fake.sendMessageMock).map(event => event.state?.lastError ?? null).filter(Boolean)).toEqual([])
  })

  // vi.resetModules() abandons the worker a test loaded; it does not stop it.
  // A reconnect it had scheduled (500 to 750 ms out) used to fire during a
  // later test and open a socket in that test's FakeWebSocket.instances, which
  // made the tests that count or index sockets fail about one run in ten.
  // The first test leaves a dropped connection's reconnect pending; the second
  // runs on after it with a WebSocket to catch whatever it opens.
  describe('a reconnect that an earlier test left pending', () => {
    it('is scheduled by a dropped connection, which this test leaves unfinished', async () => {
      const { sendMessageMock, socket } = await resumedWaitingWorker()

      socket.simulateClose(1006, '')

      await vi.waitFor(() => {
        if (broadcasts(sendMessageMock).at(-1)?.state?.connection !== 'reconnecting')
          throw new Error('expected a reconnect to be scheduled')
      })
    })

    it('does not open a socket while a later test runs', async () => {
      vi.stubGlobal('WebSocket', FakeWebSocket)

      // Longer than the longest first backoff (500 ms plus 250 ms of jitter).
      await new Promise(resolve => setTimeout(resolve, 900))

      expect(FakeWebSocket.instances).toEqual([])
    })
  })

  describe('with a player tab bound and the side panel closed', () => {
    // The page is detached from the room first; that it arrives proves the
    // binding was live when the room ended.
    const pageDetached = (fakeChrome: typeof chrome) =>
      vi.mocked(fakeChrome.tabs.sendMessage).mock.calls.some(([tabId, message]) =>
        tabId === 42
        && (message as { type?: string }).type === 'APPLY_ROOM_STATE'
        && (message as { state: { snapshot: unknown } }).state.snapshot === null)

    async function workerWithoutSidePanel() {
      const worker = await resumedWaitingWorker({ boundPlayer: true })
      // No extension view is open to receive runtime messages.
      worker.sendMessageMock.mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'))
      vi.mocked(worker.chrome.tabs.sendMessage).mockClear()
      // What the page is sent, in order. The worker hands the page its live
      // state object, so whether the room was already gone is read at the
      // moment of the call, not afterwards.
      const pageMessages: Array<{ type: string, roomWasGone: boolean | null }> = []
      vi.mocked(worker.chrome.tabs.sendMessage).mockImplementation((async (_tabId: number, message: unknown) => {
        const { type, state: sent } = message as { type: string, state?: { snapshot: unknown } }
        pageMessages.push({ type, roomWasGone: type === 'APPLY_ROOM_STATE' ? sent?.snapshot === null : null })
        return { media: { service: 'html5', canonicalId: 'html5:own-video', title: 'Own video', durationSeconds: 60 }, diagnostics: null, sample: null }
      }) as unknown as typeof chrome.tabs.sendMessage)
      return { ...worker, pageMessages }
    }

    // The page chooses what to show from whether it still has a room when the
    // notice reaches it, so the notice has to come after the page was
    // detached. A notice that arrives first is taken for an ordinary one and
    // is hidden by the detach that follows.
    const noticeFollowsDetach = (pageMessages: Array<{ type: string, roomWasGone: boolean | null }>) => {
      const detached = pageMessages.findIndex(message => message.type === 'APPLY_ROOM_STATE' && message.roomWasGone === true)
      const notice = pageMessages.findIndex(message => message.type === 'SHOW_NOTICE')
      return detached !== -1 && notice !== -1 && detached < notice
    }

    it('tells the page the player is bound to why the room expired, once', async () => {
      const { chrome: fakeChrome, socket, pageMessages } = await workerWithoutSidePanel()

      socket.simulateClose(1000, 'room_expired')

      await vi.waitFor(() => {
        if (!pageDetached(fakeChrome))
          throw new Error('expected the page to be detached from the room')
      })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(notices(fakeChrome)).toEqual([
        [42, { type: 'SHOW_NOTICE', message: expect.stringMatching(/has expired/i), roomEnded: true }, { documentId: 'document_waiting' }],
      ])
      expect(noticeFollowsDetach(pageMessages)).toBe(true)
    })

    it('does the same when the room is reported gone by an error', async () => {
      const { chrome: fakeChrome, socket, pageMessages } = await workerWithoutSidePanel()

      socket.simulateMessage({ type: 'error', code: 'room_not_found', message: 'That room code is invalid or has expired.' })

      await vi.waitFor(() => {
        if (!pageDetached(fakeChrome))
          throw new Error('expected the page to be detached from the room')
      })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(notices(fakeChrome)).toEqual([
        [42, { type: 'SHOW_NOTICE', message: expect.stringMatching(/no longer available/i), roomEnded: true }, { documentId: 'document_waiting' }],
      ])
      expect(noticeFollowsDetach(pageMessages)).toBe(true)
    })

    it('tells the page the player is bound to that the host declined the request, once', async () => {
      const { chrome: fakeChrome, socket, pageMessages } = await workerWithoutSidePanel()

      socket.simulateMessage({
        type: 'command_rejected',
        actionId: 'action_join',
        code: 'join_denied',
        message: 'The host declined to let you join this room.',
        snapshot: null,
      })

      await vi.waitFor(() => {
        if (!pageDetached(fakeChrome))
          throw new Error('expected the page to be detached from the room')
      })
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(notices(fakeChrome)).toEqual([
        [42, { type: 'SHOW_NOTICE', message: 'The host declined to let you join this room.', roomEnded: true }, { documentId: 'document_waiting' }],
      ])
      expect(noticeFollowsDetach(pageMessages)).toBe(true)
    })

    it('still ends the room and records why when no player tab is bound', async () => {
      const { chrome: fakeChrome, sendMessageMock, socket } = await resumedWaitingWorker()
      vi.mocked(fakeChrome.tabs.sendMessage).mockClear()

      socket.simulateClose(1000, 'room_expired')

      await vi.waitFor(() => {
        if (broadcasts(sendMessageMock).at(-1)?.state?.snapshot !== null)
          throw new Error('expected the room to be left')
      })
      expect(broadcasts(sendMessageMock).at(-1)!.state!.lastError).toMatch(/has expired/i)
      expect(notices(fakeChrome)).toEqual([])
    })
  })
})
