import type { ClientMessage, ControlKind, ServerMessage } from '@syncyourjoy/protocol'
import type { ExtensionState, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { mediaMatches, safeJsonParse } from '@syncyourjoy/protocol'
import { ClockSynchronizer, expectedPosition } from '@syncyourjoy/sync-engine'

declare const __ROOM_SERVER_URL__: string

const ROOM_SERVER_URL = __ROOM_SERVER_URL__
const SESSION_STATE_KEY = 'syncYourJoySessionState'
const DISPLAY_NAME_KEY = 'syncYourJoyDisplayName'

let state: ExtensionState = {
  connection: 'disconnected',
  participantId: createId('participant'),
  inviteToken: null,
  snapshot: null,
  serverOffsetMs: 0,
  clockUncertaintyMs: 99_999,
  lastError: null,
  displayName: 'Movie friend',
  currentMedia: null,
  lastPlayerSample: null,
}

let socket: WebSocket | null = null
let connectionPromise: Promise<void> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempts = 0
let intentionallyClosed = false
let clock = new ClockSynchronizer()

const initialized = initialize()

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.runtime.onStartup.addListener(() => {
  void initialized.then(() => reconnectIfNeeded())
})

chrome.runtime.onMessage.addListener((request: RuntimeRequest | RuntimeEvent, sender, sendResponse) => {
  if (!request || typeof request.type !== 'string' || request.type === 'ROOM_STATE_UPDATED' || request.type === 'APPLY_ROOM_STATE' || request.type === 'PAUSE_LOCAL' || request.type === 'SHOW_NOTICE')
    return false

  void initialized
    .then(() => handleRuntimeRequest(request, sender))
    .then(sendResponse)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unexpected extension error.'
      state.lastError = message
      void publishState()
      sendResponse({ ok: false, state, error: message } satisfies RuntimeResponse)
    })
  return true
})

async function initialize(): Promise<void> {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get(SESSION_STATE_KEY),
    chrome.storage.local.get(DISPLAY_NAME_KEY),
  ])

  const stored = sessionData[SESSION_STATE_KEY] as Partial<ExtensionState> | undefined
  const displayName = localData[DISPLAY_NAME_KEY]
  state = {
    ...state,
    ...stored,
    connection: stored?.snapshot ? 'reconnecting' : 'disconnected',
    displayName: typeof displayName === 'string' && displayName.trim() ? displayName : state.displayName,
    lastError: null,
  }

  if (state.snapshot)
    await reconnectIfNeeded()
}

async function handleRuntimeRequest(request: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  switch (request.type) {
    case 'GET_STATE':
      return success()

    case 'SET_NAME': {
      const name = request.name.trim().slice(0, 40)
      if (!name)
        return failure('Enter a display name.')
      state.displayName = name
      await chrome.storage.local.set({ [DISPLAY_NAME_KEY]: name })
      await publishState()
      return success()
    }

    case 'MEDIA_DETECTED':
      state.currentMedia = request.media
      if (state.snapshot && !mediaMatches(state.snapshot.media, request.media))
        sendToServer({ type: 'set_ready', ready: false, media: request.media })
      await publishState()
      return success()

    case 'PLAYER_STATUS':
      state.lastPlayerSample = request.sample
      sendToServer({ type: 'player_status', sample: request.sample })
      await persistState()
      return success()

    case 'CREATE_ROOM':
      if (!state.currentMedia)
        return failure('Open a supported video before creating a room.')
      const newRoomCode = createRoomCode()
      await startFreshConnection(newRoomCode)
      sendToServer({
        type: 'create_room',
        protocolVersion: 1,
        participantId: state.participantId,
        name: state.displayName,
        code: newRoomCode,
        media: state.currentMedia,
      })
      return success()

    case 'JOIN_ROOM': {
      const code = request.code.trim().toUpperCase()
      if (!/^[A-Z0-9]{8}$/.test(code))
        return failure('Enter the eight-character room code.')
      await startFreshConnection(code)
      sendToServer({
        type: 'join_room',
        protocolVersion: 1,
        participantId: state.participantId,
        name: state.displayName,
        code,
        media: state.currentMedia,
      })
      return success()
    }

    case 'LEAVE_ROOM':
      leaveRoom()
      await publishState()
      return success()

    case 'SET_READY': {
      const me = state.snapshot?.participants.find(participant => participant.id === state.participantId)
      if (!state.snapshot || state.connection !== 'connected' || !me?.connected)
        return failure('Reconnect to the room before changing readiness.')
      if (!state.currentMedia || !mediaMatches(state.snapshot.media, state.currentMedia))
        return failure('Open the matching video before getting ready.')
      sendToServer({ type: 'set_ready', ready: request.ready, media: state.currentMedia })
      return success()
    }

    case 'CONTROL':
      return sendControl(request.kind, request.positionSeconds)

    case 'PLAYER_INTENT': {
      if (!isController()) {
        await sendToActiveTabs({ type: 'APPLY_ROOM_STATE', state })
        await sendToActiveTabs({ type: 'SHOW_NOTICE', message: 'The room controller owns playback.' })
        return failure('The room controller owns playback.')
      }
      return sendControl(request.kind, request.positionSeconds)
    }

    case 'TRANSFER_CONTROL': {
      const snapshot = state.snapshot
      if (!snapshot)
        return failure('Join a room first.')
      sendToServer({
        type: 'transfer_control',
        participantId: request.participantId,
        leaseEpoch: snapshot.controller.leaseEpoch,
      })
      return success()
    }

    case 'OPEN_PANEL':
      if (sender.tab?.id !== undefined) {
        try {
          await chrome.sidePanel.open({ tabId: sender.tab.id })
        }
        catch {
          await sendToActiveTabs({ type: 'SHOW_NOTICE', message: 'Open SyncYourJoy from Chrome’s extensions button.' })
        }
      }
      return success()
  }
}

