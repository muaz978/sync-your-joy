export const PLAYER_CONTEXT_STALE_MS = 2_500

export function shouldAcceptPlayerContext(options: {
  hasRoom: boolean
  boundTabId: number | null
  boundFrameId: number | null
  boundAreaPixels: number
  boundLastSeenAtMs: number
  participantReady: boolean
  senderTabId: number
  senderFrameId: number
  senderIsActive: boolean
  senderAreaPixels: number
  nowMs: number
}): boolean {
  if (!options.hasRoom)
    return options.senderIsActive && (
      options.boundTabId !== options.senderTabId
      || options.boundFrameId === null
      || options.boundFrameId === options.senderFrameId
      || options.senderAreaPixels > options.boundAreaPixels
    )

  if (options.boundTabId === null)
    return options.senderIsActive
  if (options.senderTabId !== options.boundTabId)
    return false
  if (options.boundFrameId === null || options.boundFrameId === options.senderFrameId)
    return true
  if (options.nowMs - options.boundLastSeenAtMs >= PLAYER_CONTEXT_STALE_MS)
    return true
  return !options.participantReady && options.senderAreaPixels > options.boundAreaPixels
}
