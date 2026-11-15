import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test'
import { createAdaptiveFixtureServer, type AdaptiveFixtureServer } from './adaptive-fixture-server.ts'
import {
  attachFixtureEvents,
  eventsOfType,
  readFixtureSnapshot,
  waitForFixtureEvent,
  type FixtureEvent,
  type FixtureSnapshot,
} from './adaptive-fixture-page.ts'

// Everything below is what a browser does with the owned, unencrypted fixture
// on this machine. It says nothing about a provider, DRM, an account, a second
// device or anything painted on screen: `readyState`, buffered ranges and a
// moving `currentTime` are the element's own report, not a look at the frame.

// The owned clip has a keyframe every 20 s (fixtures/adaptive-test-clip.mp4: keyframes at
// 0, 20, 40 and so on, checked with ffprobe), which is every fifth four-second segment.
const KEYFRAME_INTERVAL_SECONDS = 20

/** Runs `body` on a fresh page and keeps the page's own event log with the test's output, pass or fail. */
async function withFixturePage(
  browser: Browser,
  testInfo: TestInfo,
  name: string,
  body: (page: Page) => Promise<void>,
): Promise<void> {
  const page = await browser.newPage()
  try {
    await body(page)
  }
  finally {
    await attachFixtureEvents(testInfo, name, page)
    await page.close()
  }
}

function indexOfEvent(snapshot: FixtureSnapshot, predicate: (event: FixtureEvent) => boolean, from = 0): number {
  return snapshot.events.findIndex((event, index) => index >= from && predicate(event))
}

