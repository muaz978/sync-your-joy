import type { ConnectionStatus, ParticipantPlaybackStatus, ParticipantState, PlayerSample, ProgressEvidenceQuality } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { playbackStatusCopy } from './playback-status.ts'
import {
  PANEL_STATUS_KEYS,
  panelStatusKey,
  participantRowHtml,
  participantStatusKey,
  providerErrorNote,
  REDETECT_LABEL,
  statusCardHtml,
  statusCardView,
  statusView,
  syncControlsView,
  type PanelIconName,
  type PanelStatusInput,
  type PanelStatusKey,
} from './panel-status-view.ts'

const TEN: ParticipantPlaybackStatus[] = [
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
]

function sample(overrides: Partial<PlayerSample> = {}): PlayerSample {
  return {
    positionSeconds: 12,
    durationSeconds: 600,
    paused: false,
    buffering: false,
    sampledAtLocalMs: 10_000,
    progressed: true,
    progressEvidence: 'frames',
    playbackStartFailed: false,
    playbackStarted: true,
    ...overrides,
  }
}

function input(overrides: Partial<PanelStatusInput> = {}): PanelStatusInput {
  return {
    connection: 'connected',
    hasVideo: true,
    me: { playbackStatus: 'playing', mediaMatches: true, ready: true },
    roomPlaying: true,
    pendingSeek: false,
    operationKind: null,
    sample: sample(),
    health: undefined,
    nowMs: 10_000,
    ...overrides,
  }
}

function participant(overrides: Partial<ParticipantState> = {}): ParticipantState {
  return {
    id: 'participant_a',
    name: 'Rana',
    role: 'member',
    ready: true,
    connected: true,
    mediaMatches: true,
    latencyMs: 40,
    playbackStatus: 'ready',
    ...overrides,
  }
}

// A stand-in for the panel's SVG renderer: the tests care which icon is
// chosen, not what it draws.
const icon = (name: PanelIconName, classes: string): string => `<i data-icon="${name}" class="${classes}"></i>`

function row(p: ParticipantState, overrides: { isMe?: boolean, isController?: boolean, canTransfer?: boolean, key?: PanelStatusKey, connection?: ConnectionStatus, localKey?: PanelStatusKey } = {}): string {
  const key = overrides.key ?? participantStatusKey({
    participant: p,
    isMe: overrides.isMe ?? false,
    connection: overrides.connection ?? 'connected',
    localKey: overrides.localKey ?? 'ready',
  })
  return participantRowHtml({
    participant: p,
    key,
    isMe: overrides.isMe ?? false,
    isController: overrides.isController ?? false,
    canTransfer: overrides.canTransfer ?? false,
  }, icon)
}

function badgeClasses(html: string): string[] {
  const match = /<span class="([^"]*)" data-status-label>/.exec(html)
  if (!match)
    throw new Error(`no status label in: ${html}`)
  return match[1]!.split(/\s+/)
}

function iconOf(html: string): string | undefined {
  return /data-icon="([a-z]+)"/.exec(html)?.[1]
}

