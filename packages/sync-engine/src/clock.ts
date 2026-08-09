import type { PlaybackState } from '@syncyourjoy/protocol'

export interface ClockSample {
  roundTripMs: number
  offsetMs: number
}

export interface ClockEstimate {
  offsetMs: number
  uncertaintyMs: number
  roundTripMs: number
  samples: number
}

export class ClockSynchronizer {
  private readonly samples: ClockSample[] = []

  addSample(sentAtLocalMs: number, receivedAtLocalMs: number, serverTimeMs: number): ClockEstimate {
    const roundTripMs = Math.max(0, receivedAtLocalMs - sentAtLocalMs)
    const midpointMs = sentAtLocalMs + roundTripMs / 2
    const offsetMs = serverTimeMs - midpointMs

    this.samples.push({ roundTripMs, offsetMs })
    this.samples.sort((a, b) => a.roundTripMs - b.roundTripMs)
    if (this.samples.length > 12)
      this.samples.length = 12

    return this.estimate()
  }

  estimate(): ClockEstimate {
    if (this.samples.length === 0) {
      return {
        offsetMs: 0,
        uncertaintyMs: Number.POSITIVE_INFINITY,
        roundTripMs: Number.POSITIVE_INFINITY,
        samples: 0,
      }
    }

    const selected = this.samples.slice(0, Math.min(4, this.samples.length))
    const offsetMs = average(selected.map(sample => sample.offsetMs))
    const roundTripMs = average(selected.map(sample => sample.roundTripMs))
    const offsetSpread = Math.max(...selected.map(sample => Math.abs(sample.offsetMs - offsetMs)))

    return {
      offsetMs,
      uncertaintyMs: roundTripMs / 2 + offsetSpread,
      roundTripMs,
      samples: this.samples.length,
    }
  }
}

export type DriftCorrection =
  | { kind: 'none'; driftSeconds: number }
  | { kind: 'rate'; driftSeconds: number; playbackRate: number }
  | { kind: 'seek'; driftSeconds: number; positionSeconds: number }

export function expectedPosition(playback: PlaybackState, estimatedServerNowMs: number): number {
  if (playback.status === 'paused')
    return playback.positionSeconds

  const elapsedSeconds = Math.max(0, estimatedServerNowMs - playback.effectiveAtServerMs) / 1000
  return Math.max(0, playback.positionSeconds + elapsedSeconds * playback.playbackRate)
}

export function chooseDriftCorrection(
  currentPositionSeconds: number,
  expectedPositionSeconds: number,
  supportsPlaybackRate: boolean,
): DriftCorrection {
  const driftSeconds = expectedPositionSeconds - currentPositionSeconds
  const absoluteDrift = Math.abs(driftSeconds)

  if (absoluteDrift < 0.12)
    return { kind: 'none', driftSeconds }

  if (absoluteDrift <= 0.6 && supportsPlaybackRate) {
    const playbackRate = driftSeconds > 0 ? 1.02 : 0.98
    return { kind: 'rate', driftSeconds, playbackRate }
  }

  return { kind: 'seek', driftSeconds, positionSeconds: expectedPositionSeconds }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
