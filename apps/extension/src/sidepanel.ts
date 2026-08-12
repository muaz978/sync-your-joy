import type { ParticipantState } from '@syncyourjoy/protocol'
import type { ExtensionState, RuntimeEvent, RuntimeRequest, RuntimeResponse } from './internal.ts'
import { expectedPosition } from '@syncyourjoy/sync-engine'

const appElement = document.querySelector<HTMLElement>('#app')
if (!appElement)
  throw new Error('SyncYourJoy panel root is missing.')
const app: HTMLElement = appElement

let state: ExtensionState | null = null
let draftName = 'Movie friend'
let draftCode = ''
let draftSharedUrl = ''
let draftRoomCode: string | null = null
let draftNavigationRevision = 0
let toastMessage = ''
let toastTimer: ReturnType<typeof setTimeout> | null = null

void initializeTheme()
void refreshState()

chrome.runtime.onMessage.addListener((message: RuntimeEvent) => {
  if (message.type === 'ROOM_STATE_UPDATED') {
    state = message.state
    draftName = message.state.displayName
    syncSharedLinkDraft(message.state)
    render()
  }
})

async function refreshState(): Promise<void> {
  const response = await sendRuntime({ type: 'GET_STATE' })
  state = response.state
  draftName = response.state.displayName
  syncSharedLinkDraft(response.state)
  render()
}

function render(): void {
  if (!state)
    return

  app.innerHTML = `
    <div class="app-shell">
      <header class="z-top-nav shrink-0 flex items-center justify-between border-b border-base px-4 py-3">
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-3 bg-primary-600 text-slate-50 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)] dark:text-slate-950" aria-hidden="true">
            ${linkIcon('h-5 w-5')}
          </span>
          <div class="min-w-0">
            <h1 class="m-0 truncate text-sm font-700 tracking-tight">SyncYourJoy</h1>
            <p class="m-0 text-[0.6875rem] leading-4 color-fade">Watch on your own account</p>
          </div>
        </div>
        <button id="theme-button" class="btn-action px-3" type="button" aria-label="Change color theme">
          ${themeIcon('h-4 w-4')}
          <span>Theme</span>
        </button>
      </header>

      <main class="z-panel-content min-h-0 flex-1 overflow-y-auto px-4 py-4">
        ${state.snapshot ? roomView(state) : welcomeView(state)}
      </main>

      <footer class="shrink-0 border-t border-base px-4 py-2.5 text-center text-[0.625rem] leading-[0.875rem] color-fade">
        Playback state and normalized page link only. No video, audio, cookies, or passwords.
      </footer>

      <div class="z-toast pointer-events-none fixed inset-x-4 bottom-12 transition-[opacity,transform] duration-150 ${toastMessage ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}" role="status" aria-live="polite">
        <div class="mx-auto max-w-sm rounded-3 bg-slate-800 px-3 py-2 text-center text-xs text-slate-50 shadow-lg dark:bg-slate-100 dark:text-slate-900">
          ${escapeHtml(toastMessage || 'Notice')}
        </div>
      </div>
    </div>
  `

  bindCommonActions()
  if (state.snapshot)
    bindRoomActions()
  else
    bindWelcomeActions()
}

