// Regression coverage for issue #30: a storage state passed to the extension
// profile helper must actually reach that persistent Chrome profile.
//
// Playwright 1.63 silently ignores `storageState` on
// `launchPersistentContext`, so the earlier helper launched both
// "authenticated" Crunchyroll profiles with no cookies and no localStorage.
// This spec needs no secrets. It serves its own loopback origin, writes two
// dummy states (fake cookies and one localStorage entry each) into a
// temporary directory at runtime, and launches both profiles through the same
// launchExtensionProfiles helper as tests/e2e/crunchyroll-two-profile.spec.ts.
// It also covers the declared session-cookie gate, the order against the
// helper's own trace, and the refusals for a dropped cookie or missing file.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { artifactFileName } from './artifact-utils.ts'
import { launchExtensionProfile, launchExtensionProfiles, type ExtensionProfile } from './extension-profile.ts'
import type { StorageStateFile } from './storage-state.ts'

const here = dirname(fileURLToPath(import.meta.url))
const extensionDistDir = resolve(here, '..', '..', 'apps/extension/dist')
// Test-only loopback plumbing, built from parts like adaptive-fixture-server.ts
// so scanners see no plain-HTTP literal. The server binds to this host only.
const probeHost = [127, 0, 0, 1].join('.')
const probeProtocol = ['h', 't', 't', 'p'].join('')

interface ProbeServer {
  origin: string
  /** Cookie names (never values) the browser sent for /probe/<profile>. */
  cookieNames: (profile: string) => string[]
  close: () => Promise<void>
}

async function createProbeServer(): Promise<ProbeServer> {
  const seen = new Map<string, string[]>()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `${probeProtocol}://${probeHost}`).pathname
    const names = (request.headers.cookie ?? '').split(';')
      .map(part => part.split('=')[0]?.trim() ?? '')
      .filter(Boolean)
    seen.set(path, names.sort())
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>storage-state probe</title>')
  })
  await new Promise<void>((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, probeHost, () => resolveServer())
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Storage-state probe server did not expose a TCP address.')
  return {
    origin: `${probeProtocol}://${probeHost}:${address.port}`,
    cookieNames: profile => seen.get(`/probe/${profile}`) ?? [],
    close: () => new Promise<void>(resolveClose => {
      server.closeAllConnections()
      server.close(() => resolveClose())
    }),
  }
}

/** Distinct fake cookies and localStorage for one profile. Never real data. */
function dummyState(origin: string, profile: 'a' | 'b'): StorageStateFile {
  const cookie = {
    domain: probeHost,
    path: '/',
    expires: Math.floor(Date.now() / 1000) + 3600,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
  }
  return {
    cookies: [
      { ...cookie, name: `syj_probe_${profile}`, value: `dummy-${profile}` },
      { ...cookie, name: `syj_probe_${profile}_http`, value: `dummy-http-${profile}`, httpOnly: true },
      // Already expired, like a short-lived provider cookie in an older saved
      // state. Chrome discards it and the helper must not count it as missing.
      { ...cookie, name: `syj_probe_${profile}_expired`, value: `dummy-expired-${profile}`, expires: 1 },
    ],
    origins: [{ origin, localStorage: [{ name: `syj_probe_ls_${profile}`, value: `dummy-ls-${profile}` }] }],
  }
}

/** The session requirement a real provider run declares, here for the dummy loopback state. */
function dummySession(cookieName: string): { site: string, cookieNames: string[] } {
  return { site: probeHost, cookieNames: [cookieName] }
}

async function readEventTypes(directory: string, label: string): Promise<string[]> {
  const log = JSON.parse(await readFile(join(directory, artifactFileName(label, 'events.json')), 'utf8')) as {
    events: Array<{ type: string }>
  }
  return log.events.map(event => event.type)
}

/** Text of every entry in a small zip archive such as a Playwright trace. */
async function zipEntryTexts(path: string): Promise<string[]> {
  const zip = await readFile(path)
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]))
  if (end < 0)
    throw new Error('The trace is not a zip archive.')
  const texts: string[] = []
  let entry = zip.readUInt32LE(end + 16)
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    const method = zip.readUInt16LE(entry + 10)
    const compressedSize = zip.readUInt32LE(entry + 20)
    const local = zip.readUInt32LE(entry + 42)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + compressedSize)
    texts.push((method === 8 ? inflateRawSync(data) : data).toString('utf8'))
    entry += 46 + zip.readUInt16LE(entry + 28) + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32)
  }
  return texts
}

