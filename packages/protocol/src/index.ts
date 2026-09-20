export const PROTOCOL_VERSION = 1 as const

/**
 * Version of the operation/compatibility contract carried by the room
 * protocol. This is deliberately separate from `roomRevision`: revisions
 * order snapshots, while this contract decides whether an operation is still
 * valid evidence for the current media and player instance.
 */
export const OPERATION_CONTRACT_VERSION = 1 as const

export const MAX_OPERATION_PARTICIPANTS = 10
export const MAX_CAPABILITIES = 16
export const MAX_SOURCE_GENERATION = Number.MAX_SAFE_INTEGER
export const MAX_SAMPLE_SEQUENCE = Number.MAX_SAFE_INTEGER

export type RoomMode = 'legacy' | 'transactional'

/** Capabilities required before a room may use prepare/commit/start work. */
export type SyncCapability =
  | 'media-epoch'
  | 'operation-identity'
  | 'prepare-start'
  | 'binding-sequence'

export const TRANSACTIONAL_CAPABILITIES: readonly SyncCapability[] = [
  'media-epoch',
  'operation-identity',
  'prepare-start',
  'binding-sequence',
]

export interface ClientCapabilities {
  contractVersion: number
  capabilities: SyncCapability[]
}

export interface CapabilityAdvertisement {
  participantId: string
  capabilities: ClientCapabilities
}

export interface RoomNegotiation {
  mode: RoomMode
  sharedCapabilities: SyncCapability[]
  /** Peers that cannot participate in transactional operations. */
  incompatibleParticipantIds: string[]
}

export interface OperationIdentity {
  /** Increments only when the room's selected media/timed edition changes. */
  mediaEpoch: number
  /** Opaque operation identity. It is not an authorization credential. */
  operationId: string
}

export interface OperationObservationIdentity extends OperationIdentity {
  /** Worker-issued identity for the accepted document/player binding. */
  bindingId: string
  /** Local player/source incarnation, reset when the media node is replaced. */
  sourceGeneration: number
  /** Monotonic sequence from the current binding, not a wall-clock ordering. */
  sampleSequence: number
}

export type OperationKind = 'play' | 'seek' | 'navigation' | 'recovery'
export type OperationPhase = 'preparing' | 'prepared' | 'committed' | 'started' | 'cancelled' | 'failed'
export type OperationReason =
  | 'controller-request'
  | 'superseded'
  | 'deadline-expired'
  | 'participant-not-ready'
  | 'participant-disconnected'
  | 'media-changed'
  | 'binding-changed'
  | 'start-rejected'
  | 'start-timeout'
  | 'unsupported-peer'
  | 'legacy-peer'
  | 'stale-operation'
  | 'manual-recovery'

/**
 * The coordinator-side operation record. `requiredParticipantIds` is frozen
 * for the operation and the other participant lists are monotonic evidence
 * sets. `roomRevision` is intentionally absent: snapshot ordering must not
 * be used as operation validity.
 */
export interface RoomOperation extends OperationIdentity {
  kind: OperationKind
  phase: OperationPhase
  requiredParticipantIds: string[]
  preparedParticipantIds: string[]
  startedParticipantIds: string[]
  targetPositionSeconds: number | null
  /** Whether a seek transaction should schedule playback after preparation. */
  resumeWhenReady?: boolean
  effectiveAtServerMs: number | null
  deadlineAtServerMs: number
  reason?: OperationReason
}

export interface OperationAcknowledgement extends OperationObservationIdentity {
  phase: 'prepared' | 'started'
  participantId: string
  observedPositionSeconds: number
  observedAtLocalMs: number
}

export interface RoomContractSnapshot {
  mode: RoomMode
  mediaEpoch: number
  sharedCapabilities: SyncCapability[]
  operation: RoomOperation | null
}

/** Safe interpretation of a pre-contract snapshot or persisted room state. */
export const LEGACY_ROOM_CONTRACT_DEFAULTS: RoomContractSnapshot = {
  mode: 'legacy',
  mediaEpoch: 0,
  sharedCapabilities: [],
  operation: null,
}

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ROOM_CODE_LENGTH = 8

/**
 * Generates a room code using rejection sampling against the Web Crypto API,
 * so the result is uniformly distributed over `alphabet` with no modulo
 * bias. `crypto.getRandomValues` is available both in browsers (the
 * extension's service worker) and in Node 19+ (via `globalThis.crypto`), so
 * this single implementation is shared by every environment that needs a
 * room code instead of being duplicated per crypto API.
 */
