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
import type { RoomSnapshot } from '@syncyourjoy/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SESSION_STATE_KEY = 'syncYourJoySessionState'
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

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event)
  }
}

interface FakeChromeOptions {
  sessionState?: unknown
  sessionSet?: (values: Record<string, unknown>) => Promise<void> | void
}

interface FakeChrome {
  chrome: typeof chrome
  messageListener: (request: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => boolean
  sessionSetMock: ReturnType<typeof vi.fn>
  sendMessageMock: ReturnType<typeof vi.fn>
}

/** Builds a fake `chrome` global exposing only what service-worker.ts
 * touches at import time and during the scenarios below. */
function buildFakeChrome(options: FakeChromeOptions = {}): FakeChrome {
  let messageListener: FakeChrome['messageListener'] = () => false
  const sessionSetMock = vi.fn(async (values: Record<string, unknown>) => {
    await options.sessionSet?.(values)
  })
  const sendMessageMock = vi.fn(async () => undefined)

  const fakeChrome = {
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
        get: vi.fn(async () => ({ [SESSION_STATE_KEY]: options.sessionState })),
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
      onUpdated: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => {
        throw new Error('no such tab in this test')
      }),
      query: vi.fn(async () => []),
      get: vi.fn(async () => {
        throw new Error('no such tab in this test')
      }),
    },
  }

  return {
    chrome: fakeChrome as unknown as typeof chrome,
    get messageListener() {
      return messageListener
    },
    sessionSetMock,
    sendMessageMock,
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

beforeEach(() => {
  vi.resetModules()
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('service worker restart resume', () => {
  it('restores the persisted room from chrome.storage.session and resumes the websocket via the normal reconnect path', async () => {
    const persistedSnapshot = buildRoomSnapshot()
    const { chrome: fakeChrome, sessionSetMock, sendMessageMock } = buildFakeChrome({
      sessionState: {
        connection: 'connected',
        participantId: 'participant_resumed',
        inviteToken: 'invite_resumed',
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
      inviteToken: 'invite_resumed',
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
