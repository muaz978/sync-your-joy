import type { ClientRoomState, ControlKind, MediaFingerprint, PlayerSample } from '@syncyourjoy/protocol'

export interface ExtensionState extends ClientRoomState {
  displayName: string
  playerTabId: number | null
  currentMedia: MediaFingerprint | null
  lastPlayerSample: PlayerSample | null
}

export type RuntimeRequest =
  | { type: 'GET_STATE' }
  | { type: 'SET_NAME'; name: string }
  | { type: 'CREATE_ROOM' }
  | { type: 'JOIN_ROOM'; code: string }
  | { type: 'LEAVE_ROOM' }
  | { type: 'SET_READY'; ready: boolean }
  | { type: 'RECHECK_MEDIA' }
  | { type: 'CONTROL'; kind: ControlKind; positionSeconds?: number }
  | { type: 'TRANSFER_CONTROL'; participantId: string }
  | { type: 'MEDIA_DETECTED'; media: MediaFingerprint }
  | { type: 'PLAYER_STATUS'; sample: PlayerSample }
  | { type: 'PLAYER_INTENT'; kind: ControlKind; positionSeconds: number }
  | { type: 'OPEN_PANEL' }

export type ContentRequest = { type: 'GET_PLAYER_CONTEXT' }

export interface PlayerContext {
  media: MediaFingerprint | null
  sample: PlayerSample | null
}

export type RuntimeEvent =
  | { type: 'ROOM_STATE_UPDATED'; state: ExtensionState }
  | { type: 'APPLY_ROOM_STATE'; state: ExtensionState }
  | { type: 'PAUSE_LOCAL' }
  | { type: 'SHOW_NOTICE'; message: string }

export interface RuntimeResponse {
  ok: boolean
  state: ExtensionState
  error?: string
}
