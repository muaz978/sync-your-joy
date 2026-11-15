// The extension's player binding while the bound player is replaced live (#51).
//
// The service worker issues a binding token (`syncYourJoyPlayerBinding`, an id
// and the id of the document it was issued to) when it first accepts a player,
// and keeps it for the same tab, frame and document: a heartbeat from the bound
// document, and a player node replaced inside that document, must not change
// it, while a replaced document must get a new one and the room must carry on
// with the new document's player.
//
// One real browser, the real extension, the owned adaptive fixture and one
// participant. The binding is read from the extension's own session storage and
// the players from their `<video>` elements. This is not a provider run, and it
// does not forge a report from a retired document: the stale-report cases are
// the service worker's unit tests (`service-worker.test.ts`).
import { expect, test, type Page } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdaptiveFixtureServer, type AdaptiveFixtureServer } from './adaptive-fixture-server.ts'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'
import {
  expectPaused,
  expectPlaying,
  pauseAll,
  readBoundPlayer,
  readyAndPlayAll,
  waitForBoundPlayer,
  waitForSampleAfter,
} from './extension-binding.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')

type FixtureWindow = Window & {
  __SYNCYOURJOY_ADAPTIVE_FIXTURE__?: {
    snapshot: () => { events: Array<{ type: string }> }
    load: (reason?: string) => Promise<void>
  }
}

async function completedLoads(page: Page): Promise<number> {
  return await page.evaluate(() => ((window as unknown as FixtureWindow).__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? []).filter(event => event.type === 'load-complete').length)
}

test.describe('player binding while the bound player is replaced live', () => {
  let fixture: AdaptiveFixtureServer
  let profile: ExtensionProfile

  test.beforeAll(async () => {
    fixture = await createAdaptiveFixtureServer()
    const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
    profile = await launchExtensionProfile(dist, 'binding-replacement', {
      ...(process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR ? { artifactDirectory: process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR } : {}),
      trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
    })
  })

  test.afterAll(async () => {
    await profile?.close()
    await fixture?.close()
  })

  test('keeps its binding across heartbeats and a replaced node, and takes a new one for a replaced document', async () => {
    await profile.panel.fill('#display-name', 'Binding replacement')
    await profile.panel.click('#create-form button[type=submit]')
    await profile.panel.waitForSelector('#copy-code')
    const pagePromise = profile.context.waitForEvent('page')
    await profile.panel.fill('#shared-video-url', `${fixture.origin}/adaptive-autostart.html`)
    await profile.panel.click('#open-shared-link')
    const page = await pagePromise
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => completedLoads(page), { timeout: 60_000 }).toBe(1)

    // 1. The first player is bound, and its binding survives the page's
    // reports while it plays (several reporting intervals).
    const first = await waitForBoundPlayer(profile, player => player.frameId === 0 && player.bindingId !== null && player.documentId !== null, 'The extension should bind the top document.')
    await readyAndPlayAll(profile)
    await expectPlaying(page, '#adaptive-player')
    await page.waitForTimeout(6_000)
    await expect.poll(() => readBoundPlayer(profile), { timeout: 5_000 }).toMatchObject({
      frameId: 0,
      bindingId: first.bindingId,
      documentId: first.documentId,
    })
    await expectPlaying(page, '#adaptive-player')
    await pauseAll(profile)
    await expectPaused(page, '#adaptive-player')

    // 2. The node is replaced inside the same document. The document did not
    // change, so the binding did not either, and Play starts the new node.
    await page.locator('#replace-player').click()
    await page.evaluate(() => (window as unknown as FixtureWindow).__SYNCYOURJOY_ADAPTIVE_FIXTURE__!.load())
    await expect.poll(() => completedLoads(page), { timeout: 60_000 }).toBe(2)
    await expect(page.locator('#adaptive-player')).toHaveCount(0)
    // A missing player is not a paused one.
    await expect(expectPaused(page, '#adaptive-player', 1_000)).rejects.toThrow(/should pause/)
    await page.waitForTimeout(3_000)
    await waitForSampleAfter(profile, Date.now() - 2_000)
    expect(await readBoundPlayer(profile)).toMatchObject({
      frameId: 0,
      bindingId: first.bindingId,
      documentId: first.documentId,
    })
    await readyAndPlayAll(profile)
    await expectPlaying(page, '#replacement-player')
    await pauseAll(profile)
    await expectPaused(page, '#replacement-player')

    // 3. The document is replaced (a reload). It has a new document id, so the
    // old token must not carry over: the binding is a new one, for the new
    // document, and the room's Play starts the new document's player.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await expect.poll(() => completedLoads(page), { timeout: 60_000 }).toBe(1)
    const reloaded = await waitForBoundPlayer(
      profile,
      player => player.frameId === 0 && player.documentId !== null && player.documentId !== first.documentId,
      'The extension should bind the reloaded document.',
    )
    expect(reloaded.bindingId).not.toBeNull()
    expect(reloaded.bindingId).not.toBe(first.bindingId)
    await readyAndPlayAll(profile)
    await expectPlaying(page, '#adaptive-player')
    expect(await readBoundPlayer(profile)).toMatchObject({ bindingId: reloaded.bindingId, documentId: reloaded.documentId })
    await pauseAll(profile)
    await expectPaused(page, '#adaptive-player')
  })
})
