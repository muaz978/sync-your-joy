import type { MediaFingerprint, PlaybackState, PlayerSample } from '@syncyourjoy/protocol'
import type { ContentRequest, ExtensionState, PlayerContext, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { canConfirmSeek, chooseDriftCorrection, expectedPosition, isDuplicateSeekIntent, isPlaybackPastStartupGrace, isSeekAligned, LOCAL_SEEK_MAX_WAIT_MS, SEEK_ACK_RETRY_MS, SEEK_COMPLETION_PROBE_MS, SEEK_INTENT_DEBOUNCE_MS } from '@syncyourjoy/sync-engine'
import { canonicalMediaId, cleanMediaTitle, normalizePageUrl, serviceName } from './media-fingerprint.ts'
import { resolveSeekTarget } from './media-seek.ts'
import { LOCAL_INTENT_HOLD_MS, shouldDeferAuthoritativeSync } from './player-intent.ts'
import { shouldBootstrapClickToLoadPlayer } from './site-adapter.ts'

const PLAYER_SCAN_INTERVAL_MS = 2_000
const SAMPLE_INTERVAL_MS = 1_000
const MEDIA_HEARTBEAT_INTERVAL_MS = 1_000
const MEDIA_LOSS_GRACE_MS = 3_000
const PLAYER_PILL_LAYER = '2147483600'

let video: HTMLVideoElement | null = null
let activeState: ExtensionState | null = null
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
let pendingSeek: { positionSeconds: number; since: number; lastAttemptAt: number; roomRevision: number | null } | null = null
let completedRoomSeekRevision = 0
let seekAckInFlightRevision = 0
let seekCompletionTimer: ReturnType<typeof setTimeout> | null = null
let seekAckRetryTimer: ReturnType<typeof setTimeout> | null = null
let lastControllerSeekPosition: number | null = null
let lastControllerSeekSentAt = 0
let seekIntentTimer: ReturnType<typeof setTimeout> | null = null
let pendingControllerSeekTarget: number | null = null
let lastProgressPosition = 0
let lastProgressAt = performance.now()
let unexpectedPauseSince = 0
let stallNoticeShown = false
let siteBootstrapAttempts = 0
let lastSiteBootstrapAt = 0
let playerScanTimer: ReturnType<typeof setTimeout> | null = null
let mediaLossTimer: ReturnType<typeof setTimeout> | null = null

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
    </span>
    <p class="notice" id="syj-notice"></p>
  </section>
`

document.documentElement.append(pillHost)

const statusElement = shadow.querySelector<HTMLElement>('#syj-status')
const metaElement = shadow.querySelector<HTMLElement>('#syj-meta')
const noticeElement = shadow.querySelector<HTMLElement>('#syj-notice')
const playbackButton = shadow.querySelector<HTMLButtonElement>('#syj-playback')
const syncButton = shadow.querySelector<HTMLButtonElement>('#syj-sync')
const roomButton = shadow.querySelector<HTMLButtonElement>('#syj-room')

roomButton?.addEventListener('click', () => {
  void sendRuntime({ type: 'OPEN_PANEL' })
})

playbackButton?.addEventListener('click', () => {
  if (!video || !activeState?.snapshot)
    return
  if (video.paused) {
    void video.play().catch(() => {
      renderPill()
      showNotice('Press Sync once so Chrome can allow synchronized play.')
    })
  }
  else {
    video.pause()
  }
})

syncButton?.addEventListener('click', () => {
  forceSyncToRoom(true)
})

chrome.runtime.onMessage.addListener((message: RuntimeEvent | ContentRequest, _sender, sendResponse) => {
  if (message.type === 'GET_PLAYER_CONTEXT') {
    sendResponse(currentPlayerContext())
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
    activeState = message.state
    if (playbackCommandChanged(previousSnapshot?.playback, message.state.snapshot?.playback))
      resetPlaybackHealthBaseline()
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
setInterval(scanForPlayer, PLAYER_SCAN_INTERVAL_MS)
const playerObserver = new MutationObserver(schedulePlayerScan)
playerObserver.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'src'],
})
setInterval(() => {
  if (!video)
    return
  void reportPlayerStatus(false)
  applyAuthoritativeState()
}, SAMPLE_INTERVAL_MS)

document.addEventListener('fullscreenchange', () => {
  const target = document.fullscreenElement
  if (target instanceof HTMLElement)
    target.append(pillHost)
  else
    document.documentElement.append(pillHost)
})

function scanForPlayer(): void {
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
  }, MEDIA_LOSS_GRACE_MS)
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
  })
}

function findPrimaryVideo(): HTMLVideoElement | null {
  const videos = [...document.querySelectorAll('video')]
    .filter(item => item instanceof HTMLVideoElement && isVisibleVideo(item))
  return videos.sort((a, b) => videoCandidateScore(b) - videoCandidateScore(a))[0] ?? null
}

function isVisibleVideo(target: HTMLVideoElement): boolean {
  if (!target.isConnected)
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
  lastProgressPosition = finiteOrZero(target.currentTime)
  lastProgressAt = performance.now()
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
  target.addEventListener('durationchange', handleMediaReady)
  target.addEventListener('progress', handleMediaReady)
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
  target.removeEventListener('durationchange', handleMediaReady)
  target.removeEventListener('progress', handleMediaReady)
  if (seekIntentTimer)
    clearTimeout(seekIntentTimer)
  seekIntentTimer = null
  pendingControllerSeekTarget = null
  localSeeking = false
  pendingSeek = null
  clearSeekCompletionTimer()
  clearSeekAckRetryTimer()
}

function handlePlay(): void {
  resetPlaybackHealthBaseline()
  const expected = consumeExpectedPlay()
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
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = null
  if (!hasExpectedSeek() && isLocalController()) {
    localSeeking = true
    scheduleControllerSeekIntent()
  }
}

function handleSeeked(): void {
  const completedPending = video && pendingSeek && isSeekAligned(video.currentTime, pendingSeek.positionSeconds)
    ? pendingSeek
    : null
  const programmatic = completedPending !== null || consumeExpectedSeek()
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
  else {
    applyAuthoritativeState()
  }
  maybeAcknowledgeRoomSeek()
  void reportPlayerStatus(false)
}

function handleTimeUpdate(): void {
  if (localSeeking && isLocalController())
    scheduleControllerSeekIntent()
}

function scheduleControllerSeekIntent(explicitPosition?: number): void {
  if (!video || !isLocalController())
    return
  pendingControllerSeekTarget = finiteOrZero(explicitPosition ?? video.currentTime)
  if (seekIntentTimer)
    clearTimeout(seekIntentTimer)
  seekIntentTimer = setTimeout(() => {
    seekIntentTimer = null
    if (!video || !isLocalController())
      return
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
  if (!video || !isLocalController())
    return
  holdLocalControllerIntent()
  void sendRuntime({ type: 'PLAYER_INTENT', kind: 'pause', positionSeconds: video.currentTime })
}

function handleBuffering(): void {
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
  applyAuthoritativeState()
  maybeAcknowledgeRoomSeek()
  void reportPlayerStatus(false)
}

function handleMediaReady(): void {
  applyAuthoritativeState()
  maybeAcknowledgeRoomSeek()
}

async function reportPlayerStatus(buffering: boolean): Promise<void> {
  const snapshot = activeState?.snapshot
  if (!video || !snapshot)
    return
  const seekPendingTooLong = pendingSeek !== null && performance.now() - pendingSeek.since >= 1_500
  const inferredBuffering = detectPlaybackStall(video, buffering || seekPendingTooLong)
  const sample: PlayerSample = {
    positionSeconds: finiteOrZero(video.currentTime),
    durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused,
    buffering: inferredBuffering,
    sampledAtLocalMs: Date.now(),
  }
  await sendRuntime({ type: 'PLAYER_STATUS', basedOnRevision: snapshot.revision, sample })
}

function currentPlayerContext(): PlayerContext {
  if (!video)
    return { media: null, sample: null }
  return {
    media: createMediaFingerprint(video),
    sample: {
      positionSeconds: finiteOrZero(video.currentTime),
      durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused,
      buffering: false,
      sampledAtLocalMs: Date.now(),
    },
  }
}

function applyAuthoritativeState(): void {
  const snapshot = activeState?.snapshot
  if (!video || !activeState || !snapshot)
    return

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

  const timeUntilPlayMs = snapshot.playback.effectiveAtServerMs - estimatedServerNowMs
  if (timeUntilPlayMs > 12) {
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

  const correction = chooseDriftCorrection(video.currentTime, expectedSeconds, true)
  if (correction.kind === 'seek') {
    if (!video.paused) {
      expectPauseEvent()
      video.pause()
    }
    if (!trySetProgrammaticPosition(correction.positionSeconds))
      return
  }
  else if (correction.kind === 'rate') {
    video.playbackRate = correction.playbackRate
    if (rateResetTimer)
      clearTimeout(rateResetTimer)
    rateResetTimer = setTimeout(restorePlaybackRate, 4_000)
  }
  else {
    restorePlaybackRate()
  }

  if (video.paused && !video.seeking && pendingSeek === null)
    playVideo()
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
  expectPlayEvent()
  void video.play().then(() => {
    renderPill()
  }).catch(() => {
    expectedPlayUntil = 0
    renderPill()
    showNotice('Playback was blocked. The room is pausing—press Sync once, then ask the host to play again.')
    void reportPlayerStatus(true)
  })
}

function activateSynchronizedPlayback(): void {
  if (!video)
    return
  expectPlayEvent()
  const shouldRemainPaused = activeState?.snapshot?.playback.status !== 'playing'
  void video.play().then(() => {
    if (shouldRemainPaused && video) {
      expectPauseEvent()
      video.pause()
    }
    renderPill()
    applyAuthoritativeState()
  }).catch(() => {
    showNotice('Click the video player once, then press Sync again.')
    void reportPlayerStatus(true)
  })
}

function forceSyncToRoom(fromUserGesture: boolean): void {
  if (!video || !activeState?.snapshot) {
    showNotice('The shared player is still loading.')
    return
  }

  clearScheduledPlay()
  localIntentHoldUntil = 0
  localSeeking = false
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

  expectPlayEvent()
  void video.play().then(() => {
    lastProgressPosition = finiteOrZero(video?.currentTime ?? 0)
    lastProgressAt = performance.now()
    renderPill()
    showNotice('Playback aligned with the room.')
    void reportPlayerStatus(false)
  }).catch(() => {
    expectedPlayUntil = 0
    renderPill()
    showNotice(fromUserGesture
      ? 'The player still blocked playback. Click its video area once, then press Sync.'
      : 'Press Sync in the in-page pill to allow playback and align the video.')
    void reportPlayerStatus(true)
  })
}

function restorePlaybackRate(): void {
  if (rateResetTimer)
    clearTimeout(rateResetTimer)
  rateResetTimer = null
  if (video && video.playbackRate !== 1) {
    video.playbackRate = 1
  }
}

function renderPill(): void {
  const snapshot = activeState?.snapshot
  pillHost.style.display = snapshot && (video || isNavigationTargetPage()) ? 'block' : 'none'
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

  if (statusElement)
    statusElement.textContent = activeState.connection === 'reconnecting'
      ? 'Reconnecting'
      : !video
        ? 'Loading shared player'
        : snapshot.seek
          ? `Aligning seek ${snapshot.seek.acknowledgedParticipantIds.length}/${connected.length}`
        : playbackBlocked
          ? 'Playback blocked'
          : allReady ? 'In sync' : 'Waiting for everyone'
  if (metaElement)
    metaElement.textContent = !video
      ? 'The page opened; preparing its video player'
      : snapshot.seek
        ? `Moving everyone to ${formatPillTime(snapshot.seek.positionSeconds)}`
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

function isLocalController(): boolean {
  return activeState?.snapshot?.controller.participantId === activeState?.participantId
}

function holdLocalControllerIntent(): void {
  if (isLocalController())
    localIntentHoldUntil = performance.now() + LOCAL_INTENT_HOLD_MS
}

function detectPlaybackStall(target: HTMLVideoElement, explicitlyBuffering: boolean): boolean {
  const now = performance.now()
  const position = finiteOrZero(target.currentTime)
  const playback = activeState?.snapshot?.playback
  const roomIsPlaying = playback?.status === 'playing'
  const estimatedServerNowMs = Date.now() + (activeState?.serverOffsetMs ?? 0)
  const playShouldHaveStarted = playback !== undefined
    && isPlaybackPastStartupGrace(playback, estimatedServerNowMs)

  if (roomIsPlaying && !playShouldHaveStarted) {
    unexpectedPauseSince = 0
    lastProgressPosition = position
    lastProgressAt = now
    return false
  }

  if (playShouldHaveStarted && target.paused && !(isLocalController() && now < localIntentHoldUntil)) {
    if (unexpectedPauseSince === 0)
      unexpectedPauseSince = now
    const stalled = explicitlyBuffering || now - unexpectedPauseSince >= 1_500
    if (stalled && !stallNoticeShown) {
      stallNoticeShown = true
      showNotice('This player stopped. The room is pausing—press Sync to recover without refreshing.')
    }
    return stalled
  }

  unexpectedPauseSince = 0
  if (!roomIsPlaying || target.paused || target.seeking || localSeeking) {
    if (!roomIsPlaying)
      stallNoticeShown = false
    lastProgressPosition = position
    lastProgressAt = now
    return explicitlyBuffering
  }
  if (Math.abs(position - lastProgressPosition) >= 0.12) {
    lastProgressPosition = position
    lastProgressAt = now
    stallNoticeShown = false
  }
  const stalled = explicitlyBuffering || now - lastProgressAt >= 2_500
  if (stalled && !stallNoticeShown) {
    stallNoticeShown = true
    showNotice('Playback stopped advancing. The room is pausing—press Sync to recover.')
  }
  return stalled
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

function resetPlaybackHealthBaseline(): void {
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = null
  unexpectedPauseSince = 0
  stallNoticeShown = false
  lastProgressPosition = finiteOrZero(video?.currentTime ?? 0)
  lastProgressAt = performance.now()
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
  const matchingPending = pendingSeek
    && isSeekAligned(pendingSeek.positionSeconds, target)
    && pendingSeek.roomRevision === roomRevision
    ? pendingSeek
    : null
  if (aligned && matchingPending) {
    completePendingSeek(matchingPending)
    return true
  }
  if (aligned && !pendingSeek)
    return true

  if (matchingPending && now - matchingPending.lastAttemptAt < 1_000)
    return false
  pendingSeek = matchingPending
    ? { ...matchingPending, lastAttemptAt: now }
    : { positionSeconds: target, since: now, lastAttemptAt: now, roomRevision }
  expectedSeek = { positionSeconds: target, until: now + 4_000 }
  try {
    video.currentTime = target
  }
  catch {
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
  if (completed.roomRevision !== null)
    completedRoomSeekRevision = completed.roomRevision
  pendingSeek = null
  expectedSeek = null
  clearSeekCompletionTimer()
}

function scheduleSeekCompletionProbe(): void {
  clearSeekCompletionTimer()
  seekCompletionTimer = setTimeout(() => {
    seekCompletionTimer = null
    const pending = pendingSeek
    if (!video || !pending)
      return
    if (canConfirmSeek({ currentSeconds: video.currentTime, targetSeconds: pending.positionSeconds, seeking: video.seeking })) {
      completePendingSeek(pending)
      maybeAcknowledgeRoomSeek()
      applyAuthoritativeState()
      return
    }
    if (performance.now() - pending.since >= LOCAL_SEEK_MAX_WAIT_MS) {
      pendingSeek = null
      expectedSeek = null
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
  return expectedSeek !== null && performance.now() < expectedSeek.until
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

function showNotice(message: string): void {
  if (!noticeElement)
    return
  noticeElement.textContent = message
  setTimeout(() => {
    if (noticeElement.textContent === message)
      noticeElement.textContent = ''
  }, 5_000)
}

function createMediaFingerprint(target: HTMLVideoElement): MediaFingerprint {
  const playerUrl = new URL(location.href)
  const service = serviceName(playerUrl.hostname)
  const pageUrl = normalizePageUrl(containerPageUrl(playerUrl))
  return {
    service,
    canonicalId: canonicalMediaId(service, playerUrl).slice(0, 500),
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
  return chrome.runtime.sendMessage(request) as Promise<RuntimeResponse>
}