async function sendControl(kind: ControlKind, explicitPosition?: number): Promise<RuntimeResponse> {
  const snapshot = state.snapshot
  if (!snapshot)
    return failure('Join a room first.')
  if (!isController())
    return failure('The room controller owns playback.')

  const estimatedNow = Date.now() + state.serverOffsetMs
  const fallbackPosition = expectedPosition(snapshot.playback, estimatedNow)
  const positionSeconds = explicitPosition ?? state.lastPlayerSample?.positionSeconds ?? fallbackPosition
  if (kind === 'pause')
    void sendToActiveTabs({ type: 'PAUSE_LOCAL' })
  sendToServer({
    type: 'control',
    actionId: createId('action'),
    basedOnRevision: snapshot.revision,
    leaseEpoch: snapshot.controller.leaseEpoch,
    kind,
    positionSeconds: Math.max(0, positionSeconds),
  })
  return success()
}

async function startFreshConnection(roomCode: string): Promise<void> {
  intentionallyClosed = true
  if (reconnectTimer)
    clearTimeout(reconnectTimer)
  reconnectTimer = null
  socket?.close(1000, 'new_room')
  socket = null
  connectionPromise = null
  state.snapshot = null
  state.inviteToken = null
  state.lastError = null
  intentionallyClosed = false
  await connect(roomCode)
}

async function connect(roomCode: string): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN)
    return
  if (connectionPromise)
    return connectionPromise

  connectionPromise = new Promise<void>((resolve, reject) => {
    clock = new ClockSynchronizer()
    const socketUrl = new URL(ROOM_SERVER_URL)
    socketUrl.searchParams.set('code', roomCode)
    const nextSocket = new WebSocket(socketUrl)
    socket = nextSocket

    nextSocket.addEventListener('open', () => {
      connectionPromise = null
      reconnectAttempts = 0
      startPingLoop()
      resolve()
    }, { once: true })

    nextSocket.addEventListener('message', event => handleServerMessage(String(event.data)))

    nextSocket.addEventListener('error', () => {
      if (connectionPromise) {
        connectionPromise = null
        reject(new Error('Cannot reach the SyncYourJoy room service. Check your connection and try again.'))
      }
    }, { once: true })

    nextSocket.addEventListener('close', () => {
      stopPingLoop()
      connectionPromise = null
      if (socket === nextSocket)
        socket = null

      if (!intentionallyClosed && state.snapshot) {
        state.connection = 'reconnecting'
        void publishState()
        scheduleReconnect()
      }
    })
  })

  return connectionPromise
}

