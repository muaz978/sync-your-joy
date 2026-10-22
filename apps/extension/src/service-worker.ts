import type { ClientMessage, ControlKind, DiagnosticEvent, DiagnosticsReport, DiagnosticReason, DiagnosticValue, MediaFingerprint, PlaybackState, RoomSnapshot, ServerMessage } from '@syncyourjoy/protocol'
import type { ContentRequest, ExtensionState, PlayerContext, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { CURRENT_CLIENT_CAPABILITIES, generateRoomCode, mediaMatches, normalizeMediaPageUrl, parseClientMessage, safeJsonParse } from '@syncyourjoy/protocol'
import { ClockSynchronizer, expectedPosition } from '@syncyourjoy/sync-engine'
import { PLAYER_CONTEXT_STALE_MS, shouldAcceptPlayerContext, shouldReusePlayerTabForNavigation } from './player-tab.ts'
import { isLikelyAdvertisingUrl } from './site-adapter.ts'
import { bindMediaToSharedPage } from './media-fingerprint.ts'
import { resolveControlPosition } from './control-position.ts'
import { shouldConfirmMediaMismatch } from './readiness-state.ts'
import { isAwaitingApproval } from './room-membership.ts'
import { connectionQuality } from './connection-quality.ts'
import { browserApi } from './browser-api.ts'
import { diagnosticEvictionIndex, fitDiagnosticsReport, roomPositionJump } from './diagnostics-budget.ts'
import { bufferedAheadBucket, MAX_BUFFERED_PAIRS, MAX_SEEKABLE_PAIRS, sanitizeElapsedMs, sanitizeMediaErrorCode, sanitizeRangeCount, sanitizeRangePairs, sanitizeRangeSeconds } from './media-ranges.ts'
import { DEFERRED_SEEK_MS, everyoneConnectedIsReady, notReadySummary, roomHasAcceptedScrub, SCRUB_ANSWER_HOLD_MS, scrubBelongsTo, shouldDeferRejectedSeek, SUPERSEDED_SCRUB_HOLD_MS } from './deferred-seek.ts'
import type { PendingScrub, SentControl } from './deferred-seek.ts'
import { CONTROLLER_FOLLOW_NAVIGATION_ENABLED, shouldFollowControllerNavigation, strongCrunchyrollNavigationKey } from './navigation-transaction.ts'

declare const __ROOM_SERVER_URL__: string

const ROOM_SERVER_URL = __ROOM_SERVER_URL__
const SESSION_STATE_KEY = 'syncYourJoySessionState'
const PLAYER_BINDING_KEY = 'syncYourJoyPlayerBinding'
const DISPLAY_NAME_KEY = 'syncYourJoyDisplayName'
const DIAGNOSTIC_EVENT_LIMIT = 100
// What the room says about resuming by itself after it paused a stalled player.
const AUTO_RESUME_NOTICES: ReadonlyMap<string, string> = new Map([
  ['auto_resume_play_pending', 'Resuming playback for everyone.'],
  ['auto_resume_abandoned', 'Could not resume automatically. The controller can press Play when everyone is ready.'],
])
// Why the room stopped or started by itself. A status change is kept in the
// report with its reason, and so are these reasons when the status did not
// change (a refused Play, a participant who is no longer ready).
const ROOM_INTERRUPTION_REASONS: ReadonlySet<string> = new Set([
  'participant_buffering',
  'participant_playback_stalled',
  'participant_playback_silent',
  'participant_playback_startup_timeout',
  'participant_playback_blocked',
  'operation_timeout_paused',
  'participant_not_ready',
  'participants_not_ready',
  'participant_disconnected',
  'auto_resume_play_pending',
  'auto_resume_abandoned',
])
// A participant may be waking a suspended service worker or a throttled tab.
// Give the room-wide report enough time to collect every response without
// making the normal playback path wait for diagnostics.
const DIAGNOSTIC_COLLECTION_TIMEOUT_MS = 8_000
// A bare setTimeout does not survive MV3 service-worker suspension. This
// alarm is a fallback that wakes the service worker to retry a reconnect
// even if it was suspended while the setTimeout backoff was pending.
const RECONNECT_ALARM_NAME = 'syncYourJoyReconnect'
// What a participant is told when the coordinator no longer has their room.
const ROOM_EXPIRED_MESSAGE = 'This room has expired. Create or join another room to keep watching together.'
const ROOM_GONE_MESSAGE = 'This room is no longer available. Create or join another room to keep watching together.'

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

interface DiagnosticObservationIdentity {
  bindingId: string
  sourceGeneration: number
  sampleSequence: number
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
// The timeout and chrome.alarms fallback can wake the service worker at the
// same time. Keep their join handshake single-flight so two callbacks never
// send duplicate join_room messages on one newly opened socket.
let reconnectPromise: Promise<void> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectAttempts = 0
let intentionallyClosed = false
// When the room first went out of reach (the first unintended close after a connection that worked),
// for the report: how long it stayed out of reach across failed attempts. It is cleared by a socket
// opening, and by a room being joined or left, which is not an outage.
let outageStartedAtMs: number | null = null
// When a pong last really arrived on the current socket. `state.lastPongAtMs` is seeded when a socket opens so that
// the heartbeat has something to measure from, which would make a socket that never got a pong look like it had.
let lastPongReceivedAtMs: number | null = null
// The last control this browser sent, and a scrub the room refused because
// someone was not ready, kept until they are (see deferred-seek.ts). Neither
// is persisted: a restarted worker simply drops the wait.
let lastControlSent: SentControl | null = null
let deferredSeek: PendingScrub | null = null
let deferredSeekTimer: ReturnType<typeof setTimeout> | null = null
let clock = new ClockSynchronizer()
const diagnosticEvents: DiagnosticEvent[] = []
let diagnosticEventsDropped = 0
let diagnosticEventsCoalesced = 0
// Repetitive telemetry is merged into its previous occurrence rather than
// filling the bounded ring, so a long stall cannot push the start of a
// failure out of a report. A merged event moves to the tail, where its latest
// occurrence belongs, so trimming the oldest events never removes the
// freshest one. `atLocalMs` is the latest occurrence, `details.firstAtLocalMs`
// the first and `details.repeatCount` how many.
const COALESCED_DIAGNOSTIC_MESSAGES = new Set(['player_status', 'media_detected'])
// A run ends when the player, the socket or the room changes, so a heartbeat
// after a reconnect or a media loss is a new event, not more of the old run.
const DIAGNOSTIC_RUN_BOUNDARIES = new Set(['media_lost', 'player_unreachable', 'player_locked', 'player_unlocked', 'socket_opened', 'socket_closed', 'heartbeat_timeout', 'room_joined'])
// The protocol caps both counters; a longer-lived worker must not push the
// whole report over the validator's limit.
const MAX_REPORTED_DIAGNOSTIC_COUNT = 100_000
const lastCoalescibleDiagnostics = new Map<string, { event: DiagnosticEvent; signature: string }>()
let lastDiagnosticReason: DiagnosticReason = 'none'
let diagnosticCollection: DiagnosticCollection | null = null
// This identity is deliberately persisted separately from ExtensionState so
// it is not sent to extension views or copied into room-state events. Content
// scripts receive it only through a successful MEDIA_DETECTED response.
let playerBinding: PlayerBinding | null = null
let lastObservationIdentity: DiagnosticObservationIdentity | null = null
let pendingMediaMismatchKey: string | null = null
let pendingMediaMismatchObservedAtMs: number | null = null
// In-memory only: tracks a navigation revision whose deferred tab-open/reuse
// side effect is currently scheduled but has not completed yet. This must
// NOT be persisted -- state.lastOpenedNavigationRevision is the durable
// "handled" marker, and it is only advanced once the side effect actually
// runs, so a service-worker restart during the deferred delay causes the
// navigation to be retried rather than silently dropped.
let pendingNavigationRevision: number | null = null
let lastControllerNavigationKey: string | null = null
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
  if (!request || typeof request.type !== 'string' || request.type === 'ROOM_STATE_UPDATED' || request.type === 'APPLY_ROOM_STATE' || request.type === 'PAUSE_LOCAL' || request.type === 'FORCE_SYNC' || request.type === 'SHOW_NOTICE' || request.type === 'CONTROLLER_SEEK_HOLD')
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
    // The socket these described went with the old worker: until a new one opens there is no quality or round trip.
    connectionQuality: 'offline',
    roundTripMs: null,
    lastPongAtMs: 0,
  }

  // A service worker that restarted drops its socket and its report: this marks where the
  // history of a report begins, and whether a room was waiting to be rejoined.
  recordDiagnostic('connection', 'worker_started', { resumedRoom: state.snapshot !== null })

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
        seeking: typeof request.diagnostics?.seeking === 'boolean' ? request.diagnostics.seeking : null,
        errorCode: sanitizeMediaErrorCode(request.diagnostics?.errorCode),
        aheadBucket: bufferedAheadBucket(request.diagnostics?.bufferedAheadSeconds),
      })
      state.currentMedia = candidateMedia
      state.playerDiagnostics = request.diagnostics ?? null
      const shouldAutoFollow = shouldFollowControllerNavigation({
        enabled: CONTROLLER_FOLLOW_NAVIGATION_ENABLED,
        isController: isController(),
        hasCurrentLease: state.snapshot?.controller.leaseEpoch !== undefined,
        currentRoomMedia: state.snapshot?.media ?? null,
        observedMedia: candidateMedia,
        lastActionKey: lastControllerNavigationKey,
      })
      if (shouldAutoFollow) {
        const actionKey = strongCrunchyrollNavigationKey(candidateMedia)
        const autoFollowUrl = candidateMedia.pageUrl
        const currentSnapshot = state.snapshot
        if (actionKey && autoFollowUrl && currentSnapshot && sendToServer({
          type: 'open_link',
          actionId: createId('action'),
          basedOnRevision: currentSnapshot.revision,
          leaseEpoch: currentSnapshot.controller.leaseEpoch,
          url: autoFollowUrl,
        })) {
          lastControllerNavigationKey = actionKey
          recordDiagnostic('navigation', 'controller_follow_requested', {
            mediaCanonicalId: candidateMedia.canonicalId,
          })
        }
      }
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
      // A page that was reloaded while a scrub waits has not been told to hold.
      if (deferredSeek)
        holdPlayerPage(deferredSeek.expiresAtMs - Date.now())
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
      const statusReason = request.sample.playbackStartFailed === true
        ? 'permission-denied' as const
        : request.sample.buffering === true && request.sample.progressed === false
          ? 'stalled' as const
          : undefined
      recordDiagnostic('playback', 'player_status', {
        revision: request.basedOnRevision,
        positionSeconds: request.sample.positionSeconds,
        paused: request.sample.paused,
        buffering: request.sample.buffering,
        progressed: typeof request.sample.progressed === 'boolean' ? request.sample.progressed : null,
        progressEvidence: request.sample.progressEvidence ?? null,
        playbackStarted: typeof request.sample.playbackStarted === 'boolean' ? request.sample.playbackStarted : null,
        playbackStartFailed: typeof request.sample.playbackStartFailed === 'boolean' ? request.sample.playbackStartFailed : null,
        correctionCount: request.sample.correctionCount ?? 0,
        // What the room's automatic resume waits for: without it a report cannot say why the room stayed paused.
        canPlay: typeof request.sample.canPlay === 'boolean' ? request.sample.canPlay : null,
      }, statusReason ? { reason: statusReason } : {})
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

    case 'OPERATION_ACK':
      if (!isBoundPlayerSender(sender, request.acknowledgement.bindingId))
        return success()
      if (!sendToServer({ type: 'operation_ack', acknowledgement: request.acknowledgement }))
        return failure('The room connection was interrupted while confirming the operation.')
      recordDiagnostic('playback', 'operation_ack', {
        operationId: request.acknowledgement.operationId,
        phase: request.acknowledgement.phase,
        sourceGeneration: request.acknowledgement.sourceGeneration,
        sampleSequence: request.acknowledgement.sampleSequence,
      })
      lastObservationIdentity = {
        bindingId: request.acknowledgement.bindingId,
        sourceGeneration: request.acknowledgement.sourceGeneration,
        sampleSequence: request.acknowledgement.sampleSequence,
      }
      return success()

    case 'PLAYER_PAUSE_CONTEXT':
      if (!isBoundPlayerSender(sender, request.bindingId))
        return success()
      recordDiagnostic('playback', 'native_pause_context', {
        ignored: request.ignored,
        visibility: request.visibility.slice(0, 12),
        focused: request.focused,
        msSinceAway: request.msSinceAway,
      })
      return success()

    case 'STUCK_SEEK_STEP':
      if (!isBoundPlayerSender(sender, request.bindingId))
        return success()
      recordDiagnostic('playback', 'stuck_seek_step', {
        step: request.step,
        reissues: request.reissues,
        positionSeconds: request.positionSeconds,
      }, { critical: true })
      return success()

    case 'RELOAD_PLAYER_TAB':
      // Only the tab the room is playing in, and only when the page itself
      // asked after its own countdown; the room survives the reload and the
      // page binds again.
      if (!isBoundPlayerSender(sender, request.bindingId) || sender.tab?.id === undefined)
        return success()
      try {
        await chrome.tabs.reload(sender.tab.id)
      }
      catch {
        return failure('The tab could not be reloaded.')
      }
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
        capabilities: CURRENT_CLIENT_CAPABILITIES,
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
        capabilities: CURRENT_CLIENT_CAPABILITIES,
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
      // Sync is the choice to return to the room, so a waiting scrub is dropped.
      clearDeferredSeek(false)
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

