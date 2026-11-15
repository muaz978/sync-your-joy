// Fault scenarios for the three-profile local matrix (CR-D03 / #68).
//
// Three isolated Chromium profiles, the real extension, the in-process Node
// room service (not apps/edge-service) and the repository-owned local test
// player. The faults are injected by the room service's token-gated control
// (`POST /__test/fault`, present only in the in-process service the E2E setup
// starts): one participant's acknowledgements held, dropped or released, or the
// participant made silent. What is asserted is what every `<video>` reports
// about itself and what the controls offer; nothing here looks at a painted
// frame, and nothing is a provider, account, device or deployment result.
//
// The expectations below are what the room does today, observed first and then
// pinned: a Play waits for every ready member's acknowledgement (3 s), a late
// acknowledgement inside that window starts everyone together, a missing one or
// one after the window leaves the room paused and a later acknowledgement does
// not start it, a Pause is not held up by a withheld acknowledgement, and a
// silent participant makes the coordinator pause the room.
import { expect, test } from '@playwright/test'
import type { ExtensionProfile } from './extension-profile.ts'
import {
  assertConverged,
  createRoomWithPlayers,
  disconnectParticipant,
  ensureRoomPaused,
  ensureRoomPlaying,
  expectHeldPaused,
  launchThreeProfiles,
  readExtensionState,
  readFixtureState,
  readFixtureStates,
  readParticipantId,
  readyUp,
  SYNC_TOLERANCE_SECONDS,
  setParticipantFault,
  waitForAllPaused,
  waitForAllPlaying,
  type Room,
} from './three-profile-room.ts'

