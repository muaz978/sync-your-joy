// A cross-origin nested frame, with the real unpacked extension.
//
// The owned adaptive fixture opens a second copy of itself in an iframe on a
// different origin (`127.0.0.1` becomes `localhost`). Both documents carry a
// player. This spec drives the real side panel through the real room and
// reads, from the extension's own session state, which frame it bound, then
// reads each `<video>` to see which one the room's Play and Pause reached.
//
// This is class (b) evidence for #49: a local browser, the owned synthetic
// fixture, one participant. It is not Crunchyroll, not two accounts and not two
// devices, and a `<video>` that reports `paused: false` with a moving
// `currentTime` is the element's report, not a look at a painted frame.
import { expect, test, type Frame, type Page, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeDiagnosticText } from './artifact-utils.ts'
import { createAdaptiveFixtureServer, type AdaptiveFixtureServer } from './adaptive-fixture-server.ts'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'
import {
  expectPaused,
  expectPlaying,
  pauseAll,
  readBoundPlayer,
  readVideo,
  readyAndPlayAll,
  waitForBoundPlayer,
  waitForChildFrame,
  waitForSampleAfter,
} from './extension-binding.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')

interface FixtureEventLike { type: string, [key: string]: unknown }
type FixtureWindow = Window & {
  __SYNCYOURJOY_ADAPTIVE_FIXTURE__?: {
    snapshot: () => { events: FixtureEventLike[] }
    load: (reason?: string) => Promise<void>
  }
  __nativeFrameCallbacks?: number
}

async function waitForEvent(target: Page | Frame, type: string, count = 1): Promise<void> {
  await target.waitForFunction(
    ({ wanted, minimum }) => ((window as unknown as FixtureWindow).__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === wanted).length >= minimum,
    { wanted: type, minimum: count },
    { timeout: 120_000 },
  )
}

async function loadMedia(target: Page | Frame): Promise<void> {
  await target.evaluate(() => (window as unknown as FixtureWindow).__SYNCYOURJOY_ADAPTIVE_FIXTURE__!.load())
}

async function nativeEventCount(target: Page | Frame, type: string): Promise<number> {
  return await target.evaluate(wanted => ((window as unknown as FixtureWindow).__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === wanted).length, type)
}

/** Counts the frames the element hands to requestVideoFrameCallback: a native callback count, not a look at the screen. */
async function countNativeFrameCallbacks(target: Page | Frame): Promise<void> {
  await target.evaluate(() => {
    const frameWindow = window as unknown as FixtureWindow
    frameWindow.__nativeFrameCallbacks = 0
    const video = document.querySelector('video')!
    const tick = () => {
      frameWindow.__nativeFrameCallbacks = (frameWindow.__nativeFrameCallbacks ?? 0) + 1
      video.requestVideoFrameCallback(tick)
    }
    video.requestVideoFrameCallback(tick)
  })
}

async function nativeFrameCallbacks(target: Page | Frame): Promise<number> {
  return await target.evaluate(() => (window as unknown as FixtureWindow).__nativeFrameCallbacks ?? 0)
}

/**
 * Keeps a frame's own event log with the test's output: written to a file in
 * the test's output directory (through the E2E sanitizer) and attached by path,
 * because the artifact reporter records an attachment's name and path, not its body.
 */
async function attachEvents(testInfo: TestInfo, name: string, target: Page | Frame): Promise<void> {
  const events = await target.evaluate(() => (window as unknown as FixtureWindow).__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).catch(() => undefined)
  if (!events)
    return
  const fileName = `fixture-events-${name}.json`
  const path = testInfo.outputPath(fileName)
  await writeFile(path, `${sanitizeDiagnosticText(JSON.stringify(events, null, 2))}\n`)
  await testInfo.attach(fileName, { path, contentType: 'application/json' })
}

