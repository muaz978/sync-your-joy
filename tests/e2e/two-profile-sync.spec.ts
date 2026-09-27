// Real two-browser-profile end-to-end test for SyncYourJoy.
//
// This is the project's first genuine two-profile E2E test (see
// docs/CODE_AUDIT.md, SYJ-AUD-009). Unlike every other test in this repo
// (packages/**/*.test.ts, apps/**/*.test.ts), which exercises pure logic
// or the room-service's wire protocol directly, this test drives:
//
//   - two separate, isolated Chrome user-data directories ("profile A" and
//     "profile B"), each with the real unpacked extension from
//     apps/extension/dist loaded via --load-extension,
//   - the extension's real side panel HTML/JS (apps/extension/src/sidepanel.ts),
//   - the extension's real content script and service worker,
//   - the real room-service coordinator (apps/room-service/src/server.ts,
//     imported in-process the same way apps/room-service/src/server.test.ts
//     does, started on an ephemeral port by ./global-setup.ts),
//   - and two real HTMLVideoElements, on the project's own local
//     apps/room-service/static/test-player.html fixture page, loaded with
//     the same tiny local fixtures/sync-test-clip.mp4 file via
//     page.setInputFiles -- never a mock player and never a real
//     streaming provider account.
//
// What this test does NOT cover: literally clicking Chrome's own docked
// side-panel UI chrome. See "Why the panel is opened as a tab" at the
// bottom of this file for exactly what that gap does and does not mean in
// practice, and docs/TEST_GUIDE.md for a plain-English summary and how to
// run this.
import { expect, test, type Page } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchExtensionProfiles, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')
const fixtureVideoPath = resolve(here, '..', '..', 'fixtures/sync-test-clip.mp4')

// A few hundred ms of drift is expected and acceptable: the room-service
// schedules commands a short "lead time" ahead so every participant's
// setTimeout has a chance to fire close to the same moment, but this is
// still two independent real browser event loops over a real (loopback)
// network connection, not a single shared clock.
const SYNC_TOLERANCE_SECONDS = 0.75

