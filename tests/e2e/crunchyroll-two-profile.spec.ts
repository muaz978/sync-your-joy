// Opt-in authenticated Crunchyroll coverage for issue #30.
//
// This spec deliberately does not contain credentials, cookies, provider
// URLs, screenshots, media bytes, or signed stream URLs. A local operator or a
// protected CI workflow supplies two Playwright storage-state files and one
// HTTPS /watch URL. The assertions stay at the native media-state boundary:
// currentTime, paused, duration, readyState, seeking, and frame progress.
// extension-profile.ts applies each state with `setStorageState` and stops
// the run before any provider page opens if a state is not fully applied, or
// if a declared session cookie is missing or expired;
// extension-profile-storage-state.spec.ts covers that path without secrets.
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launchExtensionProfiles, type ExtensionProfile } from './extension-profile.ts'
import {
  assertBothProviderVideosAdvance,
  assertProviderPositionsConverge,
  providerVideoSnapshot,
  waitForProviderVideos,
} from './provider-playback.ts'
import {
  assertDistinctStorageStateFiles,
  enabledRunnerArtifacts,
  type StorageStateSession,
} from './storage-state.ts'

interface CrunchyrollE2EConfig {
  providerUrl: string
  storageStateA: string
  storageStateB: string
  session: StorageStateSession
}

// RFC 6265 cookie-name token characters.
const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')

function readCrunchyrollConfig(): CrunchyrollE2EConfig | null {
  const providerUrl = process.env.SYNCYOURJOY_CRUNCHYROLL_URL
  const storageStateA = process.env.SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_A
  const storageStateB = process.env.SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_B
  // Names, never values, of the cookies that carry the signed-in session.
  const requiredCookieNames = process.env.SYNCYOURJOY_CRUNCHYROLL_REQUIRED_COOKIE_NAMES

  if (!providerUrl && !storageStateA && !storageStateB && !requiredCookieNames)
    return null
  if (!providerUrl || !storageStateA || !storageStateB) {
    throw new Error(
      'Crunchyroll E2E requires SYNCYOURJOY_CRUNCHYROLL_URL and both storage-state paths.',
    )
  }
  if (!requiredCookieNames) {
    throw new Error('Crunchyroll E2E requires SYNCYOURJOY_CRUNCHYROLL_REQUIRED_COOKIE_NAMES, '
      + 'the comma-separated names of the cookies that carry the signed-in session.')
  }

  const parsedUrl = new URL(providerUrl)
  if (parsedUrl.protocol !== 'https:'
    || !/(^|\.)crunchyroll\.com$/i.test(parsedUrl.hostname)
    || !/^\/watch\//i.test(parsedUrl.pathname)) {
    throw new Error('SYNCYOURJOY_CRUNCHYROLL_URL must be an HTTPS Crunchyroll /watch URL.')
  }
  const cookieNames = requiredCookieNames.split(',').map(name => name.trim()).filter(Boolean)
  if (cookieNames.length === 0 || !cookieNames.every(name => cookieNamePattern.test(name)))
    throw new Error('SYNCYOURJOY_CRUNCHYROLL_REQUIRED_COOKIE_NAMES must be a comma-separated list of cookie names.')

  return { providerUrl, storageStateA, storageStateB, session: { site: 'crunchyroll.com', cookieNames } }
}

const config = readCrunchyrollConfig()

// The runner's own trace, screenshots and video start when a browser context
// is created, which is before the helper applies a storage state. A runner
// trace would record every saved cookie and localStorage value, and the
// provider's Cookie request headers. This file-level override outranks
// `--trace` and UI mode, which both set the option at config level, and
// beforeAll checks the result before any profile launches.
test.use({ trace: 'off', screenshot: 'off', video: 'off' })

