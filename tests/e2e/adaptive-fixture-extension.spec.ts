import { expect, test } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdaptiveFixtureServer, type AdaptiveFixtureServer } from './adaptive-fixture-server.ts'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')

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

  test('discovers an actual MSE video through the real extension readiness path', async () => {
    await profile.panel.fill('#display-name', 'Adaptive fixture')
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')
    const pagePromise = profile.context.waitForEvent('page')
    await profile.panel.fill('#shared-video-url', `${fixture.origin}/adaptive-autostart.html`)
    await profile.panel.click('#open-shared-link')
    const page = await pagePromise
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => document.querySelector('video')?.readyState !== undefined)
    await page.waitForFunction(() => {
      const fixtureState = (window as Window & { __SYNCYOURJOY_ADAPTIVE_FIXTURE__?: { snapshot: () => { events: Array<{ type: string }> } } }).__SYNCYOURJOY_ADAPTIVE_FIXTURE__
      return fixtureState?.snapshot().events.some(event => event.type === 'load-complete') === true
    }, undefined, { timeout: 120_000 })
    await expect(profile.panel.locator('#ready-button')).toBeVisible({ timeout: 20_000 })
    await profile.recordState('adaptive-fixture-ready')
  })
})
