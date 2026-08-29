export const PROTOCOL_VERSION = 1 as const

export type PlaybackStatus = 'paused' | 'playing'
export type ParticipantRole = 'controller' | 'member'
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected'

export interface MediaFingerprint {
  service: string
  canonicalId: string
  title: string
  durationSeconds: number | null
  pageUrl?: string
}

export interface SharedNavigation {
  revision: number
  url: string
  effectiveAtServerMs: number
}

export interface PlaybackState {
  status: PlaybackStatus
  positionSeconds: number
  effectiveAtServerMs: number
  playbackRate: number
}

export interface SharedSeek {
  revision: number
  positionSeconds: number
  resumeWhenReady: boolean
  deadlineAtServerMs: number
  acknowledgedParticipantIds: string[]
}

export interface ParticipantState {
  id: string
  name: string
  role: ParticipantRole
  ready: boolean
  connected: boolean
  mediaMatches: boolean
  latencyMs: number | null
}

export interface RoomPolicy {
  buffering: 'pause-all' | 'catch-up'
}

export interface RoomSnapshot {
  roomId: string
  code: string
  revision: number
  controller: {
    participantId: string
    leaseEpoch: number
  }
  media: MediaFingerprint | null
  playback: PlaybackState
  seek: SharedSeek | null
  navigation: SharedNavigation | null
  participants: ParticipantState[]
  policy: RoomPolicy
}

export interface PlayerSample {
  positionSeconds: number
  durationSeconds: number | null
  paused: boolean
  buffering: boolean
  sampledAtLocalMs: number
  /** True when the player has emitted real playback progress since the last sample. */
  progressed?: boolean
  /** True only when the browser rejected the synchronized play request. */
  playbackStartFailed?: boolean
  /** True after the player has reached a playing state for the current command. */
  playbackStarted?: boolean
}

export type DiagnosticValue = string | number | boolean | null

export interface DiagnosticEvent {
  atLocalMs: number
  category: string
  message: string
  details: Record<string, DiagnosticValue>
}

export interface DiagnosticsReport {
  extensionVersion: string
  generatedAtLocalMs: number
  userAgent: string
  connection: ConnectionStatus
  roomRevision: number | null
  playbackStatus: PlaybackStatus | null
  playerFrameId: number | null
  playerAreaPixels: number
  playerLastSeenAtMs: number
  mediaService: string | null
  mediaCanonicalId: string | null
  mediaPageUrl: string | null
  playerOrigin?: string | null
  playerReadyState?: number | null
  playerNetworkState?: number | null
  playerCurrentSrcKind?: string | null
  playerHasSourceObject?: boolean | null
  sample: PlayerSample | null
  events: DiagnosticEvent[]
}

export type ControlKind = 'play' | 'pause' | 'seek'

export type ClientMessage =
  | {
      type: 'create_room'
      protocolVersion: typeof PROTOCOL_VERSION
      participantId: string
      name: string
      code: string
      media: MediaFingerprint | null
    }
  | {
      type: 'join_room'
      protocolVersion: typeof PROTOCOL_VERSION
      participantId: string
      name: string
      code: string
      media: MediaFingerprint | null
    }
  | {
      type: 'set_ready'
      ready: boolean
      media: MediaFingerprint | null
    }
  | {
      type: 'control'
      actionId: string
      basedOnRevision: number
      leaseEpoch: number
      kind: ControlKind
      positionSeconds: number
      /** True only when the controller emitted a native seek after its own seeked event. */
      controllerSeekApplied?: boolean
    }
  | {
      type: 'transfer_control'
      participantId: string
      leaseEpoch: number
    }
  | {
      type: 'open_link'
      actionId: string
      basedOnRevision: number
      leaseEpoch: number
      url: string
    }
  | {
      type: 'player_status'
      basedOnRevision: number
      sample: PlayerSample
    }
  | {
      type: 'seek_applied'
      revision: number
      positionSeconds: number
    }
  | {
      type: 'request_diagnostics'
      reportId: string
    }
  | {
      type: 'diagnostics_response'
      reportId: string
      report: DiagnosticsReport
    }
  | {
      type: 'ping'
      id: string
      sentAtLocalMs: number
    }
  | {
      type: 'client_metrics'
      roundTripMs: number
    }

export type ServerMessage =
  | {
      type: 'room_joined'
      participantId: string
      inviteToken: string
      snapshot: RoomSnapshot
    }
  | {
      type: 'room_snapshot'
      reason: string
      snapshot: RoomSnapshot
    }
  | {
      type: 'command_rejected'
      actionId: string | null
      code: string
      message: string
      snapshot: RoomSnapshot | null
    }
  | {
      type: 'pong'
      id: string
      sentAtLocalMs: number
      serverTimeMs: number
    }
  | {
      type: 'diagnostics_requested'
      reportId: string
    }
  | {
      type: 'diagnostics_response'
      reportId: string
      participantId: string
      participantName: string
      report: DiagnosticsReport
    }
  | {
      type: 'error'
      code: string
      message: string
    }