async function sendControl(kind: ControlKind, explicitPosition?: number, retryOf?: { expiresAtMs: number }): Promise<RuntimeResponse> {
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
  const actionId = createId('action')
  // Any control other than the retry of the waiting scrub is a newer decision.
  // The page keeps the controller's player where it is for a moment longer,
  // until the room's answer to that control arrives.
  if (!retryOf)
    supersedeDeferredSeek()
  else if (deferredSeek)
    deferredSeek.actionId = actionId
  lastControlSent = { actionId, kind, positionSeconds, atMs: Date.now(), carryExpiresAtMs: retryOf?.expiresAtMs }
  if (kind === 'pause')
    void sendToPlayerTab({ type: 'PAUSE_LOCAL' })
  const sent = sendToServer({
    type: 'control',
    actionId,
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
  closeOnPurpose(socket, 1000, 'new_room')
  socket = null
  connectionPromise = null
  // A new room is not a continuation of the last one's connection: its outage and retry count are not carried over.
  outageStartedAtMs = null
  reconnectAttempts = 0
  state.snapshot = null
  state.lastOpenedNavigationRevision = 0
  lastControllerNavigationKey = null
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

    // Kept with the socket, not in a shared variable: a close can arrive after a replacement has opened.
    let openedAtMs: number | null = null

    nextSocket.addEventListener('open', () => {
      connectionPromise = null
      openedAtMs = Date.now()
      lastPongReceivedAtMs = null
      const attempt = reconnectAttempts
      // The outage ends when the room has taken this client back (room_joined), not when a socket opens.
      const downMs = outageStartedAtMs === null ? null : openedAtMs - outageStartedAtMs
      reconnectAttempts = 0
      void chrome.alarms.clear(RECONNECT_ALARM_NAME)
      // The previous connection's round trip is gone before this one's first quality is recorded.
      state.roundTripMs = null
      setConnectionQuality('unknown')
      state.lastPongAtMs = Date.now()
      startPingLoop()
      // No room code: a report is sent to whoever controls the room it is asked for in, and this event outlives a change of room.
      recordDiagnostic('connection', 'socket_opened', { attempt, downMs })
      resolve()
    }, { once: true })

    nextSocket.addEventListener('message', event => handleServerMessage(String(event.data), socket === nextSocket))

    nextSocket.addEventListener('error', () => {
      if (connectionPromise) {
        connectionPromise = null
        reject(new Error('Cannot reach the SyncYourJoy room service. Check your connection and try again.'))
      }
    }, { once: true })

    nextSocket.addEventListener('close', (event) => {
      // Read before anything below can leave the room, which sets the flag:
      // the diagnostic is about who closed the socket, not about what this
      // handler then did.
      const closedByThisClient = intentionallyClosed || closedOnPurpose.has(nextSocket)
      const closedAtMs = Date.now()
      const closeEvent = event as CloseEvent
      // A socket that was already replaced (a new room, or leaving) is no longer the connection the
      // shared health numbers describe, and a close made on purpose says nothing about the network.
      const isCurrent = socket === nextSocket
      const evidence: Record<string, DiagnosticValue> = {
        code: typeof closeEvent.code === 'number' ? closeEvent.code : null,
        reason: closeEvent.reason ? safeDiagnosticCode(closeEvent.reason) : 'none',
        wasClean: closeEvent.wasClean === true,
        openMs: openedAtMs === null ? null : closedAtMs - openedAtMs,
        online: typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
      }
      if (isCurrent && !closedByThisClient && openedAtMs !== null) {
        // What the connection looked like when it ended, before the handler below marks it offline:
        // a pong that had stopped arriving points at the network.
        evidence.pongAgeMs = lastPongReceivedAtMs === null ? null : closedAtMs - lastPongReceivedAtMs
        evidence.roundTripMs = state.roundTripMs
        evidence.quality = state.connectionQuality
      }
      else if (!isCurrent) {
        evidence.replaced = true
      }
      // The coordinator closes with this reason only when the room has
      // been removed (its lifetime ended, or nobody was in it for too
      // long). Reconnecting could only end in room_not_found, so leave
      // the room instead of keeping a waiting or room view up for a room
      // that no longer exists.
      const serverEndedRoom = isCurrent && !closedByThisClient && state.snapshot !== null && closeEvent.reason === 'room_expired'
      if (isCurrent && !closedByThisClient)
        outageStartedAtMs ??= closedAtMs
      // Before the reconnect it causes: a report reads in the order things happened.
      recordDiagnostic('connection', 'socket_closed', { intentional: closedByThisClient, ...(serverEndedRoom ? { serverEndedRoom: true } : {}), ...evidence })
      // A stale socket (already replaced by a newer connection, e.g. via
      // startFreshConnection) must not tear down the new socket's ping loop
      // or flip connection state away from whatever the new socket set.
      if (isCurrent) {
        socket = null
        connectionPromise = null
        stopPingLoop()

        if (!closedByThisClient && state.snapshot) {
          if (serverEndedRoom) {
            endRoomBecauseGone(ROOM_EXPIRED_MESSAGE)
          }
          else {
            state.connection = 'reconnecting'
            setConnectionQuality('offline')
            void publishState()
            scheduleReconnect()
          }
        }
      }
    })
  })

  return connectionPromise
}

