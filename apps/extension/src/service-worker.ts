import type { ClientMessage, ControlKind, ServerMessage } from '@syncyourjoy/protocol'
import type { ContentRequest, ExtensionState, PlayerContext, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { mediaMatches, normalizePageUrl, safeJsonParse } from '@syncyourjoy/protocol'
import { ClockSynchronizer, expectedPosition } from '@syncyourjoy/sync-engine'
import { shouldAcceptPlayerContext } from './player-tab.ts'
import { isLikelyAdvertisingUrl } from './site-adapter.ts'
import { bindMediaToSharedPage } from './media-fingerprint.ts'

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
  playerTabId: null,
  playerFrameId: null,
  playerAreaPixels: 0,
  currentMedia: null,
  lastPlayerSample: null,
  lastOpenedNavigationRevision: 0,
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

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.playerTabId !== tabId)
    return
  clearPlayerTab()
  if (state.snapshot)
    sendToServer({ type: 'set_ready', ready: false, media: null })
  void publishState()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (state.playerTabId !== tabId)
    return
  if (changeInfo.status === 'complete' && state.snapshot?.navigation && state.playerFrameId === null) {
    void sendToTab(tabId, { type: 'APPLY_ROOM_STATE', state }, 0)
    return
  }
  if (changeInfo.status !== 'loading')
    return
  state.playerFrameId = null
  state.playerAreaPixels = 0
  state.currentMedia = null
  state.lastPlayerSample = null
  if (state.snapshot)
    sendToServer({ type: 'set_ready', ready: false, media: null })
  void publishState()
})

chrome.runtime.onMessage.addListener((request: RuntimeRequest | RuntimeEvent, sender, sendResponse) => {
  if (!request || typeof request.type !== 'string' || request.type === 'ROOM_STATE_UPDATED' || request.type === 'APPLY_ROOM_STATE' || request.type === 'PAUSE_LOCAL' || request.type === 'FORCE_SYNC' || request.type === 'SHOW_NOTICE')
    return false

  if (request.type === 'OPEN_PANEL' && sender.tab?.id !== undefined) {
    void chrome.sidePanel.open({ tabId: sender.tab.id })
      .then(() => sendResponse(success()))
      .catch(() => {
        void sendToPlayerTab({ type: 'SHOW_NOTICE', message: 'Open SyncYourJoy from Chrome’s extensions button.' })
        sendResponse(success())
      })
    return true
  }

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

  if (state.snapshot) {
    await refreshBoundPlayerTab()
    await reconnectIfNeeded()
  }
}

async function handleRuntimeRequest(request: RuntimeRequest, sender: chrome.runtime.MessageSender): Promise<RuntimeResponse> {
  switch (request.type) {
    case 'GET_STATE':
      if (!state.snapshot && sender.tab?.id === undefined)
        await selectActivePlayerTab()
      if (sender.tab?.id !== undefined && !isBoundPlayerSender(sender) && !isNavigationShellSender(sender))
        return success(detachedState())
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
      if (isLikelyAdvertisingUrl(sender.url) || !acceptMediaSender(sender, request.areaPixels))
        return success()
      if (sender.tab?.id !== undefined && sender.frameId !== undefined)
        await bindPlayerContext(sender.tab.id, sender.frameId, request.areaPixels)
      state.currentMedia = bindMediaToSharedPage(request.media, state.snapshot?.navigation?.url)
      if (state.snapshot) {
        const me = state.snapshot.participants.find(participant => participant.id === state.participantId)
        const matches = mediaMatches(state.snapshot.media, state.currentMedia)
        if (!me?.ready || me.mediaMatches !== matches)
          sendToServer({ type: 'set_ready', ready: false, media: state.currentMedia })
      }
      await publishState()
      return success()

    case 'MEDIA_LOST':
      if (!isBoundPlayerSender(sender))
        return success()
      state.currentMedia = null
      state.lastPlayerSample = null
      if (state.snapshot)
        sendToServer({ type: 'set_ready', ready: false, media: null })
      await publishState()
      return success()

    case 'PLAYER_STATUS':
      if (!isBoundPlayerSender(sender))
        return success()
      state.lastPlayerSample = request.sample
      sendToServer({ type: 'player_status', sample: request.sample })
      await persistState()
      return success()

    case 'CREATE_ROOM':
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
      if (!sendToServer({ type: 'set_ready', ready: request.ready, media: state.currentMedia }))
        return failure('The room connection was interrupted. Reconnecting now.')
      return success()
    }

    case 'RECHECK_MEDIA': {
      const found = await selectActivePlayerTab()
      if (!state.snapshot)
        return failure('Join a room before rechecking the video.')
      if (!found || !state.currentMedia)
        return failure('No supported video was found in the active tab.')
      if (!sendToServer({ type: 'set_ready', ready: false, media: state.currentMedia }))
        return failure('The room connection was interrupted. Reconnecting now.')
      await publishState()
      return success()
    }

    case 'SYNC_NOW':
      if (!state.snapshot || state.playerTabId === null || state.playerFrameId === null || !state.currentMedia)
        return failure('The shared player is not ready yet.')
      await sendToPlayerTab({ type: 'FORCE_SYNC' })
      return success()

    case 'OPEN_LINK': {
      const snapshot = state.snapshot
      if (!snapshot)
        return failure('Join a room before opening a link.')
      if (!isController())
        return failure('Only the controller can open a link for everyone.')
      const normalizedUrl = normalizePageUrl(request.url)
      if (!normalizedUrl)
        return failure('Enter a valid video page link.')
      if (!sendToServer({
        type: 'open_link',
        actionId: createId('action'),
        basedOnRevision: snapshot.revision,
        leaseEpoch: snapshot.controller.leaseEpoch,
        url: normalizedUrl,
      }))
        return failure('The room connection was interrupted. Reconnecting now.')
      return success()
    }

    case 'CONTROL':
      return sendControl(request.kind, request.positionSeconds)

    case 'PLAYER_INTENT': {
      if (!isBoundPlayerSender(sender))
        return success()
      if (!isController()) {
        await sendToPlayerTab({ type: 'APPLY_ROOM_STATE', state })
        await sendToPlayerTab({ type: 'SHOW_NOTICE', message: 'The room controller owns playback.' })
        return failure('The room controller owns playback.')
      }
      return sendControl(request.kind, request.positionSeconds)
    }

    case 'TRANSFER_CONTROL': {
      const snapshot = state.snapshot
      if (!snapshot)
        return failure('Join a room first.')
      if (!sendToServer({
        type: 'transfer_control',
        participantId: request.participantId,
        leaseEpoch: snapshot.controller.leaseEpoch,
      }))
        return failure('The room connection was interrupted. Reconnecting now.')
      return success()
    }

    case 'OPEN_PANEL':
      return success()
  }
}

