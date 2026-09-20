import type { ClientRoomState, ControlKind, MediaFingerprint, PlayerSample, ProgressEvidenceQuality } from '@syncyourjoy/protocol'

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
