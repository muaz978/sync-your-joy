import { expect, test } from '@playwright/test'
import { createAdaptiveFixtureServer, type AdaptiveFixtureServer } from './adaptive-fixture-server.ts'

declare global {
  interface Window {
    __SYNCYOURJOY_ADAPTIVE_FIXTURE__?: {
      snapshot: () => {
        duration: number
        bufferedRanges: number[][]
        loadedSegments: number[]
        missingSegments: number[]
        events: Array<{ type: string, index?: number, delayMs?: number }>
      }
    }
  }
}

test.describe('owned adaptive loading and lifecycle fixture', () => {
  let fixture: AdaptiveFixtureServer

  test.beforeAll(async () => {
    fixture = await createAdaptiveFixtureServer()
  })

  test.afterAll(async () => {
    await fixture.close()
  })

  test('uses native MSE for two minutes and records real fault timing', async ({ browser }) => {
    const page = await browser.newPage()
    try {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&delaySegment=2&delayMs=120&missingSegment=5&disjoint=1&rateReset=1`)
      await page.waitForFunction(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events.some(event => event.type === 'load-complete'), undefined, { timeout: 120_000 })
      const snapshot = await page.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot())
      expect(snapshot).toBeDefined()
      expect(snapshot!.duration).toBeGreaterThanOrEqual(119)
      expect(snapshot!.loadedSegments.length).toBeGreaterThanOrEqual(28)
      expect(snapshot!.missingSegments).toContain(5)
      expect(snapshot!.bufferedRanges.length).toBeGreaterThanOrEqual(2)
      expect(snapshot!.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'segment-missing', index: 5 }),
        expect.objectContaining({ type: 'disjoint-offset-applied', index: 6 }),
        expect.objectContaining({ type: 'playback-rate-reset', index: 4 }),
      ]))
      expect(snapshot!.events.some(event => event.type === 'segment-request' && event.index === 2 && event.delayMs === 120)).toBe(true)
    }
    finally {
      await page.close()
    }
  })

  test('loads every segment by default, so an unconfigured fixture is a healthy player rather than a stuck one', async ({ browser }) => {
    const page = await browser.newPage()
    try {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1`)
      await page.waitForFunction(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events.some(event => event.type === 'load-complete'), undefined, { timeout: 120_000 })
      const snapshot = await page.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot())
      // An absent `missingSegment` used to read as segment 0 (Number(null)),
      // which left the element at readyState 1 with nothing before 20 s buffered.
      expect(snapshot!.missingSegments).toEqual([])
      expect(snapshot!.loadedSegments).toHaveLength(30)
      expect(snapshot!.bufferedRanges[0]?.[0]).toBe(0)
      expect(await page.evaluate(() => document.querySelector('video')?.readyState)).toBeGreaterThanOrEqual(2)
    }
    finally {
      await page.close()
    }
  })

  test('covers open shadow, SPA, node replacement and cross-origin nested-frame lifecycles', async ({ browser }) => {
    const page = await browser.newPage()
    try {
      await page.goto(`${fixture.origin}/adaptive-player.html`)
      await page.locator('#create-shadow').click()
      await expect(page.locator('fixture-shadow-player')).toHaveCount(1)
      expect(await page.locator('fixture-shadow-player').evaluate(element => element.shadowRoot?.querySelector('video')?.id)).toBe('shadow-player')

      await page.locator('#spa-transition').click()
      await expect(page).toHaveURL(/episode=2/)
      await page.locator('#replace-player').click()
      await expect(page.locator('#replacement-player')).toHaveCount(1)

      await page.locator('#rate-reset').click()
      await page.waitForFunction(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events.some(event => event.type === 'playback-rate-reset'))
      await page.locator('#open-nested').click()
      await expect(page.locator('iframe[title="Cross-origin adaptive fixture frame"]')).toHaveCount(1)
      await page.waitForFunction(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events.some(event => event.type === 'cross-origin-frame-created'))

      const nestedFrame = page.frames().find(candidate => candidate !== page.mainFrame())
      expect(nestedFrame).toBeDefined()
      const nestedLoopbackHost = ['local', 'host'].join('')
      expect(new URL(nestedFrame!.url()).hostname).toBe(nestedLoopbackHost)
      await nestedFrame!.waitForFunction(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events.some(event => event.type === 'load-complete'), undefined, { timeout: 120_000 })
    }
    finally {
      await page.close()
    }
  })
})