async function sendControl(kind: ControlKind, explicitPosition?: number): Promise<RuntimeResponse> {
  const snapshot = state.snapshot
  if (!snapshot)
    return failure('Join a room first.')
  if (!isController())
    return failure('The room controller owns playback.')

  if (kind === 'play') {
    const connected = snapshot.participants.filter(participant => participant.connected)
    if (!connected.every(participant => participant.ready && participant.mediaMatches)) {
      void sendToPlayerTab({ type: 'PAUSE_LOCAL' })
      return failure('Everyone must be ready before playback starts.')
    }
  }

  const estimatedNow = Date.now() + state.serverOffsetMs
  const fallbackPosition = expectedPosition(snapshot.playback, estimatedNow)
  const positionSeconds = explicitPosition ?? state.lastPlayerSample?.positionSeconds ?? fallbackPosition
  if (kind === 'pause')
    void sendToPlayerTab({ type: 'PAUSE_LOCAL' })
  const sent = sendToServer({
    type: 'control',
    actionId: createId('action'),
    basedOnRevision: snapshot.revision,
    leaseEpoch: snapshot.controller.leaseEpoch,
    kind,
    positionSeconds: Math.max(0, positionSeconds),
  })
  if (!sent)
    return failure('The room connection was interrupted. Reconnecting now.')
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
  state.lastOpenedNavigationRevision = 0
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
    void applySharedNavigation(message.snapshot)
    void publishState()
    return
  }

  if (message.type === 'room_snapshot') {
    if (!state.snapshot || message.snapshot.revision >= state.snapshot.revision)
      state.snapshot = message.snapshot
    state.connection = 'connected'
    state.lastError = null
    void applySharedNavigation(message.snapshot)
    void publishState()
    return
  }

  if (message.type === 'command_rejected') {
    if (message.snapshot)
      state.snapshot = message.snapshot
    state.lastError = message.message
    void publishState()
    void sendToPlayerTab({ type: 'SHOW_NOTICE', message: message.message })
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

function sendToServer(message: ClientMessage): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message))
    return true
  }
  return false
}

function leaveRoom(): void {
  const previousPlayerTabId = state.playerTabId
  const previousPlayerFrameId = state.playerFrameId
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
  clearPlayerTab()
  state.lastError = null
  state.lastOpenedNavigationRevision = 0
  reconnectAttempts = 0
  setTimeout(() => {
    intentionallyClosed = false
  }, 0)
  if (previousPlayerTabId !== null && previousPlayerFrameId !== null)
    void sendToTab(previousPlayerTabId, { type: 'APPLY_ROOM_STATE', state }, previousPlayerFrameId)
}

function acceptMediaSender(sender: chrome.runtime.MessageSender, areaPixels: number): boolean {
  const senderTabId = sender.tab?.id
  const senderFrameId = sender.frameId
  if (senderTabId === undefined || senderFrameId === undefined)
    return false
  const me = state.snapshot?.participants.find(participant => participant.id === state.participantId)
  return shouldAcceptPlayerContext({
    hasRoom: state.snapshot !== null,
    boundTabId: state.playerTabId,
    boundFrameId: state.playerFrameId,
    boundAreaPixels: state.playerAreaPixels,
    participantReady: me?.ready ?? false,
    senderTabId,
    senderFrameId,
    senderIsActive: sender.tab?.active === true,
    senderAreaPixels: Math.max(0, areaPixels),
  })
}

function isBoundPlayerSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.tab?.id !== undefined
    && sender.frameId !== undefined
    && sender.tab.id === state.playerTabId
    && sender.frameId === state.playerFrameId
}

function isNavigationShellSender(sender: chrome.runtime.MessageSender): boolean {
  return state.snapshot?.navigation != null
    && sender.tab?.id !== undefined
    && sender.frameId === 0
    && sender.tab.id === state.playerTabId
    && state.playerFrameId === null
}

async function selectActivePlayerTab(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) {
    clearPlayerTab()
    return false
  }

  if (state.playerTabId === tab.id && state.currentMedia)
    return true

  if (state.snapshot)
    sendToServer({ type: 'set_ready', ready: false, media: null })
  await unbindPlayerContext()
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'REPORT_PLAYER_CONTEXT' } satisfies ContentRequest)
  }
  catch {
    return false
  }
  await new Promise(resolve => setTimeout(resolve, 120))
  return state.playerTabId === tab.id && state.currentMedia !== null
}

async function refreshBoundPlayerTab(): Promise<boolean> {
  if (state.playerTabId === null || state.playerFrameId === null) {
    clearPlayerTab()
    return false
  }
  try {
    const context = await chrome.tabs.sendMessage(
      state.playerTabId,
      { type: 'GET_PLAYER_CONTEXT' } satisfies ContentRequest,
      { frameId: state.playerFrameId },
    ) as PlayerContext
    if (!context?.media) {
      clearPlayerTab()
      return false
    }
    state.currentMedia = context.media
    state.lastPlayerSample = context.sample
    return true
  }
  catch {
    clearPlayerTab()
    return false
  }
}

async function applySharedNavigation(snapshot: NonNullable<ExtensionState['snapshot']>): Promise<void> {
  const navigation = snapshot.navigation
  if (!navigation || navigation.revision <= state.lastOpenedNavigationRevision)
    return

  state.lastOpenedNavigationRevision = navigation.revision
  await persistState()
  const estimatedServerNowMs = Date.now() + state.serverOffsetMs
  const delayMs = Math.max(0, navigation.effectiveAtServerMs - estimatedServerNowMs)
  setTimeout(() => {
    if (state.snapshot?.navigation?.revision !== navigation.revision)
      return
    void chrome.tabs.create({ url: navigation.url, active: true }).then((tab) => {
      if (tab.id === undefined)
        throw new Error('Chrome did not return the opened tab.')
      void bindPlayerContext(tab.id, null, 0)
      state.currentMedia = null
      state.lastPlayerSample = null
      state.lastError = null
      void publishState()
    }).catch(() => {
      state.lastError = 'Chrome could not open the shared video link.'
      void publishState()
    })
  }, Math.min(delayMs, 2_000))
}

function clearPlayerTab(): void {
  state.playerTabId = null
  state.playerFrameId = null
  state.playerAreaPixels = 0
  state.currentMedia = null
  state.lastPlayerSample = null
}

async function bindPlayerContext(tabId: number, frameId: number | null, areaPixels: number): Promise<void> {
  const previousTabId = state.playerTabId
  const previousFrameId = state.playerFrameId
  state.playerTabId = tabId
  state.playerFrameId = frameId
  state.playerAreaPixels = Math.max(0, areaPixels)
  if (previousTabId !== null && previousFrameId !== null && (previousTabId !== tabId || previousFrameId !== frameId))
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, previousFrameId)
  else if (previousTabId === tabId && previousFrameId === null && frameId !== null && frameId !== 0)
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, 0)
}

async function unbindPlayerContext(): Promise<void> {
  const previousTabId = state.playerTabId
  const previousFrameId = state.playerFrameId
  clearPlayerTab()
  if (previousTabId !== null && previousFrameId !== null)
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, previousFrameId)
}

function isController(): boolean {
  return state.snapshot?.controller.participantId === state.participantId
}

async function publishState(): Promise<void> {
  await persistState()
  const event: RuntimeEvent = { type: 'ROOM_STATE_UPDATED', state }
  void chrome.runtime.sendMessage(event).catch(() => undefined)
  await sendToPlayerTab({ type: 'APPLY_ROOM_STATE', state })
}

async function sendToPlayerTab(message: RuntimeEvent): Promise<void> {
  if (state.playerTabId !== null && state.playerFrameId !== null)
    await sendToTab(state.playerTabId, message, state.playerFrameId)
}

async function sendToTab(tabId: number, message: RuntimeEvent, frameId?: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message, frameId === undefined ? undefined : { frameId })
  }
  catch {
    // The bound tab is navigating or no longer hosts a supported player.
  }
}

async function persistState(): Promise<void> {
  await chrome.storage.session.set({ [SESSION_STATE_KEY]: state })
}

function success(responseState: ExtensionState = state): RuntimeResponse {
  return { ok: true, state: responseState }
}

function detachedState(): ExtensionState {
  return {
    ...state,
    connection: 'disconnected',
    snapshot: null,
    playerTabId: null,
    playerFrameId: null,
    playerAreaPixels: 0,
    currentMedia: null,
    lastPlayerSample: null,
    lastError: null,
  }
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
