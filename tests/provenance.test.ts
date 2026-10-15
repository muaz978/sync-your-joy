import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertExtensionBuilt,
  assertExtensionSourceRoot,
  buildExtensionAndRecordProvenance,
  collectProvenance,
  hashFiles,
  isCheckoutExtensionBuild,
  readSourceIdentity,
  resolveExtensionSourceRoot,
} from './e2e/provenance.ts'

// A run builds its extension from the current checkout, or from another one
// (a worktree of a release tag) when SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT is
// set. The provenance has to say which tree the extension came from, not
// attribute a release build to the checkout that supplied the coordinator.

function git(root: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

// A process started in a directory reports its realpath, and the system
// temporary directory is a symlink on macOS.
function realpathOf(path: string): string {
  return realpathSync(path)
}

function createRepo(root: string, files: Record<string, string>): void {
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'fixture')
}

// A build script that does what the real one is asked to: write an extension
// into SYNCYOURJOY_EXTENSION_OUTPUT_DIR. It records where and with what it was
// run, so a test can tell which tree's script ran and how.
function buildScript(label: string): string {
  return [
    `import { mkdirSync, writeFileSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `const out = process.env.SYNCYOURJOY_EXTENSION_OUTPUT_DIR`,
    `mkdirSync(out, { recursive: true })`,
    `writeFileSync(join(out, 'manifest.json'), JSON.stringify({ builtBy: ${JSON.stringify(label)}, cwd: process.cwd(), roomServerUrl: process.env.SYNCYOURJOY_ROOM_SERVER_URL }))`,
    '',
  ].join('\n')
}

describe('E2E provenance', () => {
  let base: string
  let checkout: string
  let release: string
  const roomServerUrl = 'ws://127.0.0.1:54321/rooms'

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'syj-provenance-'))
    checkout = join(base, 'checkout')
    release = join(base, 'release')
    createRepo(checkout, {
      'apps/room-service/src/server.ts': 'current coordinator\n',
      'apps/extension/static/manifest.json': '{"version":"0.2.7"}\n',
      'tests/e2e/pending-approval.spec.ts': 'current spec\n',
      'tests/e2e/playwright.config.ts': 'current config\n',
      'scripts/build-extension.mjs': buildScript('current'),
      'package.json': '{"version":"0.2.7"}\n',
      'package-lock.json': '{"lock":"current"}\n',
      'tsconfig.json': '{}\n',
      'vitest.config.ts': 'export default {}\n',
      'uno.config.mjs': 'export default {}\n',
    })
    // A release tag from before some of today's configuration files existed.
    createRepo(release, {
      'apps/room-service/src/server.ts': 'release coordinator\n',
      'apps/extension/static/manifest.json': '{"version":"0.2.6"}\n',
      'scripts/build-extension.mjs': buildScript('release'),
      'package.json': '{"version":"0.2.6"}\n',
      'package-lock.json': '{"lock":"release"}\n',
      'tsconfig.json': '{}\n',
      'vitest.config.ts': 'export default {}\n',
    })
    mkdirSync(join(checkout, 'test-results/e2e-run/extension'), { recursive: true })
    writeFileSync(join(checkout, 'test-results/e2e-run/extension/manifest.json'), '{"built":true}\n')
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const collect = (extensionSourceRoot: string) => collectProvenance({
    runId: 'e2e-run',
    createdAt: '2026-10-15T00:00:00.000Z',
    checkoutRoot: checkout,
    extensionSourceRoot,
    extensionDistDir: join(checkout, 'test-results/e2e-run/extension'),
    roomServerUrl,
  })

  describe('resolveExtensionSourceRoot', () => {
    it('is the checkout unless an override is given', () => {
      expect(resolveExtensionSourceRoot('/work/checkout', undefined)).toBe('/work/checkout')
      expect(resolveExtensionSourceRoot('/work/checkout', '')).toBe('/work/checkout')
      expect(resolveExtensionSourceRoot('/work/checkout', '/work/release')).toBe('/work/release')
    })
  })

  describe('assertExtensionSourceRoot', () => {
    it('accepts a checkout that has a build script', () => {
      expect(() => assertExtensionSourceRoot(release)).not.toThrow()
    })

    it('names the variable and the path when the directory does not exist', () => {
      const missing = join(base, 'no-such-checkout')
      expect(() => assertExtensionSourceRoot(missing)).toThrow(/SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT.*no-such-checkout.*does not exist/)
    })

    it('says what is missing when the directory is not a checkout of this repository', () => {
      const empty = join(base, 'empty-dir')
      mkdirSync(empty)
      expect(() => assertExtensionSourceRoot(empty)).toThrow(/no scripts\/build-extension\.mjs/)
    })

    it('names the variable, before anything is built, when the tree is an export with no git history', () => {
      // `git archive v0.2.6 | tar -x`: it has the build script, so it passed
      // the check above, was built in full, and then failed on `git ls-files`
      // with an error that does not mention the variable.
      const exported = join(base, 'exported-tag')
      mkdirSync(join(exported, 'scripts'), { recursive: true })
      writeFileSync(join(exported, 'scripts/build-extension.mjs'), buildScript('exported'))

      expect(() => assertExtensionSourceRoot(exported)).toThrow(/SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT.*exported-tag.*git/s)
    })
  })

  describe('assertExtensionBuilt', () => {
    it('accepts a build that wrote a manifest into the run directory', () => {
      expect(() => assertExtensionBuilt(join(checkout, 'test-results/e2e-run/extension'), release)).not.toThrow()
    })

    it('explains a build that ignored the output directory, as v0.2.4 and earlier do', () => {
      const dist = join(base, 'never-written')
      mkdirSync(dist)
      expect(() => assertExtensionBuilt(dist, release)).toThrow(/did not write .*manifest\.json.*v0\.2\.4 and earlier.*v0\.2\.5 and later/s)
    })
  })

  describe('hashFiles', () => {
    it('keeps hashing a sorted list of paths and contents the way provenance always has', async () => {
      const files = join(base, 'hash-input')
      mkdirSync(join(files, 'b'), { recursive: true })
      writeFileSync(join(files, 'a.txt'), 'alpha\n')
      writeFileSync(join(files, 'b/c.txt'), 'beta\n')
      // Independently computed: sha256 over "a.txt\0alpha\n" then "b/c.txt\0beta\n".
      const expected = '922e353a160a731f4eae43509456030f6dd4a474257304580e349d9e94567d96'
      expect(await hashFiles(files, ['b/c.txt', 'a.txt'])).toBe(expected)
    })
  })

  describe('readSourceIdentity', () => {
    it('reports the commit and tree of the tree it is given, not of the process working directory', async () => {
      const identity = await readSourceIdentity(release)
      expect(identity.commit).toBe(git(release, 'rev-parse', 'HEAD'))
      expect(identity.tree).toBe(git(release, 'rev-parse', 'HEAD^{tree}'))
      expect(identity.commit).not.toBe(git(checkout, 'rev-parse', 'HEAD'))
    })

    it('hashes the tracked source, lockfile and configuration of that tree', async () => {
      const current = await readSourceIdentity(checkout)
      const shipped = await readSourceIdentity(release)

      expect(current.trackedSourceSha256).toBe(await hashFiles(checkout, [
        'apps/extension/static/manifest.json',
        'apps/room-service/src/server.ts',
        'scripts/build-extension.mjs',
        'tests/e2e/pending-approval.spec.ts',
        'tests/e2e/playwright.config.ts',
      ]))
      expect(current.packageLockSha256).toBe(await hashFiles(checkout, ['package-lock.json']))
      expect(shipped.trackedSourceSha256).not.toBe(current.trackedSourceSha256)
      expect(shipped.packageLockSha256).not.toBe(current.packageLockSha256)
      expect(shipped.config.sha256).not.toBe(current.config.sha256)
    })

    it('lists the configuration files a tree has and says which it lacks', async () => {
      const current = await readSourceIdentity(checkout)
      expect(current.config.files).toHaveLength(7)
      expect(current.config).not.toHaveProperty('missing')

      const shipped = await readSourceIdentity(release)
      expect(shipped.config.missing).toEqual(['uno.config.mjs', 'tests/e2e/playwright.config.ts'])
      expect(shipped.config.files).not.toContain('uno.config.mjs')
      expect(shipped.config.files).toContain('package.json')
    })
  })

  describe('collectProvenance', () => {
    it('with no override, keeps the existing fields and repeats the checkout under extensionSource', async () => {
      const record = await collect(checkout)
      const identity = await readSourceIdentity(checkout)

      expect(Object.keys(record)).toEqual(['schemaVersion', 'runId', 'createdAt', 'source', 'lock', 'config', 'e2e', 'extensionSource'])
      expect(record.schemaVersion).toBe(1)
      expect(record.runId).toBe('e2e-run')
      expect(record.source).toEqual({
        commit: identity.commit,
        tree: identity.tree,
        trackedSourceSha256: identity.trackedSourceSha256,
      })
      expect(record.lock).toEqual({ packageLockSha256: identity.packageLockSha256 })
      expect(Object.keys(record.config)).toEqual(['files', 'sha256'])
      expect(record.e2e.roomServerOrigin).toBe('ws://127.0.0.1:54321')
      expect(record.e2e.extensionOutput).toBe(join('test-results', 'e2e-run', 'extension'))
      expect(Object.keys(record.e2e)).toEqual(['roomServerOrigin', 'extensionOutput', 'extensionManifestSha256'])
      // The path as given, a NUL, then the manifest the build wrote.
      const manifestPath = join(checkout, 'test-results/e2e-run/extension/manifest.json')
      expect(record.e2e.extensionManifestSha256).toBe(
        createHash('sha256').update(manifestPath).update('\0').update(readFileSync(manifestPath)).digest('hex'),
      )
      expect(record.extensionSource).toEqual({
        root: '.',
        sameAsCheckout: true,
        commit: identity.commit,
        tree: identity.tree,
        trackedSourceSha256: identity.trackedSourceSha256,
        packageLockSha256: identity.packageLockSha256,
        config: identity.config,
      })
    })

    it('identifies the tree the extension was built from, separately from the checkout', async () => {
      const record = await collect(release)
      const current = await readSourceIdentity(checkout)
      const shipped = await readSourceIdentity(release)

      // The checkout supplied the coordinator and the specs.
      expect(record.source.commit).toBe(current.commit)
      expect(record.source.tree).toBe(current.tree)
      expect(record.source.trackedSourceSha256).toBe(current.trackedSourceSha256)
      expect(record.lock.packageLockSha256).toBe(current.packageLockSha256)
      expect(record.config).toEqual(current.config)

      // The extension came from the release tree.
      expect(record.extensionSource.sameAsCheckout).toBe(false)
      expect(record.extensionSource.root).toBe(join('..', 'release'))
      expect(record.extensionSource.commit).toBe(shipped.commit)
      expect(record.extensionSource.tree).toBe(shipped.tree)
      expect(record.extensionSource.trackedSourceSha256).toBe(shipped.trackedSourceSha256)
      expect(record.extensionSource.packageLockSha256).toBe(shipped.packageLockSha256)
      expect(record.extensionSource.config).toEqual(shipped.config)
      expect(record.extensionSource.commit).not.toBe(record.source.commit)
    })

    it('does not depend on where the extension tree lives for the fields that are not about it', async () => {
      const here = await collect(checkout)
      const there = await collect(release)
      expect(there.e2e).toEqual(here.e2e)
      expect(there.source).toEqual(here.source)
      expect(resolve(checkout, there.extensionSource.root)).toBe(release)
    })
  })

  describe('buildExtensionAndRecordProvenance', () => {
    const run = (name: string, override: string | undefined) => {
      const extensionDistDir = join(base, name, 'extension')
      return {
        extensionDistDir,
        built: buildExtensionAndRecordProvenance({
          runId: name,
          createdAt: '2026-10-15T00:00:00.000Z',
          checkoutRoot: checkout,
          extensionSourceOverride: override,
          extensionDistDir,
          roomServerUrl,
          env: { ...process.env, SYNCYOURJOY_E2E_TEST_MODE: '1' },
          stdio: 'ignore',
          log: () => undefined,
        }),
      }
    }
    const builtManifest = (extensionDistDir: string) => JSON.parse(readFileSync(join(extensionDistDir, 'manifest.json'), 'utf8')) as Record<string, string>

    it('builds the checkout\'s extension, and records the checkout as its source, when no override is given', async () => {
      const { extensionDistDir, built } = run('build-checkout', undefined)
      const record = await built

      expect(builtManifest(extensionDistDir)).toEqual({ builtBy: 'current', cwd: realpathOf(checkout), roomServerUrl })
      expect(record.extensionSource.sameAsCheckout).toBe(true)
      expect(record.extensionSource.root).toBe('.')
      expect(record.extensionSource.commit).toBe(git(checkout, 'rev-parse', 'HEAD'))
    })

    it('builds the other tree\'s extension, in that tree, and records that tree as its source, with an override', async () => {
      const { extensionDistDir, built } = run('build-release', release)
      const record = await built

      expect(builtManifest(extensionDistDir)).toEqual({ builtBy: 'release', cwd: realpathOf(release), roomServerUrl })
      expect(record.extensionSource.sameAsCheckout).toBe(false)
      expect(record.extensionSource.commit).toBe(git(release, 'rev-parse', 'HEAD'))
      expect(record.source.commit).toBe(git(checkout, 'rev-parse', 'HEAD'))
      // The manifest recorded is the one this build wrote.
      const manifestPath = join(extensionDistDir, 'manifest.json')
      expect(record.e2e.extensionManifestSha256).toBe(
        createHash('sha256').update(manifestPath).update('\0').update(readFileSync(manifestPath)).digest('hex'),
      )
    })

    it('stops with the variable\'s name, and builds nothing, when the override does not exist', async () => {
      const { extensionDistDir, built } = run('build-missing', join(base, 'no-such-checkout'))

      await expect(built).rejects.toThrow(/SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT.*does not exist/)
      expect(existsSync(join(extensionDistDir, 'manifest.json'))).toBe(false)
    })

    it('stops with the variable\'s name, and builds nothing, when the override is an export with no git history', async () => {
      const { extensionDistDir, built } = run('build-exported', join(base, 'exported-tag'))

      await expect(built).rejects.toThrow(/SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT.*git/s)
      expect(existsSync(join(extensionDistDir, 'manifest.json'))).toBe(false)
    })

    it('says so when the build wrote its extension somewhere other than the run\'s directory', async () => {
      // A script that predates SYNCYOURJOY_EXTENSION_OUTPUT_DIR.
      const old = join(base, 'old-release')
      createRepo(old, { 'scripts/build-extension.mjs': 'export {}\n', 'package.json': '{}\n' })

      const { built } = run('build-old', old)

      await expect(built).rejects.toThrow(/did not write .*manifest\.json.*v0\.2\.4 and earlier/s)
    })
  })

  describe('isCheckoutExtensionBuild', () => {
    const provenanceIn = (name: string, extensionSource: unknown) => {
      const directory = join(base, name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ extensionSource }))
      return directory
    }

    it('is true for a run that built the checkout\'s own extension', () => {
      expect(isCheckoutExtensionBuild(provenanceIn('prov-same', { sameAsCheckout: true }))).toBe(true)
    })

    it('is false for a run that built another tree\'s extension', () => {
      expect(isCheckoutExtensionBuild(provenanceIn('prov-other', { sameAsCheckout: false }))).toBe(false)
    })

    it('does not claim a different build when there is nothing recorded to say so', () => {
      expect(isCheckoutExtensionBuild(undefined)).toBe(true)
      expect(isCheckoutExtensionBuild(join(base, 'no-provenance-here'))).toBe(true)
    })
  })
})
