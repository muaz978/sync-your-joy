import { describe, expect, it } from 'vitest'
import { createAdaptiveFixtureServer } from './e2e/adaptive-fixture-server.ts'

describe('owned adaptive fixture server', () => {
  it('exposes the generated two-minute fragmented media contract', async () => {
    const fixture = await createAdaptiveFixtureServer()
    try {
      expect(fixture.manifest.durationSeconds).toBeGreaterThanOrEqual(120)
      expect(fixture.manifest.segmentDurationSeconds).toBe(4)
      expect(fixture.manifest.segmentCount).toBeGreaterThanOrEqual(30)

      const manifestResponse = await fetch(`${fixture.origin}/adaptive-manifest.json`)
      expect(manifestResponse.status).toBe(200)
      expect((await manifestResponse.json()).segmentCount).toBe(fixture.manifest.segmentCount)

      const initResponse = await fetch(`${fixture.origin}/adaptive/init.mp4`)
      const segmentResponse = await fetch(`${fixture.origin}/adaptive/segment/0.mp4`)
      expect(initResponse.headers.get('content-type')).toContain('video/mp4')
      expect(segmentResponse.headers.get('x-syncyourjoy-fixture-segment')).toBe('0')
      expect((await initResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)
      expect((await segmentResponse.arrayBuffer()).byteLength).toBeGreaterThan(0)
    }
    finally {
      await fixture.close()
    }
  })

  it('applies bounded delay and controlled missing-segment responses', async () => {
    const fixture = await createAdaptiveFixtureServer()
    try {
      const startedAt = Date.now()
      const delayed = await fetch(`${fixture.origin}/adaptive/segment/2.mp4?delayMs=80`)
      const elapsed = Date.now() - startedAt
      expect(delayed.status).toBe(200)
      expect(elapsed).toBeGreaterThanOrEqual(60)

      const missing = await fetch(`${fixture.origin}/adaptive/segment/3.mp4?delayMs=80&missing=1`)
      expect(missing.status).toBe(404)
      await expect(missing.json()).resolves.toMatchObject({
        error: 'controlled-missing-segment',
        index: 3,
        delayMs: 80,
      })
    }
    finally {
      await fixture.close()
    }
  })
})
