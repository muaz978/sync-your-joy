import { expect, test, type Page } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdaptiveFixtureServer, type AdaptiveFixtureServer } from './adaptive-fixture-server.ts'
import { attachFixtureEvents, eventsOfType, readFixtureSnapshot, waitForFixtureEvent } from './adaptive-fixture-page.ts'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')

// The real unpacked extension against the owned adaptive fixture. What these
// show is limited to what the extension and the page each report about
// themselves: the extension's own session state names the frame it bound and
// where in the page it found the player (`playerDiagnostics.origin`), and the
// page's `<video>` elements say whether they were played. Nothing here looks at
// a painted frame, a provider, a second account or a second device.

test.describe('extension discovery against the owned adaptive fixture', () => {
  let fixture: AdaptiveFixtureServer
  let profile: ExtensionProfile

  test.beforeAll(async () => {
    fixture = await createAdaptiveFixtureServer()
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    profile = await launchExtensionProfile(dist, 'adaptive-fixture-extension', {
      ...(process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR ? { artifactDirectory: process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR } : {}),
      trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
    })
  })

  test.afterAll(async () => {
    await profile?.close()
    await fixture?.close()
  })

  test('discovers an actual MSE video through the real extension readiness path', async ({}, testInfo) => {
    await profile.panel.fill('#display-name', 'Adaptive fixture')
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')
    const pagePromise = profile.context.waitForEvent('page')
    await profile.panel.fill('#shared-video-url', `${fixture.origin}/adaptive-autostart.html`)
    await profile.panel.click('#open-shared-link')
    const page = await pagePromise
    try {
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => document.querySelector('video')?.readyState !== undefined)
      await waitForFixtureEvent(page, 'load-complete')
      await expect(profile.panel.locator('#ready-button')).toBeVisible({ timeout: 20_000 })
      await profile.recordState('adaptive-fixture-ready')
    }
    finally {
      await attachFixtureEvents(testInfo, 'extension-discovery', page)
    }
  })
})

test.describe('extension binding across player lifecycles in the owned adaptive fixture', () => {
  let fixture: AdaptiveFixtureServer
  let profile: ExtensionProfile

  test.beforeAll(async () => {
    fixture = await createAdaptiveFixtureServer()
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    profile = await launchExtensionProfile(dist, 'adaptive-fixture-lifecycles', {
      ...(process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR ? { artifactDirectory: process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR } : {}),
      trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
    })
  })

  test.afterAll(async () => {
    await profile?.close()
    await fixture?.close()
  })

  test('binds a player in an open shadow root, follows a replaced node and a source swapped in place', async ({}, testInfo) => {
    await profile.panel.fill('#display-name', 'Lifecycle fixture')
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')
    const pagePromise = profile.context.waitForEvent('page')
    // No autostart: the page has an empty player until the test loads media into
    // the one it mounts, so which player the extension binds is the test's choice.
    await profile.panel.fill('#shared-video-url', `${fixture.origin}/adaptive-player.html`)
    await profile.panel.click('#open-shared-link')
    const page = await pagePromise
    try {
      await page.waitForLoadState('domcontentloaded')

      // 1. An open shadow root. The page's only player with media is inside it.
      await page.locator('#create-shadow').click()
      await page.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__!.load())
      await waitForFixtureEvent(page, 'load-complete')
      await expectBoundPlayer(profile, { origin: 'open-shadow-dom', frameId: 0 })
      await readyAndPlayAll(profile)
      await expectPlaying(page, shadowVideo)
      await pauseAll(profile)
      await expectPaused(page, shadowVideo)

      // 2. The node is replaced by a new one. The old one leaves the page, the
      // extension finds the new one once it has media, and it is the new one
      // that the room's Play starts.
      await page.locator('#replace-player').click()
      await page.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__!.load())
      await expect.poll(() => completedLoads(page), { timeout: 60_000 }).toBe(2)
      await expectBoundPlayer(profile, { origin: 'light-dom', frameId: 0 })
      expect(await page.locator('fixture-shadow-player').count()).toBe(0)
      await readyAndPlayAll(profile)
      await expectPlaying(page, replacementVideo)
      await pauseAll(profile)
      await expectPaused(page, replacementVideo)

      // 3. The source of that same element is replaced. The element is the one
      // that was there; it is still the bound player and still starts.
      await page.evaluate(() => {
        (document.querySelector('#replacement-player') as HTMLVideoElement & { __marker?: string }).__marker = 'same-element'
      })
      await page.locator('#replace-source').click()
      await expect.poll(() => completedLoads(page), { timeout: 60_000 }).toBe(3)
      expect(await page.evaluate(() => (document.querySelector('#replacement-player') as HTMLVideoElement & { __marker?: string }).__marker)).toBe('same-element')
      expect(eventsOfType(await readFixtureSnapshot(page), 'native-emptied').length).toBeGreaterThan(0)
      await expectBoundPlayer(profile, { origin: 'light-dom', frameId: 0 })
      await readyAndPlayAll(profile)
      await expectPlaying(page, replacementVideo)
      await pauseAll(profile)
    }
    finally {
      await attachFixtureEvents(testInfo, 'extension-lifecycles', page)
    }
  })
})