export function generateRoomCode(alphabet: string = ROOM_CODE_ALPHABET): string {
  // Largest byte value below a multiple of alphabet.length: rejecting any
  // draw at or above it keeps `byte % alphabet.length` uniform even if the
  // alphabet's length ever stops evenly dividing 256.
  const maxUnbiasedByte = Math.floor(256 / alphabet.length) * alphabet.length
  let code = ''
  while (code.length < ROOM_CODE_LENGTH) {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0]!
    if (byte < maxUnbiasedByte)
      code += alphabet[byte % alphabet.length]!
  }
  return code
}

const ALLOWED_ORIGIN_PREFIXES = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://',
  'safari-extension://',
  'http://127.0.0.1',
  'http://localhost',
]

/**
 * Checks a WebSocket handshake's Origin header against the allowlist shared
 * by both backends. A real browser (including the extension's own WebSocket
 * handshake) always sends Origin; only a non-browser scripted client omits
 * it, so a missing origin must be rejected rather than treated as trusted.
 * Callers extract the origin string from their own request type (Node's
 * IncomingMessage vs the Workers/Fetch API Request) and pass it here so the
 * allowlist itself can never silently diverge between the two backends.
 */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  return origin != null && ALLOWED_ORIGIN_PREFIXES.some(prefix => origin.startsWith(prefix))
}

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

/**
 * A brand-new (non-reconnecting) join request awaiting the controller's
 * approve/deny decision, as it appears in a room snapshot. Deliberately
 * excludes `media` and `sessionToken`: the same minimal-exposure discipline
 * `ParticipantState` follows for internal-only or sensitive fields never
 * meant to leave the room's trust boundary.
 */
export interface PendingJoinRequest {
  id: string
  name: string
  requestedAtMs: number
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
  pendingJoinRequests: PendingJoinRequest[]
  policy: RoomPolicy
  /** Optional until the coordinator transaction contract is negotiated. */
  contract?: RoomContractSnapshot
}

export interface PlayerSample {
  positionSeconds: number
  durationSeconds: number | null
  paused: boolean
  buffering: boolean
  sampledAtLocalMs: number
  /** True when the player has emitted real playback progress since the last sample. */
  progressed?: boolean
  /** Evidence used for the most recent progress decision. */
  progressEvidence?: ProgressEvidenceQuality
  /** True only when the browser rejected the synchronized play request. */
  playbackStartFailed?: boolean
  /** True after the player has reached a playing state for the current command. */
  playbackStarted?: boolean
}

export type ProgressEvidenceQuality = 'frames' | 'clock' | 'unknown'

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
      capabilities?: ClientCapabilities
    }
  | {
      type: 'join_room'
      protocolVersion: typeof PROTOCOL_VERSION
      participantId: string
      name: string
      code: string
      media: MediaFingerprint | null
      sessionToken?: string
      capabilities?: ClientCapabilities
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
      type: 'respond_to_join'
      participantId: string
      approve: boolean
      actionId: string
      basedOnRevision: number
      leaseEpoch: number
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
      type: 'operation_ack'
      acknowledgement: OperationAcknowledgement
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
      sessionToken: string
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
  sessionToken: string | null
  snapshot: RoomSnapshot | null
  serverOffsetMs: number
  clockUncertaintyMs: number
  lastError: string | null
}

export const CURRENT_CLIENT_CAPABILITIES: ClientCapabilities = {
  contractVersion: OPERATION_CONTRACT_VERSION,
  capabilities: [...TRANSACTIONAL_CAPABILITIES],
}

/** Missing or unknown advertisements are handled as legacy, never upgraded. */
export const LEGACY_CLIENT_CAPABILITIES: ClientCapabilities = {
  contractVersion: 0,
  capabilities: [],
}

export function isCurrentOperation(current: OperationIdentity | null | undefined, candidate: OperationIdentity | null | undefined): boolean {
  return current !== null && current !== undefined
    && candidate !== null && candidate !== undefined
    && current.mediaEpoch === candidate.mediaEpoch
    && current.operationId === candidate.operationId
}

/** Snapshot ordering is independent from operation validity. */
export function isSnapshotRevisionAtLeast(candidateRevision: number, currentRevision: number): boolean {
  return isNonNegativeInteger(candidateRevision)
    && isNonNegativeInteger(currentRevision)
    && candidateRevision >= currentRevision
}

export function normalizeCapabilities(value: unknown): SyncCapability[] {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES)
    return []
  const capabilities: SyncCapability[] = []
  for (const capability of value) {
    if (!isSyncCapability(capability) || capabilities.includes(capability))
      return []
    capabilities.push(capability)
  }
  return capabilities
}