async function reconnectIfNeeded(): Promise<void> {
  if (reconnectPromise)
    return reconnectPromise
  if (!state.snapshot || socket?.readyState === WebSocket.OPEN)
    return

  reconnectPromise = (async () => {
    try {
      const roomCode = state.snapshot?.code
      if (!roomCode)
        return
      await connect(roomCode)
      if (!state.snapshot || socket?.readyState !== WebSocket.OPEN)
        return
      sendToServer({
        type: 'join_room',
        protocolVersion: 1,
        participantId: state.participantId,
        name: state.displayName,
        code: roomCode,
        media: state.currentMedia,
        capabilities: CURRENT_CLIENT_CAPABILITIES,
        ...(state.sessionToken ? { sessionToken: state.sessionToken } : {}),
      })
    }
    catch {
      scheduleReconnect()
    }
  })()

  try {
    await reconnectPromise
  }
  finally {
    reconnectPromise = null
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer)
    return
  const delayMs = Math.min(15_000, 500 * 2 ** reconnectAttempts) + Math.round(Math.random() * 250)
  reconnectAttempts += 1
  recordDiagnostic('connection', 'reconnect_scheduled', { attempt: reconnectAttempts, delayMs })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void reconnectIfNeeded()
  }, delayMs)
  // Fallback for when the service worker is suspended before the setTimeout
  // above can fire: chrome.alarms wakes the service worker independently of
  // any in-memory timer, so the reconnect is retried even after suspension.
  void chrome.alarms.create(RECONNECT_ALARM_NAME, { delayInMinutes: delayMs / 60_000 })
}

