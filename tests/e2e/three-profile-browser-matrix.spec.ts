// Deterministic local browser matrix for CR-D03 / issue #68.
//
// This spec drives three isolated Chromium profiles through the real extension
// UI, the in-process room service and the local HTMLVideoElement fixture. It
// deliberately does not load Crunchyroll, protected media, credentials or
// provider APIs. The fixture supplies only bounded observability and explicit
// fault controls so failures can be attributed to the synchronization flow.
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')
// The adaptive fixture is a repository-owned 120-second local asset. Using
// it here keeps the 30-second sustained window away from the short clip's
// natural loop boundary, which would otherwise look like a controller seek
// while the matrix is intentionally measuring steady playback.
const fixtureVideoPath = resolve(here, '..', '..', 'fixtures/adaptive-test-clip.mp4')
const SYNC_TOLERANCE_SECONDS = 0.75
const SUSTAINED_WINDOW_MS = 30_000

interface FixtureEvent {
  type: string
  at: number
  currentTime: number
  paused: boolean
  seeking: boolean
  sourceGeneration: number
}

interface FixtureState {
  currentTime: number
  duration: number
  paused: boolean
  seeking: boolean
  readyState: number
  sourceGeneration: number
  currentTimeWrites: number
  presentedFrames: number
  qualityFrames: number | null
  lastSeekedTime: number | null
  playRejections: number
  events: FixtureEvent[]
}

type FixtureWindow = Window & {
  __syncYourJoyTestPlayer?: {
    getState: () => FixtureState
  }
}

