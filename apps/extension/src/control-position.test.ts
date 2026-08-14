import type { PlayerSample } from '@syncyourjoy/protocol'
import { describe, expect, it } from 'vitest'
import { resolveControlPosition } from './control-position.ts'

const staleSample: PlayerSample = {
  positionSeconds: 2,
  durationSeconds: 600,
  paused: true,
  buffering: false,
  sampledAtLocalMs: 10_000,
}

describe('room control position', () => {
  it('starts Play all from the authoritative synced room position', () => {
    expect(resolveControlPosition('play', undefined, staleSample, 7)).toBe(7)
  })

  it('keeps explicit native-player intent precise and avoids stale remote pause samples', () => {
    expect(resolveControlPosition('play', 11, staleSample, 7)).toBe(11)
    expect(resolveControlPosition('pause', undefined, staleSample, 7)).toBe(7)
  })
})