function handleServerMessage(raw: string, fromCurrentSocket = true): void {
  const message = safeJsonParse(raw) as ServerMessage | null
  if (!message || typeof message !== 'object' || !('type' in message))
    return

  if (message.type === 'room_joined') {
    // The outage ends when the room has taken this client back, and only a join answered on the current socket says so.
    if (fromCurrentSocket && outageStartedAtMs !== null) {
      recordDiagnostic('connection', 'room_rejoined', { outageMs: Date.now() - outageStartedAtMs })
      outageStartedAtMs = null
    }
    state.connection = 'connected'
    state.participantId = message.participantId
    state.sessionToken = message.sessionToken ?? null
    // A rejoin replaces what this browser last knew, so a seek made while the
    // connection was down shows up here, not in a snapshot.
    const previousPlayback = state.snapshot?.playback ?? null
    state.snapshot = message.snapshot
    state.lastError = null
    recordDiagnostic('room', 'room_joined', { revision: message.snapshot.revision })
    recordRoomPositionJump(previousPlayback, message.snapshot, 'room_joined')
    recordRoomStatusChange(previousPlayback, message.snapshot, 'room_joined')
    retryDeferredSeek(message.snapshot)
    void applySharedNavigation(message.snapshot)
    void publishState()
    return
  }

  if (message.type === 'room_snapshot') {
    const previousPlayback = state.snapshot?.playback ?? null
    const snapshotApplied = !state.snapshot || message.snapshot.revision >= state.snapshot.revision
    if (snapshotApplied)
      state.snapshot = message.snapshot
    state.connection = 'connected'
    state.lastError = null
    const snapshotReason = safeDiagnosticReason(message.reason)
    recordDiagnostic('room', 'room_snapshot', {
      reason: safeDiagnosticCode(message.reason),
      revision: message.snapshot.revision,
      status: message.snapshot.playback.status,
      positionSeconds: message.snapshot.playback.positionSeconds,
      aligning: message.snapshot.seek !== null,
    }, snapshotReason ? { reason: snapshotReason } : {})
    if (snapshotApplied)
      recordRoomPositionJump(previousPlayback, message.snapshot, message.reason)
    if (snapshotApplied)
      recordRoomStatusChange(previousPlayback, message.snapshot, message.reason)
    if (snapshotApplied)
      retryDeferredSeek(message.snapshot)
    const autoResumeNotice = snapshotApplied ? AUTO_RESUME_NOTICES.get(message.reason) : undefined
    if (autoResumeNotice)
      void sendToPlayerTab({ type: 'SHOW_NOTICE', message: autoResumeNotice })
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
      recordDiagnostic('error', 'join_denied', { code: safeDiagnosticCode(message.code) }, { reason: 'command-rejected' })
      leaveRoomWithNotice(message.message)
      return
    }
    if (message.snapshot) {
      const previousPlayback = state.snapshot?.playback ?? null
      state.snapshot = message.snapshot
      recordRoomStatusChange(previousPlayback, message.snapshot, message.code)
    }
    recordDiagnostic('error', 'command_rejected', {
      code: safeDiagnosticCode(message.code),
      // Who was not ready, when that is why: the report can say which participant.
      ...(message.code === 'participants_not_ready' && state.snapshot ? { notReady: notReadySummary(state.snapshot.participants) } : {}),
    }, { reason: 'command-rejected' })
    if (shouldDeferRejectedSeek({ code: message.code, actionId: message.actionId ?? '', last: lastControlSent, nowMs: Date.now(), isController: isController() })) {
      // Not an error: the scrub waits, so no lastError, which would also end
      // the page's hold on the controller's player.
      deferSeek(lastControlSent!)
      void publishState()
      return
    }
    // The scrub that was sent again has been refused for another reason.
    if (message.actionId !== null && deferredSeek?.actionId === message.actionId)
      clearDeferredSeek(true)
    state.lastError = message.message
    void publishState()
    void sendToPlayerTab({ type: 'SHOW_NOTICE', message: message.message })
    return
  }

  if (message.type === 'error') {
    // While this client believes it is in a room, room_not_found can only
    // mean the room is gone (a reconnect found nothing to rejoin), and
    // room_expired is what a coordinator may answer for a room it has
    // already removed (the current local service closes every socket first,
    // so this is defence in depth). A first join to a wrong code has no
    // snapshot yet and keeps the plain error.
    if ((message.code === 'room_not_found' || message.code === 'room_expired') && state.snapshot) {
      recordDiagnostic('error', 'room_gone', { code: safeDiagnosticCode(message.code) }, { reason: 'server-error' })
      endRoomBecauseGone(message.code === 'room_expired' ? ROOM_EXPIRED_MESSAGE : ROOM_GONE_MESSAGE)
      return
    }
    state.lastError = message.message
    recordDiagnostic('error', 'server_error', { code: safeDiagnosticCode(message.code) }, { reason: 'server-error' })
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
    // A pong still in flight from a socket that has been replaced says nothing of the one that replaced it.
    if (!fromCurrentSocket)
      return
    const receivedAtLocalMs = Date.now()
    const estimate = clock.addSample(message.sentAtLocalMs, receivedAtLocalMs, message.serverTimeMs)
    state.serverOffsetMs = estimate.offsetMs
    state.clockUncertaintyMs = Number.isFinite(estimate.uncertaintyMs) ? estimate.uncertaintyMs : 99_999
    state.roundTripMs = Math.max(0, Math.min(receivedAtLocalMs - message.sentAtLocalMs, 10_000))
    state.lastPongAtMs = receivedAtLocalMs
    lastPongReceivedAtMs = receivedAtLocalMs
    setConnectionQuality(connectionQuality({
      connection: state.connection,
      roundTripMs: state.roundTripMs,
      clockUncertaintyMs: state.clockUncertaintyMs,
      lastPongAtMs: state.lastPongAtMs,
      nowMs: receivedAtLocalMs,
    }))
    sendToServer({ type: 'client_metrics', roundTripMs: receivedAtLocalMs - message.sentAtLocalMs })
    void persistState()
    notifyExtensionViews()
  }
}