test.describe('three-profile local browser matrix', () => {
  let profileA!: ExtensionProfile
  let profileB!: ExtensionProfile
  let profileC!: ExtensionProfile

  test.beforeAll(async () => {
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    const artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR
    const trace = process.env.SYNCYOURJOY_E2E_TRACE === '1'
    const options = {
      ...(artifactDirectory ? { artifactDirectory } : {}),
      trace,
    }
    const results = await Promise.allSettled(['a', 'b', 'c'].map(label => launchExtensionProfile(dist, label, options)))
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) {
      await Promise.all(results
        .filter((result): result is PromiseFulfilledResult<ExtensionProfile> => result.status === 'fulfilled')
        .map(result => result.value.close()))
      throw failure.reason
    }
    const profiles = results.map(result => (result as PromiseFulfilledResult<ExtensionProfile>).value) as [ExtensionProfile, ExtensionProfile, ExtensionProfile]
    ;[profileA, profileB, profileC] = profiles
    await Promise.all(profiles.map(profile => profile.recordState('initial')))
  })

  test.afterAll(async () => {
    await Promise.all([profileA?.close(), profileB?.close(), profileC?.close()])
  })

  test('covers quorum, exact seeks, sustained progress, native lifecycle, recovery, transfer and reconnect', async () => {
    const testPlayerUrl = process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL
    if (!testPlayerUrl)
      throw new Error('SYNCYOURJOY_E2E_TEST_PLAYER_URL was not set by global-setup.ts.')

    const profiles = [profileA, profileB, profileC]
    const names = ['Profile A', 'Profile B', 'Profile C']

    await profileA.panel.fill('#display-name', names[0]!)
    await profileA.panel.click('#create-form button[type=submit]')
    await profileA.panel.waitForSelector('#copy-code')
    const roomCode = (await profileA.panel.locator('#copy-code .font-mono').first().textContent())?.trim()
    expect(roomCode).toMatch(/^[A-Z0-9]{8}$/)

    for (const [index, profile] of [profileB, profileC].entries()) {
      await profile.panel.fill('#display-name', names[index + 1]!)
      await profile.panel.fill('#room-code', roomCode!)
      await profile.panel.click('#join-form button[type=submit]')
      await profileA.panel.waitForSelector('[data-approve-join]', { timeout: 20_000 })
      await profileA.panel.locator('[data-approve-join]').last().click()
      await profile.panel.waitForSelector('#copy-code', { timeout: 20_000 })
      await expect(profile.panel.locator('#copy-code .font-mono').first()).toHaveText(roomCode!)
    }
    await Promise.all(profiles.map(profile => profile.recordState('three-member-room')))

    const videoPagePromises = profiles.map(profile => profile.context.waitForEvent('page', { timeout: 20_000 }))
    await profileA.panel.fill('#shared-video-url', testPlayerUrl)
    await profileA.panel.click('#open-shared-link')
    const videoPages = await Promise.all(videoPagePromises)
    await Promise.all(videoPages.map(page => page.waitForLoadState('domcontentloaded')))
    for (const page of videoPages)
      expect(new URL(page.url()).pathname).toBe('/test-player')

    await Promise.all(videoPages.map(page => page.setInputFiles('input[type=file]', fixtureVideoPath)))
    await Promise.all(videoPages.map(page => page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)))
    await Promise.all(profiles.map(profile => profile.panel.waitForSelector('#ready-button', { timeout: 25_000 })))
    await Promise.all(profiles.map(profile => profile.panel.click('#ready-button')))
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })

    await profileA.panel.click('#primary-control')
    await ensureRoomPlaying(profileA, videoPages)
    await assertConverged(videoPages)

    // Establish a clean baseline after command settling, then sample every
    // 500 ms for a full 30-second recovery window. The fixture loops its local
    // file, so the test measures sustained progress instead of reaching EOF.
    const baseline = await readFixtureStates(videoPages)
    let sustained: { samples: number, maxDrift: number, finalStates: FixtureState[] }
    try {
      sustained = await observeSustainedWindow(videoPages, SUSTAINED_WINDOW_MS, async () => {
        await profileA.panel.getByText('Player diagnostics', { exact: true }).click({ timeout: 1_000 }).catch(() => undefined)
        const panel = await profileA.panel.locator('body').innerText({ timeout: 1_000 }).catch(() => 'panel unavailable')
        const diagnostics = await captureDiagnostics(profileA)
        return `${panel}\nDiagnostics:\n${diagnostics}`
      })
    }
    catch (error) {
      throw error
    }
    expect(sustained.samples).toBeGreaterThanOrEqual(50)
    expect(sustained.maxDrift).toBeLessThanOrEqual(SYNC_TOLERANCE_SECONDS)
    for (const [index, state] of sustained.finalStates.entries()) {
      const writes = state.currentTimeWrites - baseline[index]!.currentTimeWrites
      expect(writes, `profile ${String.fromCharCode(65 + index)} repeated hard corrections during the stable window`).toBeLessThanOrEqual(8)
      expect(state.presentedFrames).toBeGreaterThan(baseline[index]!.presentedFrames)
    }
    await Promise.all(profiles.map(profile => profile.recordState('after-30-second-window')))

    // The controller's real +10 button is checked against the requested
    // destination, not merely against "moved forward". It runs after the
    // sustained window has completed, so its barrier has no older seek to
    // overlap with. The panel re-renders the +10 target from the advancing
    // position about once a second, so record the destination carried by the
    // exact button that receives the click instead of reading it beforehand.
    await profileA.panel.evaluate(() => {
      document.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-seek]') : null
        if (button?.dataset.seek)
          document.documentElement.dataset.requestedSeek = button.dataset.seek
      }, { capture: true, once: true })
    })
    await profileA.panel.locator('[data-seek]').last().click()
    const requestedSeek = Number(await profileA.panel.evaluate(() => document.documentElement.dataset.requestedSeek))
    expect(Number.isFinite(requestedSeek)).toBe(true)
    try {
      await expect.poll(async () => {
        const states = await readFixtureStates(videoPages)
        return states.every(state => state.lastSeekedTime !== null && Math.abs(state.lastSeekedTime - requestedSeek) <= SYNC_TOLERANCE_SECONDS)
      }, { timeout: 20_000, message: 'All three players should acknowledge the controller requested seek destination.' }).toBe(true)
    }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nRequested seek: ${requestedSeek}\nSeek fixture states: ${JSON.stringify(await readFixtureStates(videoPages))}`)
    }
    await assertConverged(videoPages)
    await ensureRoomPlaying(profileA, videoPages)

    // Source replacement and re-detection remain local to profile C. The
    // room must not be allowed to treat the old binding as fresh evidence.
    const sourceGenerationBeforeReset = (await readFixtureState(videoPages[2]!)).sourceGeneration
    await videoPages[2]!.locator('#reset-source').click()
    await videoPages[2]!.waitForFunction((previous) => {
      const state = (window as FixtureWindow).__syncYourJoyTestPlayer?.getState()
      return !!state && state.sourceGeneration > previous && state.readyState >= 1
    }, sourceGenerationBeforeReset, { timeout: 15_000 })
    await profileC.panel.waitForSelector('#ready-button', { timeout: 20_000 })
    const readinessAfterReset = (await profileC.panel.locator('#ready-button').textContent()) ?? ''
    if (readinessAfterReset.includes("I'm ready"))
      await profileC.panel.click('#ready-button')
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })

    // A one-shot NotAllowedError is a controlled browser permission fault. It
    // must surface as blocked, then clear after one local gesture and the real
    // in-panel recovery action.
    await ensureRoomPaused(profileA, videoPages)
    await videoPages[2]!.locator('#reject-next-play').click()
    await profileA.panel.click('#primary-control')
    try {
      await expect(profileC.panel.getByText('Playback blocked', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nPermission fixture state: ${JSON.stringify(await readFixtureState(videoPages[2]!))}`)
    }
    await videoPages[2]!.locator('#allow-playback').click()
    await profileC.panel.waitForSelector('#sync-now:not([disabled])', { timeout: 15_000 })
    await profileC.panel.click('#sync-now')
    await expect(profileC.panel.getByText('Playback blocked', { exact: true })).toHaveCount(0, { timeout: 15_000 })
    // An explicit NotAllowedError clears this participant's readiness in the
    // coordinator. The successful local gesture and Sync action clear the
    // browser fault, then the participant must explicitly re-admit itself to
    // the fixed quorum before the controller can play everyone again.
    await profileC.panel.waitForSelector('#ready-button', { timeout: 15_000 })
    const readinessAfterRecovery = (await profileC.panel.locator('#ready-button').textContent()) ?? ''
    if (readinessAfterRecovery.includes("I'm ready"))
      await profileC.panel.click('#ready-button')
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
    await profileA.panel.click('#primary-control')
    await waitForAllPlaying(videoPages)
    await assertConverged(videoPages)

    // Transfer the controller lease to B, exercise B's control, then return
    // the lease to A so both controller roles are covered by the same room.
    await profileA.panel.locator('[data-transfer]').first().click()
    await profileB.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
    await expect(profileA.panel.locator('#primary-control')).toHaveCount(0, { timeout: 10_000 })
    await waitForAllPaused(videoPages)
    await expect(profileB.panel.locator('#primary-control')).toHaveText('Play all', { timeout: 10_000 })
    await profileB.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
    await profileB.panel.click('#primary-control')
    try {
      await waitForAllPlaying(videoPages)
    }
    catch (error) {
      await profileB.panel.getByText('Player diagnostics', { exact: true }).click({ timeout: 1_000 }).catch(() => undefined)
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nPost-transfer-play fixture states: ${JSON.stringify(await readFixtureStates(videoPages))}\nTransferred-controller panel: ${await profileB.panel.locator('body').innerText()}`)
    }
    await profileB.panel.locator('[data-transfer]').first().click()
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })

    // Browser-context offline emulation does not reliably sever an MV3
    // service-worker WebSocket. The local room-service test control closes
    // only C's real socket, then the browser is restored before the bounded
    // reconnect backoff expires. This route is token-gated and absent from
    // normal/deployed room-service instances.
    const participantC = await readExtensionParticipantId(profileC)
    await disconnectLocalTestParticipant(roomCode!, participantC)
    await expect(profileC.panel.getByText('Reconnecting', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect.poll(async () => readExtensionConnection(profileC), {
      timeout: 20_000,
      message: 'Profile C should rejoin the room after its real socket is disconnected.',
    }).toBe('connected')
    await expect(profileC.panel.locator('#copy-code .font-mono').first()).toHaveText(roomCode!, { timeout: 10_000 })
    try {
      // The coordinator pauses the room on any participant disconnect so a
      // stale or missing player cannot continue silently. Rejoining restores
      // C's membership and readiness, then the controller must explicitly
      // resume the room before playback convergence can be asserted again.
      await ensureRoomPlaying(profileA, videoPages)
      await waitForAllPlaying(videoPages)
    }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nPost-reconnect fixture states: ${JSON.stringify(await readFixtureStates(videoPages))}\nPost-reconnect controller panel: ${await profileA.panel.locator('body').innerText()}`)
    }
    await assertConverged(videoPages)

    // Exercise the native HTMLMediaElement seeking event path from the
    // controller page at a paused room boundary. This is a local fixture seek,
    // not a synthetic room message, so content-script attribution and remote
    // convergence both run without overlapping a prior command.
    const nativeSeekTarget = 4
    await ensureRoomPaused(profileA, videoPages)
    await videoPages[0]!.evaluate((target) => {
      const video = document.querySelector('video')
      if (!video)
        throw new Error('Controller video is missing.')
      video.currentTime = target
    }, nativeSeekTarget)
    await waitForNativeSeek(videoPages, nativeSeekTarget)
    await assertConverged(videoPages)
    await waitForAllPaused(videoPages)
    await Promise.all(profiles.map(profile => profile.recordState('reconnected-three-member-room')))
  })
})

