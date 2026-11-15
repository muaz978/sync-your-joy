// Shared setup and observation for the specs that run three isolated profiles
// against the local test player (`/test-player`) and the in-process room
// service. It carries no provider, protected media, credentials or provider
// API: the player is the repository-owned local-file page, and the observations
// are what each `<video>` element reports about itself.
import { expect, type Page } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchExtensionProfile, type ExtensionProfile } from './extension-profile.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')
// The 120-second owned clip: a long sustained window never reaches the clip's end.
export const fixtureVideoPath = resolve(here, '..', '..', 'fixtures/adaptive-test-clip.mp4')
export const SYNC_TOLERANCE_SECONDS = 0.75

export interface FixtureEvent {
  type: string
  at: number
  currentTime: number
  paused: boolean
  seeking: boolean
  sourceGeneration: number
}

export interface FixtureState {
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

type FixtureWindow = Window & { __syncYourJoyTestPlayer?: { getState: () => FixtureState } }

export interface Room {
  profiles: [ExtensionProfile, ExtensionProfile, ExtensionProfile]
  pages: [Page, Page, Page]
  roomCode: string
}

export async function launchThreeProfiles(prefix: string): Promise<[ExtensionProfile, ExtensionProfile, ExtensionProfile]> {
  const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir
  const artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR
  const options = {
    ...(artifactDirectory ? { artifactDirectory } : {}),
    trace: process.env.SYNCYOURJOY_E2E_TRACE === '1',
  }
  const results = await Promise.allSettled(['a', 'b', 'c'].map(label => launchExtensionProfile(dist, `${prefix}-${label}`, options)))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) {
    await Promise.all(results
      .filter((result): result is PromiseFulfilledResult<ExtensionProfile> => result.status === 'fulfilled')
      .map(result => result.value.close()))
    throw failure.reason
  }
  return results.map(result => (result as PromiseFulfilledResult<ExtensionProfile>).value) as [ExtensionProfile, ExtensionProfile, ExtensionProfile]
}

/**
 * A three-member room: A creates it, B and C join and A approves them, A shares
 * the local test player, every profile selects the same local file. Nobody has
 * pressed "I'm ready" yet.
 */
export async function createRoomWithPlayers(profiles: [ExtensionProfile, ExtensionProfile, ExtensionProfile]): Promise<Room> {
  const [profileA, profileB, profileC] = profiles
  const testPlayerUrl = process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL
  if (!testPlayerUrl)
    throw new Error('SYNCYOURJOY_E2E_TEST_PLAYER_URL was not set by global-setup.ts.')
  await profileA.panel.fill('#display-name', 'Profile A')
  await profileA.panel.click('#create-form button[type=submit]')
  await profileA.panel.waitForSelector('#copy-code')
  const roomCode = (await profileA.panel.locator('#copy-code .font-mono').first().textContent())?.trim()
  expect(roomCode).toMatch(/^[A-Z0-9]{8}$/)
  for (const [index, profile] of [profileB, profileC].entries()) {
    await profile.panel.fill('#display-name', index === 0 ? 'Profile B' : 'Profile C')
    await profile.panel.fill('#room-code', roomCode!)
    await profile.panel.click('#join-form button[type=submit]')
    await profileA.panel.waitForSelector('[data-approve-join]', { timeout: 20_000 })
    await profileA.panel.locator('[data-approve-join]').last().click()
    await profile.panel.waitForSelector('#copy-code', { timeout: 20_000 })
  }
  const pagePromises = profiles.map(profile => profile.context.waitForEvent('page', { timeout: 20_000 }))
  await profileA.panel.fill('#shared-video-url', testPlayerUrl)
  await profileA.panel.click('#open-shared-link')
  const pages = await Promise.all(pagePromises) as [Page, Page, Page]
  await Promise.all(pages.map(page => page.waitForLoadState('domcontentloaded')))
  await Promise.all(pages.map(page => page.setInputFiles('input[type=file]', fixtureVideoPath)))
  await Promise.all(pages.map(page => page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 1)))
  await Promise.all(profiles.map(profile => profile.panel.waitForSelector('#ready-button', { timeout: 25_000 })))
  return { profiles, pages, roomCode: roomCode! }
}