export function normalizeClientCapabilities(value: unknown): ClientCapabilities {
  if (!isRecord(value) || !isNonNegativeInteger(value.contractVersion) || value.contractVersion !== OPERATION_CONTRACT_VERSION)
    return { ...LEGACY_CLIENT_CAPABILITIES }
  return {
    contractVersion: value.contractVersion,
    capabilities: normalizeCapabilities(value.capabilities),
  }
}

export function supportsTransactionalOperations(capabilities: readonly SyncCapability[]): boolean {
  return TRANSACTIONAL_CAPABILITIES.every(capability => capabilities.includes(capability))
}

/**
 * Negotiation is deliberately fail-closed. A single missing or unknown peer
 * keeps the room in legacy mode, and legacy mode cannot acknowledge a
 * transactional operation. B02/B03 can therefore reject or rebuild an
 * operation rather than silently shrinking its contract.
 */
export function negotiateRoomMode(advertisements: readonly CapabilityAdvertisement[]): RoomNegotiation {
  const incompatibleParticipantIds: string[] = []
  const validAdvertisements: CapabilityAdvertisement[] = []
  const seenParticipantIds = new Set<string>()

  for (const advertisement of advertisements) {
    if (!validId(advertisement.participantId) || seenParticipantIds.has(advertisement.participantId))
      continue
    seenParticipantIds.add(advertisement.participantId)
    const capabilities = normalizeClientCapabilities(advertisement.capabilities)
    const compatible = capabilities.contractVersion === OPERATION_CONTRACT_VERSION
      && supportsTransactionalOperations(capabilities.capabilities)
    if (!compatible)
      incompatibleParticipantIds.push(advertisement.participantId)
    validAdvertisements.push({ participantId: advertisement.participantId, capabilities })
  }

  const sharedCapabilities = TRANSACTIONAL_CAPABILITIES.filter(capability => validAdvertisements.length > 0
    && validAdvertisements.every(advertisement => advertisement.capabilities.capabilities.includes(capability)))

  return {
    mode: validAdvertisements.length > 0
      && incompatibleParticipantIds.length === 0
      && sharedCapabilities.length === TRANSACTIONAL_CAPABILITIES.length
      ? 'transactional'
      : 'legacy',
    sharedCapabilities,
    incompatibleParticipantIds,
  }
}

export function canAcknowledgeOperation(
  mode: RoomMode,
  capabilities: readonly SyncCapability[],
  operation: OperationIdentity | null | undefined,
): boolean {
  return mode === 'transactional'
    && operation !== null
    && operation !== undefined
    && supportsTransactionalOperations(capabilities)
}

export function isOperationIdentity(value: unknown): value is OperationIdentity {
  return isRecord(value)
    && isNonNegativeInteger(value.mediaEpoch)
    && validId(value.operationId)
}

export function isOperationObservationIdentity(value: unknown): value is OperationObservationIdentity {
  if (!isRecord(value) || !isOperationIdentity(value))
    return false
  return validId(value.bindingId)
    && isBoundedSafeInteger(value.sourceGeneration, MAX_SOURCE_GENERATION)
    && isBoundedSafeInteger(value.sampleSequence, MAX_SAMPLE_SEQUENCE)
}

export function isRoomOperation(value: unknown): value is RoomOperation {
  if (!isRecord(value)
    || !isOperationIdentity(value)
    || !isOperationKind(value.kind)
    || !isOperationPhase(value.phase)
    || !isParticipantIdList(value.requiredParticipantIds, true)
    || !isParticipantIdList(value.preparedParticipantIds, false)
    || !isParticipantIdList(value.startedParticipantIds, false)
    || !isPositionOrNull(value.targetPositionSeconds)
    || !isTimestampOrNull(value.effectiveAtServerMs)
    || !isFiniteNonNegative(value.deadlineAtServerMs)
    || (value.reason !== undefined && !isOperationReason(value.reason)))
    return false

  const required = new Set(value.requiredParticipantIds as string[])
  const prepared = value.preparedParticipantIds as string[]
  const started = value.startedParticipantIds as string[]
  if (!prepared.every(participantId => required.has(participantId))
    || !started.every(participantId => required.has(participantId)))
    return false
  if (value.resumeWhenReady !== undefined && typeof value.resumeWhenReady !== 'boolean')
    return false

  const allPrepared = prepared.length === required.size && [...required].every(participantId => prepared.includes(participantId))
  const allStarted = started.length === required.size && [...required].every(participantId => started.includes(participantId))
  const terminal = value.phase === 'cancelled' || value.phase === 'failed'
  if (terminal)
    return value.reason !== undefined
  if (value.reason !== undefined)
    return false
  if (value.phase === 'preparing')
    return started.length === 0 && value.effectiveAtServerMs === null
  if (value.phase === 'prepared')
    return allPrepared && started.length === 0 && value.effectiveAtServerMs === null
  if (value.phase === 'committed')
    return allPrepared && started.length === 0 && value.effectiveAtServerMs !== null
  return value.phase === 'started' && allPrepared && allStarted && value.effectiveAtServerMs !== null
}

