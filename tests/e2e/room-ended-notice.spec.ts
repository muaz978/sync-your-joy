// When a room ends the service worker leaves it, which detaches the page, and
// then sends the page a notice saying why (see endRoomBecauseGone in
// apps/extension/src/service-worker.ts). By then the page has no room, and
// the on-page pill is hidden whenever there is no room. This checks, in a real
// browser, that such a notice is still shown, briefly, and then goes away.
//
// The worker's side (which page gets the notice, and that it gets it once) is
// covered in apps/extension/src/service-worker.test.ts. This sends the same
// message the worker sends.
import { expect, test } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')
const fixtureVideoPath = resolve(here, '..', '..', 'fixtures/sync-test-clip.mp4')

test.describe('a notice about a room that has ended', () => {
  let profile: ExtensionProfile

  test.beforeAll(async () => {
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    const artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR
    profile = await launchExtensionProfile(dist, 'room-ended', {
      ...(artifactDirectory ? { artifactDirectory } : {}),
      trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
    })
  })

  test.afterAll(async () => {
    await profile?.close()
  })

  test('is shown on the page that has no room, and goes away again', async () => {
    const testPlayerUrl = process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL
    if (!testPlayerUrl)
      throw new Error('SYNCYOURJOY_E2E_TEST_PLAYER_URL was not set by global-setup.ts.')

    const page = await profile.context.newPage()
    await page.goto(testPlayerUrl)
    await page.setInputFiles('input[type=file]', fixtureVideoPath)
    await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)

    // The pill's host element exists on every page but is only displayed for a
    // room. Its content is in a closed shadow root, so what can be read from
    // outside is whether it is displayed.
    const displayed = () => page.locator('#sync-your-joy-root').evaluate(element => getComputedStyle(element).display)
    await expect.poll(displayed).toBe('none')

    const worker = profile.context.serviceWorkers()[0]
    if (!worker)
      throw new Error('The extension service worker was not running.')
    await worker.evaluate(async (message) => {
      const [tab] = await chrome.tabs.query({ url: '*://127.0.0.1/*' })
      await chrome.tabs.sendMessage(tab!.id!, { type: 'SHOW_NOTICE', message })
    }, 'This room has expired. Create or join another room to keep watching together.')

    await expect.poll(displayed).toBe('block')
    await expect.poll(displayed, { timeout: 15_000 }).toBe('none')
  })
})
