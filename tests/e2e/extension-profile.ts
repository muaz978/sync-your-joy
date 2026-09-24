// A "profile" is one separate, isolated Chrome user-data directory with the
// real unpacked SyncYourJoy extension loaded into it -- the closest
// Playwright equivalent of "a friend's own Chrome install". MV3 unpacked
// extensions can only be loaded into a *persistent* context
// (`chromium.launchPersistentContext`); the default `chromium.launch()`
// has no extension-loading flags at all, and there is no non-persistent
// substitute for it in current Playwright.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import {
  artifactFileName,
  sanitizeBrowserUrl,
  sanitizeError,
  type SanitizedArtifactEvent,
} from './artifact-utils.ts'
import {
  assertNoSecretLogging,
  assertStorageStateApplied,
  assertStorageStateSession,
  checkStorageStateApplied,
  checkStorageStateSession,
  describeStorageStateCheck,
  describeStorageStateSessionCheck,
  readStorageStateFile,
  type StorageStateCheck,
  type StorageStateFile,
  type StorageStateSession,
  type StorageStateSessionCheck,
} from './storage-state.ts'

export interface ExtensionProfile {
  context: BrowserContext
  extensionId: string
  /**
   * Count-only proof that `options.storageState` reached this profile.
   * Absent when no storage state was requested.
   */
  storageStateCheck?: StorageStateCheck
  /**
   * Count-only proof that the declared session cookies reached this profile.
   * Absent when no `storageStateSession` was requested.
   */
  storageStateSessionCheck?: StorageStateSessionCheck
  /**
   * The extension's side panel, opened here as an ordinary tab at its
   * chrome-extension:// URL rather than docked into the browser's side
   * panel UI region. See the "Why the panel is opened as a tab" note in
   * tests/e2e/two-profile-sync.spec.ts for exactly why this is the real
   * panel's own HTML/JS and not a stand-in for it.
   */
  panel: Page
  close: () => Promise<void>
  recordEvent: (type: string, details?: Record<string, unknown>) => Promise<void>
  recordState: (label: string) => Promise<void>
}

export interface ExtensionProfileOptions {
  /**
   * Optional Playwright storage-state JSON. It is intended for opt-in
   * authenticated provider runs and must never be committed to the repo or
   * printed in test output. It is applied with `setStorageState` and
   * verified before any page opens; the launch fails if any unexpired cookie
   * or localStorage key from the file is missing. The launch also refuses to
   * apply it while PWDEBUG, PWPAUSE or Playwright protocol DEBUG logging is on.
   */
  storageState?: string
  /**
   * Provider site and session cookie names that `storageState` must carry.
   * When set, the launch also fails unless every named cookie is unexpired in
   * the file and present in the profile, so an expired or signed-out state
   * cannot pass. Names only, never values.
   */
  storageStateSession?: StorageStateSession
  /** Directory for sanitized profile logs and optional trace output. */
  artifactDirectory?: string
  /** Start and explicitly stop a metadata-only Playwright trace. */
  trace?: boolean
}

