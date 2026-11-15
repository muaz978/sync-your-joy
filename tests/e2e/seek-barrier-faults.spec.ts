// A seek that is pending while something goes wrong (#54), in a real browser.
//
// The seek barrier makes every member apply a controller's seek and acknowledge
// it before the room carries on. Three profiles, the real extension, the
// in-process Node room service (not apps/edge-service) and the owned local test
// player; a member's acknowledgement is held or released through the room
// service's token-gated fault control (`POST /__test/fault`), a socket is
// dropped through `/__test/disconnect`, and the controller lease is moved with
// the panel's own control. What is asserted is what each `<video>` reports about
// itself and what the controls offer. Class (b) evidence: a local browser on the
// owned synthetic fixture. Not Crunchyroll, not two accounts, not two devices,
// and the engine-level rules are pinned by the coordinator's unit tests.
//
// Observed first, then pinned: while a seek is pending every player is paused at
// the destination; the barrier waits 3 s for the last acknowledgement; once it
// completes the room resumes, and once it is cancelled (lease transfer, a
// dropped socket, the window running out) the room stays paused at the
// destination and an acknowledgement that arrives afterwards does not resume it.
import { expect, test, type Page } from '@playwright/test'
import type { ExtensionProfile } from './extension-profile.ts'
import {
  assertConverged,
  createRoomWithPlayers,
  disconnectParticipant,
  ensureRoomPlaying,
  expectHeldPaused,
  launchThreeProfiles,
  readExtensionState,
  readFixtureStates,
  readParticipantId,
  readyUp,
  SYNC_TOLERANCE_SECONDS,
  setParticipantFault,
  waitForAllPlaying,
} from './three-profile-room.ts'

/** Presses the controller's real +10 button and returns the destination that exact button carried. */
async function pressForwardSeek(controller: ExtensionProfile): Promise<number> {
  await controller.panel.evaluate(() => {
    delete document.documentElement.dataset.requestedSeek
    document.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-seek]') : null
      if (button?.dataset.seek)
        document.documentElement.dataset.requestedSeek = button.dataset.seek
    }, { capture: true, once: true })
  })
  await controller.panel.locator('[data-seek]').last().click()
  const requested = Number(await controller.panel.evaluate(() => document.documentElement.dataset.requestedSeek))
  expect(Number.isFinite(requested), 'the clicked seek button carries a destination').toBe(true)
  return requested
}

/** Every player has applied the destination and is paused there. */
async function expectPausedAtDestination(pages: Page[], destination: number): Promise<void> {
  await expect.poll(async () => {
    const states = await readFixtureStates(pages)
    return states.every(state => state.paused
      && state.lastSeekedTime !== null
      && Math.abs(state.lastSeekedTime - destination) <= SYNC_TOLERANCE_SECONDS
      && Math.abs(state.currentTime - destination) <= SYNC_TOLERANCE_SECONDS)
  }, { timeout: 5_000, message: `Every player should be paused at the seek destination ${destination}s while the seek is pending.` }).toBe(true)
}

test.describe('a pending seek under faults', () => {
  let profiles: [ExtensionProfile, ExtensionProfile, ExtensionProfile]

  test.beforeAll(async () => {
    profiles = await launchThreeProfiles('seekfault')
  })

  test.afterAll(async () => {
    await Promise.all(profiles?.map(profile => profile.close()) ?? [])
  })

  test('a late acknowledgement, a missing one, a dropped socket and a lease transfer while the seek is pending', async () => {
    test.setTimeout(300_000)
    const [profileA, profileB, profileC] = profiles
    const { pages, roomCode } = await createRoomWithPlayers(profiles)
    await readyUp(profileA)
    await readyUp(profileB)
    await readyUp(profileC)
    const idC = await readParticipantId(profileC)
    await profileA.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
    await ensureRoomPlaying(profileA, pages)

    await test.step('a late acknowledgement inside the window: paused at the destination, then everyone resumes together', async () => {
      await setParticipantFault(roomCode, idC, 'hold_acks')
      const destination = await pressForwardSeek(profileA)
      await expectPausedAtDestination(pages, destination)
      // The barrier is waiting for C: the controller is not offered Pause and nothing moves.
      await expect(profileA.panel.locator('#primary-control')).toHaveText('Play all')
      await expectHeldPaused(pages, 600)
      const released = await setParticipantFault(roomCode, idC, 'release')
      expect(released.released, 'C\'s held acknowledgement was delivered').toBeGreaterThan(0)
      await waitForAllPlaying(pages)
      await assertConverged(pages)
      const resumed = await readFixtureStates(pages)
      for (const state of resumed)
        expect(state.currentTime).toBeGreaterThanOrEqual(destination - SYNC_TOLERANCE_SECONDS)
    })

    await test.step('an acknowledgement after the window: paused at the destination, and the late one does not resume the room', async () => {
      await setParticipantFault(roomCode, idC, 'hold_acks')
      const destination = await pressForwardSeek(profileA)
      await expectPausedAtDestination(pages, destination)
      // Longer than the 3 s barrier window: it timed out and stays paused at the destination.
      await expectHeldPaused(pages, 4_500)
      const released = await setParticipantFault(roomCode, idC, 'release')
      expect(released.released, 'C\'s held acknowledgement was delivered, late').toBeGreaterThan(0)
      await expectHeldPaused(pages, 3_000)
      await expectPausedAtDestination(pages, destination)
      await ensureRoomPlaying(profileA, pages)
      await assertConverged(pages)
    })

    await test.step('a dropped socket while the seek is pending: paused at the destination, the late acknowledgement does not resume the room', async () => {
      await setParticipantFault(roomCode, idC, 'hold_acks')
      const destination = await pressForwardSeek(profileA)
      await expectPausedAtDestination(pages, destination)
      await disconnectParticipant(roomCode, idC)
      await expect.poll(async () => (await readExtensionState(profileC)).connection, { timeout: 20_000, message: 'C should reconnect.' }).toBe('connected')
      // C is back, and the acknowledgement it held from before the drop arrives now.
      await setParticipantFault(roomCode, idC, 'release')
      await expectHeldPaused(pages, 3_000)
      await expectPausedAtDestination(pages, destination)
      await ensureRoomPlaying(profileA, pages)
      await assertConverged(pages)
    })

    await test.step('a lease transfer while the seek is pending: paused at the destination, B decides when it resumes', async () => {
      await setParticipantFault(roomCode, idC, 'hold_acks')
      const destination = await pressForwardSeek(profileA)
      await expectPausedAtDestination(pages, destination)
      await profileA.panel.locator('[data-transfer]').first().click()
      await profileB.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
      await expect(profileA.panel.locator('#primary-control')).toHaveCount(0, { timeout: 10_000 })
      await setParticipantFault(roomCode, idC, 'release')
      // Nobody resumed the room for B: it is paused at the destination, and the
      // new controller is offered Play.
      await expectHeldPaused(pages, 3_000)
      await expectPausedAtDestination(pages, destination)
      await expect(profileB.panel.locator('#primary-control')).toHaveText('Play all')
      await ensureRoomPlaying(profileB, pages)
      await assertConverged(pages)
      await waitForAllPlaying(pages)
    })

    await test.step('with B as controller, a pending seek completes when the late acknowledgement arrives', async () => {
      await setParticipantFault(roomCode, idC, 'hold_acks')
      const destination = await pressForwardSeek(profileB)
      await expectPausedAtDestination(pages, destination)
      await setParticipantFault(roomCode, idC, 'release')
      await waitForAllPlaying(pages)
      await assertConverged(pages)
    })

  })
})
