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
// Because the port is ephemeral, a previous build almost never already
// targets it; when it does (for example a fixed port reused across local
// runs), the build is skipped.
import type { FullConfig } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomService, type RoomService } from '../../apps/room-service/src/server.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const extensionDistDir = resolve(repoRoot, 'apps/extension/dist')
const extensionManifestPath = resolve(extensionDistDir, 'manifest.json')
const buildExtensionScript = resolve(repoRoot, 'scripts/build-extension.mjs')

let service: RoomService | null = null

export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  service = await createRoomService({ port: 0 })
  const roomServerUrl = service.url // e.g. ws://127.0.0.1:54321/rooms
  const testPlayerUrl = `${roomServerUrl.replace(/^ws:/, 'http:').replace(/\/rooms$/, '')}/test-player`

  console.log(`[e2e] room-service listening at ${roomServerUrl}`)

  process.env.SYNCYOURJOY_E2E_ROOM_SERVER_URL = roomServerUrl
  process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL = testPlayerUrl
  process.env.SYNCYOURJOY_E2E_EXTENSION_DIST = extensionDistDir

  await buildExtensionIfNeeded(roomServerUrl)

  return async () => {
    await service?.close()
    service = null
  }
}

async function buildExtensionIfNeeded(roomServerUrl: string): Promise<void> {
  if (await extensionAlreadyBuiltFor(roomServerUrl)) {
    console.log('[e2e] reusing apps/extension/dist -- already built for this room-service port')
    return
  }
  console.log('[e2e] building the extension against the ephemeral room-service port...')
  execFileSync(process.execPath, [buildExtensionScript], {
    cwd: repoRoot,
    env: { ...process.env, SYNCYOURJOY_ROOM_SERVER_URL: roomServerUrl },
    stdio: 'inherit',
  })
}

async function extensionAlreadyBuiltFor(roomServerUrl: string): Promise<boolean> {
  try {
    const manifestRaw = await readFile(extensionManifestPath, 'utf8')
    const wsOrigin = new URL(roomServerUrl).origin
    return manifestRaw.includes(wsOrigin)
  }
  catch {
    return false
  }
}
