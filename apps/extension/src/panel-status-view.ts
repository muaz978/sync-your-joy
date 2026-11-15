import type { ConnectionStatus, ParticipantPlaybackStatus, ParticipantState, PlayerSample } from '@syncyourjoy/protocol'
import type { PlayerHealthDiagnostics } from './internal.ts'
import { classifyLocalPlayback, playbackStatusCopy } from './playback-status.ts'

/**
 * What the side panel's status card, repair buttons and people list say,
 * decided from state alone so it can be tested without a page.
 * sidepanel.ts only passes state in and puts the HTML this returns on the page.
 *
 * Two rules from the owner's decisions on issue #64 are enforced here:
 *  - nothing reads "Playing, confirmed" unless the player's own progress
 *    evidence is rendered frames; a clock that moves on a player with no frame
 *    counter gets its own label;
 *  - nothing claims a playback state while this browser is not connected to
 *    the room, because the status in hand is then the last one received.
 */

/** The ten public statuses, plus the three the panel needs for what the room cannot say. */
export type PanelStatusKey =
  | ParticipantPlaybackStatus
  /** A participant who is not connected to the room. */
  | 'disconnected'
  /** Playing, but only the video clock is moving: the player has no frame counter. */
  | 'clock-only'
  /** Playing, but this browser has no frame evidence for it yet. */
  | 'frames-unconfirmed'

export const PANEL_STATUS_KEYS: readonly PanelStatusKey[] = [
  'preparing',
  'ready',
  'playing',
  'seeking',
  'blocked',
  'buffering',
  'silent',
  'wrong-media',
  'recovery-required',
  'unknown',
  'disconnected',
  'clock-only',
  'frames-unconfirmed',
]

export type PanelTone = 'good' | 'warn' | 'bad' | 'muted'
export type PanelIconName = 'play' | 'check' | 'waiting' | 'sync' | 'warning' | 'offline'

export interface StatusView {
  key: PanelStatusKey
  label: string
  detail: string
  action: string
  tone: PanelTone
  icon: PanelIconName
}

export const REDETECT_LABEL = 'Redetect player'

const SYNC_NOW = 'Sync me now'

const TONE_CLASSES: Record<PanelTone, string> = {
  good: 'border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'border-amber-600/20 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  bad: 'border-rose-600/20 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  muted: 'border-slate-400/20 bg-slate-500/10 color-fade',
}

const ICON_CLASSES: Record<PanelTone, string> = {
  good: 'text-emerald-600 dark:text-emerald-300',
  warn: 'text-amber-600 dark:text-amber-300',
  bad: 'text-rose-600 dark:text-rose-300',
  muted: 'color-fade',
}

const TONES: Record<PanelStatusKey, PanelTone> = {
  'preparing': 'warn',
  'ready': 'good',
  'playing': 'good',
  'seeking': 'warn',
  'blocked': 'bad',
  'buffering': 'warn',
  'silent': 'warn',
  'wrong-media': 'bad',
  'recovery-required': 'bad',
  'unknown': 'warn',
  'disconnected': 'muted',
  'clock-only': 'warn',
  'frames-unconfirmed': 'warn',
}

const ICONS: Record<PanelStatusKey, PanelIconName> = {
  'preparing': 'waiting',
  'ready': 'check',
  'playing': 'play',
  'seeking': 'sync',
  'blocked': 'warning',
  'buffering': 'waiting',
  'silent': 'offline',
  'wrong-media': 'warning',
  'recovery-required': 'warning',
  'unknown': 'offline',
  'disconnected': 'offline',
  'clock-only': 'play',
  'frames-unconfirmed': 'waiting',
}

// The card's "Next action" names the control the panel actually has for that
// status (the Sync button's label, or Redetect player), so the words match the
// buttons. Statuses with no button of their own say what to wait for.
const ACTIONS: Partial<Record<PanelStatusKey, string>> = {
  'preparing': 'Retry preparation',
  'ready': 'Play when everyone is ready',
  'playing': 'Pause or seek from the controller',
  'seeking': 'Retry seek',
  'blocked': 'Use Sync gesture',
  'buffering': `Wait for data, then ${SYNC_NOW}`,
  'silent': REDETECT_LABEL,
  'recovery-required': SYNC_NOW,
  'unknown': 'Wait for the connection to return',
  'disconnected': 'Wait for them to rejoin',
  'clock-only': `Check the picture is moving; ${SYNC_NOW} if it is not`,
  'frames-unconfirmed': `Wait a moment; ${SYNC_NOW} if the picture is stuck`,
}

