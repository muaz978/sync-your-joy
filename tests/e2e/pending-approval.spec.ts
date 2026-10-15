// Real two-profile coverage of the host-approval join (docs/CODE_AUDIT.md
// SYJ-AUD-003), from the requester's side: the waiting view, withdrawing a
// request, a denial, an approval, and above all that a requester who is
// already watching something (its video and its tabs) is left alone while it
// waits, with a link shared in the room.
//
// The same spec runs against the shipped v0.2.6 extension build by setting
// SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT (see tests/e2e/provenance.ts), which
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
// The requester's own video is moved this far into the 20 s clip before it
// asks to join, so that a seek back to 0:00 is far from where playback would
// be anyway.
const WATCHING_FROM_SECONDS = 6
// Sampling jitter only; a rewind is whole seconds.
const POSITION_TOLERANCE_SECONDS = 0.25
// The clip loops. A backward jump from this close to its end is the loop
// starting over, not something the room did, so how long the flow takes does
// not decide whether this spec passes.
const LOOP_WRAP_WINDOW_SECONDS = 1
// The extension opens a shared link at most this long after it hears of it
// (applySharedNavigation caps its delay at 2 s in apps/extension/src/
// service-worker.ts), so a page it was going to open for the requester is open
// by the end of the window below.
const NAVIGATION_DELAY_CAP_MS = 2_000
const OBSERVATION_WINDOW_MS = NAVIGATION_DELAY_CAP_MS + 1_000

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

    // --- The host shares a link, as a host normally has before anyone asks ---
    // Without one the room has no navigation, and "the requester's browser
    // opened nothing" below could not fail. The local service's /health page
    // is a real page that is not the test player the requester is on, so the
    // extension would open it in a new tab for a member.
    const sharedLink = `${new URL(testPlayerUrl).origin}/health`
    const hostOpensLink = host.context.waitForEvent('page')
    await host.panel.fill('#shared-video-url', sharedLink)
    await host.panel.click('#open-shared-link')
    await hostOpensLink

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
    await ownVideo.evaluate((seconds) => {
      document.querySelector('video')!.currentTime = seconds
    }, WATCHING_FROM_SECONDS)
    await expect.poll(async () => (await position()).seconds, { timeout: 10_000 }).toBeGreaterThan(WATCHING_FROM_SECONDS + 0.5)

    const request = async () => {
      await requester.panel.fill('#display-name', 'Requester')
      await requester.panel.fill('#room-code', roomCode!)
      await requester.panel.click('#join-form button[type=submit]')
    }

    // From here until the wait is over the element itself is watched: a sample
    // of the position can miss a seek that is undone, and an assertion on the
    // final position alone passes when a rewound video simply played on. The
    // position the watch starts from is sampled in the same call, so what the
    // watch saw and what it is compared with cannot differ by a round trip.
    const startWatching = () => ownVideo.evaluate(({ tolerance, wrapWindow }) => {
      const video = document.querySelector('video')!
      const watch = { backwardSeeks: [] as Array<{ from: number, to: number }>, wraps: 0 }
      ;(window as unknown as { __ownVideoWatch: typeof watch }).__ownVideoWatch = watch
      let previous = video.currentTime
      video.addEventListener('timeupdate', () => {
        previous = video.currentTime
      })
      video.addEventListener('seeking', () => {
        const to = video.currentTime
        if (previous >= video.duration - wrapWindow)
          watch.wraps += 1
        else if (to < previous - tolerance)
          watch.backwardSeeks.push({ from: previous, to })
        previous = to
      })
      return { paused: video.paused, seconds: video.currentTime }
    }, { tolerance: POSITION_TOLERANCE_SECONDS, wrapWindow: LOOP_WRAP_WINDOW_SECONDS })

    // --- 1. It asks to join: waiting view, and its video is left alone -------
    // Counted before the request: a tab opened for the host's link would
    // otherwise be counted into the baseline.
    const pagesBeforeRequest = requester.context.pages().length
    const ownVideoUrl = ownVideo.url()
    const beforeWaiting = await startWatching()
    expect(beforeWaiting.seconds).toBeGreaterThan(WATCHING_FROM_SECONDS)
    await request()
    await host.panel.waitForSelector('[data-approve-join]', { timeout: 15_000 })
    await expect(requester.panel.getByText('Waiting for the host to let you in')).toBeVisible()

    await ownVideo.waitForTimeout(OBSERVATION_WINDOW_MS)
    const afterWaiting = await position()
    await ownVideo.waitForTimeout(500)
    const stillPlaying = await position()
    const watched = await ownVideo.evaluate(
      () => (window as unknown as { __ownVideoWatch: { backwardSeeks: Array<{ from: number, to: number }>, wraps: number } }).__ownVideoWatch,
    )
    // Not paused, and it kept playing.
    expect(afterWaiting.paused).toBe(false)
    expect(stillPlaying.seconds).not.toBe(afterWaiting.seconds)
    // It was never moved backwards since the request was sent: not rewound to
    // 0:00 (or anywhere earlier) by whatever the coordinator sent, even if it
    // then played on past where it had been. A loop starting over is not that.
    expect(watched.backwardSeeks).toEqual([])
    // Unless the loop started over, it played on from where it was.
    if (watched.wraps === 0)
      expect(afterWaiting.seconds).toBeGreaterThan(beforeWaiting.seconds + 1)
    // The shared link was not opened for it, in a new tab or in its own.
    expect(requester.context.pages().length).toBe(pagesBeforeRequest)
    expect(requester.context.pages().map(page => page.url())).not.toContain(sharedLink)
    expect(ownVideo.url()).toBe(ownVideoUrl)

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
    // A member's browser does open the shared link, so step 1 above could
    // have failed. It has to be that link: some other page opening does not
    // count.
    await expect.poll(() => requester.context.pages().map(page => page.url()), { timeout: 15_000 }).toContain(sharedLink)
  })
})
