import type { ClientMessage, ControlKind, DiagnosticEvent, DiagnosticsReport, DiagnosticValue, MediaFingerprint, ServerMessage } from '@syncyourjoy/protocol'
import type { ContentRequest, ExtensionState, PlayerContext, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { generateRoomCode, mediaMatches, normalizeMediaPageUrl, parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { ClockSynchronizer, expectedPosition } from '@syncyourjoy/sync-engine'
import { PLAYER_CONTEXT_STALE_MS, shouldAcceptPlayerContext, shouldReusePlayerTabForNavigation } from './player-tab.ts'
import { isLikelyAdvertisingUrl } from './site-adapter.ts'
import { bindMediaToSharedPage } from './media-fingerprint.ts'
import { resolveControlPosition } from './control-position.ts'
import { shouldConfirmMediaMismatch } from './readiness-state.ts'
import { connectionQuality } from './connection-quality.ts'
import { browserApi } from './browser-api.ts'
import { fitDiagnosticsReport } from './diagnostics-budget.ts'

declare const __ROOM_SERVER_URL__: string

const ROOM_SERVER_URL = __ROOM_SERVER_URL__
const SESSION_STATE_KEY = 'syncYourJoySessionState'
const PLAYER_BINDING_KEY = 'syncYourJoyPlayerBinding'
const DISPLAY_NAME_KEY = 'syncYourJoyDisplayName'
const DIAGNOSTIC_EVENT_LIMIT = 100
// A participant may be waking a suspended service worker or a throttled tab.
// Give the room-wide report enough time to collect every response without
// making the normal playback path wait for diagnostics.
const DIAGNOSTIC_COLLECTION_TIMEOUT_MS = 8_000
// A bare setTimeout does not survive MV3 service-worker suspension. This
// alarm is a fallback that wakes the service worker to retry a reconnect
// even if it was suspended while the setTimeout backoff was pending.
const RECONNECT_ALARM_NAME = 'syncYourJoyReconnect'

interface DiagnosticCollection {
  reportId: string
  expectedParticipantIds: Set<string>
  responses: Map<string, { participantId: string; participantName: string; report: DiagnosticsReport }>
  timer: ReturnType<typeof setTimeout>
  retryTimers: Array<ReturnType<typeof setTimeout>>
  attempts: number
}

interface PlayerBinding {
  id: string
  documentId: string | null
}

let state: ExtensionState = {
  connection: 'disconnected',
  participantId: createId('participant'),
  sessionToken: null,
  snapshot: null,
  serverOffsetMs: 0,
  clockUncertaintyMs: 99_999,
  lastError: null,
  displayName: 'Movie friend',
  playerTabId: null,
  playerFrameId: null,
  playerAreaPixels: 0,
  playerLastSeenAtMs: 0,
  currentMedia: null,
  playerDiagnostics: null,
  lastPlayerSample: null,
  lastOpenedNavigationRevision: 0,
  connectionQuality: 'offline',
  roundTripMs: null,
  lastPongAtMs: 0,
}

let socket: WebSocket | null = null
let connectionPromise: Promise<void> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempts = 0
let intentionallyClosed = false
let clock = new ClockSynchronizer()
const diagnosticEvents: DiagnosticEvent[] = []
let diagnosticCollection: DiagnosticCollection | null = null
// This identity is deliberately persisted separately from ExtensionState so
// it is not sent to extension views or copied into room-state events. Content
// scripts receive it only through a successful MEDIA_DETECTED response.
let playerBinding: PlayerBinding | null = null
let pendingMediaMismatchKey: string | null = null
let pendingMediaMismatchObservedAtMs: number | null = null
// In-memory only: tracks a navigation revision whose deferred tab-open/reuse
// side effect is currently scheduled but has not completed yet. This must
// NOT be persisted -- state.lastOpenedNavigationRevision is the durable
// "handled" marker, and it is only advanced once the side effect actually
// runs, so a service-worker restart during the deferred delay causes the
// navigation to be retried rather than silently dropped.
let pendingNavigationRevision: number | null = null
// A main-frame reload reuses frameId 0. Track the accepted context itself so
// a delayed delivery failure from the previous document cannot retire it.
let playerContextGeneration = 0

const initialized = initialize()

chrome.runtime.onInstalled.addListener(() => {
  if (browserApi.sidePanel)
    void browserApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
})

chrome.runtime.onStartup.addListener(() => {
  void initialized.then(() => reconnectIfNeeded())
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM_NAME)
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
  playerContextGeneration += 1
  playerBinding = null
  state.playerFrameId = null
  state.playerAreaPixels = 0
  state.playerLastSeenAtMs = 0
  state.currentMedia = null
  state.playerDiagnostics = null
  state.lastPlayerSample = null
  if (state.snapshot)
    sendToServer({ type: 'set_ready', ready: false, media: null })
  void publishState()
})

chrome.runtime.onMessage.addListener((request: RuntimeRequest | RuntimeEvent, sender, sendResponse) => {
  if (!request || typeof request.type !== 'string' || request.type === 'ROOM_STATE_UPDATED' || request.type === 'APPLY_ROOM_STATE' || request.type === 'PAUSE_LOCAL' || request.type === 'FORCE_SYNC' || request.type === 'SHOW_NOTICE')
    return false

  if (request.type === 'OPEN_PANEL' && sender.tab?.id !== undefined) {
    if (!browserApi.sidePanel) {
      void sendToPlayerTab({ type: 'SHOW_NOTICE', message: 'Open SyncYourJoy from the browser extensions button.' })
      sendResponse(success())
    }
    else {
      void browserApi.sidePanel.open({ tabId: sender.tab.id })
        .then(() => sendResponse(success()))
        .catch(() => {
          void sendToPlayerTab({ type: 'SHOW_NOTICE', message: 'Open SyncYourJoy from the browser extensions button.' })
          sendResponse(success())
        })
    }
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
    chrome.storage.session.get([SESSION_STATE_KEY, PLAYER_BINDING_KEY]),
    chrome.storage.local.get(DISPLAY_NAME_KEY),
  ])

  const stored = sessionData[SESSION_STATE_KEY] as Partial<ExtensionState> | undefined
  const storedBinding = sessionData[PLAYER_BINDING_KEY] as Partial<PlayerBinding> | undefined
  playerBinding = typeof storedBinding?.id === 'string'
    ? { id: storedBinding.id, documentId: typeof storedBinding.documentId === 'string' ? storedBinding.documentId : null }
    : null
  const displayName = localData[DISPLAY_NAME_KEY]
  state = {
    ...state,
    ...stored,
    connection: stored?.snapshot ? 'reconnecting' : 'disconnected',
    displayName: typeof displayName === 'string' && displayName.trim() ? displayName : state.displayName,
    lastError: null,
    connectionQuality: stored?.connectionQuality ?? 'offline',
    roundTripMs: stored?.roundTripMs ?? null,
    lastPongAtMs: stored?.lastPongAtMs ?? 0,
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
      if (isLikelyAdvertisingUrl(sender.url))
        return success()
      // The room URL is an intended destination, not proof of the media
      // currently playing. Native next-episode/SPA navigation can leave it
      // behind; using it first would relabel the next episode as the old one.
      const candidateMedia = bindMediaToSharedPage(request.media, sender.tab?.url ?? state.snapshot?.navigation?.url)
      if (!acceptMediaSender(sender, request.areaPixels, candidateMedia, request.bindingId))
        return success()
      if (sender.tab?.id !== undefined && sender.frameId !== undefined)
        await bindPlayerContext(sender.tab.id, sender.frameId, request.areaPixels, sender.documentId ?? null, request.bindingId)
      state.playerLastSeenAtMs = Date.now()
      recordDiagnostic('player', 'media_detected', {
        frameId: sender.frameId ?? null,
        areaPixels: request.areaPixels,
        service: request.media.service,
        origin: request.diagnostics?.origin ?? null,
        readyState: request.diagnostics?.readyState ?? null,
        networkState: request.diagnostics?.networkState ?? null,
        currentSrcKind: request.diagnostics?.currentSrcKind ?? null,
        hasSourceObject: request.diagnostics?.hasSourceObject ?? null,
      })
      state.currentMedia = candidateMedia
      state.playerDiagnostics = request.diagnostics ?? null
      if (state.snapshot) {
        const me = state.snapshot.participants.find(participant => participant.id === state.participantId)
        const matches = mediaMatches(state.snapshot.media, state.currentMedia)
        const nowMs = Date.now()
        const mismatchKey = JSON.stringify(state.currentMedia)
        if (matches) {
          clearPendingMediaMismatch()
        }
        else if (pendingMediaMismatchKey !== mismatchKey) {
          pendingMediaMismatchKey = mismatchKey
          pendingMediaMismatchObservedAtMs = nowMs
        }
        if (shouldConfirmMediaMismatch({
          participantReady: me?.ready ?? false,
          currentMatches: me?.mediaMatches,
          nextMatches: matches,
          mismatchObservedAtMs: pendingMediaMismatchObservedAtMs,
          nowMs,
        })) {
          sendToServer({ type: 'set_ready', ready: false, media: state.currentMedia })
          clearPendingMediaMismatch()
        }
      }
      await publishState()
      return success(state, playerBinding?.id)

    case 'MEDIA_LOST':
      if (!isBoundPlayerSender(sender, request.bindingId))
        return success()
      state.currentMedia = null
      state.playerDiagnostics = null
      state.lastPlayerSample = null
      clearPendingMediaMismatch()
      recordDiagnostic('player', 'media_lost', { frameId: sender.frameId ?? null })
      if (state.snapshot)
        sendToServer({ type: 'set_ready', ready: false, media: null })
      await publishState()
      return success()

    case 'PLAYER_STATUS':
      if (!isBoundPlayerSender(sender, request.bindingId))
        return success()
      state.lastPlayerSample = request.sample
      state.playerLastSeenAtMs = Date.now()
      recordDiagnostic('playback', 'player_status', {
        revision: request.basedOnRevision,
        positionSeconds: request.sample.positionSeconds,
        paused: request.sample.paused,
        buffering: request.sample.buffering,
        progressed: typeof request.sample.progressed === 'boolean' ? request.sample.progressed : null,
        progressEvidence: request.sample.progressEvidence ?? null,
        playbackStarted: typeof request.sample.playbackStarted === 'boolean' ? request.sample.playbackStarted : null,
        playbackStartFailed: typeof request.sample.playbackStartFailed === 'boolean' ? request.sample.playbackStartFailed : null,
      })
      sendToServer({ type: 'player_status', basedOnRevision: request.basedOnRevision, sample: request.sample })
      // Fire-and-forget, matching the 'pong' handler below: this fires on a
      // ~1s timer while media plays, so awaiting the storage write here
      // would add a needless round-trip to every heartbeat response instead
      // of just letting persistence catch up once state has already been
      // updated and the caller already answered.
      void persistState()
      notifyExtensionViews()
      return success()

    case 'SEEK_APPLIED':
      if (!isBoundPlayerSender(sender, request.bindingId))
        return success()
      if (!sendToServer({ type: 'seek_applied', revision: request.revision, positionSeconds: request.positionSeconds }))
        return failure('The room connection was interrupted while confirming the seek.')
      recordDiagnostic('playback', 'seek_applied', {
        revision: request.revision,
        positionSeconds: request.positionSeconds,
      })
      return success()

    case 'CREATE_ROOM':
      const newRoomCode = generateRoomCode()
      state.sessionToken = null
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
      const resumeToken = state.snapshot?.code === code ? state.sessionToken : null
      await startFreshConnection(code)
      if (!resumeToken)
        state.sessionToken = null
      sendToServer({
        type: 'join_room',
        protocolVersion: 1,
        participantId: state.participantId,
        name: state.displayName,
        code,
        media: state.currentMedia,
        ...(resumeToken ? { sessionToken: resumeToken } : {}),
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

    case 'LOCK_PLAYER':
      if (!state.snapshot || state.playerTabId === null || state.playerFrameId === null || !state.currentMedia)
        return failure('Detect a video before locking the player.')
      await sendToPlayerTab({ type: 'LOCK_PLAYER' })
      recordDiagnostic('player', 'player_locked', { frameId: state.playerFrameId })
      await refreshBoundPlayerTab()
      await publishState()
      return success()

    case 'UNLOCK_PLAYER':
      await sendToPlayerTab({ type: 'UNLOCK_PLAYER' })
      recordDiagnostic('player', 'player_unlocked')
      await refreshBoundPlayerTab()
      await publishState()
      return success()

    case 'SYNC_NOW':
      if (!state.snapshot || state.playerTabId === null || state.playerFrameId === null || !state.currentMedia)
        return failure('The shared player is not ready yet.')
      await sendToPlayerTab({ type: 'FORCE_SYNC' })
      recordDiagnostic('control', 'manual_sync', { revision: state.snapshot.revision })
      return success()

    case 'DOWNLOAD_DIAGNOSTICS': {
      const snapshot = state.snapshot
      if (!snapshot || state.connection !== 'connected')
        return failure('Join a connected room before collecting a detailed report.')
      if (!isController())
        return failure('Only the room controller can download reports from all participants.')
      if (diagnosticCollection)
        return failure('A detailed report is already being collected.')
      const reportId = createId('report')
      const collection: DiagnosticCollection = {
        reportId,
        expectedParticipantIds: new Set(snapshot.participants.filter(participant => participant.connected).map(participant => participant.id)),
        responses: new Map(),
        timer: setTimeout(() => finishDiagnosticCollection(reportId), DIAGNOSTIC_COLLECTION_TIMEOUT_MS),
        retryTimers: [],
        attempts: 0,
      }
      diagnosticCollection = collection
      recordDiagnostic('diagnostics', 'collection_requested', { reportId, expectedParticipants: collection.expectedParticipantIds.size })
      const me = snapshot.participants.find(participant => participant.id === state.participantId)
      if (me) {
        collection.responses.set(state.participantId, {
          participantId: state.participantId,
          participantName: me.name,
          report: validatedDiagnosticsReport(),
        })
      }
      if (!requestDiagnosticResponses(reportId)) {
        clearTimeout(collection.timer)
        diagnosticCollection = null
        return failure('The room connection was interrupted before logs could be requested.')
      }
      if (!diagnosticCollection)
        return success()
      collection.retryTimers.push(
        setTimeout(() => requestDiagnosticResponses(reportId), 1_000),
        setTimeout(() => requestDiagnosticResponses(reportId), 3_000),
        setTimeout(() => requestDiagnosticResponses(reportId), 6_000),
      )
      return success()
    }

    case 'OPEN_LINK': {
      const snapshot = state.snapshot
      if (!snapshot)
        return failure('Join a room before opening a link.')
      if (!isController())
        return failure('Only the controller can open a link for everyone.')
      const normalizedUrl = normalizeMediaPageUrl(request.url)
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
      if (!isBoundPlayerSender(sender, request.bindingId))
        return success()
      if (!isController()) {
        await sendToPlayerTab({ type: 'APPLY_ROOM_STATE', state })
        await sendToPlayerTab({ type: 'SHOW_NOTICE', message: 'The room controller owns playback.' })
        return failure('The room controller owns playback.')
      }
      recordDiagnostic('control', 'native_player_intent', {
        kind: request.kind,
        positionSeconds: request.positionSeconds,
      })
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

    case 'RESPOND_TO_JOIN': {
      const snapshot = state.snapshot
      if (!snapshot)
        return failure('Join a room first.')
      if (!isController())
        return failure('Only the controller can approve or deny join requests.')
      if (!sendToServer({
        type: 'respond_to_join',
        participantId: request.participantId,
        approve: request.approve,
        actionId: createId('action'),
        basedOnRevision: snapshot.revision,
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
  const positionSeconds = resolveControlPosition(kind, explicitPosition, state.lastPlayerSample, fallbackPosition)
  recordDiagnostic('control', 'room_control', { kind, positionSeconds, basedOnRevision: snapshot.revision })
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
  void chrome.alarms.clear(RECONNECT_ALARM_NAME)
  socket?.close(1000, 'new_room')
  socket = null
  connectionPromise = null
  state.snapshot = null
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
      void chrome.alarms.clear(RECONNECT_ALARM_NAME)
      state.connectionQuality = 'unknown'
      state.roundTripMs = null
      state.lastPongAtMs = Date.now()
      startPingLoop()
      recordDiagnostic('connection', 'socket_opened', { roomCode })
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
      // A stale socket (already replaced by a newer connection, e.g. via
      // startFreshConnection) must not tear down the new socket's ping loop
      // or flip connection state away from whatever the new socket set.
      if (socket === nextSocket) {
        socket = null
        connectionPromise = null
        stopPingLoop()

        if (!intentionallyClosed && state.snapshot) {
          state.connection = 'reconnecting'
          state.connectionQuality = 'offline'
          void publishState()
          scheduleReconnect()
        }
      }
      recordDiagnostic('connection', 'socket_closed', { intentional: intentionallyClosed })
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
      ...(state.sessionToken ? { sessionToken: state.sessionToken } : {}),
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
  // Fallback for when the service worker is suspended before the setTimeout
  // above can fire: chrome.alarms wakes the service worker independently of
  // any in-memory timer, so the reconnect is retried even after suspension.
  void chrome.alarms.create(RECONNECT_ALARM_NAME, { delayInMinutes: delayMs / 60_000 })
}

function handleServerMessage(raw: string): void {
  const message = safeJsonParse(raw) as ServerMessage | null
  if (!message || typeof message !== 'object' || !('type' in message))
    return

  if (message.type === 'room_joined') {
    state.connection = 'connected'
    state.participantId = message.participantId
    state.sessionToken = message.sessionToken ?? null
    state.snapshot = message.snapshot
    state.lastError = null
    recordDiagnostic('room', 'room_joined', { revision: message.snapshot.revision })
    void applySharedNavigation(message.snapshot)
    void publishState()
    return
  }

  if (message.type === 'room_snapshot') {
    if (!state.snapshot || message.snapshot.revision >= state.snapshot.revision)
      state.snapshot = message.snapshot
    state.connection = 'connected'
    state.lastError = null
    recordDiagnostic('room', message.reason, {
      revision: message.snapshot.revision,
      status: message.snapshot.playback.status,
      positionSeconds: message.snapshot.playback.positionSeconds,
      aligning: message.snapshot.seek !== null,
    })
    void applySharedNavigation(message.snapshot)
    void publishState()
    return
  }

  if (message.type === 'command_rejected') {
    if (message.code === 'join_denied') {
      // The host declined this join request and the server is about to
      // close this socket -- leave the room the same way LEAVE_ROOM does,
      // so the pending-close handler below does not treat this as a
      // dropped connection worth auto-reconnecting back into.
      recordDiagnostic('error', 'join_denied', { message: message.message })
      leaveRoom()
      state.lastError = message.message
      void publishState()
      void sendToPlayerTab({ type: 'SHOW_NOTICE', message: message.message })
      return
    }
    if (message.snapshot)
      state.snapshot = message.snapshot
    state.lastError = message.message
    recordDiagnostic('error', 'command_rejected', { code: message.code, message: message.message })
    void publishState()
    void sendToPlayerTab({ type: 'SHOW_NOTICE', message: message.message })
    return
  }

  if (message.type === 'error') {
    state.lastError = message.message
    recordDiagnostic('error', 'server_error', { code: message.code, message: message.message })
    void publishState()
    return
  }

  if (message.type === 'diagnostics_requested') {
    recordDiagnostic('diagnostics', 'local_report_requested', { reportId: message.reportId })
    sendToServer({ type: 'diagnostics_response', reportId: message.reportId, report: validatedDiagnosticsReport() })
    return
  }

  if (message.type === 'diagnostics_response') {
    const collection = diagnosticCollection
    if (!collection || collection.reportId !== message.reportId)
      return
    collection.responses.set(message.participantId, {
      participantId: message.participantId,
      participantName: message.participantName,
      report: message.report,
    })
    if ([...collection.expectedParticipantIds].every(participantId => collection.responses.has(participantId)))
      finishDiagnosticCollection(message.reportId)
    return
  }

  if (message.type === 'pong') {
    const receivedAtLocalMs = Date.now()
    const estimate = clock.addSample(message.sentAtLocalMs, receivedAtLocalMs, message.serverTimeMs)
    state.serverOffsetMs = estimate.offsetMs
    state.clockUncertaintyMs = Number.isFinite(estimate.uncertaintyMs) ? estimate.uncertaintyMs : 99_999
    state.roundTripMs = Math.max(0, Math.min(receivedAtLocalMs - message.sentAtLocalMs, 10_000))
    state.lastPongAtMs = receivedAtLocalMs
    state.connectionQuality = connectionQuality({
      connection: state.connection,
      roundTripMs: state.roundTripMs,
      clockUncertaintyMs: state.clockUncertaintyMs,
      lastPongAtMs: state.lastPongAtMs,
      nowMs: receivedAtLocalMs,
    })
    sendToServer({ type: 'client_metrics', roundTripMs: receivedAtLocalMs - message.sentAtLocalMs })
    void persistState()
    notifyExtensionViews()
  }
}

function startPingLoop(): void {
  stopPingLoop()
  state.lastPongAtMs = Date.now()
  state.connectionQuality = 'unknown'
  const ping = () => sendToServer({ type: 'ping', id: createId('ping'), sentAtLocalMs: Date.now() })
  ping()
  pingTimer = setInterval(ping, 5_000)
  heartbeatTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN)
      return
    const nowMs = Date.now()
    if (nowMs - state.lastPongAtMs <= 15_000)
      return
    recordDiagnostic('connection', 'heartbeat_timeout', { ageMs: nowMs - state.lastPongAtMs })
    state.connectionQuality = 'offline'
    socket.close(4001, 'heartbeat_timeout')
  }, 1_000)
}

function stopPingLoop(): void {
  if (pingTimer)
    clearInterval(pingTimer)
  pingTimer = null
  if (heartbeatTimer)
    clearInterval(heartbeatTimer)
  heartbeatTimer = null
  state.connectionQuality = 'offline'
}

// create_room/join_room are how a socket becomes a room member in the first
// place, and ping has its own server-side exemption for exactly this reason.
// Every other message type requires state.connection === 'connected': the
// socket can reach OPEN well before the server has processed and confirmed
// join_room (a real network round trip), and anything else queued to go out
// in that window -- the content script's ~1s player_status tick, a stray
// "I'm ready" click -- would otherwise reach the server on an open-but-not-
// yet-registered socket and come back rejected as not_joined, while the
// panel still shows the last good snapshot from before the reconnect. This
// was a real, reported bug: a friend saw "Create or join a room first" while
// still visibly connected with a live participant list.
const CONNECTION_BOOTSTRAP_MESSAGE_TYPES = new Set<ClientMessage['type']>(['create_room', 'join_room', 'ping'])

function sendToServer(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN)
    return false
  if (state.connection !== 'connected' && !CONNECTION_BOOTSTRAP_MESSAGE_TYPES.has(message.type))
    return false
  socket.send(JSON.stringify(message))
  return true
}

function leaveRoom(): void {
  const previousPlayerTabId = state.playerTabId
  const previousPlayerFrameId = state.playerFrameId
  const previousPlayerDocumentId = playerBinding?.documentId ?? undefined
  intentionallyClosed = true
  if (reconnectTimer)
    clearTimeout(reconnectTimer)
  reconnectTimer = null
  void chrome.alarms.clear(RECONNECT_ALARM_NAME)
  stopPingLoop()
  socket?.close(1000, 'left_room')
  socket = null
  state.connection = 'disconnected'
  state.connectionQuality = 'offline'
  state.roundTripMs = null
  state.lastPongAtMs = 0
  state.snapshot = null
  clearPlayerTab()
  state.lastError = null
  state.lastOpenedNavigationRevision = 0
  reconnectAttempts = 0
  setTimeout(() => {
    intentionallyClosed = false
  }, 0)
  if (previousPlayerTabId !== null && previousPlayerFrameId !== null)
    void sendToTab(previousPlayerTabId, { type: 'APPLY_ROOM_STATE', state }, previousPlayerFrameId, previousPlayerDocumentId)
}

function acceptMediaSender(sender: chrome.runtime.MessageSender, areaPixels: number, media: MediaFingerprint, bindingId?: string): boolean {
  const senderTabId = sender.tab?.id
  const senderFrameId = sender.frameId
  if (senderTabId === undefined || senderFrameId === undefined)
    return false
  if (!acceptMediaBinding(sender, bindingId))
    return false
  const me = state.snapshot?.participants.find(participant => participant.id === state.participantId)
  const senderMediaMatchesRoom = state.snapshot ? mediaMatches(state.snapshot.media, media) : false
  return shouldAcceptPlayerContext({
    hasRoom: state.snapshot !== null,
    boundTabId: state.playerTabId,
    boundFrameId: state.playerFrameId,
    boundAreaPixels: state.playerAreaPixels,
    boundLastSeenAtMs: state.playerLastSeenAtMs,
    participantReady: me?.ready ?? false,
    senderTabId,
    senderFrameId,
    senderIsActive: sender.tab?.active === true,
    senderAreaPixels: Math.max(0, areaPixels),
    senderMediaMatchesRoom,
    nowMs: Date.now(),
  })
}

function acceptMediaBinding(sender: chrome.runtime.MessageSender, bindingId?: string): boolean {
  const currentBinding = playerBinding
  if (!currentBinding)
    return bindingId === undefined

  // A token from a retired document must never be allowed to establish a new
  // binding after loading cleared the active frame or after another document
  // replaced it.
  if (bindingId !== undefined && bindingId !== currentBinding.id)
    return false
  if (currentBinding.documentId !== null && sender.documentId !== undefined && sender.documentId !== currentBinding.documentId)
    return bindingId === undefined && state.playerFrameId !== null
  // When documentId is unavailable, the worker-issued token is the only
  // browser-compatible identity signal after the first handshake.
  if (currentBinding.documentId === null && sender.documentId === undefined && bindingId === undefined && state.playerFrameId !== null)
    return false
  if (state.playerFrameId === null && bindingId !== undefined)
    return false
  return true
}

function clearPendingMediaMismatch(): void {
  pendingMediaMismatchKey = null
  pendingMediaMismatchObservedAtMs = null
}

function isBoundPlayerSender(sender: chrome.runtime.MessageSender, bindingId?: string): boolean {
  if (sender.tab?.id === undefined || sender.frameId === undefined)
    return false
  if (sender.tab?.id !== state.playerTabId || sender.frameId !== state.playerFrameId || !playerBinding)
    return false
  const documentMatches = playerBinding.documentId !== null
    && sender.documentId !== undefined
    && sender.documentId === playerBinding.documentId
  const bindingMatches = bindingId !== undefined && bindingId === playerBinding.id
  return documentMatches || bindingMatches
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

  if (state.playerTabId === tab.id
    && state.playerFrameId !== null
    && state.currentMedia
    && Date.now() - state.playerLastSeenAtMs < PLAYER_CONTEXT_STALE_MS)
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
  const tabId = state.playerTabId
  const frameId = state.playerFrameId
  const bindingId = playerBinding?.id ?? null
  const documentId = playerBinding?.documentId ?? undefined
  const contextGeneration = playerContextGeneration
  try {
    const context = await chrome.tabs.sendMessage(
      tabId,
      { type: 'GET_PLAYER_CONTEXT' } satisfies ContentRequest,
      documentId !== undefined ? { documentId } : { frameId },
    ) as PlayerContext
    if (state.playerTabId !== tabId || state.playerFrameId !== frameId || (playerBinding?.id ?? null) !== bindingId || playerContextGeneration !== contextGeneration)
      return false
    if (!context?.media) {
      clearPlayerTab()
      return false
    }
    const tab = await chrome.tabs.get(tabId)
    if (state.playerTabId !== tabId || state.playerFrameId !== frameId || (playerBinding?.id ?? null) !== bindingId || playerContextGeneration !== contextGeneration)
      return false
    playerContextGeneration += 1
    state.currentMedia = bindMediaToSharedPage(context.media, tab.url ?? state.snapshot?.navigation?.url)
    state.playerDiagnostics = context.diagnostics
    state.lastPlayerSample = context.sample
    state.playerLastSeenAtMs = Date.now()
    return true
  }
  catch {
    if (state.playerTabId === tabId && state.playerFrameId === frameId && (playerBinding?.id ?? null) === bindingId && playerContextGeneration === contextGeneration)
      clearPlayerTab()
    return false
  }
}

async function applySharedNavigation(snapshot: NonNullable<ExtensionState['snapshot']>): Promise<void> {
  const navigation = snapshot.navigation
  if (!navigation || navigation.revision <= state.lastOpenedNavigationRevision || navigation.revision === pendingNavigationRevision)
    return

  pendingNavigationRevision = navigation.revision
  const estimatedServerNowMs = Date.now() + state.serverOffsetMs
  const delayMs = Math.max(0, navigation.effectiveAtServerMs - estimatedServerNowMs)
  setTimeout(() => {
    const clearPending = () => {
      if (pendingNavigationRevision === navigation.revision)
        pendingNavigationRevision = null
    }
    if (state.snapshot?.navigation?.revision !== navigation.revision) {
      clearPending()
      return
    }
    if (shouldReusePlayerTabForNavigation(state.playerTabId, state.currentMedia?.pageUrl, navigation.url)) {
      if (state.currentMedia)
        state.currentMedia = bindMediaToSharedPage(state.currentMedia, navigation.url)
      state.lastError = null
      // Only mark this revision as durably "handled" once its side effect
      // has actually run, so a service-worker restart during the delay
      // above causes a retry instead of a silently dropped navigation.
      state.lastOpenedNavigationRevision = navigation.revision
      clearPending()
      void publishState()
      return
    }
    void chrome.tabs.create({ url: navigation.url, active: true }).then((tab) => {
      if (tab.id === undefined)
        throw new Error('Chrome did not return the opened tab.')
      void bindPlayerContext(tab.id, null, 0)
      state.currentMedia = null
      state.playerDiagnostics = null
      state.lastPlayerSample = null
      state.lastError = null
      state.lastOpenedNavigationRevision = navigation.revision
      clearPending()
      void publishState()
    }).catch(() => {
      state.lastError = 'Chrome could not open the shared video link.'
      clearPending()
      void publishState()
    })
  }, Math.min(delayMs, 2_000))
}

function clearPlayerTab(): void {
  playerContextGeneration += 1
  playerBinding = null
  state.playerTabId = null
  state.playerFrameId = null
  state.playerAreaPixels = 0
  state.playerLastSeenAtMs = 0
  state.currentMedia = null
  state.playerDiagnostics = null
  state.lastPlayerSample = null
  clearPendingMediaMismatch()
}

async function bindPlayerContext(tabId: number, frameId: number | null, areaPixels: number, documentId: string | null = null, bindingId?: string): Promise<void> {
  const previousTabId = state.playerTabId
  const previousFrameId = state.playerFrameId
  const previousBinding = playerBinding
  playerContextGeneration += 1
  const sameBinding = previousTabId === tabId
    && previousFrameId === frameId
    && previousBinding !== null
    && ((documentId !== null && previousBinding.documentId === documentId)
      || (documentId === null && bindingId !== undefined && previousBinding.id === bindingId))
  playerBinding = sameBinding && previousBinding !== null
    ? previousBinding
    : { id: createId('binding'), documentId }
  state.playerTabId = tabId
  state.playerFrameId = frameId
  state.playerAreaPixels = Math.max(0, areaPixels)
  state.playerLastSeenAtMs = Date.now()
  const bindingChanged = !sameBinding || previousBinding?.id !== playerBinding.id
  const canTargetPreviousDocument = previousBinding?.documentId !== null && previousBinding?.documentId !== undefined
  const previousContextChanged = previousTabId !== tabId || previousFrameId !== frameId
  if (previousTabId !== null && previousFrameId !== null && bindingChanged && (previousContextChanged || canTargetPreviousDocument))
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, previousFrameId, previousBinding?.documentId ?? undefined)
  else if (previousTabId === tabId && previousFrameId === null && frameId !== null && frameId !== 0)
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, 0)
}

async function unbindPlayerContext(): Promise<void> {
  const previousTabId = state.playerTabId
  const previousFrameId = state.playerFrameId
  const previousDocumentId = playerBinding?.documentId ?? undefined
  clearPlayerTab()
  if (previousTabId !== null && previousFrameId !== null)
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, previousFrameId, previousDocumentId)
}

function isController(): boolean {
  return state.snapshot?.controller.participantId === state.participantId
}

async function publishState(): Promise<void> {
  await persistState()
  notifyExtensionViews()
  await sendToPlayerTab({ type: 'APPLY_ROOM_STATE', state })
}

function notifyExtensionViews(): void {
  const event: RuntimeEvent = { type: 'ROOM_STATE_UPDATED', state }
  void chrome.runtime.sendMessage(event).catch(() => undefined)
}

async function sendToPlayerTab(message: RuntimeEvent): Promise<void> {
  if (state.playerTabId === null || state.playerFrameId === null)
    return
  const tabId = state.playerTabId
  const frameId = state.playerFrameId
  const bindingId = playerBinding?.id ?? null
  const documentId = playerBinding?.documentId ?? undefined
  const contextGeneration = playerContextGeneration
  const delivered = await sendToTab(tabId, message, frameId, documentId)
  if (delivered || state.playerTabId !== tabId || state.playerFrameId !== frameId || (playerBinding?.id ?? null) !== bindingId || playerContextGeneration !== contextGeneration)
    return
  playerContextGeneration += 1
  playerBinding = null
  state.playerFrameId = null
  state.playerAreaPixels = 0
  state.playerLastSeenAtMs = 0
  state.currentMedia = null
  state.playerDiagnostics = null
  state.lastPlayerSample = null
  clearPendingMediaMismatch()
  recordDiagnostic('player', 'player_unreachable', { frameId })
  if (state.snapshot)
    sendToServer({ type: 'set_ready', ready: false, media: null })
  await persistState()
  notifyExtensionViews()
}

async function sendToTab(tabId: number, message: RuntimeEvent, frameId?: number, documentId?: string): Promise<boolean> {
  try {
    const options = documentId !== undefined
      ? { documentId }
      : frameId === undefined ? undefined : { frameId }
    await chrome.tabs.sendMessage(tabId, message, options)
    return true
  }
  catch {
    // The bound tab is navigating or no longer hosts a supported player.
    return false
  }
}

async function persistState(): Promise<void> {
  await chrome.storage.session.set({ [SESSION_STATE_KEY]: state, [PLAYER_BINDING_KEY]: playerBinding })
}

function success(responseState: ExtensionState = state, playerBindingId?: string): RuntimeResponse {
  return { ok: true, state: responseState, ...(playerBindingId ? { playerBindingId } : {}) }
}

function detachedState(): ExtensionState {
  return {
    ...state,
    connection: 'disconnected',
    snapshot: null,
    playerTabId: null,
    playerFrameId: null,
    playerAreaPixels: 0,
    playerLastSeenAtMs: 0,
    currentMedia: null,
    playerDiagnostics: null,
    lastPlayerSample: null,
    lastError: null,
    connectionQuality: 'offline',
    roundTripMs: null,
    lastPongAtMs: 0,
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

function recordDiagnostic(category: string, message: string, details: Record<string, DiagnosticValue> = {}): void {
  diagnosticEvents.push({
    atLocalMs: Date.now(),
    category: category.slice(0, 40),
    message: message.slice(0, 100),
    details: Object.fromEntries(Object.entries(details).slice(0, 20).map(([key, value]) => [key.slice(0, 40), sanitizeDiagnosticValue(value)])),
  })
  if (diagnosticEvents.length > DIAGNOSTIC_EVENT_LIMIT)
    diagnosticEvents.splice(0, diagnosticEvents.length - DIAGNOSTIC_EVENT_LIMIT)
}

function sanitizeDiagnosticValue(value: DiagnosticValue): DiagnosticValue {
  return typeof value === 'string' ? value.slice(0, 300) : value
}

function buildDiagnosticsReport(): DiagnosticsReport {
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    generatedAtLocalMs: Date.now(),
    userAgent: navigator.userAgent.slice(0, 300),
    connection: state.connection,
    roomRevision: state.snapshot?.revision ?? null,
    playbackStatus: state.snapshot?.playback.status ?? null,
    playerFrameId: state.playerFrameId,
    playerAreaPixels: state.playerAreaPixels,
    playerLastSeenAtMs: state.playerLastSeenAtMs,
    mediaService: state.currentMedia?.service ?? null,
    mediaCanonicalId: sanitizeDiagnosticCanonicalId(state.currentMedia?.canonicalId),
    mediaPageUrl: sanitizeDiagnosticPageUrl(state.currentMedia?.pageUrl),
    playerOrigin: state.playerDiagnostics?.origin ?? null,
    playerReadyState: state.playerDiagnostics?.readyState ?? null,
    playerNetworkState: state.playerDiagnostics?.networkState ?? null,
    playerCurrentSrcKind: state.playerDiagnostics?.currentSrcKind ?? null,
    playerHasSourceObject: state.playerDiagnostics?.hasSourceObject ?? null,
    sample: state.lastPlayerSample ? { ...state.lastPlayerSample } : null,
    events: diagnosticEvents.map(event => ({ ...event, details: { ...event.details } })),
  }
}

function validatedDiagnosticsReport(): DiagnosticsReport {
  const report = fitDiagnosticsReport(buildDiagnosticsReport())
  const parsed = parseClientMessage({ type: 'diagnostics_response', reportId: 'report_validation_check', report })
  if (parsed?.type === 'diagnostics_response')
    return parsed.report
  recordDiagnostic('diagnostics', 'report_validation_fallback')
  return {
    extensionVersion: chrome.runtime.getManifest().version.slice(0, 30) || 'unknown',
    generatedAtLocalMs: Date.now(),
    userAgent: navigator.userAgent.slice(0, 300),
    connection: state.connection,
    roomRevision: state.snapshot?.revision ?? null,
    playbackStatus: state.snapshot?.playback.status ?? null,
    playerFrameId: null,
    playerAreaPixels: 0,
    playerLastSeenAtMs: 0,
    mediaService: null,
    mediaCanonicalId: null,
    mediaPageUrl: null,
    sample: null,
    events: [{
      atLocalMs: Date.now(),
      category: 'diagnostics',
      message: 'report_validation_fallback',
      details: {},
    }],
  }
}

function sanitizeDiagnosticCanonicalId(value: string | undefined): string | null {
  if (!value)
    return null
  if (!value.startsWith('page:'))
    return value.slice(0, 500)
  const sanitizedUrl = sanitizeDiagnosticPageUrl(value.slice(5))
  return sanitizedUrl ? `page:${sanitizedUrl}` : 'page:redacted'
}

function sanitizeDiagnosticPageUrl(value: string | undefined): string | null {
  if (!value)
    return null
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString().slice(0, 2_048)
  }
  catch {
    return null
  }
}

function finishDiagnosticCollection(reportId: string): void {
  const collection = diagnosticCollection
  if (!collection || collection.reportId !== reportId)
    return
  clearTimeout(collection.timer)
  for (const retryTimer of collection.retryTimers)
    clearTimeout(retryTimer)
  diagnosticCollection = null
  const missingParticipantIds = [...collection.expectedParticipantIds].filter(participantId => !collection.responses.has(participantId))
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    roomCode: state.snapshot?.code ?? null,
    reportId,
    privacy: 'Playback diagnostics only. No cookies, passwords, media content, or URL query parameters.',
    collection: {
      attempts: collection.attempts,
      expectedParticipants: collection.expectedParticipantIds.size,
      receivedParticipants: collection.responses.size,
      complete: missingParticipantIds.length === 0,
    },
    missingParticipantIds,
    participants: [...collection.responses.values()],
  }
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const filename = `syncyourjoy-report-${state.snapshot?.code ?? 'room'}-${timestamp}.json`
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`
  void chrome.downloads.download({ url, filename, saveAs: false }).catch(() => {
    state.lastError = 'Chrome could not download the detailed report.'
    void publishState()
  })
}

function requestDiagnosticResponses(reportId: string): boolean {
  const collection = diagnosticCollection
  if (!collection || collection.reportId !== reportId)
    return false
  if ([...collection.expectedParticipantIds].every(participantId => collection.responses.has(participantId))) {
    finishDiagnosticCollection(reportId)
    return true
  }
  collection.attempts += 1
  recordDiagnostic('diagnostics', 'collection_attempt', {
    reportId,
    attempt: collection.attempts,
    receivedParticipants: collection.responses.size,
  })
  return sendToServer({ type: 'request_diagnostics', reportId })
}