const DETAILS: Partial<Record<PanelStatusKey, { label: string, detail: string }>> = {
  'unknown': {
    label: 'Connection unclear',
    detail: 'The room is not confirming your status right now. It returns when the connection does.',
  },
  'disconnected': {
    label: 'Disconnected',
    detail: 'This person is not connected to the room.',
  },
  'clock-only': {
    label: 'Clock only, unconfirmed',
    detail: 'The video clock is advancing, but this player has no frame counter, so rendered frames are not confirmed.',
  },
  'frames-unconfirmed': {
    label: 'Frames unconfirmed',
    detail: 'Playback has not yet been confirmed from rendered frames.',
  },
}

export function statusView(key: PanelStatusKey, controller: boolean): StatusView {
  const own = DETAILS[key]
  const shared = key === 'disconnected' || key === 'clock-only' || key === 'frames-unconfirmed'
    ? null
    : playbackStatusCopy(key, controller)
  return {
    key,
    label: own?.label ?? shared?.label ?? '',
    detail: own?.detail ?? shared?.detail ?? '',
    // Only wrong-media has no action of its own here: the controller and a
    // member are told different things, which playbackStatusCopy decides.
    action: ACTIONS[key] ?? shared?.action ?? '',
    tone: TONES[key],
    icon: ICONS[key],
  }
}

export interface PanelStatusInput {
  connection: ConnectionStatus
  hasVideo: boolean
  me: Pick<ParticipantState, 'mediaMatches' | 'ready' | 'playbackStatus'> | undefined
  roomPlaying: boolean
  pendingSeek: boolean
  operationKind: 'play' | 'seek' | 'navigation' | 'recovery' | null
  sample: PlayerSample | null
  health: PlayerHealthDiagnostics | undefined
  nowMs: number
}

/**
 * The status the panel's card shows for this browser's own player.
 *
 * Whether this browser is connected to the room is checked before anything the
 * room last said about the participant, so a stale "playing" is never shown
 * beside "Reconnecting". Then a "playing" is only kept when the evidence for
 * it is rendered frames; clock-only or missing evidence gets its own key.
 */
export function panelStatusKey(input: PanelStatusInput): PanelStatusKey {
  if (input.connection !== 'connected')
    return 'unknown'
  const { sample, health, me } = input
  const evidence = sample?.progressEvidence ?? health?.progressEvidence ?? 'unknown'
  const roomStatus = me?.playbackStatus
  if (roomStatus !== undefined) {
    // The room's own status for this participant: "playing" is only kept when the evidence for it is rendered frames.
    if (roomStatus !== 'playing' || evidence === 'frames')
      return roomStatus
    return evidence === 'clock' ? 'clock-only' : 'frames-unconfirmed'
  }
  const local = classifyLocalPlayback({
    connected: true,
    hasVideo: input.hasVideo,
    mediaMatches: me?.mediaMatches ?? false,
    ready: me?.ready ?? false,
    roomPlaying: input.roomPlaying,
    pendingSeek: input.pendingSeek,
    operationKind: input.operationKind,
    paused: sample?.paused ?? null,
    buffering: sample?.buffering ?? health?.buffering ?? false,
    playbackStartFailed: sample?.playbackStartFailed ?? health?.playbackStartFailed ?? false,
    playbackStarted: sample?.playbackStarted ?? null,
    progressed: sample?.progressed ?? health?.hasRealPlaybackProgress ?? false,
    progressEvidence: evidence,
    progressAgeMs: sample && !sample.progressed ? statusAgeMs(sample, input.nowMs) : 0,
    statusAgeMs: sample ? statusAgeMs(sample, input.nowMs) : null,
    nowMs: input.nowMs,
  })
  if (local.clockOnly)
    return 'clock-only'
  return local.framesUnconfirmed ? 'frames-unconfirmed' : local.status
}

function statusAgeMs(sample: PlayerSample, nowMs: number): number {
  return Math.max(0, nowMs - sample.sampledAtLocalMs)
}

/** What a participant's row says. `localKey` is the card's key, used for this browser's own row. */
export function participantStatusKey(input: {
  participant: Pick<ParticipantState, 'connected' | 'mediaMatches' | 'ready' | 'playbackStatus'>
  isMe: boolean
  connection: ConnectionStatus
  localKey: PanelStatusKey
}): PanelStatusKey {
  if (input.connection !== 'connected')
    return 'unknown'
  const { participant } = input
  if (!participant.connected)
    return 'disconnected'
  if (input.isMe)
    return input.localKey
  return participant.playbackStatus
    ?? (participant.mediaMatches ? participant.ready ? 'ready' : 'preparing' : 'wrong-media')
}

export interface SyncControlsView {
  syncLabel: string
  syncDisabled: boolean
}

/** The Sync button's label and whether it can be pressed; null while the room has no video. */
export function syncControlsView(input: { hasLocalPlayer: boolean, roomHasMedia: boolean, key: PanelStatusKey }): SyncControlsView | null {
  if (!input.roomHasMedia)
    return null
  const { key } = input
  const syncLabel = key === 'blocked'
    ? 'Use Sync gesture'
    : key === 'seeking'
      ? 'Retry seek'
      : key === 'preparing'
        ? 'Retry preparation'
        : SYNC_NOW
  return {
    syncLabel,
    syncDisabled: !input.hasLocalPlayer || key === 'wrong-media' || key === 'silent',
  }
}