async function readFixtureState(page: Page): Promise<FixtureState> {
  return await page.evaluate(() => {
    const state = (window as FixtureWindow).__syncYourJoyTestPlayer
    if (!state)
      throw new Error('The deterministic test-player instrumentation is unavailable.')
    return state.getState()
  })
}

async function readFixtureStates(pages: Page[]): Promise<FixtureState[]> {
  return await Promise.all(pages.map(page => readFixtureState(page)))
}

async function readExtensionParticipantId(profile: ExtensionProfile): Promise<string> {
  const state = await readExtensionState(profile)
  if (!('participantId' in state) || typeof state.participantId !== 'string')
    throw new Error('The extension state did not include a participant identity for the reconnect test.')
  return state.participantId
}

async function readExtensionConnection(profile: ExtensionProfile): Promise<string> {
  const state = await readExtensionState(profile)
  if (!('connection' in state) || typeof state.connection !== 'string')
    throw new Error('The extension state did not include a connection state for the reconnect test.')
  return state.connection
}

async function readExtensionState(profile: ExtensionProfile): Promise<Record<string, unknown>> {
  const worker = profile.context.serviceWorkers()[0]
    ?? await profile.context.waitForEvent('serviceworker', { timeout: 5_000 })
  const state = await worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('syncYourJoySessionState')
    return stored.syncYourJoySessionState
  }) as unknown
  if (!state || typeof state !== 'object')
    throw new Error('The extension did not persist state for the reconnect test.')
  return state as Record<string, unknown>
}