test.describe('two-profile playback synchronization', () => {
  let profileA: ExtensionProfile
  let profileB: ExtensionProfile

  test.beforeAll(async () => {
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    const artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR
    const trace = process.env.SYNCYOURJOY_E2E_TRACE === '1'
    const profileOptions = {
      ...(artifactDirectory ? { artifactDirectory } : {}),
      trace,
    }
    ;[profileA, profileB] = await launchExtensionProfiles(dist, [
      { label: 'a', options: profileOptions },
      { label: 'b', options: profileOptions },
    ])
    await Promise.all([profileA.recordState('initial'), profileB.recordState('initial')])
  })

  test.afterAll(async () => {
    await Promise.all([profileA?.close(), profileB?.close()])
  })

  test('profile A creates a room, profile B joins, and real playback stays in sync', async () => {
    const testPlayerUrl = process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL
    if (!testPlayerUrl)
      throw new Error('SYNCYOURJOY_E2E_TEST_PLAYER_URL was not set by global-setup.ts.')

    // --- Create a room from profile A -------------------------------------
    await profileA.panel.fill('#display-name', 'Profile A')
    await profileA.panel.click('#create-form button[type=submit]')
    await profileA.panel.waitForSelector('#copy-code')
    const roomCode = (await profileA.panel.locator('#copy-code .font-mono').first().textContent())?.trim()
    expect(roomCode).toMatch(/^[A-Z0-9]{8}$/)

    // --- Join it from profile B with the room code -------------------------
    // Host-approval join (docs/CODE_AUDIT.md SYJ-AUD-003): profile B's join
    // request is now pending until profile A, the room's controller,
    // approves it, so profile B's panel shows the "waiting for the host"
    // state instead of the normal room UI until that happens.
    await profileB.panel.fill('#display-name', 'Profile B')
    await profileB.panel.fill('#room-code', roomCode!)
    await profileB.panel.click('#join-form button[type=submit]')
    await profileA.panel.waitForSelector('[data-approve-join]', { timeout: 15_000 })
    await profileA.panel.click('[data-approve-join]')
    await profileB.panel.waitForSelector('#copy-code')
    await expect(profileB.panel.locator('#copy-code .font-mono').first()).toHaveText(roomCode!)
    await Promise.all([profileA.recordState('room-created'), profileB.recordState('room-joined')])

    // --- Profile A (the controller) shares the local test-player page ------
    // This is the product's real "share code -> both open the same video"
    // flow (docs/ARCHITECTURE.md): the controller enters a page link and
    // the room-service tells every connected participant's own extension
    // to open it, each in its own new browser tab.
    const profileAVideoPagePromise = profileA.context.waitForEvent('page')
    const profileBVideoPagePromise = profileB.context.waitForEvent('page')
    await profileA.panel.fill('#shared-video-url', testPlayerUrl)
    await profileA.panel.click('#open-shared-link')
    const profileAVideoPage = await profileAVideoPagePromise
    const profileBVideoPage = await profileBVideoPagePromise
    await profileAVideoPage.waitForLoadState('domcontentloaded')
    await profileBVideoPage.waitForLoadState('domcontentloaded')
    expect(new URL(profileAVideoPage.url()).pathname).toBe('/test-player')
    expect(new URL(profileBVideoPage.url()).pathname).toBe('/test-player')

    // --- Both open the same local fixture video file ------------------------
    // The SAME local file on disk, chosen independently through each page's
    // own <input type="file"> exactly the way test-player.html and
    // docs/TEST_FIXTURE.md intend, never a shared network resource.
    await profileAVideoPage.setInputFiles('input[type=file]', fixtureVideoPath)
    await profileBVideoPage.setInputFiles('input[type=file]', fixtureVideoPath)
    await profileAVideoPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)
    await profileBVideoPage.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)

    // --- Both select "I'm ready" --------------------------------------------
    // The content script scans for a controllable player every couple of
    // seconds (apps/extension/src/content-script.ts), so the ready button
    // only appears once it has actually found the real <video> element.
    await profileA.panel.waitForSelector('#ready-button', { timeout: 20_000 })
    await profileB.panel.waitForSelector('#ready-button', { timeout: 20_000 })
    await profileA.panel.click('#ready-button')
    await profileB.panel.click('#ready-button')
    await Promise.all([profileA.recordState('ready-clicked'), profileB.recordState('ready-clicked')])
    // Profile A is the controller: its remote only enables once every
    // connected participant (including itself) is ready and on the right
    // video (apps/extension/src/sidepanel.ts, controllerControls()).
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })

    // --- Controller (profile A) plays; profile B's real video mirrors it ---
    await profileA.panel.click('#primary-control')
    await Promise.all([profileA.recordState('play-requested'), profileB.recordState('play-requested')])
    await assertBothPlayersAdvance(profileAVideoPage, profileBVideoPage)
    await assertPositionsConverge(profileAVideoPage, profileBVideoPage)

    // --- Controller seeks forward; profile B's real video follows -----------
    // The real +10s remote button (apps/extension/src/sidepanel.ts,
    // controllerControls()): a genuine seek command through the product's
    // own UI, not a synthetic one.
    const positionBeforeSeek = await profileAVideoPage.evaluate(() => document.querySelector('video')?.currentTime ?? 0)
    const duration = await profileAVideoPage.evaluate(() => document.querySelector('video')?.duration ?? 0)
    // The checked-in fixture is 20 seconds long. Leave enough footage after
    // the +10s seek to prove playback, rather than accidentally testing EOF.
    expect(positionBeforeSeek + 10).toBeLessThan(duration - 2)
    await profileA.panel.locator('[data-seek]').last().click()
    await profileAVideoPage.waitForFunction(
      before => (document.querySelector('video')?.currentTime ?? 0) > before + 2,
      positionBeforeSeek,
      { timeout: 10_000 },
    )
    await profileBVideoPage.waitForFunction(
      before => (document.querySelector('video')?.currentTime ?? 0) > before + 2,
      positionBeforeSeek,
      { timeout: 15_000 },
    )
    await assertBothPlayersAdvance(profileAVideoPage, profileBVideoPage)
    await assertPositionsConverge(profileAVideoPage, profileBVideoPage)

    // --- A backward native-media seek travels through the content script --
    // Assigning the real element's currentTime lets the browser emit seeking
    // and seeked. No extension CONTROL message or mocked event is injected.
    const backwardTarget = 3
    await profileAVideoPage.evaluate((target) => {
      const video = document.querySelector('video')
      if (!video)
        throw new Error('Controller video is missing.')
      video.currentTime = target
    }, backwardTarget)
    await Promise.all([profileAVideoPage, profileBVideoPage].map(page => page.waitForFunction(
      target => {
        const video = document.querySelector('video')
        return !!video && !video.seeking && video.currentTime >= target - 0.5 && video.currentTime < target + 2
      },
      backwardTarget,
      { timeout: 15_000 },
    )))
    await assertBothPlayersAdvance(profileAVideoPage, profileBVideoPage)
    await assertPositionsConverge(profileAVideoPage, profileBVideoPage)

    // --- Controller pauses; profile B's real video pauses too ---------------
    // The seek above may briefly show the remote as "Aligning..."; wait for
    // it to settle back to a clickable play/pause state first.
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 10_000 })
    await profileA.panel.click('#primary-control')
    await Promise.all([profileA.recordState('pause-requested'), profileB.recordState('pause-requested')])
    await profileAVideoPage.waitForFunction(() => document.querySelector('video')?.paused === true, undefined, { timeout: 10_000 })
    await profileBVideoPage.waitForFunction(() => document.querySelector('video')?.paused === true, undefined, { timeout: 15_000 })
    await assertPositionsConverge(profileAVideoPage, profileBVideoPage)

    // --- A paused seek settles; it does not fail when its window closes ----
    // A paused seek never starts playback, so it has no `started` phase. The
    // coordinator used to keep the seek's 3 s preparation deadline on it, and
    // three seconds after every paused seek the room reported `start-timeout`
    // and asked everyone to recover. Observe well past that window.
    const pausedTarget = 6
    await profileAVideoPage.evaluate((target) => {
      const video = document.querySelector('video')
      if (!video)
        throw new Error('Controller video is missing.')
      video.currentTime = target
    }, pausedTarget)
    await Promise.all([profileAVideoPage, profileBVideoPage].map(page => page.waitForFunction(
      target => {
        const video = document.querySelector('video')
        return !!video && !video.seeking && video.paused && Math.abs(video.currentTime - target) < 0.75
      },
      pausedTarget,
      { timeout: 15_000 },
    )))
    await expect.poll(async () => (await readRoom(profileA)).operation, { message: 'The paused seek should commit.' }).toMatchObject({ kind: 'seek', phase: 'committed' })
    const firstSeekId = (await readRoom(profileA)).operation?.operationId
    await profileA.panel.waitForTimeout(4_500)
    for (const profile of [profileA, profileB]) {
      // The window has closed: the seek is cleared, not failed.
      expect(await readRoom(profile)).toEqual({ operation: null, statuses: ['ready', 'ready'] })
    }
    await Promise.all([profileAVideoPage, profileBVideoPage].map(page => page.waitForFunction(() => document.querySelector('video')?.paused === true)))
    await assertPositionsConverge(profileAVideoPage, profileBVideoPage)

    // The next paused scrub has to work as well: the controller's player must
    // not be pulled back to the old target, and the room must follow.
    const secondPausedTarget = 12
    await profileAVideoPage.evaluate((target) => {
      const video = document.querySelector('video')
      if (!video)
        throw new Error('Controller video is missing.')
      video.currentTime = target
    }, secondPausedTarget)
    await Promise.all([profileAVideoPage, profileBVideoPage].map(page => page.waitForFunction(
      target => {
        const video = document.querySelector('video')
        return !!video && !video.seeking && video.paused && Math.abs(video.currentTime - target) < 0.75
      },
      secondPausedTarget,
      { timeout: 15_000 },
    )))
    await expect.poll(async () => (await readRoom(profileB)).operation?.operationId, { message: 'The second paused seek should be its own operation.' })
      .not.toBe(firstSeekId)
    await assertPositionsConverge(profileAVideoPage, profileBVideoPage)

    if (process.env.SYNCYOURJOY_E2E_INJECT_FAILURE === '1')
      throw new Error('[product-assertion] Intentional fixture assertion failure for CR-D01 artifact verification.')
  })
})