export async function readyUp(profile: ExtensionProfile): Promise<void> {
  await profile.panel.waitForSelector('#ready-button', { timeout: 15_000 })
  if (((await profile.panel.locator('#ready-button').textContent()) ?? '').includes("I'm ready"))
    await profile.panel.click('#ready-button')
  await expect(profile.panel.locator('#ready-button')).toContainText('Ready', { timeout: 10_000 })
}

export async function readFixtureState(page: Page): Promise<FixtureState> {
  return await page.evaluate(() => {
    const state = (window as unknown as FixtureWindow).__syncYourJoyTestPlayer
    if (!state)
      throw new Error('The deterministic test-player instrumentation is unavailable.')
    return state.getState()
  })
}

export async function readFixtureStates(pages: Page[]): Promise<FixtureState[]> {
  return await Promise.all(pages.map(page => readFixtureState(page)))
}

export async function waitForAllPlaying(pages: Page[], timeout = 20_000): Promise<void> {
  await expect.poll(async () => (await readFixtureStates(pages)).every(state => !state.paused && state.presentedFrames > 0), {
    timeout,
    message: 'Every local player should report real native playback progress.',
  }).toBe(true)
}

export async function waitForAllPaused(pages: Page[], timeout = 15_000): Promise<void> {
  await expect.poll(async () => (await readFixtureStates(pages)).every(state => state.paused), {
    timeout,
    message: 'Every local player should be paused.',
  }).toBe(true)
}

export async function assertConverged(pages: Page[]): Promise<void> {
  await expect.poll(async () => {
    const states = await readFixtureStates(pages)
    return Math.max(...states.map(state => state.currentTime)) - Math.min(...states.map(state => state.currentTime))
  }, { timeout: 15_000, message: 'All local timelines should converge.' }).toBeLessThanOrEqual(SYNC_TOLERANCE_SECONDS)
}

export async function readExtensionState(profile: ExtensionProfile): Promise<Record<string, unknown>> {
  const worker = profile.context.serviceWorkers()[0]
    ?? await profile.context.waitForEvent('serviceworker', { timeout: 5_000 })
  const state = await worker.evaluate(async () => {
    const stored = await chrome.storage.session.get('syncYourJoySessionState')
    return stored.syncYourJoySessionState
  }) as unknown
  if (!state || typeof state !== 'object')
    throw new Error('The extension did not persist state.')
  return state as Record<string, unknown>
}

export async function readParticipantId(profile: ExtensionProfile): Promise<string> {
  const state = await readExtensionState(profile)
  if (typeof state.participantId !== 'string')
    throw new Error('The extension state did not include a participant identity.')
  return state.participantId
}

export type FaultMode = 'hold_acks' | 'drop_acks' | 'silent' | 'release' | 'clear'

/**
 * The room service's token-gated fault control (`POST /__test/fault`), present
 * only in the in-process service the E2E setup starts.
 */
export async function setParticipantFault(roomCode: string, participantId: string, mode: FaultMode): Promise<{ released: number }> {
  const roomServerUrl = process.env.SYNCYOURJOY_E2E_ROOM_SERVER_URL
  const testControlToken = process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN
  if (!roomServerUrl || !testControlToken)
    throw new Error('The local room-service test control is not configured.')
  const controlUrl = new URL(roomServerUrl.replace(/^ws:/, 'http:'))
  controlUrl.pathname = '/__test/fault'
  controlUrl.searchParams.set('room', roomCode)
  controlUrl.searchParams.set('participant', participantId)
  controlUrl.searchParams.set('mode', mode)
  const response = await fetch(controlUrl, { method: 'POST', headers: { 'x-syncyourjoy-test-token': testControlToken } })
  if (!response.ok)
    throw new Error(`The room-service fault control returned HTTP ${response.status}.`)
  const result = await response.json() as { ok?: boolean, released?: number }
  if (result.ok !== true)
    throw new Error(`The room-service fault control refused: ${JSON.stringify(result)}`)
  return { released: result.released ?? 0 }
}