function startPingLoop(): void {
  clearPingTimers()
  state.lastPongAtMs = Date.now()
  setConnectionQuality('unknown')
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
    setConnectionQuality('offline')
    socket.close(4001, 'heartbeat_timeout')
  }, 1_000)
}

// Sockets this client closed itself. A close is reported by the browser later, by which time the flag
// above has been reset, so who closed it is remembered with the socket.
const closedOnPurpose = new WeakSet<WebSocket>()

function closeOnPurpose(target: WebSocket | null, code: number, reason: string): void {
  if (!target)
    return
  closedOnPurpose.add(target)
  target.close(code, reason)
}

function clearPingTimers(): void {
  if (pingTimer)
    clearInterval(pingTimer)
  pingTimer = null
  if (heartbeatTimer)
    clearInterval(heartbeatTimer)
  heartbeatTimer = null
}

function stopPingLoop(): void {
  clearPingTimers()
  setConnectionQuality('offline')
}

/** Every change of connection quality is recorded, wherever it comes from, with the round trip it was seen at. */
function setConnectionQuality(next: ExtensionState['connectionQuality']): void {
  const previous = state.connectionQuality
  state.connectionQuality = next
  if (next !== previous)
    recordDiagnostic('connection', 'connection_quality', { from: previous, to: next, roundTripMs: state.roundTripMs })
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

/**
 * The room this client was in no longer exists on the coordinator. Leave it
 * the way a denied join request does (so nothing reconnects into it) and say
 * why, instead of leaving the last snapshot, or a waiting view, on screen.
 */
function endRoomBecauseGone(message: string): void {
  recordDiagnostic('connection', 'room_gone', {})
  leaveRoomWithNotice(message)
}

/**
 * Leaves the room and says why, in the side panel (through the published
 * error) and on the page the participant is watching, which has to hear it
 * although the side panel may be closed.
 *
 * leaveRoom() unbinds the player tab, after which sendToPlayerTab() has
 * nowhere to send to, so the binding is read first. The page is detached from
 * the room (by leaveRoom()) before it is told why. `roomEnded` marks the
 * notice as being about a room that is gone, which is what lets the page show
 * it without a room; an ordinary notice is only shown in a room.
 */
function leaveRoomWithNotice(message: string): void {
  const playerTabId = state.playerTabId
  const playerFrameId = state.playerFrameId
  const playerDocumentId = playerBinding?.documentId ?? undefined
  leaveRoom()
  state.lastError = message
  void publishState()
  if (playerTabId !== null && playerFrameId !== null)
    void sendToTab(playerTabId, { type: 'SHOW_NOTICE', message, roomEnded: true }, playerFrameId, playerDocumentId)
}

function leaveRoom(): void {
  const previousPlayerTabId = state.playerTabId
  const previousPlayerFrameId = state.playerFrameId
  const previousPlayerDocumentId = playerBinding?.documentId ?? undefined
  clearDeferredSeek(true)
  intentionallyClosed = true
  if (reconnectTimer)
    clearTimeout(reconnectTimer)
  reconnectTimer = null
  void chrome.alarms.clear(RECONNECT_ALARM_NAME)
  stopPingLoop()
  closeOnPurpose(socket, 1000, 'left_room')
  socket = null
  state.connection = 'disconnected'
  setConnectionQuality('offline')
  state.roundTripMs = null
  state.lastPongAtMs = 0
  state.snapshot = null
  clearPlayerTab()
  state.lastError = null
  state.lastOpenedNavigationRevision = 0
  lastControllerNavigationKey = null
  reconnectAttempts = 0
  outageStartedAtMs = null
  setTimeout(() => {
    intentionallyClosed = false
  }, 0)
  if (previousPlayerTabId !== null && previousPlayerFrameId !== null)
    void sendToTab(previousPlayerTabId, { type: 'APPLY_ROOM_STATE', state, bindingReleased: true }, previousPlayerFrameId, previousPlayerDocumentId)
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
    // There is no player to be had, so the room is told this participant is not
    // ready, as it is when another tab is looked at below, and the bound page,
    // if it is still there, is told it is not bound.
    if (state.snapshot)
      sendToServer({ type: 'set_ready', ready: false, media: null })
    await unbindPlayerContext()
    return false
  }

  if (state.playerTabId === tab.id
    && state.playerFrameId !== null
    && state.currentMedia
    && Date.now() - state.playerLastSeenAtMs < PLAYER_CONTEXT_STALE_MS)
    return true

  if (state.snapshot)
    sendToServer({ type: 'set_ready', ready: false, media: null })
  // Another tab is about to be asked to report, so the page that was bound is
  // detached without being released: a released page reports again within a
  // second, and with no room, or between this and the other tab's report, it
  // would take the binding straight back from the tab the user just selected.
  // It keeps its token and is freed by the request to report if it is the tab
  // that is asked, which is the only time it should compete again.
  await unbindPlayerContext(false)
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
      // The page answered, so it is alive and still holds its token; it is told
      // the binding is gone so that it can be bound again when it has media.
      await unbindPlayerContext()
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
  // An unapproved requester is not a member: the shared page is not theirs to
  // open. A current coordinator sends such a client no navigation at all; an
  // older one sends the whole room, link included, so check here as well. The
  // revision is not recorded, so the page is opened once the request is
  // approved.
  if (isAwaitingApproval({ participantId: state.participantId, snapshot }))
    return
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
  lastObservationIdentity = null
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
  if (bindingChanged)
    lastObservationIdentity = null
  const canTargetPreviousDocument = previousBinding?.documentId !== null && previousBinding?.documentId !== undefined
  const previousContextChanged = previousTabId !== tabId || previousFrameId !== frameId
  if (previousTabId !== null && previousFrameId !== null && bindingChanged && (previousContextChanged || canTargetPreviousDocument))
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, previousFrameId, previousBinding?.documentId ?? undefined)
  else if (previousTabId === tabId && previousFrameId === null && frameId !== null && frameId !== 0)
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState() }, 0)
}

