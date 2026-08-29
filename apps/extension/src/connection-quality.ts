import type { ConnectionStatus } from '@syncyourjoy/protocol'

export type ConnectionQuality = 'unknown' | 'good' | 'degraded' | 'offline'

/** Classify the control channel without pretending that RTT proves media playback. */
export function connectionQuality(input: {
  connection: ConnectionStatus
  roundTripMs: number | null
  clockUncertaintyMs: number
  lastPongAtMs: number
  nowMs: number
}): ConnectionQuality {
  if (input.connection === 'disconnected' || input.nowMs - input.lastPongAtMs > 15_000)
    return 'offline'
  if (input.roundTripMs === null || input.lastPongAtMs <= 0)
    return 'unknown'
  if (input.roundTripMs <= 180 && input.clockUncertaintyMs <= 250)
    return 'good'
  return 'degraded'
}