async function disconnectLocalTestParticipant(roomCode: string, participantId: string): Promise<void> {
  const roomServerUrl = process.env.SYNCYOURJOY_E2E_ROOM_SERVER_URL
  const testControlToken = process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN
  if (!roomServerUrl || !testControlToken)
    throw new Error('The local room-service test control is not configured.')
  const controlUrl = new URL(roomServerUrl.replace(/^ws:/, 'http:'))
  controlUrl.pathname = '/__test/disconnect'
  controlUrl.searchParams.set('room', roomCode)
  controlUrl.searchParams.set('participant', participantId)
  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: { 'x-syncyourjoy-test-token': testControlToken },
  })
  if (!response.ok)
    throw new Error(`The local room-service test control returned HTTP ${response.status}.`)
  const result = await response.json() as { ok?: boolean; closedSockets?: number }
  if (result.ok !== true || result.closedSockets !== 1)
    throw new Error(`The local room-service test control closed an unexpected number of sockets: ${JSON.stringify(result)}`)
}

async function captureDiagnostics(profile: ExtensionProfile): Promise<string> {
  try {
    // The extension requests all connected participants and retries at 1, 3
    // and 6 seconds before producing the bounded report. Keep this wait
    // longer than the collection schedule so a red matrix can expose the
    // sanitized transaction and player-health evidence without changing the
    // production diagnostic timeout.
    const downloadPromise = profile.panel.waitForEvent('download', { timeout: 12_000 })
    await profile.panel.click('#download-diagnostics', { timeout: 1_000 })
    const download = await downloadPromise
    const path = await download.path()
    return path ? (await readFile(path, 'utf8')).slice(0, 20_000) : 'diagnostic download path unavailable'
  }
  catch (error) {
    return `diagnostic collection unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function waitForAllPlaying(pages: Page[]): Promise<void> {
  await expect.poll(async () => (await readFixtureStates(pages)).every(state => !state.paused && state.presentedFrames > 0), {
    timeout: 20_000,
    message: 'Every local player should report real native playback progress.',
  }).toBe(true)
}

async function waitForAllPaused(pages: Page[]): Promise<void> {
  await expect.poll(async () => (await readFixtureStates(pages)).every(state => state.paused), {
    timeout: 15_000,
    message: 'Every local player should pause after the controller pause command.',
  }).toBe(true)
}

async function assertConverged(pages: Page[]): Promise<void> {
  await expect.poll(async () => {
    const states = await readFixtureStates(pages)
    return Math.max(...states.map(state => state.currentTime)) - Math.min(...states.map(state => state.currentTime))
  }, { timeout: 15_000, message: 'All three local timelines should converge.' }).toBeLessThanOrEqual(SYNC_TOLERANCE_SECONDS)
}

async function observeSustainedWindow(pages: Page[], durationMs: number, describeFailure?: () => Promise<string>): Promise<{ samples: number, maxDrift: number, finalStates: FixtureState[] }> {
  const startedAt = Date.now()
  let samples = 0
  let maxDrift = 0
  let previous = await readFixtureStates(pages)
  let finalStates = previous
  while (Date.now() - startedAt < durationMs) {
    await new Promise(resolve => setTimeout(resolve, 500))
    finalStates = await readFixtureStates(pages)
    if (finalStates.some(state => state.paused)) {
      const panel = describeFailure ? await describeFailure() : 'panel unavailable'
      throw new Error(`A player paused during the sustained window: ${JSON.stringify(finalStates.map(state => ({ currentTime: state.currentTime, paused: state.paused, frames: state.presentedFrames, qualityFrames: state.qualityFrames, events: state.events.filter(event => ['play', 'playing', 'pause', 'waiting', 'stalled', 'play-rejected'].includes(event.type)) })))}\nController panel at pause:\n${panel}`)
    }
    if (finalStates.some((state, index) => state.presentedFrames <= previous[index]!.presentedFrames))
      throw new Error('At least one player stopped presenting native frames during the sustained window.')
    const duration = Math.max(...finalStates.map(state => state.duration).filter(Number.isFinite))
    const positions = finalStates.map(state => state.currentTime)
    const spread = Math.max(...positions) - Math.min(...positions)
    const drift = Number.isFinite(duration) && duration > 0 ? Math.min(spread, duration - spread) : spread
    maxDrift = Math.max(maxDrift, drift)
    if (drift > SYNC_TOLERANCE_SECONDS)
      throw new Error(`Three-player drift exceeded ${SYNC_TOLERANCE_SECONDS}s: ${JSON.stringify(positions)}`)
    previous = finalStates
    samples += 1
  }
  return { samples, maxDrift, finalStates }
}

async function waitForNativeSeek(pages: Page[], target: number): Promise<void> {
  const deadline = Date.now() + 20_000
  let states = await readFixtureStates(pages)
  while (Date.now() < deadline) {
    if (states.every(state => state.lastSeekedTime !== null && Math.abs(state.lastSeekedTime - target) <= SYNC_TOLERANCE_SECONDS))
      return
    await new Promise(resolve => setTimeout(resolve, 250))
    states = await readFixtureStates(pages)
  }
  throw new Error(`Native seek evidence did not settle at ${target}s: ${JSON.stringify(states.map(state => ({ lastSeekedTime: state.lastSeekedTime, currentTime: state.currentTime, paused: state.paused, events: state.events.filter(event => event.type === 'seeked' || event.type === 'seeking') })))}`)
}

async function ensureRoomPaused(controller: ExtensionProfile, pages: Page[]): Promise<void> {
  await controller.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
  if ((await readFixtureStates(pages)).every(state => state.paused))
    return
  const label = await controller.panel.locator('#primary-control').textContent()
  if (!label?.includes('Pause all'))
    throw new Error(`The room control did not expose a pause action while a player was still playing: ${label ?? 'missing label'}`)
  await controller.panel.click('#primary-control')
  await waitForAllPaused(pages)
}

async function ensureRoomPlaying(controller: ExtensionProfile, pages: Page[]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await controller.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
    const label = await controller.panel.locator('#primary-control').textContent()
    if (label?.includes('Play all'))
      await controller.panel.click('#primary-control')
    await expect.poll(async () => (await readFixtureStates(pages)).every(state => !state.paused && state.presentedFrames > 0), {
      timeout: 5_000,
      message: 'Every local player should enter native playback after a recovery boundary.',
    }).toBe(true).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    const states = await readFixtureStates(pages)
    if (states.every(state => !state.paused && state.presentedFrames > 0))
      return
  }
  throw new Error(`The room did not remain playing after native-seek recovery: ${JSON.stringify(await readFixtureStates(pages))}`)
}