describe('panelStatusKey: the status the card shows', () => {
  it('reports each of the ten public statuses as they are while connected and frame-confirmed', () => {
    for (const status of TEN) {
      if (status === 'unknown')
        continue
      expect(panelStatusKey(input({ me: { playbackStatus: status, mediaMatches: true, ready: true } }))).toBe(status)
    }
    expect(panelStatusKey(input({ me: { playbackStatus: 'unknown', mediaMatches: true, ready: true } }))).toBe('unknown')
  })

  it('never reports a playback status while the connection is not connected', () => {
    for (const connection of ['reconnecting', 'disconnected'] as const) {
      for (const status of TEN)
        expect(panelStatusKey(input({ connection, me: { playbackStatus: status, mediaMatches: true, ready: true } }))).toBe('unknown')
    }
  })

  it('does not call clock-only progress confirmed playing', () => {
    expect(panelStatusKey(input({ sample: sample({ progressEvidence: 'clock' }) }))).toBe('clock-only')
  })

  it('does not call progress without frame evidence confirmed playing', () => {
    expect(panelStatusKey(input({ sample: sample({ progressEvidence: 'unknown' }) }))).toBe('frames-unconfirmed')
    const { progressEvidence: _omitted, ...withoutEvidence } = sample()
    expect(panelStatusKey(input({ sample: withoutEvidence }))).toBe('frames-unconfirmed')
    expect(panelStatusKey(input({ sample: null, health: undefined }))).toBe('frames-unconfirmed')
  })

  it('takes frame evidence from the player health when there is no sample yet', () => {
    const health = { buffering: false, progressEvidence: 'frames' as ProgressEvidenceQuality, hasRealPlaybackProgress: true, playbackStartFailed: false }
    expect(panelStatusKey(input({ sample: null, health }))).toBe('playing')
    expect(panelStatusKey(input({ sample: null, health: { ...health, progressEvidence: 'clock' } }))).toBe('clock-only')
  })

  it('leaves every status other than playing alone, whatever the evidence', () => {
    for (const status of TEN.filter(item => item !== 'playing' && item !== 'unknown')) {
      for (const progressEvidence of ['frames', 'clock', 'unknown'] as const)
        expect(panelStatusKey(input({ me: { playbackStatus: status, mediaMatches: true, ready: true }, sample: sample({ progressEvidence }) }))).toBe(status)
    }
  })

  it('works the status out locally when the room has published none, with the same evidence rule', () => {
    const none = { mediaMatches: true, ready: true }
    expect(panelStatusKey(input({ me: none }))).toBe('playing')
    expect(panelStatusKey(input({ me: none, sample: sample({ progressEvidence: 'clock' }) }))).toBe('clock-only')
    expect(panelStatusKey(input({ me: none, hasVideo: false }))).toBe('preparing')
    expect(panelStatusKey(input({ me: undefined, roomPlaying: false }))).toBe('wrong-media')
    expect(panelStatusKey(input({ me: none, roomPlaying: false }))).toBe('ready')
    expect(panelStatusKey(input({ me: none, connection: 'reconnecting' }))).toBe('unknown')
  })
})

describe('statusView: the words and tone for a status', () => {
  it('gives all thirteen keys a distinct label, a detail and an action', () => {
    const labels = new Set<string>()
    for (const key of PANEL_STATUS_KEYS) {
      const view = statusView(key, false)
      expect(view.label.length).toBeGreaterThan(0)
      expect(view.detail.length).toBeGreaterThan(0)
      expect(view.action.length).toBeGreaterThan(0)
      labels.add(view.label)
    }
    expect(labels.size).toBe(PANEL_STATUS_KEYS.length)
    expect(PANEL_STATUS_KEYS).toHaveLength(13)
  })

  it('keeps the label and detail the in-page pill uses for the ten statuses', () => {
    for (const status of TEN) {
      const shared = playbackStatusCopy(status, false)
      const view = statusView(status, false)
      expect(view.label).toBe(shared.label)
      if (status !== 'unknown')
        expect(view.detail).toBe(shared.detail)
    }
  })

  it('uses green only for ready and playing, rose for what needs the person, amber for the rest', () => {
    const tones = Object.fromEntries(PANEL_STATUS_KEYS.map(key => [key, statusView(key, false).tone]))
    expect(tones).toEqual({
      preparing: 'warn',
      ready: 'good',
      playing: 'good',
      seeking: 'warn',
      blocked: 'bad',
      buffering: 'warn',
      silent: 'warn',
      'wrong-media': 'bad',
      'recovery-required': 'bad',
      unknown: 'warn',
      disconnected: 'muted',
      'clock-only': 'warn',
      'frames-unconfirmed': 'warn',
    })
  })

  it('never shows the confirmed label, or any playing label, for unconfirmed progress', () => {
    for (const key of ['clock-only', 'frames-unconfirmed'] as const) {
      const view = statusView(key, true)
      expect(view.label).not.toBe(statusView('playing', true).label)
      expect(view.label).not.toMatch(/^playing/i)
      expect(view.tone).not.toBe('good')
    }
    expect(statusView('clock-only', false).detail).toMatch(/frame counter/i)
  })

  it('tells a disconnected person to wait, not to press a Reconnect that does not exist', () => {
    const unknown = statusView('unknown', false)
    expect(unknown.action).not.toMatch(/reconnect/i)
    expect(unknown.action).toMatch(/wait/i)
    expect(unknown.detail).not.toMatch(/reconnect before/i)
  })

  it('gives the controller and a member different actions for a different episode', () => {
    expect(statusView('wrong-media', true).action).toContain('Open')
    expect(statusView('wrong-media', false).action).toContain('Ask the host')
  })

  it('names, in the card, the control that exists for the action', () => {
    for (const key of PANEL_STATUS_KEYS) {
      const controls = syncControlsView({ hasLocalPlayer: true, roomHasMedia: true, key })
      const { action } = statusView(key, false)
      if (controls && !controls.syncDisabled && ['preparing', 'seeking', 'blocked', 'recovery-required', 'buffering', 'clock-only', 'frames-unconfirmed'].includes(key))
        expect(action).toContain(controls.syncLabel)
    }
    expect(statusView('silent', false).action).toContain(REDETECT_LABEL)
  })

  it('maps the three variants to play-like and warning icons and each status to its own icon', () => {
    const icons = Object.fromEntries(PANEL_STATUS_KEYS.map(key => [key, statusView(key, false).icon]))
    expect(icons).toEqual({
      preparing: 'waiting',
      ready: 'check',
      playing: 'play',
      seeking: 'sync',
      blocked: 'warning',
      buffering: 'waiting',
      silent: 'offline',
      'wrong-media': 'warning',
      'recovery-required': 'warning',
      unknown: 'offline',
      disconnected: 'offline',
      'clock-only': 'play',
      'frames-unconfirmed': 'waiting',
    })
  })
})