function welcomeView(current: ExtensionState): string {
  const media = current.currentMedia
  return `
    <section class="flex flex-col gap-4">
      <div class="soft-panel p-4">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-3 bg-secondary color-active" aria-hidden="true">
            ${media ? playIcon('h-5 w-5') : screenIcon('h-5 w-5')}
          </span>
          <div class="min-w-0 flex-1">
            <p class="section-label m-0">Current player</p>
            <h2 class="mt-1 mb-0 truncate text-sm font-700" title="${escapeAttribute(media?.title ?? 'No supported video detected')}">
              ${escapeHtml(media?.title ?? 'Open a supported video')}
            </h2>
            <p class="mt-1 mb-0 text-xs color-fade">
              ${media ? `${escapeHtml(serviceLabel(media.service))} is ready to sync.` : 'Open any HTTP or HTTPS page with an HTML5 video.'}
            </p>
          </div>
        </div>
      </div>

      <form id="create-form" class="soft-panel p-4">
        <div class="mb-4">
          <label class="section-label mb-1.5 block" for="display-name">Your name</label>
          <input id="display-name" class="field-base" name="name" maxlength="40" autocomplete="nickname" value="${escapeAttribute(draftName)}" placeholder="How friends see you">
        </div>
        <button class="btn-primary w-full tap-scale" type="submit">
          ${plusIcon('h-4 w-4')}
          Start a synced room
        </button>
      </form>

      <div class="flex items-center gap-3 px-2" aria-hidden="true">
        <span class="h-px flex-1 bg-slate-400/20"></span>
        <span class="text-[0.6875rem] leading-4 color-fade">or join friends</span>
        <span class="h-px flex-1 bg-slate-400/20"></span>
      </div>

      <form id="join-form" class="soft-panel p-4">
        <label class="section-label mb-1.5 block" for="room-code">Room code</label>
        <input id="room-code" class="field-base font-mono tracking-[0.18em] uppercase tabular-nums" name="code" maxlength="8" autocomplete="off" spellcheck="false" value="${escapeAttribute(draftCode)}" placeholder="A7K9P2QX">
        <button class="btn-action mt-3 w-full tap-scale" type="submit">
          ${enterIcon('h-4 w-4')}
          Join room
        </button>
      </form>

      ${current.lastError ? errorPanel(current.lastError) : ''}

      <div class="px-2 text-xs leading-5 color-fade">
        Join immediately—even without a video open. The host can then open the same page for everyone before readiness begins.
      </div>
    </section>
  `
}

function roomView(current: ExtensionState): string {
  const snapshot = current.snapshot
  if (!snapshot)
    return ''

  const me = snapshot.participants.find(participant => participant.id === current.participantId)
  const connected = snapshot.participants.filter(participant => participant.connected)
  const controller = snapshot.participants.find(participant => participant.id === snapshot.controller.participantId)
  const isController = snapshot.controller.participantId === current.participantId
  const allReady = connected.every(participant => participant.ready && participant.mediaMatches)
  const serverNowMs = Date.now() + current.serverOffsetMs
  const currentPosition = expectedPosition(snapshot.playback, serverNowMs)
  return `
    <section class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <p class="section-label m-0">Room code</p>
          <button id="copy-code" class="mt-1 flex min-h-10 items-center gap-2 rounded-3 px-1 text-left focus-visible:outline-2 focus-visible:outline-primary-400" type="button" title="Copy room code ${escapeAttribute(snapshot.code)}">
            <span class="font-mono text-xl font-700 tracking-[0.14em] tabular-nums">${escapeHtml(snapshot.code)}</span>
            ${copyIcon('h-4 w-4 color-fade')}
          </button>
        </div>
        ${connectionBadge(current.connection)}
      </div>

      <div class="soft-panel p-4">
        <div class="flex items-start gap-3">
          <span class="grid h-10 w-10 shrink-0 place-items-center rounded-3 bg-secondary color-active" aria-hidden="true">
            ${playIcon('h-5 w-5')}
          </span>
          <div class="min-w-0 flex-1">
            <p class="section-label m-0">Now syncing</p>
            <h2 class="mt-1 mb-0 truncate text-sm font-700" title="${escapeAttribute(snapshot.media?.title ?? 'Waiting for the host')}">
              ${escapeHtml(snapshot.media?.title ?? 'Waiting for the host')}
            </h2>
            <p class="mt-1 mb-0 text-xs color-fade">
              ${snapshot.media
                ? current.currentMedia ? escapeHtml(serviceLabel(snapshot.media.service)) : 'Shared page opened · loading its player'
                : isController ? 'Paste a video link below when everyone has joined' : 'You are in—no video link is needed from you'}
            </p>
          </div>
        </div>

        <div class="soft-inset mt-4 flex items-center justify-between px-3 py-2.5">
          <div>
            <p class="m-0 text-[0.6875rem] leading-4 color-fade">Timeline</p>
            <p class="m-0 mt-0.5 font-mono text-sm font-700 tabular-nums">${formatTime(currentPosition)}</p>
          </div>
          <div class="text-right">
            <p class="m-0 text-[0.6875rem] leading-4 color-fade">Clock quality</p>
            <p class="m-0 mt-0.5 font-mono text-sm font-700 tabular-nums">${formatClock(current.clockUncertaintyMs)}</p>
          </div>
        </div>
      </div>

      ${readinessControls(me, isController, controller, snapshot.media !== null, current.currentMedia !== null)}
      ${isController ? sharedLinkControls() : ''}
      ${localSyncControls(current.currentMedia !== null, snapshot.media !== null)}
      ${isController && snapshot.media ? controllerControls(snapshot.playback.status, currentPosition, allReady) : ''}

      <div>
        <div class="mb-2 flex items-center justify-between px-1">
          <h2 class="section-label m-0">People</h2>
          <span class="font-mono text-[0.6875rem] leading-4 tabular-nums color-fade">${connected.length}/10 connected</span>
        </div>
        <div class="soft-panel overflow-hidden">
          ${snapshot.participants.map(participant => participantRow(participant, current, isController)).join('')}
        </div>
      </div>

      ${current.lastError ? errorPanel(current.lastError) : ''}

      <button id="leave-room" class="btn-action w-full text-rose-700 dark:text-rose-300" type="button">
        ${leaveIcon('h-4 w-4')}
        Leave room
      </button>
    </section>
  `
}

