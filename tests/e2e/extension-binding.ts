// Reading what the real extension says it bound, and driving the room's
// Play and Pause through the real panel. Shared by the specs that run the
// extension against the owned adaptive fixture.
//
// The extension's own session state is the only account of its binding: the
// frame it chose (`playerFrameId`, 0 for the top document), where in that
// frame it found the player (`playerDiagnostics.origin`) and the binding token
// it issued (`syncYourJoyPlayerBinding.id`, with the document it was issued
// to). None of this looks at a painted frame.
import { expect, type Frame, type Page } from '@playwright/test'
import type { ExtensionProfile } from './extension-profile.ts'

export interface BoundPlayer {
  frameId: number | null
  origin: string | null
  bindingId: string | null
  documentId: string | null
}

export async function readSessionStorage(profile: ExtensionProfile): Promise<{ state: Record<string, unknown>, binding: Record<string, unknown> | null }> {
  const worker = profile.context.serviceWorkers()[0]
    ?? await profile.context.waitForEvent('serviceworker', { timeout: 5_000 })
  const stored = await worker.evaluate(async () => {
    return await chrome.storage.session.get(['syncYourJoySessionState', 'syncYourJoyPlayerBinding'])
  }) as { syncYourJoySessionState?: unknown, syncYourJoyPlayerBinding?: unknown }
  const state = stored.syncYourJoySessionState
  if (!state || typeof state !== 'object')
    throw new Error('The extension did not persist its session state.')
  const binding = stored.syncYourJoyPlayerBinding
  return {
    state: state as Record<string, unknown>,
    binding: binding && typeof binding === 'object' ? binding as Record<string, unknown> : null,
  }
}

export async function readBoundPlayer(profile: ExtensionProfile): Promise<BoundPlayer> {
  const { state, binding } = await readSessionStorage(profile)
  const diagnostics = state.playerDiagnostics as { origin?: unknown } | null | undefined
  return {
    frameId: typeof state.playerFrameId === 'number' ? state.playerFrameId : null,
    origin: typeof diagnostics?.origin === 'string' ? diagnostics.origin : null,
    bindingId: typeof binding?.id === 'string' ? binding.id : null,
    documentId: typeof binding?.documentId === 'string' ? binding.documentId : null,
  }
}

/** Waits until the extension has bound a player that satisfies `accept`, and returns what it bound. */
export async function waitForBoundPlayer(
  profile: ExtensionProfile,
  accept: (bound: BoundPlayer) => boolean,
  message: string,
): Promise<BoundPlayer> {
  let latest: BoundPlayer | undefined
  await expect.poll(async () => {
    latest = await readBoundPlayer(profile)
    return accept(latest)
  }, { timeout: 20_000, message }).toBe(true)
  return latest!
}

export async function readyAndPlayAll(profile: ExtensionProfile): Promise<void> {
  await profile.panel.waitForSelector('#ready-button', { timeout: 20_000 })
  if (((await profile.panel.locator('#ready-button').textContent()) ?? '').includes("I'm ready"))
    await profile.panel.click('#ready-button')
  await profile.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })
  await expect(profile.panel.locator('#primary-control')).toHaveText('Play all', { timeout: 10_000 })
  await profile.panel.click('#primary-control')
}

export async function pauseAll(profile: ExtensionProfile): Promise<void> {
  await expect(profile.panel.locator('#primary-control')).toHaveText('Pause all', { timeout: 15_000 })
  await profile.panel.click('#primary-control')
  await expect(profile.panel.locator('#primary-control')).toHaveText('Play all', { timeout: 15_000 })
}

export interface VideoReading {
  present: boolean
  /** The element's own `paused`; null when there is no such element, so a missing player is neither paused nor playing. */
  paused: boolean | null
  currentTime: number
  readyState: number
}

/** The first `<video>` of a page or frame (or the one matching `selector`), as that element reports itself. */
export async function readVideo(target: Page | Frame, selector = 'video'): Promise<VideoReading> {
  return await target.evaluate((query) => {
    const video = document.querySelector<HTMLVideoElement>(query)
    return video
      ? { present: true, paused: video.paused, currentTime: video.currentTime, readyState: video.readyState }
      : { present: false, paused: null, currentTime: 0, readyState: 0 }
  }, selector)
}

export async function expectPlaying(target: Page | Frame, selector = 'video', timeout = 20_000): Promise<void> {
  await expect.poll(async () => (await readVideo(target, selector)).paused, { timeout, message: `The player ${selector} should be playing.` }).toBe(false)
  const first = (await readVideo(target, selector)).currentTime
  await expect.poll(async () => (await readVideo(target, selector)).currentTime, { timeout: 10_000, message: `The player ${selector} should advance while it plays.` }).toBeGreaterThan(first + 0.5)
}

/** The element exists and reports itself paused. A removed or replaced element does not pass. */
export async function expectPaused(target: Page | Frame, selector = 'video', timeout = 15_000): Promise<void> {
  await expect.poll(async () => (await readVideo(target, selector)).paused, { timeout, message: `The player ${selector} should pause.` }).toBe(true)
}

/** The page's only child frame, once it exists. */
export async function waitForChildFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().filter(frame => frame !== page.mainFrame()).length, { timeout: 15_000, message: 'The page should create a child frame.' }).toBeGreaterThan(0)
  const child = page.frames().find(frame => frame !== page.mainFrame())
  if (!child)
    throw new Error('The child frame disappeared.')
  return child
}

/**
 * Waits until the extension has sampled its bound player again after `sinceMs`
 * (a `Date.now()` value taken after the page finished its change) and that
 * player has data to play. A sample is taken from whichever element the
 * extension is bound to at that moment, so one newer than the change describes
 * the element that replaced the old one. Pressing Play before this gives the
 * extension a player it has not yet looked at.
 */
export async function waitForSampleAfter(profile: ExtensionProfile, sinceMs: number): Promise<void> {
  await expect.poll(async () => {
    const { state } = await readSessionStorage(profile)
    const sample = state.lastPlayerSample as { sampledAtLocalMs?: unknown } | null | undefined
    const diagnostics = state.playerDiagnostics as { readyState?: unknown } | null | undefined
    return typeof sample?.sampledAtLocalMs === 'number'
      && sample.sampledAtLocalMs > sinceMs
      && typeof diagnostics?.readyState === 'number'
      && diagnostics.readyState >= 2
  }, { timeout: 20_000, message: 'The extension should sample the replacement player after the change.' }).toBe(true)
}
