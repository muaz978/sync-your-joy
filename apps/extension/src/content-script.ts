import type { MediaFingerprint, OperationAcknowledgement, PlaybackState, PlayerSample, RoomOperation } from '@syncyourjoy/protocol'
import type { ContentRequest, ExtensionState, PlayerContext, PlayerDiagnostics, PlayerOrigin, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { canApplySoftDriftCorrection, canConfirmSeek, chooseDriftCorrection, expectedPosition, isDuplicateSeekIntent, isPlaybackPastStartupGrace, isPlaybackRateAccepted, isSeekAligned, LOCAL_SEEK_MAX_WAIT_MS, SEEK_ACK_RETRY_MS, SEEK_COMPLETION_PROBE_MS, SEEK_INTENT_DEBOUNCE_MS, SEEK_RETRY_INTERVAL_MS } from '@syncyourjoy/sync-engine'
import { canonicalMediaId, cleanMediaTitle, normalizePageUrl, serviceName } from './media-fingerprint.ts'
import { resolveSeekTarget } from './media-seek.ts'
import { LOCAL_INTENT_HOLD_MS, shouldDeferAuthoritativeSync } from './player-intent.ts'
import { PlayerOperations, type OperationToken } from './player-operations.ts'
import { clearPlaybackStartFailed, createPlayerHealthState, markPlaybackStartFailed, markPlayerHealthBuffering, observePlayerHealth, resetPlayerHealthBaseline, type PlayerHealthState } from './player-health.ts'
import { decidePlayerIdentity } from './player-identity.ts'
import { hasUsableVideoSource, shouldBootstrapClickToLoadPlayer } from './site-adapter.ts'
import { miniControllerView } from './mini-controller-state.ts'
import { mediaLossGraceMs } from './readiness-state.ts'
import { discoverOpenShadowRoots, discoverVideoElements } from './video-discovery.ts'

const PLAYER_SCAN_INTERVAL_MS = 2_000
const SAMPLE_INTERVAL_MS = 1_000
const MEDIA_HEARTBEAT_INTERVAL_MS = 1_000
const SEEK_RECOVERY_GRACE_MS = 2_500
const SOFT_CORRECTION_MAX_MS = 2_500
const PLAYER_PILL_LAYER = '2147483600'
const MINI_CONTROLLER_HIDDEN_KEY = 'syncYourJoyMiniControllerHidden'

let video: HTMLVideoElement | null = null
let activeState: ExtensionState | null = null
// The worker issues this opaque token after accepting the document's first
// media report. It is intentionally local to this content-script instance and
// is attached automatically to subsequent sender-bound messages.
let playerBindingId: string | null = null
let runtimeInvalidated = false
let scheduledPlayTimer: ReturnType<typeof setTimeout> | null = null
let bufferingTimer: ReturnType<typeof setTimeout> | null = null
let rateResetTimer: ReturnType<typeof setTimeout> | null = null
let lastFingerprintKey = ''
let lastMediaReportAt = 0
let localSeeking = false
let localIntentHoldUntil = 0
let expectedPlayUntil = 0
let expectedPauseUntil = 0
let expectedSeek: { positionSeconds: number; until: number } | null = null
let pendingSeek: { token: OperationToken; positionSeconds: number; since: number; lastAttemptAt: number; roomRevision: number | null; timedOut?: boolean } | null = null
let seekRecoveryUntil = 0
let hardCorrectionAttempted = false
let playbackRecoveryRequested = false
let softCorrectionAttempted = false
let softCorrectionActive = false
let softCorrectionStartedAt = 0
let softCorrectionRate = 1
let completedRoomSeekRevision = 0
let seekAckInFlightRevision = 0
let seekCompletionTimer: ReturnType<typeof setTimeout> | null = null
let seekAckRetryTimer: ReturnType<typeof setTimeout> | null = null
let lastControllerSeekPosition: number | null = null
let lastControllerSeekSentAt = 0
let seekIntentTimer: ReturnType<typeof setTimeout> | null = null
let pendingControllerSeekTarget: number | null = null
let playerHealth: PlayerHealthState = createPlayerHealthState({ nowMs: performance.now(), positionSeconds: 0, frames: null })
const playerOperations = new PlayerOperations()
let playbackStarted = false
let siteBootstrapAttempts = 0
let lastSiteBootstrapAt = 0
let playerScanTimer: ReturnType<typeof setTimeout> | null = null
let mediaLossTimer: ReturnType<typeof setTimeout> | null = null
let miniControllerHidden = false
let lockedVideo: HTMLVideoElement | null = null
let lastObservedPageIdentity = normalizePageUrl(new URL(location.href))
const playerObservers = new Map<Node, MutationObserver>()
let transactionalStartTimer: ReturnType<typeof setTimeout> | null = null
let transactionalActiveKey: string | null = null
let transactionalPlayAttemptKey: string | null = null
let transactionalPlayResolvedKey: string | null = null
let transactionalPreparedKey: string | null = null
let transactionalStartedKey: string | null = null
let transactionalAckInFlightKey: string | null = null
let transactionalSampleSequence = 0

const pillHost = document.createElement('div')
pillHost.id = 'sync-your-joy-root'
pillHost.style.position = 'fixed'
pillHost.style.right = '20px'
pillHost.style.bottom = '20px'
pillHost.style.zIndex = PLAYER_PILL_LAYER
pillHost.style.display = 'none'
const shadow = pillHost.attachShadow({ mode: 'closed' })
shadow.innerHTML = `
  <style>
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    .pill {
      --surface: #e9eef5;
      --ink: #1e293b;
      --muted: #64748b;
      --accent: #267d74;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      width: min(390px, calc(100vw - 32px));
      padding: 9px 10px;
      border: 1px solid rgb(100 116 139 / 18%);
      border-radius: 16px;
      background: var(--surface);
      color: var(--ink);
      box-shadow: 7px 7px 18px rgb(15 23 42 / 25%), -4px -4px 14px rgb(248 250 252 / 40%);
      font: 500 13px/1.25 "Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .mark {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border-radius: 11px;
      background: var(--accent);
      color: #f8fafc;
      box-shadow: inset 0 0 0 1px rgb(255 255 255 / 14%);
    }
    .mark svg { width: 18px; height: 18px; }
    .copy { min-width: 0; }
    .status { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
    .meta { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
    .actions { display: flex; gap: 6px; }
    button {
      min-width: 40px;
      min-height: 40px;
      border: 1px solid rgb(100 116 139 / 18%);
      border-radius: 12px;
      background: var(--surface);
      color: var(--ink);
      box-shadow: 3px 3px 7px rgb(15 23 42 / 18%), -2px -2px 6px rgb(248 250 252 / 46%);
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { color: var(--accent); }
    button:disabled { cursor: not-allowed; opacity: 0.5; transform: none; }
    button:focus-visible { outline: 2px solid #42a99d; outline-offset: 2px; }
    button:active { transform: translateY(1px); box-shadow: inset 2px 2px 5px rgb(15 23 42 / 16%); }
    button[hidden] { display: none; }
    .pill[hidden], .restore[hidden] { display: none; }
    .hide-button {
      min-width: 34px;
      width: 34px;
      padding: 0;
      font-size: 17px;
    }
    .restore {
      width: 42px;
      min-width: 42px;
      height: 42px;
      min-height: 42px;
      display: grid;
      place-items: center;
      border-radius: 14px 0 0 14px;
      background: var(--surface, #e9eef5);
      color: var(--accent, #267d74);
    }
    .restore svg { width: 20px; height: 20px; }
    .notice { grid-column: 1 / -1; margin: 0 2px 2px; color: #a15c10; font-size: 11px; }
    .notice:empty { display: none; }
    @media (prefers-color-scheme: dark) {
      .pill {
        --surface: #171d26;
        --ink: #e2e8f0;
        --muted: #94a3b8;
        --accent: #69c4b8;
        box-shadow: 7px 7px 18px rgb(2 6 23 / 48%), -3px -3px 12px rgb(51 65 85 / 30%);
      }
      button { box-shadow: 3px 3px 7px rgb(2 6 23 / 45%), -2px -2px 6px rgb(51 65 85 / 24%); }
      .restore { background: #171d26; color: #69c4b8; }
      .mark { color: #0f172a; }
      .notice { color: #f3b562; }
    }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  </style>
  <section class="pill" role="status" aria-live="polite" aria-label="SyncYourJoy room status">
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M8.5 14.5 6 17a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0"/>
        <path d="m15.5 9.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"/>
        <path d="m8 16 8-8"/>
      </svg>
    </span>
    <span class="copy">
      <span class="status" id="syj-status">Connected</span>
      <span class="meta" id="syj-meta">Waiting for room state</span>
    </span>
    <span class="actions">
      <button id="syj-sync" type="button">Sync</button>
      <button id="syj-playback" type="button">Pause</button>
      <button id="syj-room" type="button">Room</button>
      <button class="hide-button" id="syj-hide" type="button" aria-label="Hide SyncYourJoy controller" title="Hide controller">&#8722;</button>
    </span>
    <p class="notice" id="syj-notice"></p>
  </section>
  <button class="restore" id="syj-restore" type="button" aria-label="Show SyncYourJoy controller" title="Show SyncYourJoy controller" hidden>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
      <path d="M8.5 14.5 6 17a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0"/>
      <path d="m15.5 9.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"/>
      <path d="m8 16 8-8"/>
    </svg>
  </button>
`

document.documentElement.append(pillHost)

const statusElement = shadow.querySelector<HTMLElement>('#syj-status')
const metaElement = shadow.querySelector<HTMLElement>('#syj-meta')
const noticeElement = shadow.querySelector<HTMLElement>('#syj-notice')
const playbackButton = shadow.querySelector<HTMLButtonElement>('#syj-playback')
const syncButton = shadow.querySelector<HTMLButtonElement>('#syj-sync')
const roomButton = shadow.querySelector<HTMLButtonElement>('#syj-room')
const pillElement = shadow.querySelector<HTMLElement>('.pill')
const hideButton = shadow.querySelector<HTMLButtonElement>('#syj-hide')
const restoreButton = shadow.querySelector<HTMLButtonElement>('#syj-restore')

void chrome.storage.local.get(MINI_CONTROLLER_HIDDEN_KEY).then((stored) => {
  miniControllerHidden = stored[MINI_CONTROLLER_HIDDEN_KEY] === true
  renderPill()
}).catch(() => undefined)

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[MINI_CONTROLLER_HIDDEN_KEY])
    return
  miniControllerHidden = changes[MINI_CONTROLLER_HIDDEN_KEY].newValue === true
  renderPill()
})