export interface ClientRoomState {
  connection: ConnectionStatus
  participantId: string
  inviteToken: string | null
  snapshot: RoomSnapshot | null
  serverOffsetMs: number
  clockUncertaintyMs: number
  lastError: string | null
}

export function mediaMatches(expected: MediaFingerprint | null, actual: MediaFingerprint | null): boolean {
  if (!expected || !actual)
    return false

  if (expected.pageUrl && actual.pageUrl && normalizePageUrl(expected.pageUrl) === normalizePageUrl(actual.pageUrl))
    return true

  if (expected.service !== actual.service)
    return false

  const expectedId = normalizeCanonicalId(expected.service, expected.canonicalId)
  const actualId = normalizeCanonicalId(actual.service, actual.canonicalId)
  if (expectedId !== actualId)
    return false

  if (hasStrongCanonicalId(expected.service, expectedId))
    return true

  if (expected.durationSeconds === null || actual.durationSeconds === null)
    return true

  return Math.abs(expected.durationSeconds - actual.durationSeconds) <= 3
}

export function normalizePageUrl(value: string): string | null {
  if (value.length > 2_048)
    return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    if (url.username || url.password)
      return null
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))
      url.port = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key))
        url.searchParams.delete(key)
    }
    url.searchParams.sort()
    if (url.pathname.length > 1)
      url.pathname = url.pathname.replace(/\/+$/, '')
    return url.toString()
  }
  catch {
    return null
  }
}

export function normalizeCanonicalId(service: string, canonicalId: string): string {
  if (service === 'crunchyroll') {
    const episodeId = canonicalId.match(/^crunchyroll:([a-z0-9]+)$/i)?.[1]
      ?? canonicalId.match(/\/watch\/([a-z0-9]+)/i)?.[1]
    if (episodeId)
      return `crunchyroll:${episodeId.toUpperCase()}`
  }

  if (service === 'netflix') {
    const videoId = canonicalId.match(/^netflix:(\d+)$/)?.[1]
      ?? canonicalId.match(/\/watch\/(\d+)/)?.[1]
    if (videoId)
      return `netflix:${videoId}`
  }

  if (service === 'qfilm') {
    const videoId = canonicalId.match(/^qfilm:([a-z0-9]+)$/i)?.[1]
    if (videoId)
      return `qfilm:${videoId.toLowerCase()}`
  }

  return canonicalId
}

function hasStrongCanonicalId(service: string, canonicalId: string): boolean {
  return (service === 'crunchyroll' && /^crunchyroll:[A-Z0-9]+$/.test(canonicalId))
    || (service === 'netflix' && /^netflix:\d+$/.test(canonicalId))
    || (service === 'youtube' && canonicalId.startsWith('youtube:'))
    || (service === 'disney-plus' && canonicalId.startsWith('disney-plus:'))
    || (service === 'qfilm' && /^qfilm:[a-z0-9]+$/.test(canonicalId))
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== 'string')
    return null

  switch (value.type) {
    case 'create_room':
      if (value.protocolVersion !== PROTOCOL_VERSION || !validId(value.participantId) || !validName(value.name) || !validCode(value.code) || !validMedia(value.media))
        return null
      return { ...value, code: value.code.toUpperCase() } as unknown as ClientMessage

    case 'join_room':
      if (value.protocolVersion !== PROTOCOL_VERSION || !validId(value.participantId) || !validName(value.name) || !validCode(value.code) || !validMedia(value.media))
        return null
      return { ...value, code: value.code.toUpperCase() } as unknown as ClientMessage

    case 'set_ready':
      if (typeof value.ready !== 'boolean' || !validMedia(value.media))
        return null
      return value as unknown as ClientMessage

    case 'control':
      if (!validId(value.actionId) || !isNonNegativeInteger(value.basedOnRevision) || !isNonNegativeInteger(value.leaseEpoch) || !isControlKind(value.kind) || !isFiniteNonNegative(value.positionSeconds) || (value.controllerSeekApplied !== undefined && typeof value.controllerSeekApplied !== 'boolean'))
        return null
      return value as unknown as ClientMessage

    case 'transfer_control':
      if (!validId(value.participantId) || !isNonNegativeInteger(value.leaseEpoch))
        return null
      return value as unknown as ClientMessage

    case 'open_link':
      if (!validId(value.actionId) || !isNonNegativeInteger(value.basedOnRevision) || !isNonNegativeInteger(value.leaseEpoch) || !validPageUrl(value.url))
        return null
      return { ...value, url: normalizePageUrl(value.url) } as unknown as ClientMessage

    case 'player_status':
      if (!isNonNegativeInteger(value.basedOnRevision) || !validPlayerSample(value.sample))
        return null
      return value as unknown as ClientMessage

    case 'seek_applied':
      if (!isNonNegativeInteger(value.revision) || !isFiniteNonNegative(value.positionSeconds))
        return null
      return value as unknown as ClientMessage

    case 'request_diagnostics':
      if (!validId(value.reportId))
        return null
      return value as unknown as ClientMessage

    case 'diagnostics_response':
      if (!validId(value.reportId) || !validDiagnosticsReport(value.report))
        return null
      return value as unknown as ClientMessage

    case 'ping':
      if (!validId(value.id) || !isFiniteNonNegative(value.sentAtLocalMs))
        return null
      return value as unknown as ClientMessage

    case 'client_metrics':
      if (!isFiniteNonNegative(value.roundTripMs) || value.roundTripMs > 10_000)
        return null
      return value as unknown as ClientMessage

    default:
      return null
  }
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validMedia(value: unknown): value is MediaFingerprint | null {
  if (value === null)
    return true
  if (!isRecord(value))
    return false

  return validShortText(value.service, 40)
    && validShortText(value.canonicalId, 500)
    && validShortText(value.title, 300)
    && (value.durationSeconds === null || isFiniteNonNegative(value.durationSeconds))
    && (value.pageUrl === undefined || validPageUrl(value.pageUrl))
}

function validPageUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2_048 && normalizePageUrl(value) !== null
}

function validPlayerSample(value: unknown): value is PlayerSample {
  if (!isRecord(value))
    return false

  return isFiniteNonNegative(value.positionSeconds)
    && (value.durationSeconds === null || isFiniteNonNegative(value.durationSeconds))
    && typeof value.paused === 'boolean'
    && typeof value.buffering === 'boolean'
    && isFiniteNonNegative(value.sampledAtLocalMs)
    && (value.progressed === undefined || typeof value.progressed === 'boolean')
    && (value.playbackStartFailed === undefined || typeof value.playbackStartFailed === 'boolean')
    && (value.playbackStarted === undefined || typeof value.playbackStarted === 'boolean')
}

function validDiagnosticsReport(value: unknown): value is DiagnosticsReport {
  if (!isRecord(value) || !Array.isArray(value.events) || value.events.length > 120)
    return false
  return validShortText(value.extensionVersion, 30)
    && isFiniteNonNegative(value.generatedAtLocalMs)
    && typeof value.userAgent === 'string' && value.userAgent.length <= 300
    && (value.connection === 'connected' || value.connection === 'reconnecting' || value.connection === 'disconnected')
    && (value.roomRevision === null || isNonNegativeInteger(value.roomRevision))
    && (value.playbackStatus === null || value.playbackStatus === 'paused' || value.playbackStatus === 'playing')
    && (value.playerFrameId === null || Number.isInteger(value.playerFrameId))
    && isFiniteNonNegative(value.playerAreaPixels)
    && isFiniteNonNegative(value.playerLastSeenAtMs)
    && (value.mediaService === null || typeof value.mediaService === 'string' && value.mediaService.length <= 40)
    && (value.mediaCanonicalId === null || typeof value.mediaCanonicalId === 'string' && value.mediaCanonicalId.length <= 500)
    && (value.mediaPageUrl === null || validPageUrl(value.mediaPageUrl))
    && (value.playerOrigin === undefined || value.playerOrigin === null || validShortText(value.playerOrigin, 40))
    && (value.playerReadyState === undefined || value.playerReadyState === null || isFiniteNonNegative(value.playerReadyState))
    && (value.playerNetworkState === undefined || value.playerNetworkState === null || isFiniteNonNegative(value.playerNetworkState))
    && (value.playerCurrentSrcKind === undefined || value.playerCurrentSrcKind === null || validShortText(value.playerCurrentSrcKind, 20))
    && (value.playerHasSourceObject === undefined || value.playerHasSourceObject === null || typeof value.playerHasSourceObject === 'boolean')
    && (value.sample === null || validPlayerSample(value.sample))
    && value.events.every(validDiagnosticEvent)
}

function validDiagnosticEvent(value: unknown): value is DiagnosticEvent {
  if (!isRecord(value) || !isRecord(value.details) || Object.keys(value.details).length > 20)
    return false
  return isFiniteNonNegative(value.atLocalMs)
    && validShortText(value.category, 40)
    && validShortText(value.message, 100)
    && Object.entries(value.details).every(([key, detail]) => key.length <= 40 && validDiagnosticValue(detail))
}

function validDiagnosticValue(value: unknown): value is DiagnosticValue {
  return value === null
    || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && value.length <= 300
}

function isControlKind(value: unknown): value is ControlKind {
  return value === 'play' || value === 'pause' || value === 'seek'
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(value)
}

function validName(value: unknown): value is string {
  return validShortText(value, 40)
}

function validCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z0-9]{8}$/i.test(value)
}

function validShortText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isFiniteNonNegative(value)
}