export async function launchExtensionProfile(
  extensionDistDir: string,
  label: string,
  options: ExtensionProfileOptions = {},
): Promise<ExtensionProfile> {
  const userDataDir = await mkdtemp(join(tmpdir(), `syncyourjoy-e2e-${label}-`))
  const headed = process.env.SYNCYOURJOY_E2E_HEADED === '1'
  const events: SanitizedArtifactEvent[] = []
  const artifactDirectory = options.artifactDirectory
  const tracePath = options.trace && artifactDirectory
    ? join(artifactDirectory, artifactFileName(label, 'trace.zip'))
    : undefined
  let context: BrowserContext | undefined
  let storageStateCheck: StorageStateCheck | undefined
  let storageStateSessionCheck: StorageStateSessionCheck | undefined
  let traceStarted = false
  let closed = false

  const recordEvent = async (type: string, details?: Record<string, unknown>): Promise<void> => {
    events.push({ at: new Date().toISOString(), type, ...(details ? { details } : {}) })
  }

  const writeArtifacts = async (): Promise<void> => {
    if (!artifactDirectory)
      return
    await mkdir(artifactDirectory, { recursive: true })
    await writeFile(join(artifactDirectory, artifactFileName(label, 'events.json')), `${JSON.stringify({
      schemaVersion: 1,
      profile: label,
      events,
    }, null, 2)}\n`)
  }

  try {
    if (options.storageStateSession && !options.storageState)
      throw new Error(`Profile ${label} was given a storage-state session requirement without a storage state.`)
    if (options.storageState)
      assertNoSecretLogging(label)
    const storageState = options.storageState
      ? await readStorageStateFile(options.storageState, label)
      : undefined
    // No `storageState` here: `launchPersistentContext` has no such option
    // and Playwright 1.63 silently drops it (issue #30). It is applied below.
    const browserContext = await chromium.launchPersistentContext(userDataDir, {
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
    context = browserContext
    await recordEvent('browser-launched', { headed, extensionOutput: sanitizeBrowserUrl(`file://${extensionDistDir}`) })
    if (storageState) {
      // Applied and verified before this helper's own opt-in trace starts and
      // before any page opens, so that trace cannot record the state and no
      // provider page loads without it (extension-profile-storage-state.spec.ts
      // checks the order). The Playwright runner's `trace`, `screenshot` and
      // `video` options are separate: the runner starts its trace as soon as
      // this context exists, before the state is applied, so a spec that
      // passes real states must turn them off. crunchyroll-two-profile.spec.ts
      // does, and checks it. Only counts are recorded or printed.
      const applied = await applyStorageState(browserContext, storageState, label, options.storageStateSession)
      storageStateCheck = applied.check
      storageStateSessionCheck = applied.sessionCheck
      await recordEvent('storage-state-applied', { ...storageStateCheck, ...storageStateSessionCheck })
      const session = storageStateSessionCheck
        ? `, ${describeStorageStateSessionCheck(storageStateSessionCheck)}`
        : ''
      console.log(`[e2e] ${label} storage state applied: ${describeStorageStateCheck(storageStateCheck)}${session}`)
    }
    if (tracePath) {
      await browserContext.tracing.start({ screenshots: false, snapshots: false, sources: false })
      traceStarted = true
      await recordEvent('trace-started', { trace: artifactFileName(label, 'trace.zip') })
    }
    browserContext.on('page', page => {
      void recordEvent('page-created', { url: sanitizeBrowserUrl(page.url()) })
      page.on('framenavigated', frame => {
        if (frame === page.mainFrame())
          void recordEvent('page-navigated', { url: sanitizeBrowserUrl(frame.url()) })
      })
    })

    let serviceWorker = browserContext.serviceWorkers()[0]
    if (!serviceWorker)
      serviceWorker = await browserContext.waitForEvent('serviceworker', { timeout: 20_000 })
    const extensionId = new URL(serviceWorker.url()).host
    await recordEvent('service-worker-ready', { extensionId })

    const panel = await browserContext.newPage()
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`)
    await panel.waitForSelector('#create-form, #join-form')
    const privacyAccept = panel.locator('#privacy-accept')
    if (await privacyAccept.count() > 0)
      await privacyAccept.click()
    await recordEvent('panel-ready', { url: sanitizeBrowserUrl(panel.url()) })

    return {
      context: browserContext,
      extensionId,
      ...(storageStateCheck ? { storageStateCheck } : {}),
      ...(storageStateSessionCheck ? { storageStateSessionCheck } : {}),
      panel,
      recordEvent,
      recordState: async (stateLabel: string) => {
        const safeState = await readSafePanelState(panel)
        await recordEvent('panel-state', { label: stateLabel, state: safeState })
      },
      close: async () => {
        if (closed)
          return
        closed = true
        await recordEvent('profile-close-requested')
        if (traceStarted && tracePath) {
          try {
            await browserContext.tracing.stop({ path: tracePath })
            await recordEvent('trace-stopped', { trace: artifactFileName(label, 'trace.zip') })
          }
          catch (error) {
            await recordEvent('trace-stop-failure', { error: sanitizeError(error) })
          }
        }
        await writeArtifacts()
        await browserContext.close().catch(() => undefined)
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
      },
    }
  }
  catch (error) {
    await recordEvent('browser-launch-failure', { error: sanitizeError(error) })
    if (traceStarted && tracePath && context) {
      await context.tracing.stop({ path: tracePath }).catch(() => undefined)
    }
    await writeArtifacts()
    await context?.close().catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`[browser-launch] ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function launchExtensionProfiles(
  extensionDistDir: string,
  profiles: Array<{ label: string, options?: ExtensionProfileOptions }>,
): Promise<[ExtensionProfile, ExtensionProfile]> {
  if (profiles.length !== 2)
    throw new Error('launchExtensionProfiles requires exactly two profiles.')
  const results = await Promise.allSettled(profiles.map(profile => launchExtensionProfile(
    extensionDistDir,
    profile.label,
    profile.options,
  )))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) {
    await Promise.all(results
      .filter((result): result is PromiseFulfilledResult<ExtensionProfile> => result.status === 'fulfilled')
      .map(result => result.value.close()))
    throw failure.reason
  }
  return [
    (results[0] as PromiseFulfilledResult<ExtensionProfile>).value,
    (results[1] as PromiseFulfilledResult<ExtensionProfile>).value,
  ]
}

/**
 * Applies a parsed storage state through Playwright's supported persistent
 * context path and proves it arrived. The file was read once, so the applied
 * state and the expectations cannot diverge. `storageState()` reads
 * localStorage through a hidden page whose requests Playwright fulfills
 * locally, so the check itself sends nothing to the provider.
 */
async function applyStorageState(
  context: BrowserContext,
  state: StorageStateFile,
  label: string,
  session: StorageStateSession | undefined,
): Promise<{ check: StorageStateCheck, sessionCheck?: StorageStateSessionCheck }> {
  await context.setStorageState(state)
  const applied = await context.storageState()
  const nowSeconds = Date.now() / 1000
  const check = checkStorageStateApplied(state, applied, nowSeconds)
  assertStorageStateApplied(check, label)
  if (!session)
    return { check }
  const sessionCheck = checkStorageStateSession(state, applied, session, nowSeconds)
  assertStorageStateSession(sessionCheck, label)
  return { check, sessionCheck }
}

async function readSafePanelState(panel: Page): Promise<Record<string, unknown>> {
  const visible = async (selector: string): Promise<boolean> => {
    const locator = panel.locator(selector).first()
    return await locator.count() > 0 && await locator.isVisible({ timeout: 500 }).catch(() => false)
  }
  const enabled = async (selector: string): Promise<boolean> => {
    const locator = panel.locator(selector).first()
    return await locator.count() > 0 && await locator.isEnabled({ timeout: 500 }).catch(() => false)
  }
  return {
    url: sanitizeBrowserUrl(panel.url()),
    createFormVisible: await visible('#create-form'),
    joinFormVisible: await visible('#join-form'),
    roomVisible: await visible('#copy-code'),
    sharedLinkVisible: await visible('#shared-video-url'),
    readyVisible: await visible('#ready-button'),
    readyEnabled: await enabled('#ready-button'),
    primaryControlVisible: await visible('#primary-control'),
    primaryControlEnabled: await enabled('#primary-control'),
  }
}