/** The room operation and participant statuses as this profile's service worker last saw them. */
async function readRoom(profile: ExtensionProfile): Promise<{ operation: { operationId: string, kind: string, phase: string, reason: string | null } | null, statuses: string[] }> {
  const worker = profile.context.serviceWorkers()[0]
    ?? await profile.context.waitForEvent('serviceworker', { timeout: 5_000 })
  return await worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('syncYourJoySessionState') as {
      syncYourJoySessionState?: { snapshot?: { contract?: { operation?: Record<string, unknown> | null }, participants: Array<{ playbackStatus?: string }> } }
    }
    const snapshot = stored.syncYourJoySessionState?.snapshot
    const operation = snapshot?.contract?.operation
    return {
      operation: operation
        ? {
            operationId: String(operation.operationId),
            kind: String(operation.kind),
            phase: String(operation.phase),
            reason: typeof operation.reason === 'string' ? operation.reason : null,
          }
        : null,
      statuses: (snapshot?.participants ?? []).map(participant => participant.playbackStatus ?? 'unknown'),
    }
  })
}

async function assertBothPlayersAdvance(...pages: Page[]): Promise<void> {
  await Promise.all(pages.map(page => page.evaluate(() => new Promise<void>((resolveProgress, rejectProgress) => {
    const video = document.querySelector('video')
    if (!video || typeof video.requestVideoFrameCallback !== 'function') {
      rejectProgress(new Error('A real video with frame callbacks is required.'))
      return
    }
    let baseline: { mediaTime: number, position: number, presentedFrames: number } | null = null
    let callbackId = 0
    const timeout = window.setTimeout(() => {
      video.cancelVideoFrameCallback(callbackId)
      rejectProgress(new Error(`Playback did not advance media time and presented frames: ${JSON.stringify({
        currentTime: video.currentTime, paused: video.paused, seeking: video.seeking, readyState: video.readyState,
      })}`))
    }, 10_000)
    const observe: VideoFrameRequestCallback = (_now, frame) => {
      if (video.paused || video.seeking) {
        baseline = null
      }
      else {
        baseline ??= { mediaTime: frame.mediaTime, position: video.currentTime, presentedFrames: frame.presentedFrames }
        if (frame.mediaTime - baseline.mediaTime >= 0.6
          && video.currentTime - baseline.position >= 0.6
          && frame.presentedFrames - baseline.presentedFrames >= 3) {
          window.clearTimeout(timeout)
          resolveProgress()
          return
        }
      }
      callbackId = video.requestVideoFrameCallback(observe)
    }
    callbackId = video.requestVideoFrameCallback(observe)
  }))))
}

