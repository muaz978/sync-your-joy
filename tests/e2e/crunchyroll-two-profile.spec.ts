// Opt-in authenticated Crunchyroll coverage for issue #30.
//
// This spec deliberately does not contain credentials, cookies, provider
// URLs, screenshots, media bytes, or signed stream URLs. A local operator or a
// protected CI workflow supplies two Playwright storage-state files and one
// HTTPS /watch URL. The assertions stay at the native media-state boundary:
// currentTime, paused, duration, readyState, seeking, and frame progress.
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'
import {
  assertBothProviderVideosAdvance,
  assertProviderPositionsConverge,
  providerVideoSnapshot,
  waitForProviderVideos,
} from './provider-playback.ts'

interface CrunchyrollE2EConfig {
  providerUrl: string
  storageStateA: string
  storageStateB: string
}

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')

function readCrunchyrollConfig(): CrunchyrollE2EConfig | null {
  const providerUrl = process.env.SYNCYOURJOY_CRUNCHYROLL_URL
  const storageStateA = process.env.SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_A
  const storageStateB = process.env.SYNCYOURJOY_CRUNCHYROLL_STORAGE_STATE_B

  if (!providerUrl && !storageStateA && !storageStateB)
    return null
  if (!providerUrl || !storageStateA || !storageStateB) {
    throw new Error(
      'Crunchyroll E2E requires SYNCYOURJOY_CRUNCHYROLL_URL and both storage-state paths.',
    )
  }

  const parsedUrl = new URL(providerUrl)
  if (parsedUrl.protocol !== 'https:'
    || !/(^|\.)crunchyroll\.com$/i.test(parsedUrl.hostname)
    || !/^\/watch\//i.test(parsedUrl.pathname)) {
    throw new Error('SYNCYOURJOY_CRUNCHYROLL_URL must be an HTTPS Crunchyroll /watch URL.')
  }

  return { providerUrl, storageStateA, storageStateB }
}

const config = readCrunchyrollConfig()

test.describe('authenticated Crunchyroll two-profile playback', () => {
  test.skip(!config, 'Provide the protected storage-state paths to run live Crunchyroll coverage.')

  let profileA: ExtensionProfile
  let profileB: ExtensionProfile

  test.beforeAll(async () => {
    if (!config)
      return
    await Promise.all([config.storageStateA, config.storageStateB].map(path => access(path)))
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    ;[profileA, profileB] = await Promise.all([
      launchExtensionProfile(dist, 'crunchyroll-a', { storageState: config.storageStateA }),
      launchExtensionProfile(dist, 'crunchyroll-b', { storageState: config.storageStateB }),
    ])
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
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })

    await profileA.panel.click('#primary-control')
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
