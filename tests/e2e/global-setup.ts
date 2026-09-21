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
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoomService, type RoomService } from '../../apps/room-service/src/server.ts'
import { sanitizeError } from './artifact-utils.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const buildExtensionScript = resolve(repoRoot, 'scripts/build-extension.mjs')

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
    const testPlayerUrl = `${roomServerUrl.replace(/^ws:/, 'http:').replace(/\/rooms$/, '')}/test-player`

    console.log(`[e2e] room-service listening at ${roomServerUrl}`)

    process.env.SYNCYOURJOY_E2E_ROOM_SERVER_URL = roomServerUrl
    process.env.SYNCYOURJOY_E2E_TEST_PLAYER_URL = testPlayerUrl
    process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN = testControlToken

    await buildExtension(roomServerUrl, extensionDistDir)
    await writeProvenance(artifactDirectory, extensionDistDir, roomServerUrl)
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
    throw error
  }

  return async () => {
    await service?.close()
    service = null
    delete process.env.SYNCYOURJOY_E2E_CONTROL_TOKEN
  }
}

async function buildExtension(roomServerUrl: string, extensionDistDir: string): Promise<void> {
  console.log(`[e2e] building an isolated extension at ${relative(repoRoot, extensionDistDir)}...`)
  execFileSync(process.execPath, [buildExtensionScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SYNCYOURJOY_ROOM_SERVER_URL: roomServerUrl,
      SYNCYOURJOY_EXTENSION_OUTPUT_DIR: extensionDistDir,
    },
    stdio: 'inherit',
  })
}

async function writeProvenance(
  artifactDirectory: string,
  extensionDistDir: string,
  roomServerUrl: string,
): Promise<void> {
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const sourceFiles = trackedFiles.filter(path => /^(apps|packages|scripts|tests|fixtures)\//.test(path))
  const configFiles = [
    'package.json',
    'tsconfig.json',
    'vitest.config.ts',
    'uno.config.mjs',
    'scripts/build-extension.mjs',
    'tests/e2e/playwright.config.ts',
    'apps/extension/static/manifest.json',
  ]
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const manifestPath = resolve(extensionDistDir, 'manifest.json')

  await writeJson(resolve(artifactDirectory, 'provenance.json'), {
    schemaVersion: 1,
    runId: basename(artifactDirectory),
    createdAt: new Date().toISOString(),
    source: {
      commit: sourceCommit,
      tree: sourceTree,
      trackedSourceSha256: await hashFiles(sourceFiles),
    },
    lock: {
      packageLockSha256: await hashFiles(['package-lock.json']),
    },
    config: {
      files: configFiles,
      sha256: await hashFiles(configFiles),
    },
    e2e: {
      roomServerOrigin: new URL(roomServerUrl).origin,
      extensionOutput: relative(repoRoot, extensionDistDir),
      extensionManifestSha256: await hashFiles([manifestPath]),
    },
  })
}

async function hashFiles(paths: string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) {
    const filePath = resolve(repoRoot, path)
    hash.update(path)
    hash.update('\0')
    hash.update(await readFile(filePath))
  }
  return hash.digest('hex')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