roomButton?.addEventListener('click', () => {
  void sendRuntime({ type: 'OPEN_PANEL' })
})

playbackButton?.addEventListener('click', () => {
  if (!video || !activeState?.snapshot)
    return
  if (video.paused) {
    const operation = currentTransactionalOperation()
    if (operation?.phase === 'committed' && operation.resumeWhenReady !== false)
      activateSynchronizedPlayback()
    else {
      void video.play().catch(() => {
        renderPill()
        showNotice('Press Sync once so Chrome can allow synchronized play.')
      })
    }
  }
  else {
    video.pause()
  }
})

syncButton?.addEventListener('click', () => {
  forceSyncToRoom(true)
})

hideButton?.addEventListener('click', () => {
  setMiniControllerHidden(true)
})

restoreButton?.addEventListener('click', () => {
  setMiniControllerHidden(false)
})

chrome.runtime.onMessage.addListener((message: RuntimeEvent | ContentRequest, _sender, sendResponse) => {
  if (message.type === 'GET_PLAYER_CONTEXT') {
    sendResponse(currentPlayerContext())
    return false
  }

  if (message.type === 'LOCK_PLAYER') {
    if (video) {
      lockedVideo = video
      renderPill()
      void reportMedia(video)
    }
    return false
  }

  if (message.type === 'UNLOCK_PLAYER') {
    lockedVideo = null
    scanForPlayer()
    return false
  }

  if (message.type === 'REPORT_PLAYER_CONTEXT') {
    if (video) {
      void reportMedia(video)
      void reportPlayerStatus(false)
    }
    sendResponse(currentPlayerContext())
    return false
  }

  if (message.type === 'APPLY_ROOM_STATE') {
    const previousSnapshot = activeState?.snapshot
    const previousRevision = previousSnapshot?.revision ?? -1
    const commandChanged = playbackCommandChanged(previousSnapshot?.playback, message.state.snapshot?.playback)
    const controllerChanged = previousSnapshot?.controller.participantId !== message.state.snapshot?.controller.participantId
      || previousSnapshot?.controller.leaseEpoch !== message.state.snapshot?.controller.leaseEpoch
    const roomDetached = previousSnapshot !== undefined && message.state.snapshot === null
    const pendingSeekSuperseded = pendingSeek !== null
      && (pendingSeek.roomRevision !== null
        ? message.state.snapshot?.seek?.revision !== pendingSeek.roomRevision
        : commandChanged)
    activeState = message.state
    if (pendingSeekSuperseded || commandChanged || controllerChanged || roomDetached) {
      // The room may release a shared barrier before the browser finishes its
      // native seek. Keep a short-lived attribution window for that target so
      // the late `seeked` event cannot be mistaken for a fresh controller
      // scrub. A genuinely different native target clears this expectation
      // through handleSeeking() and is still propagated normally.
      invalidateRoomOperations()
    }
    if (commandChanged) {
      invalidatePlayRequest()
      restorePlaybackRate()
      resetCorrectionBudget()
      resetPlaybackHealthBaseline()
    }
    if ((message.state.snapshot?.revision ?? -1) > previousRevision)
      localIntentHoldUntil = 0
    if (message.state.lastError)
      localIntentHoldUntil = 0
    renderPill()
    applyAuthoritativeState()
    if (!video)
      scanForPlayer()
  }
  else if (message.type === 'PAUSE_LOCAL') {
    invalidateRoomOperations()
    clearScheduledPlay()
    holdLocalControllerIntent()
    if (video && !video.paused) {
      expectPauseEvent()
      video.pause()
    }
  }
  else if (message.type === 'FORCE_SYNC') {
    forceSyncToRoom(false)
  }
  else if (message.type === 'SHOW_NOTICE') {
    showNotice(message.message)
  }
  return false
})

void sendRuntime({ type: 'GET_STATE' }).then((response) => {
  activeState = response.state
  renderPill()
  applyAuthoritativeState()
  if (!video)
    scanForPlayer()
})

scanForPlayer()
const playerScanIntervalId = setInterval(scanForPlayer, PLAYER_SCAN_INTERVAL_MS)
const pageIdentityIntervalId = setInterval(observePageIdentity, 500)
window.addEventListener('popstate', observePageIdentity)
window.addEventListener('hashchange', observePageIdentity)
refreshPlayerObservers()
const sampleIntervalId = setInterval(() => {
  if (!video)
    return
  observePageIdentity()
  void reportPlayerStatus(false)
  applyAuthoritativeState()
}, SAMPLE_INTERVAL_MS)

function recoverAfterPageVisibilityChange(): void {
  resetPlaybackHealthBaseline(true)
  schedulePlayerScan()
  if (video) {
    void reportMedia(video)
    void reportPlayerStatus(false)
    applyAuthoritativeState()
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible')
    recoverAfterPageVisibilityChange()
})
window.addEventListener('pageshow', recoverAfterPageVisibilityChange)

document.addEventListener('fullscreenchange', () => {
  const target = document.fullscreenElement
  if (target instanceof HTMLElement)
    target.append(pillHost)
  else
    document.documentElement.append(pillHost)
})

function scanForPlayer(): void {
  observePageIdentity()
  refreshPlayerObservers()
  const candidate = findPrimaryVideo()
  if (!candidate) {
    maybeBootstrapSitePlayer()
    scheduleMediaLossConfirmation()
    return
  }

  clearMediaLossConfirmation()
  if (candidate === video) {
    reportMediaIfChanged(candidate)
    return
  }

  const previousVideo = video
  detachPlayer(previousVideo)
  if (previousVideo && !previousVideo.paused)
    previousVideo.pause()
  video = candidate
  lastFingerprintKey = ''
  lastMediaReportAt = 0
  attachPlayer(candidate)
  reportMediaIfChanged(candidate)
  void reportPlayerStatus(false)
}

function scheduleMediaLossConfirmation(): void {
  if (!video || mediaLossTimer)
    return
  const me = activeState?.snapshot?.participants.find(participant => participant.id === activeState?.participantId)
  mediaLossTimer = setTimeout(() => {
    mediaLossTimer = null
    if (findPrimaryVideo()) {
      scanForPlayer()
      return
    }
    const lostVideo = video
    detachPlayer(lostVideo)
    video = null
    lastFingerprintKey = ''
    lastMediaReportAt = 0
    renderPill()
    void sendRuntime({ type: 'MEDIA_LOST' })
  }, mediaLossGraceMs(me?.ready ?? false))
}

