import { cp, mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'

const run = promisify(execFile)
const root = resolve(new URL('..', import.meta.url).pathname)
// Safari's packager requires a path it can access through the macOS security
// boundary. Keep the short-lived staging directory under the repository rather
// than /tmp so the same command works from a normal Terminal session.
const staging = await mkdtemp(join(root, '.browser-package-smoke-'))
const result = { chrome: null, firefox: null, safari: null }

try {
  const buildEnvironment = {
    ...process.env,
    SYNCYOURJOY_ROOM_SERVER_URL: process.env.SYNCYOURJOY_ROOM_SERVER_URL ?? 'wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms',
  }

  await run(process.execPath, ['scripts/build-extension.mjs'], { cwd: root, env: buildEnvironment })
  await cp(resolve(root, 'apps/extension/dist'), join(staging, 'chrome'), { recursive: true })
  const chromeManifest = await readManifest(join(staging, 'chrome'))
  assertChromeManifest(chromeManifest)
  result.chrome = { ok: true, manifestVersion: chromeManifest.version, serviceWorker: chromeManifest.background?.service_worker }

  await run(process.execPath, ['scripts/build-extension.mjs'], {
    cwd: root,
    env: { ...buildEnvironment, SYNCYOURJOY_BROWSER: 'firefox' },
  })
  await cp(resolve(root, 'apps/extension/dist'), join(staging, 'firefox'), { recursive: true })
  const firefoxManifest = await readManifest(join(staging, 'firefox'))
  assertFirefoxManifest(firefoxManifest)
  result.firefox = { ok: true, manifestVersion: firefoxManifest.version, sidebar: firefoxManifest.sidebar_action?.default_panel }

  // Leave the canonical dist directory in its default Chrome form. The
  // Firefox build above is copied to staging for verification only.
  await run(process.execPath, ['scripts/build-extension.mjs'], { cwd: root, env: buildEnvironment })

  if (await commandExists('xcrun')) {
    const safariProject = join(staging, 'safari-project')
    await run('xcrun', [
      'safari-web-extension-packager',
      '--macos-only',
      '--copy-resources',
      '--no-open',
      '--no-prompt',
      '--force',
      '--app-name', 'SyncYourJoy',
      '--bundle-identifier', 'dev.muaz978.syncyourjoy',
      '--project-location', safariProject,
      join(staging, 'chrome'),
    ], { cwd: root })
    const projectEntries = await readDirectory(safariProject)
    if (!projectEntries.some(entry => entry.endsWith('.xcodeproj')))
      throw new Error('Safari packager completed without generating an Xcode project.')
    result.safari = { ok: true, mode: 'macOS package smoke', project: safariProject }
  }
  else {
    result.safari = { ok: false, skipped: true, reason: 'xcrun is not available on this host.' }
  }

  console.log(JSON.stringify(result, null, 2))
}
finally {
  await rm(staging, { recursive: true, force: true })
}

async function readManifest(directory) {
  return JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
}

function assertChromeManifest(manifest) {
  if (manifest.manifest_version !== 3 || manifest.side_panel?.default_path !== 'sidepanel.html')
    throw new Error('Chrome manifest does not contain the expected MV3 side-panel configuration.')
  if (manifest.background?.service_worker !== 'service-worker.js')
    throw new Error('Chrome manifest does not point to service-worker.js.')
  if (!manifest.permissions?.includes('sidePanel'))
    throw new Error('Chrome manifest is missing the sidePanel permission.')
  if (manifest.sidebar_action)
    throw new Error('Chrome build unexpectedly contains Firefox sidebar metadata.')
}

function assertFirefoxManifest(manifest) {
  if (manifest.manifest_version !== 3 || manifest.sidebar_action?.default_panel !== 'sidepanel.html')
    throw new Error('Firefox manifest does not contain the expected sidebar configuration.')
  if (manifest.permissions?.includes('sidePanel'))
    throw new Error('Firefox build unexpectedly contains the Chrome sidePanel permission.')
  if (manifest.minimum_chrome_version)
    throw new Error('Firefox build unexpectedly contains minimum_chrome_version.')
}

async function commandExists(command) {
  try {
    await run('sh', ['-lc', `command -v ${command}`])
    return true
  }
  catch {
    return false
  }
}

async function readDirectory(directory) {
  const { stdout } = await run('find', [directory, '-maxdepth', '5', '-type', 'd', '-name', '*.xcodeproj', '-print'])
  return stdout.split('\n').map(line => line.trim()).filter(Boolean)
}