export async function disconnectParticipant(roomCode: string, participantId: string): Promise<void> {
  const roomServerUrl = process.env.SYNCYOURJOY_E2E_ROOM_SERVER_URL
  const testControlToken = process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN
  if (!roomServerUrl || !testControlToken)
    throw new Error('The local room-service test control is not configured.')
  const controlUrl = new URL(roomServerUrl.replace(/^ws:/, 'http:'))
  controlUrl.pathname = '/__test/disconnect'
  controlUrl.searchParams.set('room', roomCode)
  controlUrl.searchParams.set('participant', participantId)
  const response = await fetch(controlUrl, { method: 'POST', headers: { 'x-syncyourjoy-test-token': testControlToken } })
  if (!response.ok)
    throw new Error(`The local room-service test control returned HTTP ${response.status}.`)
  const result = await response.json() as { ok?: boolean, closedSockets?: number }
  if (result.ok !== true || result.closedSockets !== 1)
    throw new Error(`The local room-service test control closed an unexpected number of sockets: ${JSON.stringify(result)}`)
}

/** What a participant's panel says, flattened: for reading a failure, not for assertions on wording. */
export async function panelText(profile: ExtensionProfile): Promise<string> {
  return ((await profile.panel.locator('body').innerText({ timeout: 2_000 }).catch(() => 'panel unavailable')) ?? '').replace(/\s+/g, ' ').trim()
}

export async function ensureRoomPaused(controller: ExtensionProfile, pages: Page[]): Promise<void> {
  await controller.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
  if ((await readFixtureStates(pages)).every(state => state.paused))
    return
  const label = await controller.panel.locator('#primary-control').textContent()
  if (!label?.includes('Pause all'))
    throw new Error(`The room control did not expose a pause action while a player was still playing: ${label ?? 'missing label'}`)
  await controller.panel.click('#primary-control')
  await waitForAllPaused(pages)
}

/** Presses Play when the control offers it and waits until every player is playing and the room keeps playing for a second. */
export async function ensureRoomPlaying(controller: ExtensionProfile, pages: Page[]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await controller.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
    const label = await controller.panel.locator('#primary-control').textContent()
    if (label?.includes('Play all'))
      await controller.panel.click('#primary-control')
    await expect.poll(async () => (await readFixtureStates(pages)).every(state => !state.paused && state.presentedFrames > 0), {
      timeout: 5_000,
      message: 'Every local player should enter native playback.',
    }).toBe(true).catch(() => undefined)
    await pages[0]!.waitForTimeout(1_000)
    if ((await readFixtureStates(pages)).every(state => !state.paused && state.presentedFrames > 0))
      return
  }
  throw new Error(`The room did not stay playing: ${JSON.stringify((await readFixtureStates(pages)).map(state => ({ t: state.currentTime, paused: state.paused })))}`)
}

/** Every player holds still: none is playing and none moved more than `toleranceSeconds` over `forMs`. */
export async function expectHeldPaused(pages: Page[], forMs: number, toleranceSeconds = 0.15): Promise<void> {
  const before = await readFixtureStates(pages)
  expect(before.every(state => state.paused), 'every player should be paused').toBe(true)
  await pages[0]!.waitForTimeout(forMs)
  const after = await readFixtureStates(pages)
  expect(after.every(state => state.paused), 'every player should still be paused').toBe(true)
  for (const [index, state] of after.entries())
    expect(Math.abs(state.currentTime - before[index]!.currentTime), `player ${index} should not have moved`).toBeLessThanOrEqual(toleranceSeconds)
}