function clearMediaLossConfirmation(): void {
  if (mediaLossTimer)
    clearTimeout(mediaLossTimer)
  mediaLossTimer = null
}

function schedulePlayerScan(): void {
  if (playerScanTimer)
    clearTimeout(playerScanTimer)
  playerScanTimer = setTimeout(() => {
    playerScanTimer = null
    scanForPlayer()
  }, 25)
}

function refreshPlayerObservers(): void {
  const roots: Array<Document | ShadowRoot> = [document, ...discoverOpenShadowRoots(document)]
  const currentRoots = new Set<Node>(roots)
  for (const root of roots) {
    if (playerObservers.has(root))
      continue
    const observer = new MutationObserver(schedulePlayerScan)
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'src', 'hidden'],
    })
    playerObservers.set(root, observer)
  }
  for (const [root, observer] of playerObservers) {
    if (currentRoots.has(root))
      continue
    observer.disconnect()
    playerObservers.delete(root)
  }
}

function observePageIdentity(): void {
  let currentIdentity: string | null = null
  try {
    currentIdentity = normalizePageUrl(new URL(location.href))
  }
  catch {
    return
  }
  if (currentIdentity === lastObservedPageIdentity)
    return
  lastObservedPageIdentity = currentIdentity
  resetPlayerOperations()
  resetPlaybackHealthBaseline()
  lastFingerprintKey = ''
  lastMediaReportAt = 0
  if (video) {
    reportMediaIfChanged(video)
    void reportPlayerStatus(false)
  }
}

function reportMediaIfChanged(target: HTMLVideoElement): void {
  const media = createMediaFingerprint(target)
  const key = JSON.stringify(media)
  const now = performance.now()
  if (key === lastFingerprintKey && now - lastMediaReportAt < MEDIA_HEARTBEAT_INTERVAL_MS)
    return
  lastFingerprintKey = key
  lastMediaReportAt = now
  void reportMedia(target, media)
}

async function reportMedia(target: HTMLVideoElement, media = createMediaFingerprint(target)): Promise<void> {
  await sendRuntime({
    type: 'MEDIA_DETECTED',
    media,
    areaPixels: Math.max(0, target.clientWidth * target.clientHeight),
    diagnostics: playerDiagnostics(target),
  })
}

function findPrimaryVideo(): HTMLVideoElement | null {
  const videos = discoverVideoElements(document)
    .filter(item => item instanceof HTMLVideoElement && isVisibleVideo(item))
  if (lockedVideo) {
    if (videos.includes(lockedVideo))
      return lockedVideo
    lockedVideo = null
  }
  return videos.sort((a, b) => videoCandidateScore(b) - videoCandidateScore(a))[0] ?? null
}

function isVisibleVideo(target: HTMLVideoElement): boolean {
  if (!target.isConnected)
    return false
  if (!hasUsableVideoSource(
    target.currentSrc,
    target.getAttribute('src'),
    target.querySelector('source[src]')?.getAttribute('src') ?? null,
    target.srcObject !== null,
    target.readyState,
    target.networkState,
  ))
    return false
  const style = getComputedStyle(target)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)
    return false
  const rectangle = target.getBoundingClientRect()
  return rectangle.width > 1 && rectangle.height > 1
}

function videoCandidateScore(target: HTMLVideoElement): number {
  const rectangle = target.getBoundingClientRect()
  const viewportWidth = Math.max(0, Math.min(rectangle.right, innerWidth) - Math.max(rectangle.left, 0))
  const viewportHeight = Math.max(0, Math.min(rectangle.bottom, innerHeight) - Math.max(rectangle.top, 0))
  const visibleArea = viewportWidth * viewportHeight
  const sourceBonus = target.currentSrc ? 100_000 : 0
  const readyBonus = target.readyState >= HTMLMediaElement.HAVE_METADATA ? 50_000 : 0
  const activeBonus = !target.paused && !target.ended ? 200_000 : 0
  return visibleArea + sourceBonus + readyBonus + activeBonus
}

function attachPlayer(target: HTMLVideoElement): void {
  playbackStarted = !target.paused && target.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  resetPlaybackHealthBaseline()
  target.addEventListener('play', handlePlay)
  target.addEventListener('pause', handlePause)
  target.addEventListener('seeking', handleSeeking)
  target.addEventListener('seeked', handleSeeked)
  target.addEventListener('timeupdate', handleTimeUpdate)
  target.addEventListener('ended', handleEnded)
  target.addEventListener('waiting', handleBuffering)
  target.addEventListener('stalled', handleBuffering)
  target.addEventListener('playing', handleCanPlay)
  target.addEventListener('canplay', handleCanPlay)
  target.addEventListener('loadedmetadata', handleMediaReady)
  target.addEventListener('loadeddata', handleMediaReady)
  target.addEventListener('durationchange', handleMediaReady)
  target.addEventListener('progress', handleMediaReady)
  target.addEventListener('loadstart', handleMediaLifecycle)
  target.addEventListener('emptied', handleMediaLifecycle)
  target.addEventListener('error', handleMediaLifecycle)
  renderPill()
}

function detachPlayer(target: HTMLVideoElement | null): void {
  if (!target)
    return
  target.removeEventListener('play', handlePlay)
  target.removeEventListener('pause', handlePause)
  target.removeEventListener('seeking', handleSeeking)
  target.removeEventListener('seeked', handleSeeked)
  target.removeEventListener('timeupdate', handleTimeUpdate)
  target.removeEventListener('ended', handleEnded)
  target.removeEventListener('waiting', handleBuffering)
  target.removeEventListener('stalled', handleBuffering)
  target.removeEventListener('playing', handleCanPlay)
  target.removeEventListener('canplay', handleCanPlay)
  target.removeEventListener('loadedmetadata', handleMediaReady)
  target.removeEventListener('loadeddata', handleMediaReady)
  target.removeEventListener('durationchange', handleMediaReady)
  target.removeEventListener('progress', handleMediaReady)
  target.removeEventListener('loadstart', handleMediaLifecycle)
  target.removeEventListener('emptied', handleMediaLifecycle)
  target.removeEventListener('error', handleMediaLifecycle)
  resetPlayerOperations()
}

function invalidatePlayRequest(): void {
  playerOperations.retirePlay()
  expectedPlayUntil = 0
  playerHealth = clearPlaybackStartFailed(playerHealth)
}

function invalidateRoomOperations(sourceChanged = false): void {
  const retiredTarget = pendingSeek?.positionSeconds
  if (sourceChanged)
    playerOperations.invalidateSource(performance.now())
  else
    playerOperations.invalidateCommand(performance.now())
  pendingSeek = null
  clearSeekCompletionTimer()
  if (seekIntentTimer)
    clearTimeout(seekIntentTimer)
  seekIntentTimer = null
  pendingControllerSeekTarget = null
  clearScheduledPlay()
  clearTransactionalStartTimer()
  expectedSeek = retiredTarget === undefined
    ? null
    : { positionSeconds: retiredTarget, until: performance.now() + 4_000 }
  transactionalPlayAttemptKey = null
  transactionalPlayResolvedKey = null
  transactionalAckInFlightKey = null
  invalidatePlayRequest()
}

function resetPlayerOperations(): void {
  invalidateRoomOperations(true)
  clearScheduledPlay()
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = null
  restorePlaybackRate()
  if (seekIntentTimer)
    clearTimeout(seekIntentTimer)
  seekIntentTimer = null
  pendingControllerSeekTarget = null
  localSeeking = false
  localIntentHoldUntil = 0
  seekRecoveryUntil = 0
  expectedSeek = null
  expectedPauseUntil = 0
  completedRoomSeekRevision = 0
  seekAckInFlightRevision = 0
  lastControllerSeekPosition = null
  playbackStarted = false
  clearSeekCompletionTimer()
  clearSeekAckRetryTimer()
  resetCorrectionBudget()
}

function resetCorrectionBudget(): void {
  hardCorrectionAttempted = false
  playbackRecoveryRequested = false
  softCorrectionAttempted = false
  softCorrectionActive = false
  softCorrectionStartedAt = 0
  softCorrectionRate = 1
}

function requestBoundedPlaybackRecovery(): void {
  if (!video || playbackRecoveryRequested)
    return
  restorePlaybackRate()
  playbackRecoveryRequested = true
  showNotice('Playback could not converge. Press Sync to retry without refreshing.')
  if (!video.paused) {
    expectPauseEvent()
    video.pause()
  }
  void reportPlayerStatus(true)
}

