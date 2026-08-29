import type { ClientRoomState, ControlKind, MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'

export type PlayerOrigin = 'light-dom' | 'open-shadow-dom'

export interface PlayerDiagnostics {
  origin: PlayerOrigin
  readyState: number
  networkState: number
  currentSrcKind: 'none' | 'http' | 'https' | 'blob' | 'data' | 'other'
  hasSourceObject: boolean
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
}

export type RuntimeRequest =
  | { type: 'GET_STATE' }
  | { type: 'SET_NAME'; name: string }
  | { type: 'CREATE_ROOM' }
  | { type: 'JOIN_ROOM'; code: string }
  | { type: 'LEAVE_ROOM' }
  | { type: 'SET_READY'; ready: boolean }
  | { type: 'RECHECK_MEDIA' }
  | { type: 'OPEN_LINK'; url: string }
  | { type: 'SYNC_NOW' }
  | { type: 'DOWNLOAD_DIAGNOSTICS' }
  | { type: 'CONTROL'; kind: ControlKind; positionSeconds?: number }
  | { type: 'TRANSFER_CONTROL'; participantId: string }
  | { type: 'MEDIA_DETECTED'; media: MediaFingerprint; areaPixels: number; diagnostics?: PlayerDiagnostics }
  | { type: 'MEDIA_LOST' }
  | { type: 'PLAYER_STATUS'; basedOnRevision: number; sample: PlayerSample }
  | { type: 'SEEK_APPLIED'; revision: number; positionSeconds: number }
  | { type: 'PLAYER_INTENT'; kind: ControlKind; positionSeconds: number }
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

export interface RuntimeResponse {
  ok: boolean
  state: ExtensionState
  error?: string
}