describe('syncControlsView: the repair buttons', () => {
  it('labels the Sync button for the reason', () => {
    const label = (key: PanelStatusKey) => syncControlsView({ hasLocalPlayer: true, roomHasMedia: true, key })?.syncLabel
    expect(label('blocked')).toBe('Use Sync gesture')
    expect(label('seeking')).toBe('Retry seek')
    expect(label('preparing')).toBe('Retry preparation')
    for (const key of ['ready', 'playing', 'buffering', 'recovery-required', 'clock-only', 'frames-unconfirmed', 'unknown'] as const)
      expect(label(key)).toBe('Sync me now')
  })

  it('disables Sync without a local player, on a different episode and when the player is silent', () => {
    const disabled = (key: PanelStatusKey, hasLocalPlayer = true) => syncControlsView({ hasLocalPlayer, roomHasMedia: true, key })?.syncDisabled
    expect(disabled('ready', false)).toBe(true)
    expect(disabled('wrong-media')).toBe(true)
    expect(disabled('silent')).toBe(true)
    for (const key of ['preparing', 'ready', 'playing', 'seeking', 'blocked', 'buffering', 'recovery-required', 'unknown', 'clock-only', 'frames-unconfirmed'] as const)
      expect(disabled(key)).toBe(false)
  })

  it('shows nothing until the room has a video', () => {
    expect(syncControlsView({ hasLocalPlayer: true, roomHasMedia: false, key: 'ready' })).toBeNull()
  })
})

describe('providerErrorNote: the standard media error code, and nothing else', () => {
  it('names the four standard MediaError codes', () => {
    expect(providerErrorNote(1)).toMatch(/error 1 \(aborted\)/)
    expect(providerErrorNote(2)).toMatch(/error 2 \(network\)/)
    expect(providerErrorNote(3)).toMatch(/error 3 \(decode\)/)
    expect(providerErrorNote(4)).toMatch(/error 4 \(unsupported\)/)
    expect(providerErrorNote(3)).toMatch(/Player diagnostics/)
  })

  it('says nothing for a missing, zero or non-standard code', () => {
    for (const code of [null, undefined, 0, 5, -1, 3.5, Number.NaN])
      expect(providerErrorNote(code)).toBeNull()
  })

  it('shows on the card for a connected player, not while disconnected or on a different episode', () => {
    const note = (key: PanelStatusKey) => statusCardView({ key, controller: false, errorCode: 3 }).errorNote
    expect(note('recovery-required')).toMatch(/decode/)
    expect(note('buffering')).toMatch(/decode/)
    expect(note('silent')).toMatch(/decode/)
    expect(note('unknown')).toBeNull()
    expect(note('wrong-media')).toBeNull()
    expect(statusCardView({ key: 'playing', controller: false, errorCode: null }).errorNote).toBeNull()
  })
})