const MEDIA_ERROR_NAMES: Record<number, string> = {
  1: 'aborted',
  2: 'network',
  3: 'decode',
  4: 'unsupported',
}

/**
 * The standard `MediaError.code` of the selected player, named, and where to
 * look next. Only the four standard codes, never a message from the provider.
 */
export function providerErrorNote(code: number | null | undefined): string | null {
  if (typeof code !== 'number' || !Number.isInteger(code))
    return null
  const name = MEDIA_ERROR_NAMES[code]
  if (!name)
    return null
  return `The player reported media error ${code} (${name}). See Player diagnostics, then ${REDETECT_LABEL.toLowerCase()} or reopen the shared page.`
}

export interface StatusCardView extends StatusView {
  errorNote: string | null
}

export function statusCardView(input: { key: PanelStatusKey, controller: boolean, errorCode: number | null | undefined }): StatusCardView {
  const view = statusView(input.key, input.controller)
  // A media error says nothing about a player this browser is not driving or
  // cannot reach, so it is only shown for a status that is about the player.
  const aboutThePlayer = input.key !== 'unknown' && input.key !== 'wrong-media' && input.key !== 'disconnected'
  return { ...view, errorNote: aboutThePlayer ? providerErrorNote(input.errorCode) : null }
}

export function statusCardHtml(view: StatusCardView): string {
  // The label shares a line with the heading and may wrap under it; the detail
  // has the card's full width. Beside the badge, on a 360 px panel, the detail
  // was left about 120 px wide.
  return `
    <div class="soft-panel p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="section-label m-0">Playback status</p>
        <span class="status-badge ${TONE_CLASSES[view.tone]}" data-status-label>${escapeHtml(view.label)}</span>
      </div>
      <p class="mt-2 mb-0 text-xs leading-5 color-fade">${escapeHtml(view.detail)}</p>
      <p class="mt-3 mb-0 text-[0.6875rem] leading-4 color-fade">Next action: ${escapeHtml(view.action)}</p>
      ${view.errorNote ? `<p class="mt-1 mb-0 text-[0.6875rem] leading-4 color-fade">${escapeHtml(view.errorNote)}</p>` : ''}
    </div>
  `
}

export interface ParticipantRowInput {
  participant: ParticipantState
  key: PanelStatusKey
  isMe: boolean
  /** This participant is the room's controller. */
  isController: boolean
  /** The local participant is the controller and may pass control on. */
  canTransfer: boolean
}

/**
 * One person in the room. The status label sits in the name's column, under
 * the name, so it is there at every panel width: it used to be a badge that
 * Tailwind's `sm:` breakpoint hid below 640 px, which is where a docked side
 * panel is. The icon beside it follows the same status.
 */
export function participantRowHtml(input: ParticipantRowInput, renderIcon: (name: PanelIconName, classes: string) => string): string {
  const { participant, key } = input
  const view = statusView(key, input.canTransfer && input.isController)
  const detail = !participant.connected
    ? 'Not in the room right now'
    : `${input.isController ? 'Controller · ' : ''}${participant.ready ? 'Ready' : 'Not ready'}${participant.latencyMs !== null ? `, ${participant.latencyMs} ms` : ''}`
  return `
    <div class="flex min-h-14 items-center gap-3 border-b border-base px-3 py-2 last:border-b-0 ${participant.connected ? '' : 'opacity-50'}" data-participant-row data-status="${key}">
      <span class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-700 color-active" aria-hidden="true">
        ${escapeHtml(initials(participant.name))}
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 truncate text-sm font-700" title="${escapeHtml(participant.name)}">${escapeHtml(participant.name)}${input.isMe ? ' (you)' : ''}</p>
        <p class="m-0 mt-0.5 text-[0.6875rem] leading-4 color-fade">${escapeHtml(detail)}</p>
        <span class="status-badge mt-1 ${TONE_CLASSES[view.tone]}" data-status-label>${escapeHtml(view.label)}</span>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <span class="${ICON_CLASSES[view.tone]}" title="${escapeHtml(view.label)}" aria-hidden="true">${renderIcon(view.icon, 'h-4 w-4')}</span>
        ${input.canTransfer && !input.isMe && participant.connected
          ? `<button class="btn-action min-h-10 px-3 text-xs" type="button" data-transfer="${escapeHtml(participant.id)}">Pass</button>`
          : ''}
      </div>
    </div>
  `
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\'': '&#39;',
    '"': '&quot;',
  })[character] ?? character)
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'SY'
}
