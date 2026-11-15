import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAdaptiveFixtureServer, parseFragmentedMp4 } from './e2e/adaptive-fixture-server.ts'

const clipPath = resolve(import.meta.dirname, '..', 'fixtures/adaptive-test-clip.mp4')

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

  it('says a missing segment was not delayed unless it was, in the same header a delivered one carries', async () => {
    const fixture = await createAdaptiveFixtureServer()
    try {
      const missing = await fetch(`${fixture.origin}/adaptive/segment/3.mp4?missing=1`)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('x-syncyourjoy-fixture-delay-ms')).toBe('0')
      const delayedMissing = await fetch(`${fixture.origin}/adaptive/segment/3.mp4?missing=1&delayMs=50`)
      expect(delayedMissing.status).toBe(404)
      expect(delayedMissing.headers.get('x-syncyourjoy-fixture-delay-ms')).toBe('50')
    }
    finally {
      await fixture.close()
    }
  })

  it('applies no delay for a delayMs that is not on its allowlist', async () => {
    const fixture = await createAdaptiveFixtureServer()
    try {
      // The server reports what it applied. Values off the list, including an
      // oversized one and a malformed one, are not delayed and do not wait.
      for (const value of ['77', '5000', '99999999', '-5', 'abc', '']) {
        const startedAt = Date.now()
        const response = await fetch(`${fixture.origin}/adaptive/segment/1.mp4?delayMs=${encodeURIComponent(value)}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('x-syncyourjoy-fixture-delay-ms'), `delayMs=${value}`).toBe('0')
        expect(Date.now() - startedAt, `delayMs=${value} must not wait`).toBeLessThan(1_000)
      }
      const listed = await fetch(`${fixture.origin}/adaptive/segment/1.mp4?delayMs=80`)
      expect(listed.headers.get('x-syncyourjoy-fixture-delay-ms')).toBe('80')
    }
    finally {
      await fixture.close()
    }
  })

  it('reads the media duration from the media, not from a constant', async () => {
    const clip = await readFile(clipPath)
    const parsed = parseFragmentedMp4(clip)
    expect(parsed.timescale).toBe(10_240)
    expect(parsed.segments).toHaveLength(30)
    expect(parsed.segmentDurationSeconds).toBeCloseTo(4, 3)
    // Every fragment says where it starts, and they are consecutive.
    expect(parsed.segmentStartSeconds).toEqual(Array.from({ length: 30 }, (_, index) => index * 4))
    expect(parsed.durationSeconds).toBeCloseTo(120, 3)

    // A shorter file is a shorter duration: the first ten fragments are 40 s.
    const firstTen = Buffer.concat([parsed.init, ...parsed.segments.slice(0, 10)])
    const shorter = parseFragmentedMp4(firstTen)
    expect(shorter.segments).toHaveLength(10)
    expect(shorter.durationSeconds).toBeCloseTo(40, 3)
  })

  it('serves the derived duration in the manifest', async () => {
    const fixture = await createAdaptiveFixtureServer()
    try {
      const manifest = await (await fetch(`${fixture.origin}/adaptive-manifest.json`)).json() as { durationSeconds: number, segmentDurationSeconds: number }
      expect(manifest.durationSeconds).toBeCloseTo(120, 3)
      expect(manifest.segmentDurationSeconds).toBeCloseTo(4, 3)
      expect(fixture.manifest.durationSeconds).toBe(manifest.durationSeconds)
    }
    finally {
      await fixture.close()
    }
  })

  it('rejects media that is not a usable fragmented MP4', async () => {
    const clip = await readFile(clipPath)
    const parsed = parseFragmentedMp4(clip)
    // Nothing fragmented: the initialization section alone has no moof.
    expect(() => parseFragmentedMp4(parsed.init)).toThrow(/no fragmented MP4 moof/)
    // One fragment is not enough to exercise segment loading.
    expect(() => parseFragmentedMp4(Buffer.concat([parsed.init, parsed.segments[0]!]))).toThrow(/multiple MSE segments/)
    // A moof with no mdat after it.
    const moofOnly = parsed.segments[1]!.subarray(0, readBoxSize(parsed.segments[1]!))
    expect(() => parseFragmentedMp4(Buffer.concat([parsed.init, parsed.segments[0]!, moofOnly]))).toThrow(/no mdat box/)
    // A box that claims more bytes than the file has.
    const truncated = Buffer.from(clip.subarray(0, clip.length - 5))
    expect(() => parseFragmentedMp4(truncated)).toThrow(/Invalid MP4 box size/)
    // An initialization section with its timescale box removed.
    const noTimescale = Buffer.from(clip)
    const mdhdAt = noTimescale.indexOf('mdhd')
    noTimescale.write('free', mdhdAt, 'ascii')
    expect(() => parseFragmentedMp4(noTimescale)).toThrow(/no mdhd box/)
    // Empty input.
    expect(() => parseFragmentedMp4(Buffer.alloc(0))).toThrow(/no fragmented MP4 moof/)
  })
})

function readBoxSize(box: Buffer): number {
  return box.readUInt32BE(0)
}