describe('statusCardHtml', () => {
  it('shows the label, the detail and the next action, escaped', () => {
    const html = statusCardHtml(statusCardView({ key: 'blocked', controller: false, errorCode: null }))
    expect(html).toContain('Playback blocked')
    expect(html).toContain('Use Sync gesture')
    expect(html).toContain('Next action:')
    expect(statusCardHtml({ ...statusCardView({ key: 'ready', controller: false, errorCode: null }), detail: '<script>x</script>' })).not.toContain('<script>')
  })

  it('adds the media error note under the action when there is one', () => {
    const html = statusCardHtml(statusCardView({ key: 'recovery-required', controller: false, errorCode: 4 }))
    expect(html).toContain('error 4 (unsupported)')
  })

  it('puts the label beside the heading, free to wrap, and gives the detail the full width', () => {
    const html = statusCardHtml(statusCardView({ key: 'frames-unconfirmed', controller: false, errorCode: null }))
    const headingRow = /<div class="([^"]*)">\s*<p class="section-label m-0">Playback status<\/p>\s*<span class="([^"]*)" data-status-label>/.exec(html)
    expect(headingRow).not.toBeNull()
    expect(headingRow![1]).toContain('flex-wrap')
    for (const token of headingRow![2]!.split(/\s+/))
      expect(token).not.toMatch(/^(hidden|(sm|md|lg):)/)
    // The detail is a sibling of that row, not a column beside the label.
    expect(html).toMatch(/<\/div>\s*<p class="mt-2 mb-0 text-xs leading-5 color-fade">Playback has not yet/)
  })
})

describe('participantStatusKey: what each row says', () => {
  const base = { connection: 'connected' as ConnectionStatus, localKey: 'clock-only' as PanelStatusKey }

  it('uses the status the room published for each of the ten values', () => {
    for (const status of TEN)
      expect(participantStatusKey({ participant: participant({ playbackStatus: status }), isMe: false, ...base })).toBe(status)
  })

  it('says Disconnected for a participant who is not connected, whatever they last were', () => {
    for (const status of TEN)
      expect(participantStatusKey({ participant: participant({ connected: false, playbackStatus: status }), isMe: false, ...base })).toBe('disconnected')
  })

  it('says unknown for everyone while this browser is not connected to the room', () => {
    for (const connection of ['reconnecting', 'disconnected'] as const) {
      for (const status of TEN)
        expect(participantStatusKey({ participant: participant({ playbackStatus: status }), isMe: false, connection, localKey: 'playing' })).toBe('unknown')
    }
  })

  it('uses the card\'s own key, with its frame evidence, for the local participant only', () => {
    expect(participantStatusKey({ participant: participant({ playbackStatus: 'playing' }), isMe: true, ...base })).toBe('clock-only')
    expect(participantStatusKey({ participant: participant({ playbackStatus: 'playing' }), isMe: false, ...base })).toBe('playing')
  })

  it('works one out from the flags for an older coordinator that sent none', () => {
    const none = (overrides: Partial<ParticipantState>) => {
      const { playbackStatus: _omitted, ...withoutStatus } = participant(overrides)
      return participantStatusKey({ participant: withoutStatus, isMe: false, ...base })
    }
    expect(none({ mediaMatches: false })).toBe('wrong-media')
    expect(none({ ready: false })).toBe('preparing')
    expect(none({ ready: true })).toBe('ready')
  })
})