function sharedLinkControls(): string {
  return `
    <form id="shared-link-form" class="soft-panel p-4">
      <label class="section-label mb-1.5 block" for="shared-video-url">Video page link</label>
      <p class="mt-0 mb-3 text-xs color-fade">Open the same page for everyone. Readiness resets after navigation.</p>
      <input id="shared-video-url" class="field-base" name="url" type="url" inputmode="url" autocomplete="url" value="${escapeAttribute(draftSharedUrl)}" placeholder="https://example.com/watch/video">
      <button class="btn-action mt-3 w-full tap-scale" type="submit">
        ${enterIcon('h-4 w-4')}
        Open link for everyone
      </button>
    </form>
  `
}

function controllerControls(status: 'paused' | 'playing', position: number, allReady: boolean): string {
  return `
    <div class="soft-panel p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <p class="section-label m-0">Your remote</p>
          <p class="mt-1 mb-0 text-xs color-fade">Your controls apply to everyone.</p>
        </div>
        <span class="status-badge ${allReady ? 'border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'}">
          ${allReady ? 'Ready' : 'Waiting'}
        </span>
      </div>
      <div class="grid grid-cols-[1fr_1.45fr_1fr] gap-2">
        <button class="btn-action px-2" type="button" data-seek="${Math.max(0, position - 10)}" aria-label="Go back 10 seconds">
          ${backIcon('h-4 w-4')}
          <span class="font-mono text-xs tabular-nums">10s</span>
        </button>
        <button id="primary-control" class="btn-primary px-3 tap-scale" type="button" ${status === 'paused' && !allReady ? 'disabled' : ''}>
          ${status === 'playing' ? pauseIcon('h-4 w-4') : playIcon('h-4 w-4')}
          ${status === 'playing' ? 'Pause all' : 'Play all'}
        </button>
        <button class="btn-action px-2" type="button" data-seek="${position + 10}" aria-label="Go forward 10 seconds">
          <span class="font-mono text-xs tabular-nums">10s</span>
          ${forwardIcon('h-4 w-4')}
        </button>
      </div>
      <button id="sync-everyone" class="btn-action mt-3 w-full tap-scale" type="button" ${allReady ? '' : 'disabled'}>
        ${syncIcon('h-4 w-4')}
        Sync everyone to ${formatTime(position)}
      </button>
    </div>
  `
}