test.describe('authenticated Crunchyroll two-profile playback', () => {
  test.skip(!config, 'Provide the protected storage-state paths to run live Crunchyroll coverage.')

  let profileA: ExtensionProfile
  let profileB: ExtensionProfile

  test.beforeAll(async ({ trace, screenshot, video }) => {
    if (!config)
      return
    const runnerArtifacts = enabledRunnerArtifacts({ trace, screenshot, video })
    if (runnerArtifacts.length > 0)
      throw new Error(`Playwright runner ${runnerArtifacts.join(', ')} must stay off for authenticated provider runs.`)
    await Promise.all([config.storageStateA, config.storageStateB].map(path => access(path)))
    await assertDistinctStorageStateFiles(config.storageStateA, config.storageStateB, config.session)
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    const artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR
    // The helper's own opt-in trace starts only after the states are applied.
    const helperTrace = process.env.SYNCYOURJOY_E2E_TRACE === '1'
    const profileOptions = {
      ...(artifactDirectory ? { artifactDirectory } : {}),
      trace: helperTrace,
    }
    ;[profileA, profileB] = await launchExtensionProfiles(dist, [
      { label: 'crunchyroll-a', options: { ...profileOptions, storageState: config.storageStateA, storageStateSession: config.session } },
      { label: 'crunchyroll-b', options: { ...profileOptions, storageState: config.storageStateB, storageStateSession: config.session } },
    ])
    // The helper already refuses to launch a profile whose saved state was
    // not fully applied or has no live declared session cookie. Repeating the
    // count check here keeps this provider run from ever starting
    // unauthenticated if that helper changes.
    for (const profile of [profileA, profileB]) {
      const check = profile.storageStateCheck
      const sessionCheck = profile.storageStateSessionCheck
      expect(check?.cookiesExpected).toBeGreaterThan(0)
      expect(check?.cookiesApplied).toBe(check?.cookiesExpected)
      expect(check?.localStorageKeysApplied).toBe(check?.localStorageKeysExpected)
      expect(sessionCheck?.sessionCookiesExpected).toBe(new Set(config.session.cookieNames).size)
      expect(sessionCheck?.sessionCookiesApplied).toBe(sessionCheck?.sessionCookiesExpected)
    }
    await Promise.all([profileA.recordState('initial'), profileB.recordState('initial')])
  })

  test.afterAll(async () => {
    await Promise.all([profileA?.close(), profileB?.close()])
  })

  test('plays, seeks, observes frames, converges, and pauses on Crunchyroll', async () => {
    if (!config)
      return
    await profileA.panel.fill('#display-name', 'Crunchyroll profile A')
    await profileA.panel.click('#create-form button[type=submit]')
    await profileA.panel.waitForSelector('#copy-code')
    const roomCode = (await profileA.panel.locator('#copy-code .font-mono').first().textContent())?.trim()
    expect(roomCode).toMatch(/^[A-Z0-9]{8}$/)

    await profileB.panel.fill('#display-name', 'Crunchyroll profile B')
    await profileB.panel.fill('#room-code', roomCode!)
    await profileB.panel.click('#join-form button[type=submit]')
    await profileA.panel.waitForSelector('[data-approve-join]', { timeout: 15_000 })
    await profileA.panel.click('[data-approve-join]')
    await profileB.panel.waitForSelector('#copy-code')
    await Promise.all([profileA.recordState('room-created'), profileB.recordState('room-joined')])

    const profileAProviderPagePromise = profileA.context.waitForEvent('page')
    const profileBProviderPagePromise = profileB.context.waitForEvent('page')
    await profileA.panel.fill('#shared-video-url', config.providerUrl)
    await profileA.panel.click('#open-shared-link')
    const profileAProviderPage = await profileAProviderPagePromise
    const profileBProviderPage = await profileBProviderPagePromise
    await Promise.all([
      profileAProviderPage.waitForLoadState('domcontentloaded'),
      profileBProviderPage.waitForLoadState('domcontentloaded'),
    ])
    await waitForProviderVideos(profileAProviderPage, profileBProviderPage)

    await profileA.panel.waitForSelector('#ready-button', { timeout: 20_000 })
    await profileB.panel.waitForSelector('#ready-button', { timeout: 20_000 })
    await profileA.panel.click('#ready-button')
    await profileB.panel.click('#ready-button')
    await Promise.all([profileA.recordState('ready-clicked'), profileB.recordState('ready-clicked')])
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })

    await profileA.panel.click('#primary-control')
    await Promise.all([profileA.recordState('play-requested'), profileB.recordState('play-requested')])
    await assertBothProviderVideosAdvance(profileAProviderPage, profileBProviderPage)
    await assertProviderPositionsConverge(profileAProviderPage, profileBProviderPage)

    const beforeForwardSeek = await providerVideoSnapshot(profileAProviderPage)
    expect(beforeForwardSeek.currentTime + 10).toBeLessThan(beforeForwardSeek.duration - 2)
    await profileA.panel.locator('[data-seek]').last().click()
    await Promise.all([
      waitForProviderPosition(profileAProviderPage, beforeForwardSeek.currentTime + 2),
      waitForProviderPosition(profileBProviderPage, beforeForwardSeek.currentTime + 2),
    ])
    await assertBothProviderVideosAdvance(profileAProviderPage, profileBProviderPage)
    await assertProviderPositionsConverge(profileAProviderPage, profileBProviderPage)

    const backwardTarget = Math.max(3, Math.floor((await providerVideoSnapshot(profileAProviderPage)).currentTime - 8))
    await setProviderPosition(profileAProviderPage, backwardTarget)
    await Promise.all([
      waitForProviderPosition(profileAProviderPage, backwardTarget - 0.5, backwardTarget + 2),
      waitForProviderPosition(profileBProviderPage, backwardTarget - 0.5, backwardTarget + 2),
    ])
    await assertBothProviderVideosAdvance(profileAProviderPage, profileBProviderPage)
    await assertProviderPositionsConverge(profileAProviderPage, profileBProviderPage)

    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
    await profileA.panel.click('#primary-control')
    await Promise.all([profileA.recordState('pause-requested'), profileB.recordState('pause-requested')])
    await Promise.all([
      waitForProviderPaused(profileAProviderPage),
      waitForProviderPaused(profileBProviderPage),
    ])
    await assertProviderPositionsConverge(profileAProviderPage, profileBProviderPage)
  })
})

async function waitForProviderPosition(page: import('@playwright/test').Page, minimum: number, maximum = Number.POSITIVE_INFINITY): Promise<void> {
  await page.waitForFunction(({ minimum, maximum }) => {
    const video = Array.from(document.querySelectorAll('video'))
      .filter(candidate => candidate.readyState >= 2 && Number.isFinite(candidate.duration))
      .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0]
    return !!video && video.currentTime >= minimum && video.currentTime <= maximum
  }, { minimum, maximum }, { timeout: 20_000 })
}

async function setProviderPosition(page: import('@playwright/test').Page, target: number): Promise<void> {
  await page.evaluate(target => {
    const video = Array.from(document.querySelectorAll('video'))
      .filter(candidate => candidate.readyState >= 2 && Number.isFinite(candidate.duration))
      .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0]
    if (!video)
      throw new Error('A provider video is required for the native seek.')
    video.currentTime = target
  }, target)
}

async function waitForProviderPaused(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => {
    const video = Array.from(document.querySelectorAll('video'))
      .filter(candidate => candidate.readyState >= 1 && Number.isFinite(candidate.duration))
      .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0]
    return !!video && video.paused
  }, undefined, { timeout: 20_000 })
}