describe('participantRowHtml: the people list', () => {
  it('shows the status label for every status', () => {
    for (const key of PANEL_STATUS_KEYS) {
      const html = row(participant(), { key })
      expect(html).toContain(`data-status="${key}"`)
      expect(html).toContain(`>${statusView(key, false).label}</span>`)
    }
  })

  it('never hides the label behind a breakpoint, so a narrow panel and a wide one show the same row', () => {
    for (const key of PANEL_STATUS_KEYS) {
      const classes = badgeClasses(row(participant(), { key, canTransfer: true }))
      expect(classes).toContain('status-badge')
      for (const token of classes)
        expect(token).not.toMatch(/^(hidden|invisible|sr-only|(sm|md|lg|xl|2xl|max-[a-z0-9]+):)/)
    }
  })

  it('keeps the label outside the truncated name and inside the column that can shrink', () => {
    const html = row(participant({ name: 'A'.repeat(40) }), { key: 'recovery-required', canTransfer: true, isController: false })
    expect(html).toMatch(/<p class="[^"]*truncate[^"]*"[^>]*>A{40}<\/p>/)
    expect(html.indexOf('data-status-label')).toBeGreaterThan(html.indexOf('min-w-0 flex-1'))
    expect(html.indexOf('data-status-label')).toBeLessThan(html.indexOf('shrink-0 items-center'))
  })

  it('chooses the icon from the status, not from the ready flag', () => {
    const iconFor = (key: PanelStatusKey, ready: boolean) => iconOf(row(participant({ ready }), { key }))
    // The old icon said "ready" or "not ready" and so showed a tick for a
    // participant who needed recovery and a clock for one who was blocked.
    expect(iconFor('recovery-required', true)).toBe('warning')
    expect(iconFor('blocked', false)).toBe('warning')
    expect(iconFor('playing', true)).toBe('play')
    expect(iconFor('ready', true)).toBe('check')
    expect(iconFor('preparing', true)).toBe('waiting')
    expect(iconFor('seeking', false)).toBe('sync')
    expect(iconFor('silent', true)).toBe('offline')
    expect(iconFor('wrong-media', true)).toBe('warning')
    expect(iconFor('clock-only', true)).toBe('play')
  })

  it('titles the icon with the same words as the label', () => {
    for (const key of PANEL_STATUS_KEYS) {
      const html = row(participant(), { key })
      expect(html).toContain(`title="${statusView(key, false).label}"`)
    }
  })

  it('dims a disconnected participant and shows the offline icon', () => {
    const p = participant({ connected: false, playbackStatus: 'playing' })
    const html = row(p, { localKey: 'ready' })
    expect(html).toContain('opacity-50')
    expect(html).toContain('>Disconnected</span>')
    expect(iconOf(html)).toBe('offline')
    expect(html).not.toContain('Playing')
  })

  it('shows Connection unclear on every row, not Playing, while this browser reconnects', () => {
    const html = row(participant({ playbackStatus: 'playing' }), { connection: 'reconnecting' })
    expect(html).toContain('>Connection unclear</span>')
    expect(html).not.toContain('Playing, confirmed')
  })

  it('shows the clock-only label on the local participant\'s own row', () => {
    const html = row(participant({ playbackStatus: 'playing' }), { isMe: true, localKey: 'clock-only' })
    expect(html).toContain('>Clock only, unconfirmed</span>')
    expect(html).not.toContain('Playing, confirmed')
    expect(html).toContain('(you)')
  })

  it('offers Pass only to the controller, for another connected participant', () => {
    expect(row(participant(), { canTransfer: true })).toContain('data-transfer="participant_a"')
    expect(row(participant(), { canTransfer: false })).not.toContain('data-transfer')
    expect(row(participant(), { canTransfer: true, isMe: true })).not.toContain('data-transfer')
    expect(row(participant({ connected: false }), { canTransfer: true })).not.toContain('data-transfer')
  })

  it('escapes the participant name', () => {
    const html = row(participant({ name: '<img src=x onerror=alert(1)>' }))
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('says who the controller is without repeating the status', () => {
    expect(row(participant(), { isController: true })).toContain('Controller')
    expect(row(participant({ connected: false }))).toContain('Not in the room right now')
  })
})

describe('panelStatusKey and rows agree', () => {
  it('shows one thing on the card and on the local row for every status and connection', () => {
    for (const connection of ['connected', 'reconnecting'] as const) {
      for (const status of TEN) {
        for (const progressEvidence of ['frames', 'clock'] as const) {
          const me = participant({ playbackStatus: status })
          const key = panelStatusKey(input({ connection, me, sample: sample({ progressEvidence }) }))
          expect(participantStatusKey({ participant: me, isMe: true, connection, localKey: key })).toBe(key)
        }
      }
    }
  })
})