function handlePlay(): void {
  if (!currentEpisodeMatchesRoom())
    return
  resetPlaybackHealthBaseline()
  playbackStarted = false
  playerHealth = clearPlaybackStartFailed(playerHealth)
  const expected = consumeExpectedPlay()
  const transactionalOperation = currentTransactionalOperation()
  if (!expected && transactionalOperation?.phase === 'committed' && transactionalOperation.resumeWhenReady !== false) {
    // A direct player gesture can recover an autoplay rejection without a
    // second extension-side play() call. Treat this native play event as the
    // current transaction attempt, but still wait for real progress before
    // acknowledging started.
    const key = transactionalOperationKey(transactionalOperation)
    transactionalPlayAttemptKey = key
    transactionalPlayResolvedKey = key
  }
  if (!expected && video && isLocalController() && activeState?.snapshot?.seek) {
    expectPauseEvent()
    video.pause()
    showNotice('Finishing the room seek before playback resumes…')
  }
  else if (expected) {
    renderPill()
  }
  else if (video) {
    holdLocalControllerIntent()
    void sendRuntime({ type: 'PLAYER_INTENT', kind: 'play', positionSeconds: video.currentTime })
  }
  renderPill()
  void reportPlayerStatus(false)
}

function handlePause(): void {
  if (!currentEpisodeMatchesRoom())
    return
  restorePlaybackRate()
  if (consumeExpectedPause()) {
    // Programmatic pause already reflects the authoritative room state.
  }
  else if (video && !video.ended) {
    holdLocalControllerIntent()
    void sendRuntime({ type: 'PLAYER_INTENT', kind: 'pause', positionSeconds: video.currentTime })
  }
  renderPill()
  void reportPlayerStatus(false)
}

function handleSeeking(): void {
  if (!currentEpisodeMatchesRoom())
    return
  restorePlaybackRate()
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = null
  if (!hasExpectedSeek() && isLocalController()) {
    // A real scrub/Skip Intro to another destination supersedes the old
    // operation, even inside its event-suppression window.
    invalidateRoomOperations()
    localSeeking = true
    scheduleControllerSeekIntent()
  }
}

function handleSeeked(): void {
  if (!currentEpisodeMatchesRoom())
    return
  const attribution = video
    ? playerOperations.classifySeekEvent(video.currentTime, performance.now())
    : 'user'
  const completedPending = video && pendingSeek && isSeekAligned(video.currentTime, pendingSeek.positionSeconds)
    && playerOperations.isCurrentSeek(pendingSeek.token)
    ? pendingSeek
    : null
  const programmatic = attribution !== 'user' || completedPending !== null || consumeExpectedSeek()
  const shouldSend = !programmatic && video && isLocalController()
  const completedNativePosition = shouldSend && video ? finiteOrZero(video.currentTime) : null
  localSeeking = false
  if (completedPending) {
    completePendingSeek(completedPending)
  }
  if (completedNativePosition !== null) {
    holdLocalControllerIntent()
    scheduleControllerSeekIntent(completedNativePosition)
  }
  else if (attribution === 'user' || completedPending !== null) {
    applyAuthoritativeState()
  }
  else if (attribution === 'active') {
    scheduleSeekCompletionProbe()
  }
  maybeAcknowledgeRoomSeek()
  void reportPlayerStatus(false)
}

function handleTimeUpdate(): void {
  if (localSeeking && isLocalController())
    scheduleControllerSeekIntent()
}

function scheduleControllerSeekIntent(explicitPosition?: number): void {
  if (!video || !isLocalController() || !currentEpisodeMatchesRoom())
    return
  pendingControllerSeekTarget = finiteOrZero(explicitPosition ?? video.currentTime)
  const intentGeneration = playerOperations.snapshot()
  if (seekIntentTimer)
    clearTimeout(seekIntentTimer)
  seekIntentTimer = setTimeout(() => {
    seekIntentTimer = null
    if (!video || !playerOperations.isCurrentGeneration(intentGeneration) || !isLocalController() || !currentEpisodeMatchesRoom()) {
      pendingControllerSeekTarget = null
      return
    }
    const positionSeconds = pendingControllerSeekTarget ?? finiteOrZero(video.currentTime)
    pendingControllerSeekTarget = null
    const now = performance.now()
    localSeeking = false
    if (isDuplicateSeekIntent({
      positionSeconds,
      lastPositionSeconds: lastControllerSeekPosition,
      nowMs: now,
      lastSentAtMs: lastControllerSeekSentAt,
    }))
      return
    lastControllerSeekPosition = positionSeconds
    lastControllerSeekSentAt = now
    holdLocalControllerIntent()
    void sendRuntime({ type: 'PLAYER_INTENT', kind: 'seek', positionSeconds })
  }, SEEK_INTENT_DEBOUNCE_MS)
}

function handleEnded(): void {
  if (!video || !isLocalController() || !currentEpisodeMatchesRoom())
    return
  holdLocalControllerIntent()
  void sendRuntime({ type: 'PLAYER_INTENT', kind: 'pause', positionSeconds: video.currentTime })
}

function handleBuffering(): void {
  restorePlaybackRate()
  playerHealth = markPlayerHealthBuffering(playerHealth)
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = setTimeout(() => {
    bufferingTimer = null
    if (video?.seeking || localSeeking || activeState?.snapshot?.playback.status !== 'playing')
      return
    void reportPlayerStatus(true)
  }, 700)
}

function handleCanPlay(): void {
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = null
  if (video && !video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    playbackStarted = true
    playerHealth = clearPlaybackStartFailed(playerHealth)
  }
  maybeCompletePendingSeek()
  applyAuthoritativeState()
  maybeAcknowledgeRoomSeek()
  void reportPlayerStatus(false)
}

function handleMediaReady(): void {
  maybeCompletePendingSeek()
  applyAuthoritativeState()
  maybeAcknowledgeRoomSeek()
}

function handleMediaLifecycle(): void {
  resetPlayerOperations()
  resetPlaybackHealthBaseline()
  lastFingerprintKey = ''
  lastMediaReportAt = 0
  schedulePlayerScan()
  if (video)
    reportMediaIfChanged(video)
}

async function reportPlayerStatus(buffering: boolean): Promise<void> {
  const snapshot = activeState?.snapshot
  if (!video || !snapshot || !currentEpisodeMatchesRoom())
    return
  const seekPendingTooLong = pendingSeek !== null && performance.now() - pendingSeek.since >= 1_500
  const previousBuffering = playerHealth.buffering
  playerHealth = observePlayerHealth(playerHealth, {
    nowMs: performance.now(),
    positionSeconds: finiteOrZero(video.currentTime),
    frames: presentedFrameCount(video),
    paused: video.paused,
    seeking: video.seeking,
    localSeeking: localSeeking || pendingSeek !== null,
    roomPlaying: snapshot.playback.status === 'playing',
    playShouldHaveStarted: isPlaybackPastStartupGrace(snapshot.playback, Date.now() + (activeState?.serverOffsetMs ?? 0)),
    lacksPlayableData: video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA,
    explicitlyBuffering: buffering || seekPendingTooLong,
    localIntentHold: isLocalController() && performance.now() < localIntentHoldUntil,
  })
  if (playerHealth.buffering && !previousBuffering) {
    showNotice(video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ? 'This player stopped. The room is pausing, press Sync to recover without refreshing.'
      : 'Playback stopped advancing. The room is pausing, press Sync to recover.')
  }
  const sample = currentPlayerSample(video)
  renderPill()
  await sendRuntime({ type: 'PLAYER_STATUS', basedOnRevision: snapshot.revision, sample })
}

function currentPlayerContext(): PlayerContext {
  if (!video)
    return { media: null, sample: null, diagnostics: null }
  return {
    media: createMediaFingerprint(video),
    diagnostics: playerDiagnostics(video),
    sample: currentPlayerSample(video),
  }
}

function currentPlayerSample(target: HTMLVideoElement): PlayerSample {
  return {
    positionSeconds: finiteOrZero(target.currentTime),
    durationSeconds: Number.isFinite(target.duration) ? target.duration : null,
    paused: target.paused,
    buffering: playerHealth.buffering,
    sampledAtLocalMs: Date.now(),
    progressed: playerHealth.progressed,
    progressEvidence: playerHealth.progressEvidence,
    playbackStartFailed: playerHealth.playbackStartFailed,
    playbackStarted: playbackStarted || (!target.paused && target.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA),
  }
}