type VideoReader = (page: Page) => Promise<{ paused: boolean, currentTime: number } | null>

const shadowVideo: VideoReader = page => page.evaluate(() => {
  const video = document.querySelector('fixture-shadow-player')?.shadowRoot?.querySelector('video')
  return video ? { paused: video.paused, currentTime: video.currentTime } : null
})

const replacementVideo: VideoReader = page => page.evaluate(() => {
  const video = document.querySelector<HTMLVideoElement>('#replacement-player')
  return video ? { paused: video.paused, currentTime: video.currentTime } : null
})

function completedLoads(page: Page): Promise<number> {
  return page.evaluate(() => (window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === 'load-complete').length)
}

async function readSessionState(profile: ExtensionProfile): Promise<Record<string, unknown>> {
  const worker = profile.context.serviceWorkers()[0]
    ?? await profile.context.waitForEvent('serviceworker', { timeout: 5_000 })
  const state = await worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('syncYourJoySessionState')
    return stored.syncYourJoySessionState
  }) as unknown
  if (!state || typeof state !== 'object')
    throw new Error('The extension did not persist its session state.')
  return state as Record<string, unknown>
}

/** What the extension itself says it bound: the frame, and where in the page it found the player. */
async function expectBoundPlayer(profile: ExtensionProfile, expected: { origin: string, frameId: number }): Promise<void> {
  await expect.poll(async () => {
    const state = await readSessionState(profile)
    const diagnostics = state.playerDiagnostics as { origin?: string } | null | undefined
    return { frameId: state.playerFrameId, origin: diagnostics?.origin }
  }, { timeout: 20_000, message: 'The extension should bind the expected player.' }).toEqual(expected)
}

async function readyAndPlayAll(profile: ExtensionProfile): Promise<void> {
  await profile.panel.waitForSelector('#ready-button', { timeout: 20_000 })
  if (((await profile.panel.locator('#ready-button').textContent()) ?? '').includes("I'm ready"))
    await profile.panel.click('#ready-button')
  await profile.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })
  await expect(profile.panel.locator('#primary-control')).toHaveText('Play all', { timeout: 10_000 })
  await profile.panel.click('#primary-control')
}

async function pauseAll(profile: ExtensionProfile): Promise<void> {
  await expect(profile.panel.locator('#primary-control')).toHaveText('Pause all', { timeout: 15_000 })
  await profile.panel.click('#primary-control')
  await expect(profile.panel.locator('#primary-control')).toHaveText('Play all', { timeout: 15_000 })
}

async function expectPlaying(page: Page, read: VideoReader): Promise<void> {
  await expect.poll(async () => (await read(page))?.paused, { timeout: 20_000, message: 'The bound player should be playing.' }).toBe(false)
  const first = (await read(page))!.currentTime
  await expect.poll(async () => (await read(page))!.currentTime, { timeout: 10_000, message: 'The bound player should advance while it plays.' }).toBeGreaterThan(first + 0.5)
}

async function expectPaused(page: Page, read: VideoReader): Promise<void> {
  await expect.poll(async () => (await read(page))?.paused, { timeout: 15_000, message: 'The bound player should pause.' }).toBe(true)
}