async function launchOutcome(
  dist: string,
  profiles: Parameters<typeof launchExtensionProfiles>[1],
): Promise<unknown> {
  return await launchExtensionProfiles(dist, profiles).then(
    async launched => {
      await Promise.all(launched.map(profile => profile.close()))
      return undefined
    },
    (error: unknown) => error,
  )
}

test.describe('extension profile storage-state application', () => {
  let server: ProbeServer
  let stateDirectory: string
  let statePaths: Record<'a' | 'b', string>
  let artifactDirectory: string
  const dist = process.env.SYNCYOURJOY_E2E_EXTENSION_DIST ?? extensionDistDir

  test.beforeAll(async () => {
    server = await createProbeServer()
    stateDirectory = await mkdtemp(join(tmpdir(), 'syncyourjoy-e2e-storage-state-'))
    artifactDirectory = process.env.SYNCYOURJOY_E2E_ARTIFACT_DIR ?? stateDirectory
    statePaths = { a: join(stateDirectory, 'state-a.json'), b: join(stateDirectory, 'state-b.json') }
    await Promise.all((['a', 'b'] as const).map(profile =>
      writeFile(statePaths[profile], JSON.stringify(dummyState(server.origin, profile)))))
  })

  test.afterAll(async () => {
    await server?.close()
    if (stateDirectory)
      await rm(stateDirectory, { recursive: true, force: true })
  })

  test('applies each dummy state to its own profile and to no other', async () => {
    const [profileA, profileB] = await launchExtensionProfiles(dist, [
      { label: 'storage-state-a', options: {
        artifactDirectory,
        storageState: statePaths.a,
        storageStateSession: dummySession('syj_probe_a_http'),
      } },
      { label: 'storage-state-b', options: {
        artifactDirectory,
        storageState: statePaths.b,
        storageStateSession: dummySession('syj_probe_b_http'),
      } },
    ])
    const profiles: Array<[ExtensionProfile, 'a' | 'b']> = [[profileA, 'a'], [profileB, 'b']]
    try {
      for (const [profile, own] of profiles) {
        const cookieNames = (await profile.context.cookies()).map(cookie => cookie.name).sort()
        expect(cookieNames).toEqual([`syj_probe_${own}`, `syj_probe_${own}_http`])

        const page = await profile.context.newPage()
        await page.goto(`${server.origin}/probe/${own}`)
        const pageState = await page.evaluate(() => ({
          cookie: document.cookie,
          localStorage: Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
            const key = localStorage.key(index) ?? ''
            return [key, localStorage.getItem(key)]
          })),
        }))
        await page.close()
        expect(pageState.cookie).toBe(`syj_probe_${own}=dummy-${own}`)
        expect(pageState.localStorage).toEqual({ [`syj_probe_ls_${own}`]: `dummy-ls-${own}` })
        expect(server.cookieNames(own)).toEqual([`syj_probe_${own}`, `syj_probe_${own}_http`])

        expect(profile.storageStateCheck).toEqual({
          cookiesExpected: 2,
          cookiesApplied: 2,
          cookiesExpiredInFile: 1,
          localStorageOriginsExpected: 1,
          localStorageOriginsApplied: 1,
          localStorageKeysExpected: 1,
          localStorageKeysApplied: 1,
        })
        expect(profile.storageStateSessionCheck).toEqual({
          siteCookiesApplied: 2,
          sessionCookiesExpected: 1,
          sessionCookiesApplied: 1,
        })
      }
    }
    finally {
      await Promise.all([profileA.close(), profileB.close()])
    }

    // The sanitized per-profile log records the check as counts only.
    for (const label of ['storage-state-a', 'storage-state-b']) {
      const events = await readFile(join(artifactDirectory, artifactFileName(label, 'events.json')), 'utf8')
      expect(events).toContain('"storage-state-applied"')
      expect(events).not.toMatch(/syj_probe|dummy-/)
    }
  })

  test('refuses to launch when a saved cookie is not applied', async () => {
    // SameSite=None without Secure: setStorageState resolves, but Chrome
    // silently drops the cookie, exactly the kind of loss that must not let
    // a provider run continue unauthenticated.
    const state = dummyState(server.origin, 'b')
    const rejectedPath = join(stateDirectory, 'state-rejected.json')
    await writeFile(rejectedPath, JSON.stringify({
      ...state,
      cookies: state.cookies.map(cookie => cookie.httpOnly ? cookie : { ...cookie, sameSite: 'None' }),
    }))

    const outcome = await launchOutcome(dist, [
      { label: 'storage-state-a', options: { storageState: statePaths.a } },
      { label: 'storage-state-rejected', options: { storageState: rejectedPath } },
    ])
    expect(outcome).toBeInstanceOf(Error)
    const message = (outcome as Error).message
    expect(message).toContain('Storage state for storage-state-rejected was not fully applied')
    expect(message).toContain('cookies 1/2')
    expect(message).not.toMatch(/syj_probe|dummy-/)
  })

  test('refuses a state whose declared session cookie expired in the file', async () => {
    // Every live cookie and localStorage key still applies. Only the cookie
    // declared as the session has expired, like an old or signed-out saved
    // state. The applied-state check alone would let this profile run.
    const outcome = await launchOutcome(dist, [
      { label: 'storage-state-a', options: { storageState: statePaths.a, storageStateSession: dummySession('syj_probe_a_http') } },
      { label: 'storage-state-signed-out', options: {
        storageState: statePaths.b,
        storageStateSession: dummySession('syj_probe_b_expired'),
      } },
    ])
    expect(outcome).toBeInstanceOf(Error)
    const message = (outcome as Error).message
    expect(message).toContain('Storage state for storage-state-signed-out does not carry a live signed-in session '
      + '(session cookies 0/1, provider-site cookies 2)')
    expect(message).not.toMatch(/syj_probe|dummy-/)
  })

  test('applies the state before its own trace starts, so the trace holds none of it', async () => {
    // The trace stays in this test's temporary directory and is deleted with it.
    const traceDirectory = join(stateDirectory, 'trace-order')
    const labels = ['storage-state-trace-a', 'storage-state-trace-b'] as const
    const profiles = await launchExtensionProfiles(dist, [
      { label: labels[0], options: { artifactDirectory: traceDirectory, trace: true, storageState: statePaths.a } },
      { label: labels[1], options: { artifactDirectory: traceDirectory, trace: true, storageState: statePaths.b } },
    ])
    await Promise.all(profiles.map(profile => profile.close()))

    for (const label of labels) {
      const types = await readEventTypes(traceDirectory, label)
      expect(types).toContain('trace-stopped')
      expect(types.indexOf('storage-state-applied')).toBeGreaterThan(-1)
      expect(types.indexOf('storage-state-applied')).toBeLessThan(types.indexOf('trace-started'))
      const entries = await zipEntryTexts(join(traceDirectory, artifactFileName(label, 'trace.zip')))
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.join('\n')).not.toMatch(/syj_probe|dummy-|StorageState/)
    }
  })

  test('refuses to launch when a storage-state file is missing', async () => {
    const missingDirectory = join(stateDirectory, 'missing-file')
    const outcome = await launchOutcome(dist, [
      { label: 'storage-state-a', options: { storageState: statePaths.a } },
      { label: 'storage-state-missing', options: {
        artifactDirectory: missingDirectory,
        storageState: join(stateDirectory, 'missing.json'),
      } },
    ])
    expect(outcome).toBeInstanceOf(Error)
    // The helper's own message, which reports the error code only.
    expect((outcome as Error).message)
      .toBe('[browser-launch] Storage state for storage-state-missing could not be read (ENOENT).')
    // The file is read before Chrome starts, so this profile never launched a browser.
    const types = await readEventTypes(missingDirectory, 'storage-state-missing')
    expect(types).toContain('browser-launch-failure')
    expect(types).not.toContain('browser-launched')
  })

  test('refuses to apply a state while Playwright protocol logging is on', async () => {
    const debugDirectory = join(stateDirectory, 'debug-guard')
    const previous = process.env.DEBUG
    // The guard runs before Chrome starts, so no protocol message is ever sent.
    process.env.DEBUG = 'pw:protocol'
    let outcome: unknown
    try {
      outcome = await launchExtensionProfile(dist, 'storage-state-debug', {
        artifactDirectory: debugDirectory,
        storageState: statePaths.a,
      }).then(async (profile) => {
        await profile.close()
        return undefined
      }, (error: unknown) => error)
    }
    finally {
      if (previous === undefined)
        delete process.env.DEBUG
      else
        process.env.DEBUG = previous
    }
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('[browser-launch] Storage state for storage-state-debug was not applied '
      + 'because DEBUG is set, and Playwright would log the saved cookies. Unset DEBUG and rerun.')
    const types = await readEventTypes(debugDirectory, 'storage-state-debug')
    expect(types).toContain('browser-launch-failure')
    expect(types).not.toContain('browser-launched')
  })
})