function playerDiagnostics(target: HTMLVideoElement): PlayerDiagnostics {
  let currentSrcKind: PlayerDiagnostics['currentSrcKind'] = 'none'
  const currentSrc = target.currentSrc.trim()
  if (currentSrc) {
    try {
      const protocol = new URL(currentSrc, location.href).protocol
      currentSrcKind = protocol === 'http:' ? 'http'
        : protocol === 'https:' ? 'https'
          : protocol === 'blob:' ? 'blob'
            : protocol === 'data:' ? 'data'
              : 'other'
    }
    catch {
      currentSrcKind = 'other'
    }
  }
  const rootNode = target.getRootNode()
  const origin: PlayerOrigin = rootNode instanceof ShadowRoot ? 'open-shadow-dom' : 'light-dom'
  return {
    origin,
    readyState: target.readyState,
    networkState: target.networkState,
    currentSrcKind,
    hasSourceObject: target.srcObject !== null,
    health: {
      buffering: playerHealth.buffering,
      progressEvidence: playerHealth.progressEvidence,
      hasRealPlaybackProgress: playerHealth.hasRealPlaybackProgress,
      playbackStartFailed: playerHealth.playbackStartFailed,
    },
    locked: lockedVideo === target,
  }
}

function applyAuthoritativeState(): void {
  const snapshot = activeState?.snapshot
  if (!activeState || !snapshot)
    return

  const transactionalOperation = currentTransactionalOperation()
  if (transactionalOperation && applyTransactionalOperation(transactionalOperation))
    return

  if (!video)
    return

  // A same-tab episode transition can precede the worker's media heartbeat.
  // Never move the new Crunchyroll episode to the old episode's room time.
  if (!currentEpisodeMatchesRoom()) {
    clearScheduledPlay()
    invalidatePlayRequest()
    return
  }

  if (shouldDeferAuthoritativeSync({
    isController: isLocalController(),
    isSeeking: localSeeking,
    holdUntil: localIntentHoldUntil,
    now: performance.now(),
  }))
    return

  const estimatedServerNowMs = Date.now() + activeState.serverOffsetMs
  const expectedSeconds = expectedPosition(snapshot.playback, estimatedServerNowMs)

  if (snapshot.playback.status === 'paused') {
    clearScheduledPlay()
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    const targetSeconds = snapshot.seek?.positionSeconds ?? expectedSeconds
    if (snapshot.seek || Math.abs(video.currentTime - targetSeconds) > 0.25)
      trySetProgrammaticPosition(targetSeconds, snapshot.seek?.revision ?? null)
    restorePlaybackRate()
    maybeAcknowledgeRoomSeek()
    return
  }

  // Let an adaptive player finish fetching/decoding the pending destination.
  // Chasing the advancing room clock here aborts that seek every heartbeat.
  if (pendingSeek || video.seeking)
    return

  const timeUntilPlayMs = snapshot.playback.effectiveAtServerMs - estimatedServerNowMs
  if (timeUntilPlayMs > 12) {
    restorePlaybackRate()
    const controllerAlreadyPlaying = isLocalController() && !video.paused
    if (!video.paused && !controllerAlreadyPlaying) {
      expectPauseEvent()
      video.pause()
    }
    if (!controllerAlreadyPlaying && Math.abs(video.currentTime - snapshot.playback.positionSeconds) > 0.12)
      trySetProgrammaticPosition(snapshot.playback.positionSeconds)
    schedulePlay(timeUntilPlayMs)
    return
  }

  let correction = chooseDriftCorrection(video.currentTime, expectedSeconds, true)
  const inSeekRecoveryGrace = correction.kind === 'seek' && performance.now() < seekRecoveryUntil
  if (inSeekRecoveryGrace && video.paused && !softCorrectionAttempted) {
    restorePlaybackRate()
    playVideo()
    return
  }
  if (correction.kind === 'seek' && performance.now() < seekRecoveryUntil) {
    correction = { kind: 'rate', driftSeconds: correction.driftSeconds, playbackRate: correction.driftSeconds > 0 ? 1.02 : 0.98 }
  }
  if (correction.kind === 'rate') {
    const activeSoftCorrectionHealthy = softCorrectionActive
      && isPlaybackRateAccepted(softCorrectionRate, video.playbackRate)
      && hasRecentPlaybackProgress()
      && performance.now() - softCorrectionStartedAt < SOFT_CORRECTION_MAX_MS
    const canUseSoftCorrection = !softCorrectionActive
      && !softCorrectionAttempted
      && canApplySoftDriftCorrection({
          playing: !video.paused,
          buffering: playerHealth.buffering,
          seeking: video.seeking || localSeeking,
          hasPendingOperation: pendingSeek !== null,
          hasRecentProgress: hasRecentPlaybackProgress(),
        })
    if (softCorrectionActive && !activeSoftCorrectionHealthy) {
      restorePlaybackRate()
      correction = {
        kind: 'seek',
        driftSeconds: correction.driftSeconds,
        positionSeconds: expectedSeconds,
      }
    }
    else if (!softCorrectionActive && (!canUseSoftCorrection || !tryApplySoftCorrection(correction.playbackRate))) {
      correction = {
        kind: 'seek',
        driftSeconds: correction.driftSeconds,
        positionSeconds: expectedSeconds,
      }
    }
  }
  if (softCorrectionActive && correction.kind === 'seek')
    restorePlaybackRate()
  if (correction.kind === 'seek') {
    if (hardCorrectionAttempted) {
      requestBoundedPlaybackRecovery()
      return
    }
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    const previousPendingSeek = pendingSeek
    if (!trySetProgrammaticPosition(correction.positionSeconds)) {
      if (pendingSeek !== null && pendingSeek !== previousPendingSeek)
        hardCorrectionAttempted = true
      return
    }
    hardCorrectionAttempted = true
  }
  else if (correction.kind === 'rate') {
    // tryApplySoftCorrection() validated the assignment and installed the
    // bounded expiry. Do not write the provider rate again on every heartbeat.
  }
  else {
    restorePlaybackRate()
  }

  if (video.paused && !video.seeking && pendingSeek === null)
    playVideo()
}

function tryApplySoftCorrection(playbackRate: number): boolean {
  if (!video)
    return false
  try {
    video.playbackRate = playbackRate
  }
  catch {
    softCorrectionAttempted = true
    return false
  }
  if (!isPlaybackRateAccepted(playbackRate, video.playbackRate)) {
    softCorrectionAttempted = true
    restorePlaybackRate()
    return false
  }
  softCorrectionAttempted = true
  softCorrectionActive = true
  softCorrectionStartedAt = performance.now()
  softCorrectionRate = playbackRate
  if (rateResetTimer)
    clearTimeout(rateResetTimer)
  rateResetTimer = setTimeout(() => {
    rateResetTimer = null
    if (!softCorrectionActive)
      return
    restorePlaybackRate()
    applyAuthoritativeState()
  }, SOFT_CORRECTION_MAX_MS)
  return true
}

function schedulePlay(delayMs: number): void {
  clearScheduledPlay()
  scheduledPlayTimer = setTimeout(() => {
    scheduledPlayTimer = null
    applyAuthoritativeState()
  }, Math.min(delayMs, 1_000))
}

function clearScheduledPlay(): void {
  if (scheduledPlayTimer)
    clearTimeout(scheduledPlayTimer)
  scheduledPlayTimer = null
}

function playVideo(): void {
  if (!video || video.readyState === HTMLMediaElement.HAVE_NOTHING || video.seeking || pendingSeek !== null)
    return
  requestVideoPlay(() => {
    renderPill()
  }, 'Playback was blocked. The room is pausing, press Sync once, then ask the host to play again.')
}

function activateSynchronizedPlayback(): void {
  if (!video)
    return
  const shouldRemainPaused = activeState?.snapshot?.playback.status !== 'playing'
  requestVideoPlay(() => {
    if (shouldRemainPaused && video) {
      expectPauseEvent()
      video.pause()
    }
    renderPill()
    applyAuthoritativeState()
  }, 'Click the video player once, then press Sync again.')
}

function requestVideoPlay(onStarted: () => void, blockedNotice: string, onFailed?: () => void): void {
  if (!video)
    return
  const target = video
  const source = target.currentSrc
  const operation = playerOperations.beginPlay()
  if (!operation)
    return
  expectPlayEvent()
  const isCurrent = () => playerOperations.isCurrentPlay(operation) && video === target && target.currentSrc === source
  void target.play().then(() => {
    if (!isCurrent()) {
      playerOperations.settlePlay(operation)
      return
    }
    playerOperations.settlePlay(operation)
    onStarted()
  }).catch((error: unknown) => {
    if (!isCurrent()) {
      playerOperations.settlePlay(operation)
      return
    }
    playerOperations.settlePlay(operation)
    expectedPlayUntil = 0
    // pause(), load(), and source replacement can interrupt play(). They
    // do not indicate that the browser needs another user gesture.
    const name = error instanceof Error ? error.name : ''
    if (name === 'AbortError') {
      onFailed?.()
      return
    }
    onFailed?.()
    playerHealth = name === 'NotAllowedError'
      ? markPlaybackStartFailed(playerHealth)
      : clearPlaybackStartFailed(playerHealth)
    renderPill()
    showNotice(name === 'NotAllowedError' ? blockedNotice : 'The video could not start. Check the player, then press Sync to retry.')
    void reportPlayerStatus(true)
  })
}

