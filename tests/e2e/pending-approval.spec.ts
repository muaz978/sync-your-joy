// Real two-profile coverage of the host-approval join (docs/CODE_AUDIT.md
// SYJ-AUD-003), from the requester's side: the waiting view, withdrawing a
// request, a denial, an approval, and above all that a requester who is
// already watching something is left alone while it waits.
//
// The same spec runs against the shipped v0.2.6 extension build by setting
// SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT (see tests/e2e/global-setup.ts), which
// is how "installed extensions need no update" is checked against the current
// coordinator: the coordinator is the code under test, the extension is
// whichever build the run builds.
import { expect, test } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchExtensionProfiles, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')
const fixtureVideoPath = resolve(here, '..', '..', 'fixtures/sync-test-clip.mp4')

test.describe('a join request that has not been approved', () => {
  let host: ExtensionProfile
  let requester: ExtensionProfile

  test.beforeAll(async () => {
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    const artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR
    const profileOptions = {
      ...(artifactDirectory ? { artifactDirectory } : {}),
      trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
    }
    ;[host, requester] = await launchExtensionProfiles(dist, [
      { label: 'host', options: profileOptions },
      { label: 'requester', options: profileOptions },
    ])
  })

  test.afterAll(async () => {
    await Promise.all([host?.close(), requester?.close()])
  })

  test('leaves the requester watching, can be withdrawn, denied and approved', async () => {
    const testPlayerUrl = process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL
    if (!testPlayerUrl)
      throw new Error('SYNCYOURJOY_E2E_TEST_PLAYER_URL was not set by global-setup.ts.')

    // --- The host creates a room ---------------------------------------------
    await host.panel.fill('#display-name', 'Host')
    await host.panel.click('#create-form button[type=submit]')
    await host.panel.waitForSelector('#copy-code')
    const roomCode = (await host.panel.locator('#copy-code .font-mono').first().textContent())?.trim()
    expect(roomCode).toMatch(/^[A-Z0-9]{8}$/)

    // --- The requester is already watching its own video ---------------------
    const ownVideo = await requester.context.newPage()
    await ownVideo.goto(testPlayerUrl)
    await ownVideo.setInputFiles('input[type=file]', fixtureVideoPath)
    await ownVideo.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)
    await ownVideo.evaluate(async () => {
      const video = document.querySelector('video')!
      video.muted = true
      video.loop = true
      await video.play()
    })
    const position = () => ownVideo.evaluate(() => {
      const video = document.querySelector('video')!
      return { paused: video.paused, seconds: video.currentTime }
    })
    await expect.poll(async () => (await position()).seconds, { timeout: 10_000 }).toBeGreaterThan(0.5)

    const request = async () => {
      await requester.panel.fill('#display-name', 'Requester')
      await requester.panel.fill('#room-code', roomCode!)
      await requester.panel.click('#join-form button[type=submit]')
    }

    // --- 1. It asks to join: waiting view, and its video is left alone -------
    await request()
    await host.panel.waitForSelector('[data-approve-join]', { timeout: 15_000 })
    await expect(requester.panel.getByText('Waiting for the host to let you in')).toBeVisible()

    const pagesWhileWaiting = requester.context.pages().length
    const beforeWaiting = await position()
    await ownVideo.waitForTimeout(3_000)
    const afterWaiting = await position()
    // Not paused, and not rewound to 0:00 by whatever the coordinator sent.
    expect(afterWaiting.paused).toBe(false)
    expect(afterWaiting.seconds).toBeGreaterThan(Math.min(beforeWaiting.seconds, 1))
    expect(requester.context.pages().length).toBe(pagesWhileWaiting)

    // --- 2. It withdraws the request: the host's list empties ----------------
    await requester.panel.click('#leave-room')
    await expect(host.panel.locator('[data-approve-join]')).toHaveCount(0, { timeout: 15_000 })
    await expect(requester.panel.locator('#join-form')).toBeVisible()

    // --- 3. It asks again and the host denies it -----------------------------
    await request()
    await host.panel.waitForSelector('[data-deny-join]', { timeout: 15_000 })
    await host.panel.click('[data-deny-join]')
    await expect(requester.panel.locator('#join-form')).toBeVisible({ timeout: 15_000 })
    expect((await position()).paused).toBe(false)

    // --- 4. It asks a third time and the host approves it --------------------
    await request()
    await host.panel.waitForSelector('[data-approve-join]', { timeout: 15_000 })
    await host.panel.click('[data-approve-join]')
    await requester.panel.waitForSelector('#copy-code', { timeout: 15_000 })
    await expect(requester.panel.locator('#copy-code .font-mono').first()).toHaveText(roomCode!)
  })
})