export function parseOperationAcknowledgement(value: unknown): OperationAcknowledgement | null {
  if (!isRecord(value)
    || (value.phase !== 'prepared' && value.phase !== 'started')
    || !isOperationObservationIdentity(value)
    || !validId(value.participantId)
    || !isFiniteNonNegative(value.observedPositionSeconds)
    || !isFiniteNonNegative(value.observedAtLocalMs))
    return null
  return value as unknown as OperationAcknowledgement
}

/**
 * Old persisted snapshots have no contract section. They are restored as a
 * paused-safe legacy room with media epoch zero and no active operation. A
 * malformed or partially written contract receives the same safe defaults.
 */
export function normalizeRoomContractSnapshot(value: unknown): RoomContractSnapshot {
  if (!isRecord(value))
    return cloneLegacyRoomContractDefaults()

  const sharedCapabilities = normalizeCapabilities(value.sharedCapabilities)
  const mediaEpoch = isNonNegativeInteger(value.mediaEpoch) ? value.mediaEpoch : 0
  const mode = value.mode === 'transactional'
    && supportsTransactionalOperations(sharedCapabilities)
    ? 'transactional'
    : 'legacy'
  const operation = mode === 'transactional'
    && isRoomOperation(value.operation)
    && value.operation.mediaEpoch === mediaEpoch
    ? value.operation
    : null

  return {
    mode,
    mediaEpoch,
    sharedCapabilities,
    operation,
  }
}

function cloneLegacyRoomContractDefaults(): RoomContractSnapshot {
  return {
    mode: LEGACY_ROOM_CONTRACT_DEFAULTS.mode,
    mediaEpoch: LEGACY_ROOM_CONTRACT_DEFAULTS.mediaEpoch,
    sharedCapabilities: [],
    operation: null,
  }
}