async function unbindPlayerContext(release = true): Promise<void> {
  const previousTabId = state.playerTabId
  const previousFrameId = state.playerFrameId
  const previousDocumentId = playerBinding?.documentId ?? undefined
  clearPlayerTab()
  if (previousTabId !== null && previousFrameId !== null)
    await sendToTab(previousTabId, { type: 'APPLY_ROOM_STATE', state: detachedState(), ...(release ? { bindingReleased: true } : {}) }, previousFrameId, previousDocumentId)
}

/**
 * The room refused a scrub because someone was not ready. Keep it, tell the
 * page to leave the controller's player where it is, and send it again when
 * everyone is ready (or give up after DEFERRED_SEEK_MS).
 */
function deferSeek(rejected: SentControl): void {
  const snapshot = state.snapshot
  if (!snapshot)
    return
  const nowMs = Date.now()
  const expiresAtMs = deferredSeek?.expiresAtMs ?? rejected.carryExpiresAtMs ?? nowMs + DEFERRED_SEEK_MS
  deferredSeek = {
    positionSeconds: rejected.positionSeconds,
    expiresAtMs,
    roomId: snapshot.roomId,
    mediaId: snapshot.media?.canonicalId ?? null,
    phase: 'waiting',
    actionId: null,
  }
  if (deferredSeekTimer)
    clearTimeout(deferredSeekTimer)
  deferredSeekTimer = setTimeout(expireDeferredSeek, Math.max(0, expiresAtMs - nowMs))
  recordDiagnostic('control', 'seek_deferred', {
    positionSeconds: rejected.positionSeconds,
    waitMs: Math.max(0, expiresAtMs - nowMs),
    notReady: notReadySummary(snapshot.participants),
  })
  holdPlayerPage(expiresAtMs - nowMs)
  void sendToPlayerTab({ type: 'SHOW_NOTICE', message: 'Waiting for everyone to be ready, then the room moves to that position.' })
}

/**
 * The page keeps the controller's player where it is for `holdMs` and then lets
 * go by itself, so a worker that is suspended or restarted cannot leave it held.
 */