function readinessControls(me: ParticipantState | undefined, isController: boolean, controller: ParticipantState | undefined, roomHasMedia: boolean, hasLocalPlayer: boolean): string {
  const ready = me?.ready ?? false
  const matches = me?.mediaMatches ?? false
  if (!roomHasMedia) {
    return `
      <div class="soft-panel p-4">
        <p class="section-label m-0">${isController ? 'Room is ready' : `Waiting for ${escapeHtml(controller?.name ?? 'the host')}`}</p>
        <p class="mt-1 mb-0 text-xs leading-5 color-fade">${isController
          ? 'Friends can join now. Paste the video page below only after they are connected.'
          : 'You joined successfully. Stay here—the host will open the video page for everyone.'}</p>
      </div>
    `
  }
  if (!hasLocalPlayer) {
    return `
      <div class="soft-panel p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="section-label m-0">Preparing your player</p>
            <p class="mt-1 mb-0 text-xs leading-5 color-fade">The shared page opened. SyncYourJoy is loading and detecting its video.</p>
          </div>
          <span class="status-badge border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-300">Loading</span>
        </div>
      </div>
    `
  }
  return `
    <div class="soft-panel p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="section-label m-0">${isController ? 'Your readiness' : `Controlled by ${escapeHtml(controller?.name ?? 'the host')}`}</p>
          <p class="mt-1 mb-0 text-xs color-fade">${ready ? 'You are ready. Click again to step out.' : 'Confirm the right video, then get ready.'}</p>
        </div>
        ${matches
          ? '<span class="status-badge border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">Video matches</span>'
          : '<span class="status-badge border-rose-600/20 bg-rose-500/10 text-rose-700 dark:text-rose-300">Wrong video</span>'}
      </div>
      ${matches
        ? `<button id="ready-button" class="${ready ? 'btn-action' : 'btn-primary'} mt-4 w-full tap-scale" type="button">
            ${ready ? checkIcon('h-4 w-4') : readyIcon('h-4 w-4')}
            ${ready ? 'Ready — click to undo' : "I'm ready"}
          </button>`
        : `<button id="recheck-video" class="btn-primary mt-4 w-full tap-scale" type="button">
            ${screenIcon('h-4 w-4')}
            Recheck this tab
          </button>`}
    </div>
  `
}

function localSyncControls(hasLocalPlayer: boolean, roomHasMedia: boolean): string {
  if (!roomHasMedia)
    return ''
  return `
    <div class="soft-panel p-4">
      <p class="section-label m-0">Playback repair</p>
      <p class="mt-1 mb-0 text-xs leading-5 color-fade">Jump to the room timeline and retry playback without refreshing the page.</p>
      <button id="sync-now" class="btn-action mt-3 w-full tap-scale" type="button" ${hasLocalPlayer && roomHasMedia ? '' : 'disabled'}>
        ${syncIcon('h-4 w-4')}
        Sync me now
      </button>
    </div>
  `
}

function participantRow(participant: ParticipantState, current: ExtensionState, canTransfer: boolean): string {
  const isMe = participant.id === current.participantId
  const isController = participant.id === current.snapshot?.controller.participantId
  return `
    <div class="flex min-h-14 items-center gap-3 border-b border-base px-3 py-2 last:border-b-0 ${participant.connected ? '' : 'opacity-50'}">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-700 color-active" aria-hidden="true">
        ${escapeHtml(initials(participant.name))}
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 truncate text-sm font-700" title="${escapeAttribute(participant.name)}">
          ${escapeHtml(participant.name)}${isMe ? ' (you)' : ''}
        </p>
        <p class="m-0 mt-0.5 text-[0.6875rem] leading-4 color-fade">
          ${!participant.connected
            ? 'Disconnected'
            : isController
              ? `Controller · ${participant.ready ? 'Ready' : 'Not ready'}`
              : participant.ready ? 'Ready' : 'Not ready'}${participant.latencyMs !== null ? `, ${participant.latencyMs} ms` : ''}
        </p>
      </div>
      ${canTransfer && !isMe && participant.connected
        ? `<button class="btn-action min-h-10 px-3 text-xs" type="button" data-transfer="${escapeAttribute(participant.id)}">Pass</button>`
        : statusIcon(participant)}
    </div>
  `
}

function bindCommonActions(): void {
  document.querySelector('#theme-button')?.addEventListener('click', () => void toggleTheme())
}

function bindWelcomeActions(): void {
  const nameInput = document.querySelector<HTMLInputElement>('#display-name')
  const codeInput = document.querySelector<HTMLInputElement>('#room-code')
  nameInput?.addEventListener('input', () => {
    draftName = nameInput.value
  })
  codeInput?.addEventListener('input', () => {
    draftCode = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    codeInput.value = draftCode
  })

  document.querySelector('#create-form')?.addEventListener('submit', event => {
    event.preventDefault()
    void saveNameThen({ type: 'CREATE_ROOM' })
  })
  document.querySelector('#join-form')?.addEventListener('submit', event => {
    event.preventDefault()
    void saveNameThen({ type: 'JOIN_ROOM', code: draftCode })
  })
}

