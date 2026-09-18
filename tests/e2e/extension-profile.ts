// A "profile" is one separate, isolated Chrome user-data directory with the
// real unpacked SyncYourJoy extension loaded into it -- the closest
// Playwright equivalent of "a friend's own Chrome install". MV3 unpacked
// extensions can only be loaded into a *persistent* context
// (`chromium.launchPersistentContext`); the default `chromium.launch()`
// has no extension-loading flags at all, and there is no non-persistent
// substitute for it in current Playwright.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'

export interface ExtensionProfile {
  context: BrowserContext
  extensionId: string
  /**
   * The extension's side panel, opened here as an ordinary tab at its
   * chrome-extension:// URL rather than docked into the browser's side
   * panel UI region. See the "Why the panel is opened as a tab" note in
   * tests/e2e/two-profile-sync.spec.ts for exactly why this is the real
   * panel's own HTML/JS and not a stand-in for it.
   */
  panel: Page
  close: () => Promise<void>
}

export async function launchExtensionProfile(extensionDistDir: string, label: string): Promise<ExtensionProfile> {
  const userDataDir = await mkdtemp(join(tmpdir(), `syncyourjoy-e2e-${label}-`))
  const headed = process.env.SYNCYOURJOY_E2E_HEADED === '1'

  const context = await chromium.launchPersistentContext(userDataDir, {
    // Chrome's classic headless mode never loaded extensions. Chrome's
    // newer "--headless=new" mode does, so it is passed explicitly here
    // rather than relying on Playwright's own `headless: true` (which, at
    // least as of Playwright 1.63 / Chrome for Testing 153, still launches
    // the classic mode and silently never spawns the extension's service
    // worker). `SYNCYOURJOY_E2E_HEADED=1` runs a normal visible window for
    // local debugging.
    headless: false,
    args: [
      ...(headed ? [] : ['--headless=new']),
      `--disable-extensions-except=${extensionDistDir}`,
      `--load-extension=${extensionDistDir}`,
      '--no-first-run',
    ],
  })

  let serviceWorker = context.serviceWorkers()[0]
  if (!serviceWorker)
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 20_000 })
  const extensionId = new URL(serviceWorker.url()).host

  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
  await panel.waitForSelector('#create-form, #join-form')
  const privacyAccept = panel.locator('#privacy-accept')
  if (await privacyAccept.count() > 0)
    await privacyAccept.click()

  return {
    context,
    extensionId,
    panel,
    close: async () => {
      await context.close().catch(() => undefined)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    },
  }
}
