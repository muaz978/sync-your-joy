import type { ClientCapabilities, ClientRoomState, ControlKind, MediaFingerprint, OperationAcknowledgement, OperationIdentity, PlayerSample, ProgressEvidenceQuality, RoomMode } from '@syncyourjoy/protocol'
import { LEGACY_CLIENT_CAPABILITIES, OPERATION_CONTRACT_VERSION, normalizeRoomContractSnapshot } from '@syncyourjoy/protocol'

export type PlayerOrigin = 'light-dom' | 'open-shadow-dom'

export interface PlayerHealthDiagnostics {
  buffering: boolean
  progressEvidence: ProgressEvidenceQuality
  hasRealPlaybackProgress: boolean
  playbackStartFailed: boolean
}

export interface PlayerDiagnostics {
  origin: PlayerOrigin
  readyState: number
  networkState: number
  currentSrcKind: 'none' | 'http' | 'https' | 'blob' | 'data' | 'other'
  hasSourceObject: boolean
  health?: PlayerHealthDiagnostics
  locked?: boolean
}

/**
 * Extension-owned contract state. It is optional on ExtensionState so older
 * in-memory/test messages remain readable, but any restored value should pass
 * through normalizeStoredContractState before it is used for acknowledgements.
 */
export interface ExtensionContractState {
  mode: RoomMode
  capabilities: ClientCapabilities
  mediaEpoch: number
  operation: OperationIdentity | null
  bindingId: string | null
  sourceGeneration: number
  sampleSequence: number
}

export const LEGACY_EXTENSION_CONTRACT_DEFAULTS: ExtensionContractState = {
  mode: 'legacy',
  capabilities: { ...LEGACY_CLIENT_CAPABILITIES },
  mediaEpoch: 0,
  operation: null,
  bindingId: null,
  sourceGeneration: 0,
  sampleSequence: 0,
}

/**
 * Restores the safe defaults for pre-CR-B01 session records. In particular,
 * an old operation is never treated as current preparation evidence after a
 * service-worker restart, and a missing binding starts at sequence zero.
 */
export function normalizeStoredContractState(value: unknown): ExtensionContractState {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return cloneLegacyContractDefaults()

  const stored = value as Record<string, unknown>
  const snapshot = normalizeRoomContractSnapshot({
    mode: stored.mode,
    mediaEpoch: stored.mediaEpoch,
    sharedCapabilities: stored.capabilities && typeof stored.capabilities === 'object'
      ? (stored.capabilities as Record<string, unknown>).capabilities
      : stored.capabilities,
    operation: stored.operation,
  })
  const capabilities = stored.capabilities && typeof stored.capabilities === 'object'
    ? stored.capabilities as Record<string, unknown>
    : null
  const contractVersion = capabilities?.contractVersion
  const normalizedCapabilities: ClientCapabilities = Number.isSafeInteger(contractVersion)
    && contractVersion === OPERATION_CONTRACT_VERSION
    ? {
        contractVersion,
        capabilities: snapshot.sharedCapabilities,
      }
    : { ...LEGACY_CLIENT_CAPABILITIES }

  return {
    mode: snapshot.mode,
    capabilities: normalizedCapabilities,
    mediaEpoch: snapshot.mediaEpoch,
    operation: snapshot.operation
      ? { mediaEpoch: snapshot.operation.mediaEpoch, operationId: snapshot.operation.operationId }
      : null,
    bindingId: typeof stored.bindingId === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(stored.bindingId) ? stored.bindingId : null,
    sourceGeneration: boundedCounter(stored.sourceGeneration),
    sampleSequence: boundedCounter(stored.sampleSequence),
  }
}

function cloneLegacyContractDefaults(): ExtensionContractState {
  return {
    ...LEGACY_EXTENSION_CONTRACT_DEFAULTS,
    capabilities: { ...LEGACY_EXTENSION_CONTRACT_DEFAULTS.capabilities },
  }
}

function boundedCounter(value: unknown): number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 ? value : 0
}

export interface ExtensionState extends ClientRoomState {
  displayName: string
  playerTabId: number | null
  playerFrameId: number | null
  playerAreaPixels: number
  playerLastSeenAtMs: number
  currentMedia: MediaFingerprint | null
  playerDiagnostics: PlayerDiagnostics | null
  lastPlayerSample: PlayerSample | null
  lastOpenedNavigationRevision: number
  connectionQuality: 'unknown' | 'good' | 'degraded' | 'offline'
  roundTripMs: number | null
  lastPongAtMs: number
  contract?: ExtensionContractState
}

export type RuntimeRequest =
  | { type: 'GET_STATE' }
  | { type: 'SET_NAME'; name: string }
  | { type: 'CREATE_ROOM' }
  | { type: 'JOIN_ROOM'; code: string }
  | { type: 'LEAVE_ROOM' }
  | { type: 'SET_READY'; ready: boolean }
  | { type: 'RECHECK_MEDIA' }
  | { type: 'LOCK_PLAYER' }
  | { type: 'UNLOCK_PLAYER' }
  | { type: 'OPEN_LINK'; url: string }
  | { type: 'SYNC_NOW' }
  | { type: 'DOWNLOAD_DIAGNOSTICS' }
  | { type: 'CONTROL'; kind: ControlKind; positionSeconds?: number }
  | { type: 'TRANSFER_CONTROL'; participantId: string }
  | { type: 'RESPOND_TO_JOIN'; participantId: string; approve: boolean }
  | { type: 'MEDIA_DETECTED'; media: MediaFingerprint; areaPixels: number; diagnostics?: PlayerDiagnostics; bindingId?: string | undefined }
  | { type: 'MEDIA_LOST'; bindingId?: string | undefined }
  | { type: 'PLAYER_STATUS'; basedOnRevision: number; sample: PlayerSample; bindingId?: string | undefined }
  | { type: 'SEEK_APPLIED'; revision: number; positionSeconds: number; bindingId?: string | undefined }
  | { type: 'OPERATION_ACK'; acknowledgement: OperationAcknowledgement }
  | { type: 'PLAYER_INTENT'; kind: ControlKind; positionSeconds: number; bindingId?: string | undefined }
  | { type: 'OPEN_PANEL' }

export type ContentRequest =
  | { type: 'GET_PLAYER_CONTEXT' }
  | { type: 'REPORT_PLAYER_CONTEXT' }

export interface PlayerContext {
  media: MediaFingerprint | null
  sample: PlayerSample | null
  diagnostics: PlayerDiagnostics | null
}

export type RuntimeEvent =
  | { type: 'ROOM_STATE_UPDATED'; state: ExtensionState }
  | { type: 'APPLY_ROOM_STATE'; state: ExtensionState }
  | { type: 'PAUSE_LOCAL' }
  | { type: 'FORCE_SYNC' }
  | { type: 'SHOW_NOTICE'; message: string }
  | { type: 'LOCK_PLAYER' }
  | { type: 'UNLOCK_PLAYER' }

export interface RuntimeResponse {
  ok: boolean
  state: ExtensionState
  error?: string
  /** Opaque worker-issued identity for the current content-script document. */
  playerBindingId?: string
}
