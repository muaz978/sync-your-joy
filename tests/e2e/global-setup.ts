// Starts the real room-service coordinator in-process (the same
// `createRoomService` used by apps/room-service/src/server.test.ts, on an
// ephemeral port so multiple runs never collide with a developer's own
// `npm run dev:server` or with each other) and builds the unpacked Chrome
// extension against that exact port before any test runs.
//
// The extension bakes its room-service URL in at build time via esbuild's
// `define` (see scripts/build-extension.mjs and __ROOM_SERVER_URL__ in
// apps/extension/src/service-worker.ts), so the port is not something a
// test can change at runtime -- the extension has to be built for it.
// Every run writes to a unique Playwright output directory and always builds
// a fresh extension there. The canonical apps/extension/dist release output
// is never used as the E2E build target.
import type { FullConfig } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomService, type RoomService } from '../../apps/room-service/src/server.ts'
import { sanitizeError } from './artifact-utils.ts'
import { buildExtensionAndRecordProvenance } from './provenance.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

let service: RoomService | null = null

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const artifactDirectory = process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
    ?? resolve(repoRoot, 'test-results', `e2e-fallback-${Date.now()}`)
  const extensionDistDir = resolve(artifactDirectory, 'extension')
  await mkdir(artifactDirectory, { recursive: true })
  await mkdir(extensionDistDir, { recursive: true })

  process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR = artifactDirectory
  process.env.SYNCYOURJOY_E2E_EXTENSION_DIST = extensionDistDir

  try {
    const testControlToken = randomBytes(24).toString('base64url')
    service = await createRoomService({ port: 0, testControlToken })
    const roomServerUrl = service.url // e.g. ws://127.0.0.1:54321/rooms
    const testPlayerOrigin = new URL(roomServerUrl.replace(/^ws:/, 'http:')).origin
    const testPlayerUrl = `${testPlayerOrigin}/test-player`

    console.log(`[e2e] room-service listening at ${roomServerUrl}`)

    process.env.SYNCYOURJOY_E2E_ROOM_SERVER_URL = roomServerUrl
    process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL = testPlayerUrl
    process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN = testControlToken
    process.env.SYNCYOURJOY_E2E_TEST_MODE = '1'
    process.env.SYNCYOURJOY_E2E_TEST_ORIGIN = testPlayerOrigin

    // Builds the extension (from the checkout, or from the tree
    // SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT names) and records where it came
    // from. Which tree is built, and from where, is decided and tested in
    // provenance.ts; this only supplies the run's inputs.
    await writeJson(resolve(artifactDirectory, 'provenance.json'), await buildExtensionAndRecordProvenance({
      runId: basename(artifactDirectory),
      createdAt: new Date().toISOString(),
      checkoutRoot: repoRoot,
      extensionSourceOverride: process.env.SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT,
      extensionDistDir,
      roomServerUrl,
      env: process.env,
    }))
  }
  catch (error) {
    await writeJson(resolve(artifactDirectory, 'setup-failure.json'), {
      schemaVersion: 1,
      failureClass: 'browser-launch/setup',
      at: new Date().toISOString(),
      error: sanitizeError(error),
    })
    await service?.close()
    service = null
    delete process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN
    delete process.env.SYNCYOURJOY_E2E_TEST_MODE
    delete process.env.SYNCYOURJOY_E2E_TEST_ORIGIN
    throw error
  }

  return async () => {
    await service?.close()
    service = null
    delete process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN
    delete process.env.SYNCYOURJOY_E2E_TEST_MODE
    delete process.env.SYNCYOURJOY_E2E_TEST_ORIGIN
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