function currentEpisodeMatchesRoom(): boolean {
  if (!video || !activeState?.snapshot?.media)
    return true
  const actual = createMediaFingerprint(video)
  const decision = decidePlayerIdentity({
    roomMedia: activeState.snapshot.media,
    localMedia: actual,
    workerBoundMedia: activeState.currentMedia,
    nested: window.top !== window,
  })
  return decision === 'match'
}

function currentTransactionalOperation(): RoomOperation | null {
  const operation = activeState?.snapshot?.contract?.mode === 'transactional'
    ? activeState.snapshot.contract.operation
    : null
  return operation && (operation.phase === 'preparing' || operation.phase === 'prepared' || operation.phase === 'committed')
    ? operation
    : null
}

function transactionalOperationKey(operation: RoomOperation): string {
  return `${operation.mediaEpoch}:${operation.operationId}`
}

function syncTransactionalOperationIdentity(operation: RoomOperation): string {
  const key = transactionalOperationKey(operation)
  if (transactionalActiveKey === key)
    return key
  clearTransactionalStartTimer()
  transactionalActiveKey = key
  transactionalPlayAttemptKey = null
  transactionalPlayResolvedKey = null
  transactionalPreparedKey = null
  transactionalStartedKey = null
  transactionalAckInFlightKey = null
  return key
}

function clearTransactionalStartTimer(): void {
  if (transactionalStartTimer)
    clearTimeout(transactionalStartTimer)
  transactionalStartTimer = null
}

function transactionalTargetPosition(operation: RoomOperation): number {
  return operation.targetPositionSeconds ?? activeState?.snapshot?.playback.positionSeconds ?? 0
}

function isTransactionallyPrepared(targetSeconds: number): boolean {
  return video !== null
    && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    && !video.seeking
    && !localSeeking
    && pendingSeek === null
    && canConfirmSeek({
      currentSeconds: video.currentTime,
      targetSeconds,
      seeking: false,
    })
}

function scheduleTransactionalPlay(delayMs: number): void {
  clearTransactionalStartTimer()
  transactionalStartTimer = setTimeout(() => {
    transactionalStartTimer = null
    applyAuthoritativeState()
  }, Math.min(Math.max(0, delayMs), 1_000))
}

function applyTransactionalOperation(operation: RoomOperation): boolean {
  const key = syncTransactionalOperationIdentity(operation)
  clearScheduledPlay()

  if (!video || !currentEpisodeMatchesRoom()) {
    clearTransactionalStartTimer()
    return true
  }

  const targetSeconds = transactionalTargetPosition(operation)
  if (operation.phase === 'preparing' || operation.phase === 'prepared') {
    clearTransactionalStartTimer()
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    if (!isTransactionallyPrepared(targetSeconds)) {
      trySetProgrammaticPosition(targetSeconds)
      return true
    }
    if (operation.phase === 'preparing' && transactionalPreparedKey !== key)
      sendTransactionalAcknowledgement(operation, 'prepared')
    return true
  }

  if (operation.resumeWhenReady === false) {
    clearTransactionalStartTimer()
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    if (!isTransactionallyPrepared(targetSeconds))
      trySetProgrammaticPosition(targetSeconds)
    return true
  }

  if (operation.effectiveAtServerMs === null)
    return true

  const estimatedServerNowMs = Date.now() + (activeState?.serverOffsetMs ?? 0)
  const timeUntilPlayMs = operation.effectiveAtServerMs - estimatedServerNowMs
  if (timeUntilPlayMs > 12) {
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    if (Math.abs(video.currentTime - targetSeconds) > 0.12)
      trySetProgrammaticPosition(targetSeconds)
    scheduleTransactionalPlay(timeUntilPlayMs)
    return true
  }

  clearTransactionalStartTimer()
  const needsTransactionalPreparation = transactionalPlayAttemptKey !== key && !isTransactionallyPrepared(targetSeconds)
  if (video.seeking || pendingSeek !== null || needsTransactionalPreparation) {
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    trySetProgrammaticPosition(targetSeconds)
    return true
  }

  if (video.paused) {
    requestTransactionalPlay(key)
    return true
  }

  if (transactionalPlayResolvedKey === key
    && !video.seeking
    && pendingSeek === null
    && playerHealth.hasRealPlaybackProgress
    && transactionalStartedKey !== key) {
    sendTransactionalAcknowledgement(operation, 'started')
  }
  return true
}

function requestTransactionalPlay(key: string): void {
  if (transactionalPlayAttemptKey === key)
    return
  const operation = currentTransactionalOperation()
  if (!operation || transactionalOperationKey(operation) !== key)
    return
  transactionalPlayAttemptKey = key
  requestVideoPlay(() => {
    const current = currentTransactionalOperation()
    if (current && transactionalOperationKey(current) === key)
      transactionalPlayResolvedKey = key
    applyAuthoritativeState()
  }, 'Click the video player once, then press Sync again.', () => {
    if (transactionalActiveKey === key) {
      transactionalPlayAttemptKey = null
      transactionalPlayResolvedKey = null
    }
  })
}

function sendTransactionalAcknowledgement(operation: RoomOperation, phase: 'prepared' | 'started'): void {
  if (!activeState || !video || !playerBindingId)
    return
  const key = transactionalOperationKey(operation)
  if ((phase === 'prepared' && transactionalPreparedKey === key)
    || (phase === 'started' && transactionalStartedKey === key))
    return
  const acknowledgementKey = `${key}:${phase}`
  if (transactionalAckInFlightKey === acknowledgementKey)
    return
  const { sourceGeneration } = playerOperations.snapshot()
  const acknowledgement: OperationAcknowledgement = {
    mediaEpoch: operation.mediaEpoch,
    operationId: operation.operationId,
    bindingId: playerBindingId,
    sourceGeneration,
    sampleSequence: ++transactionalSampleSequence,
    phase,
    participantId: activeState.participantId,
    observedPositionSeconds: finiteOrZero(video.currentTime),
    observedAtLocalMs: Date.now(),
  }
  transactionalAckInFlightKey = acknowledgementKey
  void sendRuntime({ type: 'OPERATION_ACK', acknowledgement }).then(response => {
    if (transactionalAckInFlightKey === acknowledgementKey)
      transactionalAckInFlightKey = null
    if (!response.ok || transactionalActiveKey !== key)
      return
    if (phase === 'prepared')
      transactionalPreparedKey = key
    else
      transactionalStartedKey = key
  }).catch(() => {
    if (transactionalAckInFlightKey === acknowledgementKey)
      transactionalAckInFlightKey = null
  })
}

function forceSyncToRoom(fromUserGesture: boolean): void {
  if (!video || !activeState?.snapshot) {
    showNotice('The shared player is still loading.')
    return
  }
  if (!currentEpisodeMatchesRoom()) {
    showNotice('This episode differs from the room. Share its link and confirm readiness before syncing.')
    return
  }

  clearScheduledPlay()
  resetCorrectionBudget()
  restorePlaybackRate()
  localIntentHoldUntil = 0
  localSeeking = false
  // An explicit Sync is the retry boundary for a timed-out operation.
  if (pendingSeek?.timedOut) {
    playerOperations.retireSeek(performance.now())
    pendingSeek = null
    clearSeekCompletionTimer()
  }
  const estimatedServerNowMs = Date.now() + activeState.serverOffsetMs
  const expectedSeconds = expectedPosition(activeState.snapshot.playback, estimatedServerNowMs)
  const seekApplied = trySetProgrammaticPosition(expectedSeconds, activeState.snapshot.seek?.revision ?? null)
  if (!seekApplied && !fromUserGesture) {
    showNotice('Waiting for this player to make the room position seekable…')
    return
  }

  if (activeState.snapshot.playback.status === 'paused') {
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    if (fromUserGesture)
      activateSynchronizedPlayback()
    showNotice('Aligned with the room. Waiting for the host to play.')
    return
  }

  requestVideoPlay(() => {
    playerHealth = clearPlaybackStartFailed(playerHealth)
    renderPill()
    showNotice('Playback aligned with the room.')
    void reportPlayerStatus(false)
  }, fromUserGesture
      ? 'The player still blocked playback. Click its video area once, then press Sync.'
      : 'Press Sync in the in-page pill to allow playback and align the video.')
}