function bindRoomActions(): void {
  const sharedUrlInput = document.querySelector<HTMLInputElement>('#shared-video-url')
  sharedUrlInput?.addEventListener('input', () => {
    draftSharedUrl = sharedUrlInput.value
  })
  document.querySelector('#shared-link-form')?.addEventListener('submit', event => {
    event.preventDefault()
    void perform({ type: 'OPEN_LINK', url: draftSharedUrl })
  })

  document.querySelector('#copy-code')?.addEventListener('click', () => {
    const code = state?.snapshot?.code
    if (!code)
      return
    void navigator.clipboard.writeText(code).then(() => showToast('Room code copied.'))
  })

  document.querySelector('#primary-control')?.addEventListener('click', () => {
    if (!state?.snapshot)
      return
    const kind = state.snapshot.playback.status === 'playing' ? 'pause' : 'play'
    void perform({ type: 'CONTROL', kind })
  })

  document.querySelector('#sync-now')?.addEventListener('click', () => {
    void perform({ type: 'SYNC_NOW' })
  })

  document.querySelector('#sync-everyone')?.addEventListener('click', () => {
    if (!state?.snapshot)
      return
    const serverNowMs = Date.now() + state.serverOffsetMs
    void perform({ type: 'CONTROL', kind: 'seek', positionSeconds: expectedPosition(state.snapshot.playback, serverNowMs) })
  })

  document.querySelectorAll<HTMLElement>('[data-seek]').forEach((button) => {
    button.addEventListener('click', () => {
      const positionSeconds = Number(button.dataset.seek)
      if (Number.isFinite(positionSeconds))
        void perform({ type: 'CONTROL', kind: 'seek', positionSeconds })
    })
  })

  document.querySelector('#ready-button')?.addEventListener('click', () => {
    const me = state?.snapshot?.participants.find(participant => participant.id === state?.participantId)
    void perform({ type: 'SET_READY', ready: !(me?.ready ?? false) })
  })

  document.querySelector('#recheck-video')?.addEventListener('click', () => {
    void perform({ type: 'RECHECK_MEDIA' })
  })

  document.querySelectorAll<HTMLElement>('[data-transfer]').forEach((button) => {
    button.addEventListener('click', () => {
      const participantId = button.dataset.transfer
      if (participantId)
        void perform({ type: 'TRANSFER_CONTROL', participantId })
    })
  })

  document.querySelector('#leave-room')?.addEventListener('click', () => {
    void perform({ type: 'LEAVE_ROOM' })
  })
}

async function saveNameThen(action: RuntimeRequest): Promise<void> {
  const nameResponse = await sendRuntime({ type: 'SET_NAME', name: draftName })
  if (!nameResponse.ok) {
    showToast(nameResponse.error ?? 'Enter a display name.')
    return
  }
  await perform(action)
}

async function perform(request: RuntimeRequest): Promise<void> {
  const response = await sendRuntime(request)
  state = response.state
  syncSharedLinkDraft(response.state)
  if (!response.ok)
    showToast(response.error ?? 'That action could not be completed.')
  else if (request.type === 'SYNC_NOW')
    showToast('Sync requested. If playback is blocked, press Sync once in the in-page pill.')
  render()
}

function syncSharedLinkDraft(nextState: ExtensionState): void {
  const roomCode = nextState.snapshot?.code ?? null
  const navigationRevision = nextState.snapshot?.navigation?.revision ?? 0
  if (roomCode === draftRoomCode && navigationRevision === draftNavigationRevision)
    return
  draftRoomCode = roomCode
  draftNavigationRevision = navigationRevision
  draftSharedUrl = nextState.snapshot?.navigation?.url ?? nextState.snapshot?.media?.pageUrl ?? ''
}

function errorPanel(message: string): string {
  return `
    <div class="rounded-3 border border-rose-600/20 bg-rose-500/8 px-3 py-2.5 text-xs leading-5 text-rose-700 dark:text-rose-300" role="alert">
      ${escapeHtml(message)}
    </div>
  `
}

function connectionBadge(connection: ExtensionState['connection']): string {
  const connected = connection === 'connected'
  return `
    <span class="status-badge ${connected ? 'border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-300'}">
      <span class="h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-amber-500'}" aria-hidden="true"></span>
      ${connected ? 'Connected' : 'Reconnecting'}
    </span>
  `
}

