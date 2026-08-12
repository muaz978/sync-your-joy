import type { MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'
import type { ExtensionState, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { chooseDriftCorrection, expectedPosition } from '@syncyourjoy/sync-engine'
import { canonicalMediaId, cleanMediaTitle, serviceName } from './media-fingerprint.ts'

const PLAYER_SCAN_INTERVAL_MS = 2_000
const SAMPLE_INTERVAL_MS = 1_000
const PLAYER_PILL_LAYER = '2147483600'

let video: HTMLVideoElement | null = null
let activeState: ExtensionState | null = null
let suppressEventsUntil = 0
let scheduledPlayTimer: ReturnType<typeof setTimeout> | null = null
let bufferingTimer: ReturnType<typeof setTimeout> | null = null
let rateResetTimer: ReturnType<typeof setTimeout> | null = null
let lastFingerprintKey = ''

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
      width: min(310px, calc(100vw - 32px));
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
const roomButton = shadow.querySelector<HTMLButtonElement>('#syj-room')

roomButton?.addEventListener('click', () => {
  void sendRuntime({ type: 'OPEN_PANEL' })
})

playbackButton?.addEventListener('click', () => {
  if (!video || !activeState?.snapshot)
    return
  const kind = activeState.snapshot.playback.status === 'playing' ? 'pause' : 'play'
  void sendRuntime({ type: 'PLAYER_INTENT', kind, positionSeconds: video.currentTime })
})

chrome.runtime.onMessage.addListener((message: RuntimeEvent) => {
  if (message.type === 'APPLY_ROOM_STATE' || message.type === 'ROOM_STATE_UPDATED') {
    activeState = message.state
    renderPill()
    applyAuthoritativeState()
  }
  else if (message.type === 'PAUSE_LOCAL') {
    if (video && !video.paused) {
      suppressPlayerEvents()
      video.pause()
    }
  }
  else if (message.type === 'SHOW_NOTICE') {
    showNotice(message.message)
  }
})

void sendRuntime({ type: 'GET_STATE' }).then((response) => {
  activeState = response.state
  renderPill()
  applyAuthoritativeState()
})

scanForPlayer()
setInterval(scanForPlayer, PLAYER_SCAN_INTERVAL_MS)
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
  if (!candidate)
    return

  if (candidate === video) {
    reportMediaIfChanged(candidate)
    return
  }

  detachPlayer(video)
  video = candidate
  attachPlayer(candidate)
  reportMediaIfChanged(candidate)
  void reportPlayerStatus(false)
}

function reportMediaIfChanged(target: HTMLVideoElement): void {
  const media = createMediaFingerprint(target)
  const key = JSON.stringify(media)
  if (key === lastFingerprintKey)
    return
  lastFingerprintKey = key
  void sendRuntime({ type: 'MEDIA_DETECTED', media })
}

function findPrimaryVideo(): HTMLVideoElement | null {
  const videos = [...document.querySelectorAll('video')]
    .filter(item => item instanceof HTMLVideoElement)
  return videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] ?? null
}

function attachPlayer(target: HTMLVideoElement): void {
  target.addEventListener('play', handlePlay)
  target.addEventListener('pause', handlePause)
  target.addEventListener('seeked', handleSeeked)
  target.addEventListener('waiting', handleBuffering)
  target.addEventListener('stalled', handleBuffering)
  target.addEventListener('playing', handleCanPlay)
  target.addEventListener('canplay', handleCanPlay)
  renderPill()
}

function detachPlayer(target: HTMLVideoElement | null): void {
  if (!target)
    return
  target.removeEventListener('play', handlePlay)
  target.removeEventListener('pause', handlePause)
  target.removeEventListener('seeked', handleSeeked)
  target.removeEventListener('waiting', handleBuffering)
  target.removeEventListener('stalled', handleBuffering)
  target.removeEventListener('playing', handleCanPlay)
  target.removeEventListener('canplay', handleCanPlay)
}

function handlePlay(): void {
  if (!eventsSuppressed() && video)
    void sendRuntime({ type: 'PLAYER_INTENT', kind: 'play', positionSeconds: video.currentTime })
  void reportPlayerStatus(false)
}

function handlePause(): void {
  if (!eventsSuppressed() && video && !video.ended)
    void sendRuntime({ type: 'PLAYER_INTENT', kind: 'pause', positionSeconds: video.currentTime })
  void reportPlayerStatus(false)
}

function handleSeeked(): void {
  if (!eventsSuppressed() && video)
    void sendRuntime({ type: 'PLAYER_INTENT', kind: 'seek', positionSeconds: video.currentTime })
  void reportPlayerStatus(false)
}