export function mediaMatches(expected: MediaFingerprint | null, actual: MediaFingerprint | null): boolean {
  if (!expected || !actual)
    return false

  if (expected.pageUrl && actual.pageUrl && normalizeMediaPageUrl(expected.pageUrl) === normalizeMediaPageUrl(actual.pageUrl))
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

/** Normalize a media identity URL while removing unknown query parameters. */
export function normalizeMediaPageUrl(value: string): string | null {
  const normalized = normalizePageUrl(value)
  if (!normalized)
    return null
  try {
    const url = new URL(normalized)
    const host = url.hostname.toLowerCase()
    const allowedKeys = host === 'qfilm.tv' || host.endsWith('.qfilm.tv')
      ? /^vid$/i
      : host.includes('youtube')
        ? /^v$/i
        : /^(id|v|vid|video|videoid|episode|movie|media)$/i
    for (const key of [...url.searchParams.keys()]) {
      if (!allowedKeys.test(key))
        url.searchParams.delete(key)
    }
    url.searchParams.sort()
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
      if (value.protocolVersion !== PROTOCOL_VERSION || !validId(value.participantId) || !validName(value.name) || !validCode(value.code) || !validMedia(value.media) || (value.capabilities !== undefined && !validClientCapabilities(value.capabilities)))
        return null
      return { ...value, code: value.code.toUpperCase(), media: sanitizeMedia(value.media) } as unknown as ClientMessage

    case 'join_room':
      if (value.protocolVersion !== PROTOCOL_VERSION || !validId(value.participantId) || !validName(value.name) || !validCode(value.code) || !validMedia(value.media) || (value.sessionToken !== undefined && !validSessionToken(value.sessionToken)) || (value.capabilities !== undefined && !validClientCapabilities(value.capabilities)))
        return null
      return { ...value, code: value.code.toUpperCase(), media: sanitizeMedia(value.media) } as unknown as ClientMessage

    case 'set_ready':
      if (typeof value.ready !== 'boolean' || !validMedia(value.media))
        return null
      return { ...value, media: sanitizeMedia(value.media) } as unknown as ClientMessage

    case 'control':
      if (!validId(value.actionId) || !isNonNegativeInteger(value.basedOnRevision) || !isNonNegativeInteger(value.leaseEpoch) || !isControlKind(value.kind) || !isFiniteNonNegative(value.positionSeconds))
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

    case 'respond_to_join':
      if (!validId(value.participantId) || typeof value.approve !== 'boolean' || !validId(value.actionId) || !isNonNegativeInteger(value.basedOnRevision) || !isNonNegativeInteger(value.leaseEpoch))
        return null
      return value as unknown as ClientMessage

    case 'player_status':
      if (!isNonNegativeInteger(value.basedOnRevision) || !validPlayerSample(value.sample))
        return null
      return value as unknown as ClientMessage

    case 'seek_applied':
      if (!isNonNegativeInteger(value.revision) || !isFiniteNonNegative(value.positionSeconds))
        return null
      return value as unknown as ClientMessage

    case 'operation_ack': {
      const acknowledgement = parseOperationAcknowledgement(value.acknowledgement)
      return acknowledgement ? { type: 'operation_ack', acknowledgement } : null
    }

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

function validClientCapabilities(value: unknown): value is ClientCapabilities {
  if (!isRecord(value)
    || (value.contractVersion !== 0 && value.contractVersion !== OPERATION_CONTRACT_VERSION)
    || !Array.isArray(value.capabilities)
    || value.capabilities.length > MAX_CAPABILITIES)
    return false
  const capabilities = value.capabilities as unknown[]
  return capabilities.every(isSyncCapability)
    && new Set(capabilities).size === capabilities.length
}

/**
 * Applies the per-provider pageUrl allowlist (normalizeMediaPageUrl) to an
 * already-validated MediaFingerprint before it is stored or broadcast, so
 * temporary/signed query parameters (session tokens, nonces) never leave the
 * room's trust boundary. `value` must already have passed `validMedia`.
 */
function sanitizeMedia(value: MediaFingerprint | null): MediaFingerprint | null {
  if (!value || value.pageUrl === undefined)
    return value
  const sanitizedPageUrl = normalizeMediaPageUrl(value.pageUrl)
  if (!sanitizedPageUrl) {
    const { pageUrl: _pageUrl, ...rest } = value
    return rest
  }
  return { ...value, pageUrl: sanitizedPageUrl }
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
    && (value.progressEvidence === undefined || value.progressEvidence === 'frames' || value.progressEvidence === 'clock' || value.progressEvidence === 'unknown')
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

function isSyncCapability(value: unknown): value is SyncCapability {
  return value === 'media-epoch'
    || value === 'operation-identity'
    || value === 'prepare-start'
    || value === 'binding-sequence'
}

function isOperationKind(value: unknown): value is OperationKind {
  return value === 'play'
    || value === 'seek'
    || value === 'navigation'
    || value === 'recovery'
}

function isOperationPhase(value: unknown): value is OperationPhase {
  return value === 'preparing'
    || value === 'prepared'
    || value === 'committed'
    || value === 'started'
    || value === 'cancelled'
    || value === 'failed'
}

function isOperationReason(value: unknown): value is OperationReason {
  return value === 'controller-request'
    || value === 'superseded'
    || value === 'deadline-expired'
    || value === 'participant-not-ready'
    || value === 'participant-disconnected'
    || value === 'media-changed'
    || value === 'binding-changed'
    || value === 'start-rejected'
    || value === 'start-timeout'
    || value === 'unsupported-peer'
    || value === 'legacy-peer'
    || value === 'stale-operation'
    || value === 'manual-recovery'
}

function isParticipantIdList(value: unknown, requireAtLeastOne: boolean): value is string[] {
  if (!Array.isArray(value)
    || value.length > MAX_OPERATION_PARTICIPANTS
    || (requireAtLeastOne && value.length === 0))
    return false
  const seen = new Set<string>()
  return value.every(participantId => validId(participantId) && !seen.has(participantId) && seen.add(participantId))
}

function isPositionOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNonNegative(value)
}

function isTimestampOrNull(value: unknown): value is number | null {
  return value === null || isFiniteNonNegative(value)
}

function isBoundedSafeInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && isNonNegativeInteger(value) && value <= maximum
}

function isControlKind(value: unknown): value is ControlKind {
  return value === 'play' || value === 'pause' || value === 'seek'
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(value)
}

function validSessionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{20,80}$/.test(value)
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