test.describe('owned adaptive loading and lifecycle fixture', () => {
  let fixture: AdaptiveFixtureServer

  test.beforeAll(async () => {
    fixture = await createAdaptiveFixtureServer()
  })

  test.afterAll(async () => {
    await fixture.close()
  })

  test('uses native MSE for two minutes and records real fault timing', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'mse-faults', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&delaySegment=2&delayMs=120&missingSegment=5&rateReset=1`)
      await waitForFixtureEvent(page, 'load-complete')
      const snapshot = await readFixtureSnapshot(page)
      expect(snapshot.duration).toBeGreaterThanOrEqual(119)
      expect(snapshot.loadedSegments).toHaveLength(29)
      expect(snapshot.missingSegments).toEqual([5])
      // The withheld segment is 20-24 s. Everything the browser could not
      // decode without it is missing from the buffer too: it discards frames
      // until the next keyframe, which the clip has every 20 s, so the second
      // range starts at 40 s and the hole is 20 s, not the 4 s that was withheld.
      expect(snapshot.bufferedRanges).toHaveLength(2)
      expect(snapshot.bufferedRanges[0]?.[1]).toBeCloseTo(5 * fixture.manifest.segmentDurationSeconds, 1)
      expect(snapshot.bufferedRanges[1]?.[0]).toBeCloseTo(KEYFRAME_INTERVAL_SECONDS * 2, 1)
      expect(snapshot.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'segment-missing', index: 5 }),
        expect.objectContaining({ type: 'playback-rate-reset', index: 4 }),
      ]))
      // The rate change is also an event the element itself raised.
      const nativeRates = eventsOfType(snapshot, 'native-ratechange').map(event => event.playbackRate)
      expect(nativeRates).toEqual([1.5, 1])
      // The delay is the one the server applied (read from its response header),
      // and it cost real time: the fetch took at least that long.
      const delayedResponse = snapshot.events.find(event => event.type === 'segment-response' && event.index === 2)
      expect(delayedResponse).toMatchObject({ status: 200, requestedDelayMs: 120, appliedDelayMs: 120 })
      expect(delayedResponse!.fetchMs).toBeGreaterThanOrEqual(100)
      // Only the named segment is delayed.
      const otherDelays = eventsOfType(snapshot, 'segment-response').filter(event => event.index !== 2)
      expect(otherDelays.every(event => event.requestedDelayMs === 0 && event.appliedDelayMs === 0)).toBe(true)
    })
  })

  test('a delay the server does not honour is recorded as requested but not applied', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'delay-off-allowlist', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&delaySegment=1&delayMs=77`)
      await waitForFixtureEvent(page, 'load-complete')
      const snapshot = await readFixtureSnapshot(page)
      const response = snapshot.events.find(event => event.type === 'segment-response' && event.index === 1)
      // 77 ms is not on the server's allowlist, so it is ignored. The page
      // asked for it; the response header says it was not applied.
      expect(response).toMatchObject({ status: 200, requestedDelayMs: 77, appliedDelayMs: 0 })
    })
  })

  test('a delayed first segment holds back the native canplay by the applied delay', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'delayed-first-segment', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&delaySegment=0&delayMs=500`)
      await waitForFixtureEvent(page, 'load-complete')
      const snapshot = await readFixtureSnapshot(page)
      const requested = snapshot.events.find(event => event.type === 'segment-request' && event.index === 0)
      const response = snapshot.events.find(event => event.type === 'segment-response' && event.index === 0)
      const appended = snapshot.events.find(event => event.type === 'segment-appended' && event.index === 0)
      const canplay = snapshot.events.find(event => event.type === 'native-canplay')
      expect(requested).toBeDefined()
      expect(canplay).toBeDefined()
      expect(response).toMatchObject({ requestedDelayMs: 500, appliedDelayMs: 500 })
      expect(response!.fetchMs).toBeGreaterThanOrEqual(450)
      // The element cannot be ready to play before the first media segment is
      // appended, so `canplay` follows the delayed response, not the page load.
      expect(appended!.elapsedMs).toBeGreaterThanOrEqual(requested!.elapsedMs + 450)
      expect(canplay!.elapsedMs).toBeGreaterThanOrEqual(appended!.elapsedMs)
      expect(canplay!.elapsedMs - requested!.elapsedMs).toBeGreaterThanOrEqual(450)
    })
  })

  test('loads every segment by default, so an unconfigured fixture is a healthy player rather than a stuck one', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'default-load', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1`)
      await waitForFixtureEvent(page, 'load-complete')
      const snapshot = await readFixtureSnapshot(page)
      // An absent `missingSegment` used to read as segment 0 (Number(null)),
      // which left the element at readyState 1 with nothing before 20 s buffered.
      // The same holds for an absent `delaySegment`: no segment is delayed.
      expect(snapshot.missingSegments).toEqual([])
      expect(snapshot.loadedSegments).toHaveLength(30)
      expect(snapshot.bufferedRanges).toHaveLength(1)
      expect(snapshot.bufferedRanges[0]?.[0]).toBe(0)
      expect(eventsOfType(snapshot, 'segment-response').every(event => event.requestedDelayMs === 0 && event.appliedDelayMs === 0)).toBe(true)
      expect(await page.evaluate(() => document.querySelector('video')?.readyState)).toBeGreaterThanOrEqual(2)
      // The page's own record survives a JSON round trip unchanged, which is
      // what the attached artifact relies on.
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    })
  })

  test('disjoint=1 alone leaves two buffered ranges separated by the four-second timestamp offset', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'disjoint-only', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&disjoint=1`)
      await waitForFixtureEvent(page, 'load-complete')
      const snapshot = await readFixtureSnapshot(page)
      // Nothing is withheld here, so the gap can only come from the offset.
      expect(snapshot.missingSegments).toEqual([])
      expect(snapshot.loadedSegments).toHaveLength(30)
      expect(snapshot.bufferedRanges).toHaveLength(2)
      const [first, second] = snapshot.bufferedRanges
      expect(first![0]).toBe(0)
      expect(first![1]).toBeCloseTo(KEYFRAME_INTERVAL_SECONDS, 1)
      // The offset is the whole gap: segment 5 starts on a keyframe, so nothing
      // after it is discarded, and the second range starts one segment late.
      expect(second![0]! - first![1]!).toBeCloseTo(fixture.manifest.segmentDurationSeconds, 1)
      expect(snapshot.duration).toBeCloseTo(fixture.manifest.durationSeconds + fixture.manifest.segmentDurationSeconds, 0)
      // The page's own record agrees, but it is the ranges above, read from the
      // element, that show the offset took effect.
      expect(eventsOfType(snapshot, 'disjoint-offset-applied')).toEqual([
        expect.objectContaining({ index: 5, timestampOffset: fixture.manifest.segmentDurationSeconds }),
      ])
    })
  })

  test('starves a playing buffer with a held loader and recovers after the release', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'starvation', async (page) => {
      // One segment is appended, then the loader holds: nothing past four
      // seconds can be played until it is released.
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&holdAfter=0`)
      await waitForFixtureEvent(page, 'hold-start', { timeout: 20_000 })
      const held = await readFixtureSnapshot(page)
      expect(held.holding).toBe(true)
      expect(held.loadedSegments).toEqual([0])
      expect(held.bufferedRanges).toEqual([[0, fixture.manifest.segmentDurationSeconds]])

      // Muted, so the browser's autoplay policy lets the page start it.
      await page.evaluate(async () => {
        const video = document.querySelector('video')!
        video.muted = true
        await video.play()
      })
      await waitForFixtureEvent(page, 'native-waiting', { timeout: 20_000 })
      const starved = await readFixtureSnapshot(page)
      const waiting = eventsOfType(starved, 'native-waiting').at(-1)!
      // The element ran off the end of what it was given: it was playing (not
      // paused), had too little data to continue, and sat at the buffer's end.
      expect(waiting.paused).toBe(false)
      expect(waiting.readyState).toBeLessThanOrEqual(2)
      expect(waiting.currentTime).toBeGreaterThanOrEqual(fixture.manifest.segmentDurationSeconds - 0.5)
      expect(starved.holding).toBe(true)
      // Held, so it stays starved: a second look shows it has not moved on.
      const stalledAt = await page.evaluate(() => document.querySelector('video')!.currentTime)
      await page.waitForTimeout(1_000)
      expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeCloseTo(stalledAt, 1)
      expect(eventsOfType(await readFixtureSnapshot(page), 'native-playing').filter(event => event.elapsedMs > waiting.elapsedMs)).toHaveLength(0)

      await page.locator('#release-hold').click()
      await waitForFixtureEvent(page, 'load-complete')
      await expect.poll(async () => {
        const snapshot = await readFixtureSnapshot(page)
        const waitingAt = indexOfEvent(snapshot, event => event.type === 'native-waiting')
        return indexOfEvent(snapshot, event => event.type === 'native-playing', waitingAt)
      }, { timeout: 15_000, message: 'The element should report playing again after the held segments arrive.' }).toBeGreaterThan(-1)
      await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 10_000 })
        .toBeGreaterThan(fixture.manifest.segmentDurationSeconds + 0.5)

      const recovered = await readFixtureSnapshot(page)
      const order = ['hold-start', 'native-waiting', 'hold-released'].map(type => indexOfEvent(recovered, event => event.type === type))
      expect(order.every(index => index >= 0)).toBe(true)
      expect(order).toEqual([...order].sort((left, right) => left - right))
      expect(eventsOfType(recovered, 'hold-released')[0]).toMatchObject({ reason: 'button' })
      expect(recovered.loadedSegments).toHaveLength(30)

      // The rate reset is a second native event pair: up, then back down.
      const eventsBeforeRate = recovered.events.length
      await page.locator('#rate-reset').click()
      await waitForFixtureEvent(page, 'playback-rate-reset', { since: eventsBeforeRate })
      const rates = (await readFixtureSnapshot(page)).events.slice(eventsBeforeRate)
        .filter(event => event.type === 'native-ratechange')
        .map(event => event.playbackRate)
      expect(rates).toEqual([1.75, 1])
    })
  })

  test('a player with nothing held does not starve while it plays', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'no-starvation', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1`)
      await waitForFixtureEvent(page, 'load-complete')
      await page.evaluate(async () => {
        const video = document.querySelector('video')!
        video.muted = true
        await video.play()
      })
      // Long enough to run past the four seconds the held test starves at.
      await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 15_000 })
        .toBeGreaterThan(fixture.manifest.segmentDurationSeconds + 1)
      const snapshot = await readFixtureSnapshot(page)
      expect(eventsOfType(snapshot, 'native-waiting')).toHaveLength(0)
      expect(eventsOfType(snapshot, 'native-playing').length).toBeGreaterThan(0)
    })
  })

  test('replaces the source of the same element, with the browser reporting emptied and loadstart for it', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'same-element-source', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1`)
      await waitForFixtureEvent(page, 'load-complete')
      const before = await readFixtureSnapshot(page)
      await page.evaluate(() => {
        (document.querySelector('video') as HTMLVideoElement & { __marker?: string }).__marker = 'first-element'
      })
      const loadstartsBefore = eventsOfType(before, 'native-loadstart').length

      await page.locator('#replace-source').click()
      await page.waitForFunction(
        () => (window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === 'load-complete').length >= 2,
        undefined,
        { timeout: 60_000 },
      )

      // The element is the one that was there before, not a new one.
      expect(await page.evaluate(() => document.querySelectorAll('video').length)).toBe(1)
      expect(await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement & { __marker?: string }).__marker)).toBe('first-element')

      const after = await readFixtureSnapshot(page)
      const replacedAt = indexOfEvent(after, event => event.type === 'source-replaced')
      expect(replacedAt).toBeGreaterThan(-1)
      const sinceReplacement = after.events.slice(replacedAt)
      expect(sinceReplacement[0]).toMatchObject({ type: 'source-replaced', sameElement: true, nodeSerial: 1 })
      // No node was mounted or replaced.
      expect(sinceReplacement.some(event => event.type === 'player-mounted' || event.type === 'node-replaced')).toBe(false)
      expect(after.nodeSerial).toBe(1)
      // The browser's own account of a source swap on one element: it emptied,
      // then it started loading the new resource.
      const emptiedAt = sinceReplacement.findIndex(event => event.type === 'native-emptied')
      const loadstartAt = sinceReplacement.findIndex(event => event.type === 'native-loadstart')
      expect(emptiedAt).toBeGreaterThan(-1)
      expect(loadstartAt).toBeGreaterThan(emptiedAt)
      expect(eventsOfType(after, 'native-loadstart').length).toBe(loadstartsBefore + 1)
      // The replacement load starts from nothing and arrives complete.
      expect(after.loadCount).toBe(2)
      expect(after.loadedSegments).toHaveLength(30)
      expect(after.missingSegments).toEqual([])
      expect(after.bufferedRanges).toHaveLength(1)
      expect(after.bufferedRanges[0]?.[0]).toBe(0)
      expect(await page.evaluate(() => document.querySelector('video')?.readyState)).toBeGreaterThanOrEqual(2)
    })
  })

  test('replacing the source while the loader is held stops the old loader from appending', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'same-element-source-held', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&holdAfter=3`)
      await waitForFixtureEvent(page, 'hold-start', { timeout: 20_000 })
      await page.locator('#replace-source').click()
      // The first loader is let go by the replacement, finds it has been
      // superseded and stops; the second one runs into the same hold.
      await page.waitForFunction(
        () => (window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === 'hold-start').length >= 2,
        undefined,
        { timeout: 30_000 },
      )
      const midway = await readFixtureSnapshot(page)
      expect(eventsOfType(midway, 'hold-released')[0]).toMatchObject({ reason: 'source-replaced' })
      expect(eventsOfType(midway, 'load-superseded')).toHaveLength(1)
      // Only the new load's four segments are in the new buffer.
      expect(midway.loadedSegments).toEqual([0, 1, 2, 3])
      expect(await page.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.release())).toBe(true)
      await page.waitForFunction(
        () => (window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).some(event => event.type === 'load-complete'),
        undefined,
        { timeout: 60_000 },
      )
      const done = await readFixtureSnapshot(page)
      expect(done.loadedSegments).toEqual(Array.from({ length: 30 }, (_, index) => index))
      expect(done.bufferedRanges).toHaveLength(1)
      expect(eventsOfType(done, 'load-complete')).toHaveLength(1)
    })
  })

  test('replacing the source while the first load still waits for its manifest leaves the element on the replacement media', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'same-element-source-manifest-window', async (page) => {
      // The first load's manifest is held back 500 ms. The source is replaced
      // while it waits, so the replacement load finishes first and the stale
      // manifest arrives after it.
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&manifestDelayMs=500`)
      await waitForFixtureEvent(page, 'load-start', { timeout: 20_000 })
      await page.locator('#replace-source').click()
      await waitForFixtureEvent(page, 'load-complete', { timeout: 60_000 })
      // The stale load reports that it was superseded once its manifest is back.
      await waitForFixtureEvent(page, 'load-superseded', { timeout: 10_000 })
      const snapshot = await readFixtureSnapshot(page)
      const superseded = eventsOfType(snapshot, 'load-superseded')
      expect(superseded).toHaveLength(1)
      // The element was given one source, the replacement's.
      expect(eventsOfType(snapshot, 'native-loadstart')).toHaveLength(1)
      expect(snapshot.loadedSegments).toHaveLength(30)
      expect(snapshot.bufferedRanges).toHaveLength(1)
      expect(snapshot.bufferedRanges[0]?.[0]).toBe(0)
      expect(await page.evaluate(() => document.querySelector('video')?.readyState)).toBeGreaterThanOrEqual(2)
      // And it plays: real progress on the replacement media, not a counter.
      await page.evaluate(async () => {
        const video = document.querySelector('video')!
        video.muted = true
        await video.play()
      })
      await expect.poll(() => page.evaluate(() => document.querySelector('video')!.currentTime), { timeout: 10_000, message: 'The replacement media should play.' })
        .toBeGreaterThan(1)
      // The stale load stopped before touching the element, not after assigning
      // its own source (the page's record of where it stopped).
      expect(superseded[0]).toMatchObject({ generation: 1, at: 'manifest' })
    })
  })

  test('a load after a node replacement starts from nothing instead of adding to the first load', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'node-replacement-reload', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1`)
      await waitForFixtureEvent(page, 'load-complete')
      expect((await readFixtureSnapshot(page)).loadedSegments).toHaveLength(30)
      // A new node, then a load into it. The per-load record is the second
      // load's own: 30 segments, not the first load's 30 plus its own.
      await page.locator('#replace-player').click()
      await page.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__!.load())
      await page.waitForFunction(
        () => (window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === 'load-complete').length >= 2,
        undefined,
        { timeout: 60_000 },
      )
      const snapshot = await readFixtureSnapshot(page)
      expect(snapshot.loadCount).toBe(2)
      expect(snapshot.loadedSegments).toEqual(Array.from({ length: 30 }, (_, index) => index))
      expect(snapshot.missingSegments).toEqual([])
      expect(snapshot.bufferedRanges).toHaveLength(1)
      expect(snapshot.bufferedRanges[0]?.[0]).toBe(0)
      expect(await page.evaluate(() => document.querySelector<HTMLVideoElement>('#replacement-player')?.readyState)).toBeGreaterThanOrEqual(2)
    })
  })

  test('a hold that was released does not let its own timeout release the next hold', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'stale-hold-timeout', async (page) => {
      // The first hold lasts 1.2 s at most; the second one keeps the full limit.
      await page.goto(`${fixture.origin}/adaptive-player.html?autostart=1&holdAfter=2&holdLimitMs=1200`)
      await waitForFixtureEvent(page, 'hold-start', { timeout: 20_000 })
      // The source is replaced while the first hold is on, which releases it. The
      // replacement load runs into a hold of its own.
      await page.locator('#replace-source').click()
      await page.waitForFunction(
        () => (window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === 'hold-start').length >= 2,
        undefined,
        { timeout: 30_000 },
      )
      // Wait past the first hold's own 1.2 s limit. Its timer must have died
      // with its release; the second hold is still holding.
      await page.waitForTimeout(1_800)
      const snapshot = await readFixtureSnapshot(page)
      expect(snapshot.holding).toBe(true)
      expect(eventsOfType(snapshot, 'hold-released')).toHaveLength(1)
      expect(eventsOfType(snapshot, 'hold-released')[0]).toMatchObject({ reason: 'source-replaced' })
      expect(eventsOfType(snapshot, 'hold-start')[1]).toMatchObject({ limitMs: 30_000 })
      expect(snapshot.loadedSegments).toEqual([0, 1, 2])
      // The second hold is still the one the release control reaches.
      expect(await page.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.release())).toBe(true)
      await waitForFixtureEvent(page, 'load-complete', { timeout: 60_000 })
      expect((await readFixtureSnapshot(page)).holding).toBe(false)
    })
  })

  test('covers open shadow, SPA, node replacement and cross-origin nested-frame lifecycles', async ({ browser }, testInfo) => {
    await withFixturePage(browser, testInfo, 'lifecycles', async (page) => {
      await page.goto(`${fixture.origin}/adaptive-player.html`)
      await page.locator('#create-shadow').click()
      await expect(page.locator('fixture-shadow-player')).toHaveCount(1)
      expect(await page.locator('fixture-shadow-player').evaluate(element => element.shadowRoot?.querySelector('video')?.id)).toBe('shadow-player')

      await page.locator('#spa-transition').click()
      await expect(page).toHaveURL(/episode=2/)
      await page.locator('#replace-player').click()
      await expect(page.locator('#replacement-player')).toHaveCount(1)
      const replaced = eventsOfType(await readFixtureSnapshot(page), 'node-replaced')
      expect(replaced).toHaveLength(1)
      expect(replaced[0]).toMatchObject({ previous: 'shadow-player', next: 'replacement-player' })
      expect(replaced[0]!.nodeSerial).toBeGreaterThan(1)

      await page.locator('#rate-reset').click()
      await waitForFixtureEvent(page, 'playback-rate-reset')
      await page.locator('#open-nested').click()
      await expect(page.locator('iframe[title="Cross-origin adaptive fixture frame"]')).toHaveCount(1)
      await waitForFixtureEvent(page, 'cross-origin-frame-created')

      const nestedFrame = page.frames().find(candidate => candidate !== page.mainFrame())
      expect(nestedFrame).toBeDefined()
      const nestedLoopbackHost = ['local', 'host'].join('')
      expect(new URL(nestedFrame!.url()).hostname).toBe(nestedLoopbackHost)
      await waitForFixtureEvent(nestedFrame!, 'load-complete')
      await attachFixtureEvents(testInfo, 'lifecycles-nested-frame', nestedFrame!)
    })
  })
})