function handleBuffering(): void {
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = setTimeout(() => {
    bufferingTimer = null
    void reportPlayerStatus(true)
  }, 700)
}

function handleCanPlay(): void {
  if (bufferingTimer)
    clearTimeout(bufferingTimer)
  bufferingTimer = null
  void reportPlayerStatus(false)
}

async function reportPlayerStatus(buffering: boolean): Promise<void> {
  if (!video)
    return
  const sample: PlayerSample = {
    positionSeconds: finiteOrZero(video.currentTime),
    durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
    paused: video.paused,
    buffering,
    sampledAtLocalMs: Date.now(),
  }
  await sendRuntime({ type: 'PLAYER_STATUS', sample })
}

function applyAuthoritativeState(): void {
  const snapshot = activeState?.snapshot
  if (!video || !activeState || !snapshot)
    return

  const estimatedServerNowMs = Date.now() + activeState.serverOffsetMs
  const expectedSeconds = expectedPosition(snapshot.playback, estimatedServerNowMs)

  if (snapshot.playback.status === 'paused') {
    clearScheduledPlay()
    if (!video.paused) {
      suppressPlayerEvents()
      video.pause()
    }
    if (Math.abs(video.currentTime - expectedSeconds) > 0.25) {
      suppressPlayerEvents()
      video.currentTime = expectedSeconds
    }
    restorePlaybackRate()
    return
  }

  const timeUntilPlayMs = snapshot.playback.effectiveAtServerMs - estimatedServerNowMs
  if (timeUntilPlayMs > 12) {
    if (!video.paused) {
      suppressPlayerEvents()
      video.pause()
    }
    if (Math.abs(video.currentTime - snapshot.playback.positionSeconds) > 0.12) {
      suppressPlayerEvents()
      video.currentTime = snapshot.playback.positionSeconds
    }
    schedulePlay(timeUntilPlayMs)
    return
  }

  const correction = chooseDriftCorrection(video.currentTime, expectedSeconds, true)
  if (correction.kind === 'seek') {
    suppressPlayerEvents()
    video.currentTime = correction.positionSeconds
  }
  else if (correction.kind === 'rate') {
    suppressPlayerEvents()
    video.playbackRate = correction.playbackRate
    if (rateResetTimer)
      clearTimeout(rateResetTimer)
    rateResetTimer = setTimeout(restorePlaybackRate, 4_000)
  }
  else {
    restorePlaybackRate()
  }

  if (video.paused)
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
  if (!video)
    return
  suppressPlayerEvents()
  void video.play().catch(() => {
    showNotice('Click the video once so Chrome can allow synchronized play.')
  })
}

function restorePlaybackRate(): void {
  if (rateResetTimer)
    clearTimeout(rateResetTimer)
  rateResetTimer = null
  if (video && video.playbackRate !== 1) {
    suppressPlayerEvents()
    video.playbackRate = 1
  }
}

function suppressPlayerEvents(): void {
  suppressEventsUntil = performance.now() + 1_200
}

function eventsSuppressed(): boolean {
  return performance.now() < suppressEventsUntil
}

function renderPill(): void {
  const snapshot = activeState?.snapshot
  pillHost.style.display = video && snapshot ? 'block' : 'none'
  if (!snapshot || !activeState)
    return

  const participant = snapshot.participants.find(item => item.id === activeState?.participantId)
  const connected = snapshot.participants.filter(item => item.connected)
  const allReady = connected.every(item => item.ready && item.mediaMatches)
  const isController = snapshot.controller.participantId === activeState.participantId

  if (statusElement)
    statusElement.textContent = activeState.connection === 'reconnecting' ? 'Reconnecting' : allReady ? 'In sync' : 'Waiting for everyone'
  if (metaElement)
    metaElement.textContent = `${isController ? 'Controller' : 'Member'}, ${connected.length} connected${participant?.mediaMatches === false ? ', wrong video' : ''}`
  if (playbackButton) {
    playbackButton.hidden = !isController
    playbackButton.textContent = snapshot.playback.status === 'playing' ? 'Pause' : 'Play'
  }
  if (noticeElement && activeState.lastError)
    noticeElement.textContent = activeState.lastError
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
  const service = serviceName(location.hostname)
  const url = new URL(location.href)
  return {
    service,
    canonicalId: canonicalMediaId(service, url).slice(0, 500),
    title: cleanMediaTitle(document.title).slice(0, 300) || 'Untitled video',
    durationSeconds: Number.isFinite(target.duration) ? Math.round(target.duration * 10) / 10 : null,
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

async function sendRuntime(request: RuntimeRequest): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(request) as Promise<RuntimeResponse>
}