async function reconnectIfNeeded(): Promise<void> {
  if (!state.snapshot || socket?.readyState === WebSocket.OPEN)
    return

  try {
    await connect(state.snapshot.code)
    sendToServer({
      type: 'join_room',
      protocolVersion: 1,
      participantId: state.participantId,
      name: state.displayName,
      code: state.snapshot.code,
      media: state.currentMedia,
    })
  }
  catch {
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer)
    return
  const delayMs = Math.min(15_000, 500 * 2 ** reconnectAttempts) + Math.round(Math.random() * 250)
  reconnectAttempts += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void reconnectIfNeeded()
  }, delayMs)
}

function handleServerMessage(raw: string): void {
  const message = safeJsonParse(raw) as ServerMessage | null
  if (!message || typeof message !== 'object' || !('type' in message))
    return

  if (message.type === 'room_joined') {
    state.connection = 'connected'
    state.participantId = message.participantId
    state.inviteToken = message.inviteToken
    state.snapshot = message.snapshot
    state.lastError = null
    void publishState()
    return
  }

  if (message.type === 'room_snapshot') {
    if (!state.snapshot || message.snapshot.revision >= state.snapshot.revision)
      state.snapshot = message.snapshot
    state.connection = 'connected'
    state.lastError = null
    void publishState()
    return
  }

  if (message.type === 'command_rejected') {
    if (message.snapshot)
      state.snapshot = message.snapshot
    state.lastError = message.message
    void publishState()
    void sendToActiveTabs({ type: 'SHOW_NOTICE', message: message.message })
    return
  }

  if (message.type === 'error') {
    state.lastError = message.message
    void publishState()
    return
  }

  if (message.type === 'pong') {
    const receivedAtLocalMs = Date.now()
    const estimate = clock.addSample(message.sentAtLocalMs, receivedAtLocalMs, message.serverTimeMs)
    state.serverOffsetMs = estimate.offsetMs
    state.clockUncertaintyMs = Number.isFinite(estimate.uncertaintyMs) ? estimate.uncertaintyMs : 99_999
    sendToServer({ type: 'client_metrics', roundTripMs: receivedAtLocalMs - message.sentAtLocalMs })
    void persistState()
  }
}

function startPingLoop(): void {
  stopPingLoop()
  const ping = () => sendToServer({ type: 'ping', id: createId('ping'), sentAtLocalMs: Date.now() })
  ping()
  pingTimer = setInterval(ping, 5_000)
}

function stopPingLoop(): void {
  if (pingTimer)
    clearInterval(pingTimer)
  pingTimer = null
}

function sendToServer(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message))
}

function leaveRoom(): void {
  intentionallyClosed = true
  if (reconnectTimer)
    clearTimeout(reconnectTimer)
  reconnectTimer = null
  stopPingLoop()
  socket?.close(1000, 'left_room')
  socket = null
  state.connection = 'disconnected'
  state.snapshot = null
  state.inviteToken = null
  state.lastError = null
  reconnectAttempts = 0
  setTimeout(() => {
    intentionallyClosed = false
  }, 0)
}

function isController(): boolean {
  return state.snapshot?.controller.participantId === state.participantId
}

async function publishState(): Promise<void> {
  await persistState()
  const event: RuntimeEvent = { type: 'ROOM_STATE_UPDATED', state }
  void chrome.runtime.sendMessage(event).catch(() => undefined)
  await sendToActiveTabs({ type: 'APPLY_ROOM_STATE', state })
}

async function sendToActiveTabs(message: RuntimeEvent): Promise<void> {
  const tabs = await chrome.tabs.query({})
  await Promise.all(tabs.map(async (tab) => {
    if (tab.id === undefined)
      return
    try {
      await chrome.tabs.sendMessage(tab.id, message)
    }
    catch {
      // The tab does not host a supported player.
    }
  }))
}

async function persistState(): Promise<void> {
  await chrome.storage.session.set({ [SESSION_STATE_KEY]: state })
}

function success(): RuntimeResponse {
  return { ok: true, state }
}

function failure(error: string): RuntimeResponse {
  state.lastError = error
  void publishState()
  return { ok: false, state, error }
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

function createRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('')
}