function statusIcon(participant: ParticipantState): string {
  if (!participant.connected)
    return `<span class="color-fade" title="Disconnected">${offlineIcon('h-4 w-4')}</span>`
  if (!participant.mediaMatches)
    return `<span class="text-rose-600 dark:text-rose-300" title="Wrong video">${warningIcon('h-4 w-4')}</span>`
  if (participant.ready)
    return `<span class="text-emerald-600 dark:text-emerald-300" title="Ready">${checkIcon('h-4 w-4')}</span>`
  return `<span class="color-fade" title="Not ready">${waitingIcon('h-4 w-4')}</span>`
}

function showToast(message: string): void {
  toastMessage = message
  if (toastTimer)
    clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage = ''
    render()
  }, 3_500)
  render()
}

async function initializeTheme(): Promise<void> {
  const stored = await chrome.storage.local.get('syncYourJoyTheme')
  const theme = stored.syncYourJoyTheme
  const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

async function toggleTheme(): Promise<void> {
  const dark = !document.documentElement.classList.contains('dark')
  document.documentElement.classList.toggle('dark', dark)
  await chrome.storage.local.set({ syncYourJoyTheme: dark ? 'dark' : 'light' })
}

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

function formatClock(uncertaintyMs: number): string {
  if (!Number.isFinite(uncertaintyMs) || uncertaintyMs > 5_000)
    return 'Measuring'
  return `±${Math.round(uncertaintyMs)} ms`
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'SY'
}

function serviceLabel(service: string): string {
  const labels: Record<string, string> = {
    netflix: 'Netflix',
    'disney-plus': 'Disney+',
    crunchyroll: 'Crunchyroll',
    youtube: 'YouTube',
    html5: 'HTML5 video',
    'shared-link': 'Shared video page',
  }
  return labels[service] ?? service
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character)
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

async function sendRuntime(request: RuntimeRequest): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(request) as Promise<RuntimeResponse>
}

function svg(paths: string, classes: string): string {
  return `<svg class="${classes}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}

function linkIcon(classes: string): string { return svg('<path d="M8.5 14.5 6 17a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0"/><path d="m15.5 9.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"/><path d="m8 16 8-8"/>', classes) }
function playIcon(classes: string): string { return svg('<path d="m8 5 11 7-11 7Z"/>', classes) }
function pauseIcon(classes: string): string { return svg('<path d="M9 5v14M15 5v14"/>', classes) }
function plusIcon(classes: string): string { return svg('<path d="M12 5v14M5 12h14"/>', classes) }
function enterIcon(classes: string): string { return svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>', classes) }
function copyIcon(classes: string): string { return svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', classes) }
function themeIcon(classes: string): string { return svg('<path d="M12 3a9 9 0 1 0 9 9c0-1-.2-2-.5-3A5 5 0 0 1 12 3Z"/>', classes) }
function screenIcon(classes: string): string { return svg('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>', classes) }
function backIcon(classes: string): string { return svg('<path d="m12 5-7 7 7 7M19 12H5"/>', classes) }
function forwardIcon(classes: string): string { return svg('<path d="m12 5 7 7-7 7M5 12h14"/>', classes) }
function checkIcon(classes: string): string { return svg('<path d="m5 12 4 4L19 6"/>', classes) }
function readyIcon(classes: string): string { return svg('<path d="M20 6 9 17l-5-5"/>', classes) }
function leaveIcon(classes: string): string { return svg('<path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>', classes) }
function warningIcon(classes: string): string { return svg('<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3ZM12 9v4M12 17h.01"/>', classes) }
function waitingIcon(classes: string): string { return svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', classes) }
function syncIcon(classes: string): string { return svg('<path d="M20 7h-5V2"/><path d="M20 2 9 13"/><path d="M4 17h5v5"/><path d="m4 22 11-11"/>', classes) }
function offlineIcon(classes: string): string { return svg('<path d="M2 2l20 20M8.5 8.5A5 5 0 0 0 7 12c0 3 2 5 5 5a5 5 0 0 0 3.5-1.5M17 12a5 5 0 0 0-6.5-4.8"/>', classes) }