function restorePlaybackRate(): void {
  if (rateResetTimer)
    clearTimeout(rateResetTimer)
  rateResetTimer = null
  softCorrectionActive = false
  softCorrectionStartedAt = 0
  softCorrectionRate = 1
  if (video && video.playbackRate !== 1) {
    try {
      video.playbackRate = 1
    }
    catch {
      // A provider can expose a read-only or transient playback-rate setter.
      // The correction is still retired locally and will not be retried in a
      // loop during this operation.
    }
  }
}

function renderPill(): void {
  const snapshot = activeState?.snapshot
  const view = miniControllerView(Boolean(snapshot && (video || isNavigationTargetPage())), miniControllerHidden)
  pillHost.style.display = view.hostVisible ? 'block' : 'none'
  pillHost.style.top = view.restoreVisible ? '20px' : 'auto'
  pillHost.style.bottom = view.restoreVisible ? 'auto' : '20px'
  if (pillElement)
    pillElement.hidden = !view.controllerVisible
  if (restoreButton)
    restoreButton.hidden = !view.restoreVisible
  if (!snapshot || !activeState)
    return

  const participant = snapshot.participants.find(item => item.id === activeState?.participantId)
  const connected = snapshot.participants.filter(item => item.connected)
  const allReady = connected.every(item => item.ready && item.mediaMatches)
  const isController = snapshot.controller.participantId === activeState.participantId
  const estimatedServerNowMs = Date.now() + activeState.serverOffsetMs
  const playbackBlocked = Boolean(video?.paused)
    && snapshot.playback.status === 'playing'
    && estimatedServerNowMs > snapshot.playback.effectiveAtServerMs + 300
  const playerBuffering = snapshot.playback.status === 'playing' && playerHealth.buffering
  const catchingUp = snapshot.playback.status === 'playing' && video !== null
    && Math.abs(video.currentTime - expectedPosition(snapshot.playback, estimatedServerNowMs)) > 0.6

  if (statusElement)
    statusElement.textContent = activeState.connection === 'reconnecting'
      ? 'Reconnecting'
      : !video
        ? 'Loading shared player'
        : snapshot.seek
          ? `Aligning seek ${snapshot.seek.acknowledgedParticipantIds.length}/${connected.length}`
        : playerBuffering
          ? 'Player buffering'
        : playbackBlocked
          ? 'Playback blocked'
        : catchingUp
          ? 'Catching up'
          : allReady ? snapshot.playback.status === 'playing' ? 'In sync' : 'Ready' : 'Waiting for everyone'
  if (metaElement)
    metaElement.textContent = !video
      ? 'The page opened; preparing its video player'
      : snapshot.seek
        ? `Moving everyone to ${formatPillTime(snapshot.seek.positionSeconds)}`
      : playerBuffering
        ? 'Waiting for video playback to recover'
      : playbackBlocked
        ? 'Press Sync once to repair playback'
        : `${isController ? 'Controller' : 'Member'}, ${connected.length} connected${participant?.mediaMatches === false ? ', wrong video' : ''}`
  if (playbackButton) {
    playbackButton.hidden = !isController || !video
    playbackButton.disabled = snapshot.seek !== null || (snapshot.playback.status === 'paused' && !allReady)
    playbackButton.textContent = snapshot.seek ? 'Aligning' : snapshot.playback.status === 'playing' ? 'Pause' : 'Play'
  }
  if (syncButton)
    syncButton.disabled = !video
  if (noticeElement && activeState.lastError)
    noticeElement.textContent = activeState.lastError
}

function setMiniControllerHidden(hidden: boolean): void {
  miniControllerHidden = hidden
  renderPill()
  void chrome.storage.local.set({ [MINI_CONTROLLER_HIDDEN_KEY]: hidden }).catch(() => undefined)
}

function isLocalController(): boolean {
  return activeState?.snapshot?.controller.participantId === activeState?.participantId
}

function holdLocalControllerIntent(): void {
  if (isLocalController())
    localIntentHoldUntil = performance.now() + LOCAL_INTENT_HOLD_MS
}

function hasRecentPlaybackProgress(): boolean {
  return playerHealth.hasRealPlaybackProgress
    && performance.now() - playerHealth.lastProgressAtMs < SOFT_CORRECTION_MAX_MS
}

function playbackCommandChanged(
  previous: PlaybackState | undefined,
  next: PlaybackState | undefined,
): boolean {
  if (!previous || !next)
    return previous !== next
  return previous.status !== next.status
    || previous.positionSeconds !== next.positionSeconds
    || previous.effectiveAtServerMs !== next.effectiveAtServerMs
    || previous.playbackRate !== next.playbackRate
}

function resetPlaybackHealthBaseline(preserveCurrentSignal = false): void {
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = null
  playerHealth = resetPlayerHealthBaseline(playerHealth, {
    nowMs: performance.now(),
    positionSeconds: finiteOrZero(video?.currentTime ?? 0),
    frames: video ? presentedFrameCount(video) : null,
  }, preserveCurrentSignal)
}

function presentedFrameCount(target: HTMLVideoElement): number | null {
  // Browsers may suspend video rendering in background tabs while the
  // audio/media clock continues. Use clock evidence there to avoid a false
  // freeze report, and also on browsers without frame-quality counters.
  if (document.visibilityState !== 'visible' || typeof target.getVideoPlaybackQuality !== 'function')
    return null
  try {
    const quality = target.getVideoPlaybackQuality()
    const count = quality.totalVideoFrames - quality.droppedVideoFrames
    return Number.isFinite(count) && count >= 0 ? count : null
  }
  catch {
    return null
  }
}

function maybeBootstrapSitePlayer(): void {
  if (!shouldBootstrapClickToLoadPlayer(location.hostname, window.top === window, isNavigationTargetPage()))
    return
  if (document.querySelector('#player iframe, #player .load'))
    return
  const now = performance.now()
  if (siteBootstrapAttempts >= 4 || now - lastSiteBootstrapAt < 1_500)
    return
  const launch = document.querySelector<HTMLElement>('#click-player')
  if (!launch)
    return
  siteBootstrapAttempts += 1
  lastSiteBootstrapAt = now
  launch.click()
  showNotice('Opening the default video server…')
}

function isNavigationTargetPage(): boolean {
  const navigationUrl = activeState?.snapshot?.navigation?.url
  if (!navigationUrl)
    return false
  return normalizePageUrl(new URL(location.href)) === normalizePageUrl(new URL(navigationUrl))
}

function expectPlayEvent(): void {
  expectedPlayUntil = performance.now() + 2_000
}

function expectPauseEvent(): void {
  expectedPauseUntil = performance.now() + 2_000
}

function consumeExpectedPlay(): boolean {
  const expected = performance.now() < expectedPlayUntil
  expectedPlayUntil = 0
  return expected
}

function consumeExpectedPause(): boolean {
  const expected = performance.now() < expectedPauseUntil
  expectedPauseUntil = 0
  return expected
}

function trySetProgrammaticPosition(positionSeconds: number, roomRevision: number | null = null): boolean {
  if (!video || video.readyState === HTMLMediaElement.HAVE_NOTHING)
    return false

  const durationSeconds = Number.isFinite(video.duration) ? video.duration : null
  const ranges = Array.from({ length: video.seekable.length }, (_, index) => ({
    start: video?.seekable.start(index) ?? 0,
    end: video?.seekable.end(index) ?? 0,
  }))
  const target = resolveSeekTarget(positionSeconds, durationSeconds, ranges)
  if (target === null)
    return false
  const now = performance.now()
  const aligned = !video.seeking && Math.abs(video.currentTime - target) <= 0.2
  const currentPending = pendingSeek && playerOperations.isCurrentSeek(pendingSeek.token)
    ? pendingSeek
    : null
  const matchingPending = currentPending
    && isSeekAligned(currentPending.positionSeconds, target)
    && currentPending.roomRevision === roomRevision
    ? currentPending
    : null
  if (aligned && matchingPending) {
    completePendingSeek(matchingPending)
    return true
  }
  if (aligned && !currentPending)
    return true

  if (video.seekable.length === 0)
    return false
  if (matchingPending && video.seeking)
    return false
  if (matchingPending?.timedOut)
    return false

  if (matchingPending && now - matchingPending.lastAttemptAt < SEEK_RETRY_INTERVAL_MS)
    return false
  if (matchingPending) {
    pendingSeek = { ...matchingPending, lastAttemptAt: now }
  }
  else {
    const started = playerOperations.beginSeek(target, roomRevision, now)
    pendingSeek = {
      token: started.operation.token,
      positionSeconds: target,
      since: started.operation.since,
      lastAttemptAt: started.operation.lastAttemptAt,
      roomRevision,
    }
  }
  expectedSeek = { positionSeconds: target, until: now + 4_000 }
  if (video.seeking && isSeekAligned(video.currentTime, target)) {
    // The controller may already be seeking natively when its room barrier
    // arrives. Adopt that operation instead of restarting the provider load.
    scheduleSeekCompletionProbe()
    return false
  }
  try {
    video.currentTime = target
  }
  catch {
    playerOperations.retireSeek(performance.now())
    pendingSeek = null
    expectedSeek = null
    clearSeekCompletionTimer()
    showNotice('This player refused the synchronized seek. Press Sync to retry without refreshing.')
    void reportPlayerStatus(true)
    return false
  }
  scheduleSeekCompletionProbe()
  return false
}