function holdPlayerPage(holdMs: number): void {
  void sendToPlayerTab({ type: 'CONTROLLER_SEEK_HOLD', held: true, holdMs: Math.max(0, Math.round(holdMs)) })
}

function clearDeferredSeek(releasePage: boolean, releaseHoldMs?: number): void {
  if (deferredSeekTimer)
    clearTimeout(deferredSeekTimer)
  deferredSeekTimer = null
  if (!deferredSeek)
    return
  deferredSeek = null
  if (releasePage)
    void sendToPlayerTab({ type: 'CONTROLLER_SEEK_HOLD', held: false, ...(releaseHoldMs === undefined ? {} : { releaseHoldMs }) })
}

/**
 * The controller decided something else while a scrub waited. The scrub is
 * dropped, but the room has not answered the newer control yet and still
 * shows the old position, so the page keeps its player where it is a moment.
 */
function supersedeDeferredSeek(): void {
  if (!deferredSeek)
    return
  if (deferredSeekTimer)
    clearTimeout(deferredSeekTimer)
  deferredSeekTimer = null
  deferredSeek = null
  holdPlayerPage(SUPERSEDED_SCRUB_HOLD_MS)
}

function expireDeferredSeek(): void {
  if (!deferredSeek)
    return
  recordDiagnostic('control', 'seek_deferred_expired', { positionSeconds: deferredSeek.positionSeconds })
  clearDeferredSeek(true)
  void sendToPlayerTab({ type: 'SHOW_NOTICE', message: 'The room did not move: someone was not ready. Press Sync to return to the room position.' })
}

/** Called with every room state this browser applies. */
function retryDeferredSeek(snapshot: RoomSnapshot): void {
  const pending = deferredSeek
  if (!pending)
    return
  if (Date.now() >= pending.expiresAtMs) {
    expireDeferredSeek()
    return
  }
  // Another room, another video or another controller: the scrub is not theirs.
  if (snapshot.controller.participantId !== state.participantId || !scrubBelongsTo(pending, snapshot)) {
    clearDeferredSeek(true)
    return
  }
  if (pending.phase === 'sent') {
    // Kept held until the room has the seek (or refuses it, or time runs out):
    // a snapshot that still shows the old position must not take the player back.
    if (roomHasAcceptedScrub(snapshot, pending.positionSeconds)) {
      recordDiagnostic('control', 'seek_deferred_accepted', { positionSeconds: pending.positionSeconds })
      // The page lets go only after it has been given the state that shows the
      // seek: released first, it would apply the room position it still has.
      void publishState().then(() => {
        if (deferredSeek === pending)
          clearDeferredSeek(true)
      })
    }
    return
  }
  if (!everyoneConnectedIsReady(snapshot.participants))
    return
  recordDiagnostic('control', 'seek_deferred_retry', { positionSeconds: pending.positionSeconds })
  pending.phase = 'sent'
  void sendControl('seek', pending.positionSeconds, { expiresAtMs: pending.expiresAtMs }).then((response) => {
    if (deferredSeek !== pending)
      return
    if (response.ok) {
      holdPlayerPage(Math.min(SCRUB_ANSWER_HOLD_MS, pending.expiresAtMs - Date.now()))
      return
    }
    // The connection was not there to send on: the scrub is still waiting.
    pending.phase = 'waiting'
    pending.actionId = null
  })
}

