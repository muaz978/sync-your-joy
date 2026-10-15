// A page that was bound to a room keeps working after the room is left.
//
// The service worker issues a page a binding token with its first media
// report, and a page that still holds a token the worker has dropped (it
// clears the binding when the room is left) has every later report refused.
// Left alone, that page could not take part in the next room until it was
// reloaded: nothing to share, no ready button, no playback. This is the flow
// in one real browser with the real extension, in the page that stays open
// throughout.
import { expect, test } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')
const fixtureVideoPath = resolve(here, '..', '..', 'fixtures/sync-test-clip.mp4')

test.describe('a page that was bound to a room and then left it', () => {
  let profile: ExtensionProfile

  test.beforeAll(async () => {
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    const artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR
    profile = await launchExtensionProfile(dist, 'watcher', {
      ...(artifactDirectory ? { artifactDirectory } : {}),
      trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
    })
  })

  test.afterAll(async () => {
    await profile?.close()
  })

  test('is bound again for the next room it creates, without a reload', async () => {
    const testPlayerUrl = process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL
    if (!testPlayerUrl)
      throw new Error('SYNCYOURJOY_E2E_TEST_PLAYER_URL was not set by global-setup.ts.')

    // --- A room, with the page in it ----------------------------------------
    await profile.panel.fill('#display-name', 'Watcher')
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')

    const opensPage = profile.context.waitForEvent('page')
    await profile.panel.fill('#shared-video-url', testPlayerUrl)
    await profile.panel.click('#open-shared-link')
    const videoPage = await opensPage
    await videoPage.waitForLoadState('domcontentloaded')
    await videoPage.setInputFiles('input[type=file]', fixtureVideoPath)
    await videoPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)
    // The ready button only appears once the worker has bound the page.
    await profile.panel.waitForSelector('#ready-button', { timeout: 20_000 })
    const firstRoom = (await profile.panel.locator('#copy-code .font-mono').first().textContent())?.trim()

    // --- The room is left; the page stays open --------------------------------
    await profile.panel.click('#leave-room')
    await expect(profile.panel.locator('#create-form')).toBeVisible({ timeout: 15_000 })
    await expect(profile.panel.locator('#ready-button')).toHaveCount(0)

    // --- The next room, from the same page ------------------------------------
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')
    const secondRoom = (await profile.panel.locator('#copy-code .font-mono').first().textContent())?.trim()
    expect(secondRoom).toMatch(/^[A-Z0-9]{8}$/)
    expect(secondRoom).not.toBe(firstRoom)
    expect(videoPage.isClosed()).toBe(false)

    // Bound again. "Use current" is only enabled for a player the worker has
    // bound, and it is what a host presses to share the page it is watching.
    await expect(profile.panel.locator('#use-current-link')).toBeEnabled({ timeout: 20_000 })
    await profile.panel.click('#use-current-link')
    await profile.panel.click('#open-shared-link')
    // The page takes part in the room: it is the player the room is about.
    await profile.panel.waitForSelector('#ready-button', { timeout: 20_000 })
    const playerPages = profile.context.pages().filter(page => new URL(page.url()).pathname === '/test-player')
    expect(playerPages).toHaveLength(1)
  })
})