function maybeAcknowledgeRoomSeek(): void {
  const roomSeek = activeState?.snapshot?.seek
  const participantId = activeState?.participantId
  if (!video || !roomSeek || !participantId)
    return
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !currentEpisodeMatchesRoom())
    return
  if (roomSeek.acknowledgedParticipantIds.includes(participantId)) {
    clearSeekAckRetryTimer()
    return
  }
  if (seekAckInFlightRevision === roomSeek.revision)
    return
  if (!canConfirmSeek({ currentSeconds: video.currentTime, targetSeconds: roomSeek.positionSeconds, seeking: video.seeking }))
    return
  if (pendingSeek && pendingSeek.roomRevision === roomSeek.revision)
    return
  if (completedRoomSeekRevision !== roomSeek.revision && pendingSeek !== null)
    return

  seekAckInFlightRevision = roomSeek.revision
  void sendRuntime({
    type: 'SEEK_APPLIED',
    revision: roomSeek.revision,
    positionSeconds: video.currentTime,
  }).finally(() => {
    if (seekAckInFlightRevision === roomSeek.revision)
      seekAckInFlightRevision = 0
    scheduleSeekAckRetry(roomSeek.revision)
  })
}

function completePendingSeek(completed: NonNullable<typeof pendingSeek>): void {
  playerOperations.completeSeek(completed.token)
  if (completed.roomRevision !== null)
    completedRoomSeekRevision = completed.roomRevision
  else if (activeState?.snapshot?.playback.status === 'playing')
    seekRecoveryUntil = performance.now() + SEEK_RECOVERY_GRACE_MS
  pendingSeek = null
  expectedSeek = null
  clearSeekCompletionTimer()
}

function maybeCompletePendingSeek(): boolean {
  const pending = pendingSeek
  if (!video || !pending || !playerOperations.isCurrentSeek(pending.token))
    return false
  if (!canConfirmSeek({ currentSeconds: video.currentTime, targetSeconds: pending.positionSeconds, seeking: video.seeking }))
    return false
  completePendingSeek(pending)
  maybeAcknowledgeRoomSeek()
  applyAuthoritativeState()
  return true
}

function scheduleSeekCompletionProbe(): void {
  clearSeekCompletionTimer()
  seekCompletionTimer = setTimeout(() => {
    seekCompletionTimer = null
    const pending = pendingSeek
    if (!video || !pending)
      return
    if (maybeCompletePendingSeek()) {
      return
    }
    if (performance.now() - pending.since >= LOCAL_SEEK_MAX_WAIT_MS) {
      // Retain ownership of the native seek while reporting the timeout.
      // Clearing it lets the next heartbeat restart the same slow load.
      // A native completion or explicit Sync can still recover it.
      pending.timedOut = true
      playerOperations.markSeekTimedOut(pending.token)
      clearSeekCompletionTimer()
      showNotice('This player could not finish aligning. The room is pausing so Sync can retry without a refresh.')
      void reportPlayerStatus(true)
      return
    }
    scheduleSeekCompletionProbe()
  }, SEEK_COMPLETION_PROBE_MS)
}

function clearSeekCompletionTimer(): void {
  if (seekCompletionTimer)
    clearTimeout(seekCompletionTimer)
  seekCompletionTimer = null
}

function scheduleSeekAckRetry(revision: number): void {
  clearSeekAckRetryTimer()
  seekAckRetryTimer = setTimeout(() => {
    seekAckRetryTimer = null
    if (activeState?.snapshot?.seek?.revision === revision)
      maybeAcknowledgeRoomSeek()
  }, SEEK_ACK_RETRY_MS)
}

function clearSeekAckRetryTimer(): void {
  if (seekAckRetryTimer)
    clearTimeout(seekAckRetryTimer)
  seekAckRetryTimer = null
}

function hasExpectedSeek(): boolean {
  if (!video)
    return false
  return (pendingSeek !== null
    && playerOperations.isCurrentSeek(pendingSeek.token)
    && isSeekAligned(video.currentTime, pendingSeek.positionSeconds))
    || (expectedSeek !== null && performance.now() < expectedSeek.until && isSeekAligned(video.currentTime, expectedSeek.positionSeconds))
}

function consumeExpectedSeek(): boolean {
  if (!video || !expectedSeek)
    return false
  const expected = performance.now() < expectedSeek.until
    && Math.abs(video.currentTime - expectedSeek.positionSeconds) <= 1
  if (expected || performance.now() >= expectedSeek.until)
    expectedSeek = null
  return expected
}

function showNotice(message: string, sticky = false): void {
  if (!noticeElement)
    return
  noticeElement.textContent = message
  if (sticky)
    return
  setTimeout(() => {
    if (noticeElement.textContent === message)
      noticeElement.textContent = ''
  }, 5_000)
}

function createMediaFingerprint(target: HTMLVideoElement): MediaFingerprint {
  const playerUrl = new URL(location.href)
  const identityUrl = containerPageUrl(playerUrl)
  const service = serviceName(identityUrl.hostname)
  const pageUrl = normalizePageUrl(identityUrl)
  return {
    service,
    canonicalId: canonicalMediaId(service, identityUrl).slice(0, 500),
    title: cleanMediaTitle(document.title).slice(0, 300) || 'Untitled video',
    durationSeconds: Number.isFinite(target.duration) ? Math.round(target.duration * 10) / 10 : null,
    ...(pageUrl ? { pageUrl } : {}),
  }
}

function containerPageUrl(playerUrl: URL): URL {
  if (window.top === window || !document.referrer)
    return playerUrl
  try {
    return new URL(document.referrer)
  }
  catch {
    return playerUrl
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function formatPillTime(value: number): string {
  const seconds = Math.max(0, Math.floor(value))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

async function sendRuntime(request: RuntimeRequest): Promise<RuntimeResponse> {
  if (!chrome.runtime?.id) {
    handleRuntimeInvalidated()
    throw new Error('SyncYourJoy extension context is gone.')
  }
  try {
    const response = await chrome.runtime.sendMessage(withPlayerBinding(request)) as RuntimeResponse
    if (request.type === 'MEDIA_DETECTED' && response.playerBindingId)
      playerBindingId = response.playerBindingId
    return response
  }
  catch (error) {
    handleRuntimeInvalidated()
    throw error
  }
}

function withPlayerBinding(request: RuntimeRequest): RuntimeRequest {
  if (!playerBindingId)
    return request
  switch (request.type) {
    case 'MEDIA_DETECTED':
    case 'MEDIA_LOST':
    case 'PLAYER_STATUS':
    case 'SEEK_APPLIED':
    case 'PLAYER_INTENT':
      return { ...request, bindingId: playerBindingId }
    default:
      return request
  }
}

/**
 * Reloading or updating the extension does not re-inject content scripts
 * into tabs that were already open (a documented Chrome MV3 limitation), so
 * this instance can be a ghost: frozen with whatever room state it last
 * received, unable to reach the new service worker, and unable to learn
 * that the room it displays may no longer be accurate. Without this, the
 * pill silently keeps showing stale "Controller"/room state forever with no
 * indication anything is wrong.
 */
function handleRuntimeInvalidated(): void {
  if (runtimeInvalidated)
    return
  runtimeInvalidated = true
  clearInterval(playerScanIntervalId)
  clearInterval(pageIdentityIntervalId)
  clearInterval(sampleIntervalId)
  showNotice('SyncYourJoy was updated. Refresh this page to reconnect.', true)
}