/** Why the room paused, resumed or was interrupted, whichever message carried the new state. */
function recordRoomStatusChange(previousPlayback: PlaybackState | null, snapshot: RoomSnapshot, reason: string): void {
  if (previousPlayback?.status === snapshot.playback.status && !ROOM_INTERRUPTION_REASONS.has(reason))
    return
  recordDiagnostic('room', 'room_status_changed', {
    from: previousPlayback?.status ?? 'none',
    to: snapshot.playback.status,
    reason: safeDiagnosticCode(reason),
    positionSeconds: snapshot.playback.positionSeconds,
    revision: snapshot.revision,
  })
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
  lastObservationIdentity = null
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

function recordRoomPositionJump(previousPlayback: PlaybackState | null, snapshot: RoomSnapshot, reason: string): void {
  const jump = roomPositionJump(previousPlayback, snapshot.playback, Date.now() + state.serverOffsetMs)
  if (!jump)
    return
  recordDiagnostic('room', 'room_position_changed', {
    fromSeconds: jump.fromSeconds,
    toSeconds: jump.toSeconds,
    reason: safeDiagnosticCode(reason),
    revision: snapshot.revision,
  }, { critical: true })
}

function recordDiagnostic(category: string, message: string, details: Record<string, DiagnosticValue> = {}, options: { critical?: boolean; reason?: DiagnosticReason } = {}): void {
  const atLocalMs = Date.now()
  const sanitizedDetails = Object.fromEntries(Object.entries(details).slice(0, 20).map(([key, value]) => [key.slice(0, 40), sanitizeDiagnosticValue(value)]))
  const isStatus = message === 'player_status'
  const signature = !COALESCED_DIAGNOSTIC_MESSAGES.has(message)
    ? null
    : isStatus ? diagnosticStatusSignature(sanitizedDetails) : JSON.stringify(sanitizedDetails)
  const critical = options.critical ?? (!isStatus || sanitizedDetails.playbackStartFailed === true || sanitizedDetails.buffering === true && sanitizedDetails.progressed === false)
  const previous = signature === null ? undefined : lastCoalescibleDiagnostics.get(message)
  if (previous && previous.signature === signature && diagnosticEvents.includes(previous.event)) {
    const merged = previous.event
    const repeatCount = typeof merged.details.repeatCount === 'number' ? merged.details.repeatCount : 1
    const firstAtLocalMs = typeof merged.details.firstAtLocalMs === 'number' ? merged.details.firstAtLocalMs : merged.atLocalMs
    merged.atLocalMs = atLocalMs
    if (critical)
      merged.critical = true
    merged.details = { ...sanitizedDetails, firstAtLocalMs, repeatCount: repeatCount + 1 }
    diagnosticEvents.splice(diagnosticEvents.indexOf(merged), 1)
    diagnosticEvents.push(merged)
    diagnosticEventsCoalesced += 1
    if (options.reason)
      lastDiagnosticReason = options.reason
    return
  }

  const event: DiagnosticEvent = {
    atLocalMs,
    category: category.slice(0, 40),
    message: message.slice(0, 100),
    details: sanitizedDetails,
    ...(critical ? { critical: true } : {}),
  }
  diagnosticEvents.push(event)
  if (DIAGNOSTIC_RUN_BOUNDARIES.has(message))
    lastCoalescibleDiagnostics.clear()
  if (signature !== null)
    lastCoalescibleDiagnostics.set(message, { event, signature })
  if (options.reason)
    lastDiagnosticReason = options.reason
  if (diagnosticEvents.length > DIAGNOSTIC_EVENT_LIMIT) {
    diagnosticEvents.splice(diagnosticEvictionIndex(diagnosticEvents), 1)
    diagnosticEventsDropped += 1
  }
}

function sanitizeDiagnosticValue(value: DiagnosticValue): DiagnosticValue {
  return typeof value === 'string' ? value.slice(0, 300) : value
}

function diagnosticStatusSignature(details: Record<string, DiagnosticValue>): string {
  return JSON.stringify([
    details.paused ?? null,
    details.buffering ?? null,
    details.progressed ?? null,
    details.progressEvidence ?? null,
    details.playbackStarted ?? null,
    details.playbackStartFailed ?? null,
    details.canPlay ?? null,
  ])
}

function safeDiagnosticCode(value: unknown): string {
  if (typeof value !== 'string')
    return 'unknown'
  const code = value.trim().slice(0, 80)
  return /^[a-z][a-z0-9_-]{1,79}$/.test(code) ? code : 'unknown'
}

function safeDiagnosticReason(value: unknown): DiagnosticReason | undefined {
  const reason = safeDiagnosticCode(value)
  const allowed = new Set<DiagnosticReason>([
    'none',
    'permission-denied',
    'interrupted',
    'provider-error',
    'player-missing',
    'waiting-for-data',
    'stalled',
    'startup-timeout',
    'connection-lost',
    'command-rejected',
    'server-error',
    'recovery-required',
    'unknown',
    'controller-request',
    'superseded',
    'deadline-expired',
    'participant-not-ready',
    'participant-disconnected',
    'media-changed',
    'binding-changed',
    'start-rejected',
    'start-timeout',
    'unsupported-peer',
    'legacy-peer',
    'stale-operation',
    'manual-recovery',
  ])
  return allowed.has(reason as DiagnosticReason) ? reason as DiagnosticReason : undefined
}

function buildDiagnosticsReport(): DiagnosticsReport {
  const sample = state.lastPlayerSample
  const operation = state.snapshot?.contract?.operation ?? null
  const bindingId = playerBinding?.id ?? null
  const observation = lastObservationIdentity?.bindingId === bindingId ? lastObservationIdentity : null
  const nowMs = Date.now()
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
    playerSeeking: typeof state.playerDiagnostics?.seeking === 'boolean' ? state.playerDiagnostics.seeking : null,
    playerErrorCode: sanitizeMediaErrorCode(state.playerDiagnostics?.errorCode),
    playerBufferedRangeCount: sanitizeRangeCount(state.playerDiagnostics?.bufferedRangeCount),
    playerBufferedRanges: sanitizeRangePairs(state.playerDiagnostics?.bufferedRanges, MAX_BUFFERED_PAIRS),
    playerSeekableRangeCount: sanitizeRangeCount(state.playerDiagnostics?.seekableRangeCount),
    playerSeekableRanges: sanitizeRangePairs(state.playerDiagnostics?.seekableRanges, MAX_SEEKABLE_PAIRS),
    playerBufferedAheadSeconds: sanitizeRangeSeconds(state.playerDiagnostics?.bufferedAheadSeconds),
    playerPendingSeekAgeMs: sanitizeElapsedMs(state.playerDiagnostics?.pendingSeekAgeMs),
    playerHasMediaKeys: typeof state.playerDiagnostics?.hasMediaKeys === 'boolean' ? state.playerDiagnostics.hasMediaKeys : null,
    sample: sample ? { ...sample } : null,
    events: diagnosticEvents.map(event => ({ ...event, details: { ...event.details } })),
    mediaEpoch: state.snapshot?.contract?.mediaEpoch ?? operation?.mediaEpoch ?? null,
    operationId: operation?.operationId ?? null,
    operationKind: operation?.kind ?? null,
    operationPhase: operation?.phase ?? null,
    bindingId,
    sourceGeneration: observation?.sourceGeneration ?? null,
    sampleSequence: observation?.sampleSequence ?? null,
    targetPositionSeconds: operation?.targetPositionSeconds ?? null,
    observedPositionSeconds: sample?.positionSeconds ?? null,
    progressConfidence: sample?.progressEvidence ?? null,
    observationAgeMs: sample ? Math.max(0, nowMs - sample.sampledAtLocalMs) : state.playerLastSeenAtMs > 0 ? Math.max(0, nowMs - state.playerLastSeenAtMs) : null,
    correctionCount: sample?.correctionCount ?? state.playerDiagnostics?.health?.correctionCount ?? 0,
    reason: operation?.reason ?? lastDiagnosticReason,
    eventsDropped: Math.min(diagnosticEventsDropped, MAX_REPORTED_DIAGNOSTIC_COUNT),
    eventsCoalesced: Math.min(diagnosticEventsCoalesced, MAX_REPORTED_DIAGNOSTIC_COUNT),
    payloadTruncated: false,
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