async function assertPositionsConverge(pageA: Page, pageB: Page): Promise<void> {
  await expect.poll(async () => {
    const [timeA, timeB] = await Promise.all([
      pageA.evaluate(() => document.querySelector('video')?.currentTime ?? Number.NaN),
      pageB.evaluate(() => document.querySelector('video')?.currentTime ?? Number.NaN),
    ])
    return Number.isFinite(timeA) && Number.isFinite(timeB) ? Math.abs(timeA - timeB) : Infinity
  }, { message: 'Both real video timelines should converge.' }).toBeLessThanOrEqual(SYNC_TOLERANCE_SECONDS)
}

// --- Why the panel is opened as a tab ---------------------------------------
//
// The side panel's HTML page (apps/extension/static/sidepanel.html and
// apps/extension/src/sidepanel.ts) has no dependency on being docked into
// Chrome's side-panel UI region: it only uses chrome.storage, chrome.runtime
// messaging, and ordinary DOM APIs. Every button this test clicks
// (#create-form, #join-form, [data-approve-join], #ready-button,
// #shared-video-url, #open-shared-link, #primary-control, [data-seek],
// #sync-everyone) runs the
// exact same real event listener and the exact same real
// chrome.runtime.sendMessage call whether the page is docked in the side
// panel or open in an ordinary tab.
//
// We investigated driving the *actual* docked side panel first:
//   - Chrome only opens the real side panel in response to a trusted user
//     gesture (either a click on the extension's toolbar action, which is
//     outside Playwright's page-content automation surface entirely, or a
//     genuine content-script-originated click with transient activation).
//   - This extension's in-page trigger for that is a shadow-DOM "mini
//     controller" pill (apps/extension/src/content-script.ts) attached with
//     `mode: 'closed'`, which Playwright's locators cannot pierce, so there
//     is no reliable selector to click to request the panel open in the
//     first place.
//   - We also tried invoking chrome.runtime.sendMessage(...) from inside the
//     extension's own service-worker Worker target (reachable via
//     `context.serviceWorkers()`); Chrome rejects a same-context self-send
//     with "Could not establish connection. Receiving end does not exist.",
//     since there is no separate page listening.
//
// Separately, apps/extension/src/service-worker.ts deliberately treats a
// GET_STATE request from any *tab* (chrome.runtime.MessageSender.tab set)
// that isn't the bound player tab as untrusted, and answers with a
// deliberately empty "detached" state -- this exists to stop a compromised
// web page's content script from reading room state by impersonating the
// panel. A tab hosting sidepanel.html directly IS such a tab. In practice
// this only affects the panel's very first GET_STATE call on load, which is
// indistinguishable from a fresh "no room yet" state either way (there is no
// room until this test creates or joins one); every action this test takes
// after that (CREATE_ROOM, JOIN_ROOM, SET_READY, OPEN_LINK, CONTROL, ...)
// returns the real, unfiltered global state directly in its response, and
// every subsequent ROOM_STATE_UPDATED broadcast the panel listens for also
// carries the real state. We verified this empirically before writing this
// test: the panel opened as a tab creates a real room against the real
// room-service and reflects the real, live room snapshot throughout.
//
// So this test drives the real panel code end to end, just not the cosmetic
// docking chrome around it. A follow-up that wants that last mile would need
// to automate an actual toolbar-icon click and a piercing strategy for the
// closed shadow root's "open panel" button -- both genuinely outside
// Playwright's supported automation surface today, not merely unattempted.