test.describe('three-profile fault matrix', () => {
  let profiles: [ExtensionProfile, ExtensionProfile, ExtensionProfile]

  test.beforeAll(async () => {
    profiles = await launchThreeProfiles('fault')
  })

  test.afterAll(async () => {
    await Promise.all(profiles?.map(profile => profile.close()) ?? [])
  })

  test('quorum, late and missing acknowledgements, pending pause, silent players and a second controller', async () => {
    const [profileA, profileB, profileC] = profiles
    const room: Room = await createRoomWithPlayers(profiles)
    const { pages, roomCode } = room
    const [pageA, pageB, pageC] = pages
    const idC = await readParticipantId(profileC)
    const idA = await readParticipantId(profileA)

    await test.step('Play is refused while one of three members is not ready', async () => {
      await readyUp(profileA)
      await readyUp(profileB)
      // C has a player but has not said it is ready: the controller's Play is
      // not offered, and nothing starts by itself.
      await expect(profileA.panel.locator('#primary-control')).toBeDisabled({ timeout: 10_000 })
      await expectHeldPaused(pages, 2_500)
      await expect(profileA.panel.locator('#primary-control')).toBeDisabled()
      await readyUp(profileC)
      await expect(profileA.panel.locator('#primary-control')).toBeEnabled({ timeout: 15_000 })
    })

    await test.step('a late acknowledgement inside the window starts everyone together', async () => {
      await setParticipantFault(roomCode, idC, 'hold_acks')
      await profileA.panel.click('#primary-control')
      // C's acknowledgement is held: the barrier is waiting for it, so nobody plays.
      await expectHeldPaused(pages, 800)
      const released = await setParticipantFault(roomCode, idC, 'release')
      expect(released.released, 'the held acknowledgement was delivered').toBeGreaterThan(0)
      await waitForAllPlaying(pages)
      await assertConverged(pages)
    })

    await test.step('a Pause is not held up by a withheld acknowledgement', async () => {
      await setParticipantFault(roomCode, idC, 'hold_acks')
      await expect(profileA.panel.locator('#primary-control')).toHaveText('Pause all', { timeout: 10_000 })
      await profileA.panel.click('#primary-control')
      // Well inside the 3 s window, with C's acknowledgements held.
      await waitForAllPaused(pages, 2_500)
      await setParticipantFault(roomCode, idC, 'release')
      // A late acknowledgement for a pause does not start anything.
      await expectHeldPaused(pages, 2_000)
    })

    await test.step('a missing acknowledgement leaves the room paused, and the next Play works', async () => {
      await setParticipantFault(roomCode, idC, 'drop_acks')
      await expect(profileA.panel.locator('#primary-control')).toHaveText('Play all', { timeout: 10_000 })
      await profileA.panel.click('#primary-control')
      // Past the 3 s window, 5 s more: it never started and it has not moved.
      await expectHeldPaused(pages, 5_500)
      await setParticipantFault(roomCode, idC, 'clear')
      await ensureRoomPlaying(profileA, pages)
      await assertConverged(pages)
    })

    await test.step('an acknowledgement after the window does not start a Play that timed out', async () => {
      await ensureRoomPaused(profileA, pages)
      await setParticipantFault(roomCode, idC, 'hold_acks')
      await profileA.panel.click('#primary-control')
      await expectHeldPaused(pages, 4_500)
      const released = await setParticipantFault(roomCode, idC, 'release')
      expect(released.released, 'the held acknowledgement was delivered, late').toBeGreaterThan(0)
      await expectHeldPaused(pages, 3_000)
      await ensureRoomPlaying(profileA, pages)
    })

    await test.step('a silent participant makes the coordinator pause the room', async () => {
      await setParticipantFault(roomCode, idC, 'silent')
      await waitForAllPaused(pages, 20_000)
      await setParticipantFault(roomCode, idC, 'clear')
      await ensureRoomPlaying(profileA, pages)
      await assertConverged(pages)
    })

    await test.step('a silent controller does the same', async () => {
      // A is the controller. Its own reports stop, and the room pauses.
      await setParticipantFault(roomCode, idA, 'silent')
      await waitForAllPaused(pages, 20_000)
      await setParticipantFault(roomCode, idA, 'clear')
      await ensureRoomPlaying(profileA, pages)
      await assertConverged(pages)
    })

    await test.step('B takes the controller lease and plays, scrubs, and the room follows', async () => {
      await ensureRoomPaused(profileA, pages)
      await profileA.panel.locator('[data-transfer]').first().click()
      await profileB.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 15_000 })
      await expect(profileA.panel.locator('#primary-control')).toHaveCount(0, { timeout: 10_000 })
      await ensureRoomPlaying(profileB, pages)
      await assertConverged(pages)
      await ensureRoomPaused(profileB, pages)
      // A native scrub on the controller's own player, at a paused boundary.
      const target = 4
      await pageB.evaluate((position) => {
        const video = document.querySelector('video')
        if (!video)
          throw new Error('Controller video is missing.')
        video.currentTime = position
      }, target)
      await expect.poll(async () => (await readFixtureStates(pages)).every(state => state.lastSeekedTime !== null && Math.abs(state.lastSeekedTime - target) <= SYNC_TOLERANCE_SECONDS), {
        timeout: 20_000,
        message: 'All three players should settle on the destination of the controller\'s native scrub.',
      }).toBe(true)
      await assertConverged(pages)
      await waitForAllPaused(pages)
    })

    await test.step('with B as controller, a source reset on C is recovered', async () => {
      const before = (await readFixtureState(pageC)).sourceGeneration
      await pageC.locator('#reset-source').click()
      await pageC.waitForFunction((previous) => {
        const state = (window as unknown as { __syncYourJoyTestPlayer?: { getState: () => { sourceGeneration: number, readyState: number } } }).__syncYourJoyTestPlayer?.getState()
        return !!state && state.sourceGeneration > previous && state.readyState >= 1
      }, before, { timeout: 15_000 })
      await profileC.panel.waitForSelector('#ready-button', { timeout: 20_000 })
      // Observed: replacing the source of the same media does not make C unready
      // (the panel still reads "Ready", the extension re-detected the player), so
      // there is no re-admission to assert here. What is asserted is that the room
      // still plays with the reset player: B's Play starts all three and they converge.
      await expect(profileC.panel.locator('#ready-button')).toContainText('Ready', { timeout: 20_000 })
      await profileB.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })
      await ensureRoomPlaying(profileB, pages)
      await assertConverged(pages)
      await ensureRoomPaused(profileB, pages)
      await profileB.panel.waitForSelector('#primary-control:not([disabled])', { timeout: 20_000 })
    })

    await test.step('with B as controller, a blocked play permission is shown and recovered', async () => {
      await ensureRoomPaused(profileB, pages)
      await pageC.locator('#reject-next-play').click()
      await profileB.panel.click('#primary-control')
      await expect(profileC.panel.getByText('Playback blocked', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
      await profileC.panel.waitForTimeout(3_000)
      await expect(profileC.panel.getByText('Playback blocked', { exact: true }).first()).toBeVisible({ timeout: 1_000 })
      await waitForAllPaused(pages)
      await pageC.locator('#allow-playback').click()
      await profileC.panel.waitForSelector('#sync-now:not([disabled])', { timeout: 15_000 })
      await profileC.panel.click('#sync-now')
      await expect(profileC.panel.getByText('Playback blocked', { exact: true })).toHaveCount(0, { timeout: 15_000 })
      // The rejected play cleared C's readiness: it has to say it is ready again.
      await profileC.panel.waitForSelector('#ready-button', { timeout: 15_000 })
      await expect(profileC.panel.locator('#ready-button')).toContainText("I'm ready", { timeout: 15_000 })
      await readyUp(profileC)
      await ensureRoomPlaying(profileB, pages)
      await assertConverged(pages)
    })

    await test.step('with B as controller, a dropped member reconnects and the room is resumed by B', async () => {
      await disconnectParticipant(roomCode, idC)
      await expect(profileC.panel.getByText('Reconnecting', { exact: true })).toBeVisible({ timeout: 10_000 })
      await expect.poll(async () => (await readExtensionState(profileC)).connection, { timeout: 20_000 }).toBe('connected')
      await ensureRoomPlaying(profileB, pages)
      await assertConverged(pages)
    })

    await test.step('with B as controller, a silent controller pauses the room and B can resume it', async () => {
      const idB = await readParticipantId(profileB)
      await setParticipantFault(roomCode, idB, 'silent')
      await waitForAllPaused(pages, 20_000)
      await setParticipantFault(roomCode, idB, 'clear')
      await ensureRoomPlaying(profileB, pages)
      await assertConverged(pages)
    })
  })
})