test.describe('cross-origin nested frame with the real extension', () => {
  let fixture: AdaptiveFixtureServer
  let profile: ExtensionProfile

  test.beforeAll(async () => {
    fixture = await createAdaptiveFixtureServer()
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    profile = await launchExtensionProfile(dist, 'adaptive-fixture-nested', {
      ...(process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR ? { artifactDirectory: process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR } : {}),
      trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
    })
  })

  test.afterAll(async () => {
    await profile?.close()
    await fixture?.close()
  })

  // Each test starts from a profile with no room and no video page, so what one
  // bound cannot be what the next one finds.
  test.afterEach(async () => {
    for (const candidate of profile.context.pages()) {
      if (candidate !== profile.panel)
        await candidate.close().catch(() => undefined)
    }
    if (await profile.panel.locator('#leave-room').count() > 0)
      await profile.panel.click('#leave-room')
    await expect(profile.panel.locator('#create-form')).toBeVisible({ timeout: 15_000 })
  })

  test('binds the nested frame, leaves the top frame alone, and follows a replaced node and native frame progress', async ({}, testInfo) => {
    await profile.panel.fill('#display-name', 'Nested frame')
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')
    const pagePromise = profile.context.waitForEvent('page')
    // No autostart: the top document has an empty player until the test loads
    // media into it, so the nested frame is the only document with media at first.
    await profile.panel.fill('#shared-video-url', `${fixture.origin}/adaptive-player.html`)
    await profile.panel.click('#open-shared-link')
    const page = await pagePromise
    let nested: Frame | undefined
    try {
      await page.waitForLoadState('domcontentloaded')
      await page.waitForSelector('video', { state: 'attached' })
      // Nothing to bind yet: the only player is empty.
      expect((await readBoundPlayer(profile)).frameId).toBeNull()

      // 1. The nested frame holds the only media, so it is the one bound.
      await page.locator('#open-nested').click()
      nested = await waitForChildFrame(page)
      const childFrame = nested
      await expect.poll(() => childFrame.url(), { timeout: 15_000, message: 'The nested frame should navigate to the fixture.' }).toMatch(/^http/)
      expect(new URL(nested.url()).hostname).not.toBe(new URL(page.url()).hostname)
      await waitForEvent(nested, 'load-complete')
      const bound = await waitForBoundPlayer(profile, player => player.frameId !== null, 'The extension should bind the frame that holds the media.')
      // A child frame, not the main frame, and the page has exactly one.
      expect(bound.frameId).toBeGreaterThan(0)
      expect(page.frames().filter(frame => frame !== page.mainFrame())).toHaveLength(1)
      expect(bound.origin).toBe('light-dom')
      const nestedFrameId = bound.frameId

      // 2. Play and Pause reach the nested player and only it.
      await countNativeFrameCallbacks(nested)
      await readyAndPlayAll(profile)
      await expectPlaying(nested)
      await expect.poll(() => nativeFrameCallbacks(nested!), { timeout: 10_000, message: 'The nested element should hand frames to its frame callback while it plays.' }).toBeGreaterThan(5)
      expect(await nativeEventCount(nested, 'native-playing')).toBeGreaterThan(0)
      const topWhilePlaying = await readVideo(page)
      expect(topWhilePlaying).toMatchObject({ paused: true, currentTime: 0, readyState: 0 })

      // 3. The top document now has media too. The bound, ready frame is not
      // replaced by it, and the room's Play still reaches only the nested one.
      await loadMedia(page)
      await waitForEvent(page, 'load-complete')
      await expect.poll(async () => (await readVideo(page)).readyState, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
      // Several of the page's reporting intervals: the extension has had every
      // chance to take the larger top player.
      await page.waitForTimeout(4_000)
      expect((await readBoundPlayer(profile)).frameId).toBe(nestedFrameId)
      await pauseAll(profile)
      await expectPaused(nested)
      await readyAndPlayAll(profile)
      await expectPlaying(nested)
      expect((await readBoundPlayer(profile)).frameId).toBe(nestedFrameId)
      expect(await nativeEventCount(page, 'native-playing')).toBe(0)
      expect(await readVideo(page)).toMatchObject({ paused: true, currentTime: 0 })
      await pauseAll(profile)
      await expectPaused(nested)

      // 4. The nested node is replaced and given media. The same frame stays
      // bound and the new element is the one the room's Play starts.
      await nested.locator('#replace-player').click()
      await loadMedia(nested)
      await waitForEvent(nested, 'load-complete', 2)
      await expect.poll(async () => (await readVideo(nested!, '#replacement-player')).readyState, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
      // Give the extension a look at the new player before Play. Pressing Play in
      // the same instant as the swap was seen (1 run in 12) to start the new
      // player, pause it 0.6 s later and not resume it; see the pull request.
      await waitForSampleAfter(profile, Date.now())
      const afterReplacement = await waitForBoundPlayer(profile, player => player.frameId === nestedFrameId, 'The extension should stay bound to the nested frame.')
      expect(afterReplacement.origin).toBe('light-dom')
      // The replaced node is gone, and a missing player is not a paused one.
      await expect(nested.locator('#adaptive-player')).toHaveCount(0)
      await expect(expectPaused(nested, '#adaptive-player', 1_000)).rejects.toThrow(/should pause/)
      await expect(expectPlaying(nested, '#adaptive-player', 1_000)).rejects.toThrow(/should be playing/)
      await readyAndPlayAll(profile)
      await expectPlaying(nested, '#replacement-player')
      expect((await readBoundPlayer(profile)).frameId).toBe(nestedFrameId)
      expect(await nativeEventCount(page, 'native-playing')).toBe(0)
      expect(await readVideo(page)).toMatchObject({ paused: true, currentTime: 0 })
      await pauseAll(profile)
      await expectPaused(nested, '#replacement-player')
    }
    finally {
      await attachEvents(testInfo, 'nested-top-frame', page)
      if (nested)
        await attachEvents(testInfo, 'nested-child-frame', nested)
    }
  })

  test('keeps the top frame bound when a nested frame with media appears after it, and plays only the top player', async ({}, testInfo) => {
    await profile.panel.fill('#display-name', 'Top frame first')
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')
    const pagePromise = profile.context.waitForEvent('page')
    // Path-based autostart: the top document loads its media itself.
    await profile.panel.fill('#shared-video-url', `${fixture.origin}/adaptive-autostart.html`)
    await profile.panel.click('#open-shared-link')
    const page = await pagePromise
    let nested: Frame | undefined
    try {
      await page.waitForLoadState('domcontentloaded')
      await waitForEvent(page, 'load-complete')
      const topBound = await waitForBoundPlayer(profile, player => player.frameId !== null, 'The extension should bind the top document.')
      expect(topBound.frameId).toBe(0)
      await readyAndPlayAll(profile)
      await expectPlaying(page)

      // A nested frame with media of its own appears while the top player is
      // bound and playing. It is a candidate and not the authority.
      await page.locator('#open-nested').click()
      nested = await waitForChildFrame(page)
      await waitForEvent(nested, 'load-complete')
      await expect.poll(async () => (await readVideo(nested!)).readyState, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
      await page.waitForTimeout(4_000)
      expect((await readBoundPlayer(profile)).frameId).toBe(0)
      await expectPlaying(page)

      await pauseAll(profile)
      await expectPaused(page)
      await readyAndPlayAll(profile)
      await expectPlaying(page)
      expect((await readBoundPlayer(profile)).frameId).toBe(0)
      // The nested player was never started, never played and never seeked.
      expect(await nativeEventCount(nested, 'native-playing')).toBe(0)
      expect(await readVideo(nested)).toMatchObject({ paused: true, currentTime: 0 })
      await pauseAll(profile)
      await expectPaused(page)
    }
    finally {
      await attachEvents(testInfo, 'top-first-top-frame', page)
      if (nested)
        await attachEvents(testInfo, 'top-first-child-frame', nested)
    }
  })
})
