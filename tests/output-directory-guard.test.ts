import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  assertSafeBuildOutputDirectory,
  assertSafeE2EOutputDirectory,
  defaultE2EOutputDirectory,
  resolveE2EOutputDirectory,
} from '../scripts/output-directory-guard.mjs'

// The E2E harness lets a run's output directory be overridden with
// SYNCYOURJOY_E2E_OUTPUT_DIR. Playwright empties that directory and the build
// deletes `<output>/extension`, so the guard decides what may be named. The
// extension build has its own, narrower guard because the release is made with
// it, into apps/extension/dist.

const realRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('output directory guard', () => {
  let base: string
  let repo: string
  let home: string
  let temp: string
  let elsewhere: string

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'syj-guard-'))
    repo = join(base, 'work', 'repo')
    home = join(base, 'home')
    temp = join(base, 'tmp')
    elsewhere = join(base, 'elsewhere')
    for (const directory of [
      'apps/extension/src',
      'apps/extension/static',
      'apps/extension/dist',
      'packages/protocol',
      'node_modules/esbuild',
      '.git/hooks',
      'test-results',
    ])
      mkdirSync(join(repo, directory), { recursive: true })
    for (const directory of [home, temp, elsewhere])
      mkdirSync(directory, { recursive: true })
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const e2e = (directory: string) => assertSafeE2EOutputDirectory(directory, { repoRoot: repo, homeDirectory: home, tempDirectory: temp })
  const build = (directory: string) => assertSafeBuildOutputDirectory(directory, { repoRoot: repo, homeDirectory: home })

  describe('E2E output directory', () => {
    it('accepts a directory below the repository\'s test-results, existing or not', () => {
      const run = join(repo, 'test-results', 'e2e-1-2-abc')
      expect(e2e(run)).toBe(run)
      mkdirSync(run, { recursive: true })
      expect(e2e(run)).toBe(run)
      expect(e2e(join(run, 'extension'))).toBe(join(run, 'extension'))
    })

    it('accepts a directory below the system temporary directory', () => {
      const run = join(temp, 'my-run')
      expect(e2e(run)).toBe(run)
    })

    it('resolves a relative override against the working directory', () => {
      const target = join(temp, 'relative-run')
      expect(e2e(relative(process.cwd(), target))).toBe(target)
    })

    it.each([
      ['the release output', () => join(repo, 'apps/extension/dist'), /release output/],
      ['a directory inside the release output', () => join(repo, 'apps/extension/dist/inner'), /release output/],
      ['the repository root', () => repo, /repository root/],
      ['the parent of the repository', () => dirname(repo), /contains the repository/],
      ['the grandparent of the repository', () => base, /contains the repository/],
      ['the filesystem root', () => resolve('/'), /filesystem root/],
      ['the home directory', () => home, /home directory/],
      ['an ancestor of the home directory', () => dirname(home), /contains the home directory|contains the repository/],
      ['test-results itself, which Playwright would empty', () => join(repo, 'test-results'), /only a directory below test-results/],
      ['the system temporary directory itself', () => temp, /outside the allowed locations/],
      ['a source directory in the repository', () => join(repo, 'apps/extension/src'), /only a directory below test-results/],
      ['apps', () => join(repo, 'apps'), /only a directory below test-results/],
      ['.git', () => join(repo, '.git'), /only a directory below test-results/],
      ['node_modules', () => join(repo, 'node_modules'), /only a directory below test-results/],
      ['a directory outside the repository, the temp directory and home', () => elsewhere, /outside the allowed locations/],
      ['a sibling of test-results with the same prefix', () => join(repo, 'test-results-old'), /only a directory below test-results/],
    ])('refuses %s', (_name, directory, reason) => {
      expect(() => e2e(directory())).toThrow(reason)
      expect(() => e2e(directory())).toThrow(/^SYNCYOURJOY_E2E_OUTPUT_DIR=/)
    })

    it('refuses a path that leaves test-results through a symlink', () => {
      symlinkSync(elsewhere, join(repo, 'test-results', 'escape'))
      expect(() => e2e(join(repo, 'test-results', 'escape', 'run'))).toThrow(/outside the allowed locations/)
    })

    it('refuses a path that reaches the release output through a symlink', () => {
      symlinkSync(join(repo, 'apps/extension/dist'), join(temp, 'to-release'))
      expect(() => e2e(join(temp, 'to-release'))).toThrow(/release output/)
    })

    it('refuses a path that climbs out of test-results with ..', () => {
      expect(() => e2e(join(repo, 'test-results', '..', 'apps', 'extension', 'dist'))).toThrow(/release output/)
    })

    it('refuses an empty override rather than reading it as the working directory', () => {
      expect(() => e2e('')).toThrow(/SYNCYOURJOY_E2E_OUTPUT_DIR is set but empty/)
      expect(() => e2e('   ')).toThrow(/is set but empty/)
    })
  })

  describe('E2E output directory with a home directory below the temporary directory', () => {
    // The home directory is neither the repository nor outside the allowed
    // locations here, so only the two home checks can refuse it.
    let tempHome: string

    beforeAll(() => {
      tempHome = join(temp, 'users', 'me')
      mkdirSync(tempHome, { recursive: true })
    })

    const e2eWithTempHome = (directory: string) => assertSafeE2EOutputDirectory(directory, { repoRoot: repo, homeDirectory: tempHome, tempDirectory: temp })

    it('refuses the home directory and says that it is the home directory', () => {
      expect(() => e2eWithTempHome(tempHome)).toThrow(/it is the home directory/)
    })

    it('refuses the parent of the home directory and says that it contains the home directory', () => {
      expect(() => e2eWithTempHome(dirname(tempHome))).toThrow(/it contains the home directory/)
    })

    it('still accepts a directory next to the home directory and one inside it', () => {
      expect(e2eWithTempHome(join(temp, 'run'))).toBe(join(temp, 'run'))
      expect(e2eWithTempHome(join(tempHome, 'run'))).toBe(join(tempHome, 'run'))
    })
  })

  describe('default E2E output directory', () => {
    it('is the same unique directory under test-results as before the guard', () => {
      expect(defaultE2EOutputDirectory(repo, { now: 1760000000000, pid: 4242, uuid: '11111111-2222-3333-4444-555555555555' }))
        .toBe(join(repo, 'test-results', 'e2e-1760000000000-4242-11111111-2222-3333-4444-555555555555'))
    })

    it('is what a run gets with no override, and passes the guard', () => {
      const resolved = resolveE2EOutputDirectory({ env: {}, repoRoot: repo, homeDirectory: home, tempDirectory: temp })
      expect(resolved.overridden).toBe(false)
      expect(resolved.directory.startsWith(`${join(repo, 'test-results')}/e2e-`)).toBe(true)
      expect(e2e(resolved.directory)).toBe(resolved.directory)
    })

    it('differs between two runs, even in the same millisecond of the same process', () => {
      const first = resolveE2EOutputDirectory({ env: {}, repoRoot: repo }).directory
      const second = resolveE2EOutputDirectory({ env: {}, repoRoot: repo }).directory
      expect(first).not.toBe(second)

      const fixed = { now: 1760000000000, pid: 4242 }
      expect(defaultE2EOutputDirectory(repo, fixed)).not.toBe(defaultE2EOutputDirectory(repo, fixed))
      expect(new Set(Array.from({ length: 200 }, () => defaultE2EOutputDirectory(repo))).size).toBe(200)
    })

    it('uses a fallback directory when it is given and nothing is overridden', () => {
      const fallback = join(repo, 'test-results', 'e2e-fallback-1')
      expect(resolveE2EOutputDirectory({ env: {}, repoRoot: repo, fallbackDirectory: fallback }))
        .toEqual({ directory: fallback, overridden: false })
    })
  })

  describe('resolveE2EOutputDirectory with an override', () => {
    it('returns the override after the guard', () => {
      const run = join(temp, 'override-run')
      expect(resolveE2EOutputDirectory({
        env: { SYNCYOURJOY_E2E_OUTPUT_DIR: run },
        repoRoot: repo,
        homeDirectory: home,
        tempDirectory: temp,
      })).toEqual({ directory: run, overridden: true })
    })

    it('refuses an empty or blank override instead of using the default', () => {
      for (const value of ['', '   ', '\t\n']) {
        expect(() => resolveE2EOutputDirectory({ env: { SYNCYOURJOY_E2E_OUTPUT_DIR: value }, repoRoot: repo, homeDirectory: home, tempDirectory: temp }))
          .toThrow(/SYNCYOURJOY_E2E_OUTPUT_DIR is set but empty/)
      }
    })

    it('throws for an override the guard refuses', () => {
      expect(() => resolveE2EOutputDirectory({
        env: { SYNCYOURJOY_E2E_OUTPUT_DIR: join(repo, 'apps/extension/dist') },
        repoRoot: repo,
        homeDirectory: home,
        tempDirectory: temp,
      })).toThrow(/release output/)
    })
  })

  describe('extension build output directory', () => {
    it('accepts the release directory, the Firefox build\'s directory and ordinary scratch directories', () => {
      expect(build(join(repo, 'apps/extension/dist'))).toBe(join(repo, 'apps/extension/dist'))
      expect(build(join(repo, 'test-results/e2e-1/extension'))).toBe(join(repo, 'test-results/e2e-1/extension'))
      expect(build(join(temp, 'scratch'))).toBe(join(temp, 'scratch'))
      expect(build(join(repo, 'release-staging'))).toBe(join(repo, 'release-staging'))
    })

    it.each([
      ['the filesystem root', () => resolve('/'), /filesystem root/],
      ['the home directory', () => home, /home directory/],
      ['an ancestor of the home directory', () => dirname(home), /contains the home directory/],
      ['the repository root', () => repo, /repository root/],
      ['the parent of the repository', () => dirname(repo), /contains the repository/],
      ['.git', () => join(repo, '.git'), /\.git/],
      ['a directory inside .git', () => join(repo, '.git/hooks'), /\.git/],
      ['node_modules', () => join(repo, 'node_modules'), /node_modules/],
      ['a directory inside node_modules', () => join(repo, 'node_modules/esbuild'), /node_modules/],
      ['apps', () => join(repo, 'apps'), /apps directory/],
      ['packages', () => join(repo, 'packages'), /packages directory/],
      ['the extension directory, which holds the sources', () => join(repo, 'apps/extension'), /build input/],
      ['the extension sources', () => join(repo, 'apps/extension/src'), /build input/],
      ['a directory inside the extension sources', () => join(repo, 'apps/extension/src/nested'), /build input/],
      ['the static files', () => join(repo, 'apps/extension/static'), /build input/],
    ])('refuses %s', (_name, directory, reason) => {
      expect(() => build(directory())).toThrow(reason)
      expect(() => build(directory())).toThrow(/^SYNCYOURJOY_EXTENSION_OUTPUT_DIR=/)
    })

    it('refuses a symlink that points at the repository', () => {
      symlinkSync(repo, join(temp, 'to-repo'))
      expect(() => build(join(temp, 'to-repo'))).toThrow(/repository root/)
    })
  })

  describe('how the E2E configuration and setup use the guard', () => {
    // Playwright cannot start here, so the files that call the guard are read
    // as source: the repository root they pass is two levels above tests/e2e,
    // and nothing else decides the output directory.
    const read = (path: string) => readFileSync(join(realRoot, path), 'utf8')
    const repoRootFromHere = /const here = dirname\(fileURLToPath\(import\.meta\.url\)\)\nconst repoRoot = resolve\(here, '\.\.', '\.\.'\)/

    it('has tests/e2e/playwright.config.ts resolve its output directory through the guard from the repository root', () => {
      const source = read('tests/e2e/playwright.config.ts')
      expect(source).toContain('../../scripts/output-directory-guard.mjs')
      expect(source).toMatch(repoRootFromHere)
      expect(source).toContain('const { directory: outputDirectory } = resolveE2EOutputDirectory({ env: process.env, repoRoot })')
      expect(source).toContain('outputDir: outputDirectory,')
      expect(source).toContain('process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = outputDirectory')
      expect(source).not.toMatch(/outputDir:\s*process\.env/)
    })

    it('has tests/e2e/global-setup.ts resolve its output directory through the guard from the repository root', () => {
      const source = read('tests/e2e/global-setup.ts')
      expect(source).toContain('../../scripts/output-directory-guard.mjs')
      expect(source).toMatch(repoRootFromHere)
      expect(source).toMatch(/const \{ directory: artifactDirectory \} = resolveE2EOutputDirectory\(\{\n\s+env: process\.env,\n\s+repoRoot,\n/)
      expect(source).not.toMatch(/artifactDirectory\s*=\s*process\.env/)
      expect(source.indexOf('resolveE2EOutputDirectory({')).toBeLessThan(source.indexOf('mkdir(artifactDirectory'))
    })

    it('has tests/e2e/global-setup.ts mask the repository root in setup-failure.json', () => {
      const source = read('tests/e2e/global-setup.ts')
      expect(source).toContain('error: sanitizeError(error, { repositoryRoot: repoRoot }),')
    })

    it('has tests/e2e/artifact-reporter.ts give a project directory precedence over a guarded environment value', () => {
      const source = read('tests/e2e/artifact-reporter.ts')
      expect(source).toMatch(/config\.projects\[0\]\?\.outputDir\n\s+\?\? \(override === undefined \? undefined : assertSafeE2EOutputDirectory\(override, \{ repoRoot \}\)\)/)
      expect(source).toContain('const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), \'..\', \'..\')')
    })
  })

  describe('scripts/build-extension.mjs', () => {
    it('calls the guard before it deletes anything', () => {
      const source = readFileSync(join(realRoot, 'scripts/build-extension.mjs'), 'utf8')
      const guardCall = source.indexOf('assertSafeBuildOutputDirectory(outputDirectory')
      expect(source).toContain('./output-directory-guard.mjs')
      expect(guardCall).toBeGreaterThan(-1)
      expect(guardCall).toBeLessThan(source.indexOf('await rm(outputDirectory'))
    })

    it('passes the repository root, one level above scripts, to the guard', () => {
      const source = readFileSync(join(realRoot, 'scripts/build-extension.mjs'), 'utf8')
      expect(source).toContain('const root = resolve(scriptDirectory, \'..\')')
      expect(source).toContain('assertSafeBuildOutputDirectory(outputDirectory, { repoRoot: root })')
    })

    it('exits with the reason and deletes nothing when the output is the repository, run in a throwaway copy', () => {
      // A copy of the script and the guard in a repository of its own, so that a
      // regression deletes this directory and nothing else.
      const fake = join(base, 'fake-repo')
      mkdirSync(join(fake, 'scripts'), { recursive: true })
      mkdirSync(join(fake, 'apps/extension/src'), { recursive: true })
      writeFileSync(join(fake, 'apps/extension/src/marker.ts'), 'export {}\n')
      writeFileSync(join(fake, 'uno.config.mjs'), 'export default {}\n')
      cpSync(join(realRoot, 'scripts/build-extension.mjs'), join(fake, 'scripts/build-extension.mjs'))
      cpSync(join(realRoot, 'scripts/output-directory-guard.mjs'), join(fake, 'scripts/output-directory-guard.mjs'))
      symlinkSync(join(realRoot, 'node_modules'), join(fake, 'node_modules'))

      for (const output of ['.', 'apps/extension/src', '..']) {
        const outcome = spawnSync(process.execPath, [join(fake, 'scripts/build-extension.mjs')], {
          cwd: fake,
          env: { ...process.env, SYNCYOURJOY_EXTENSION_OUTPUT_DIR: output },
          encoding: 'utf8',
        })
        expect(outcome.status).toBe(1)
        expect(outcome.stderr).toMatch(/^SYNCYOURJOY_EXTENSION_OUTPUT_DIR=.* is refused: /)
        expect(existsSync(join(fake, 'apps/extension/src/marker.ts'))).toBe(true)
      }
    })
  })
})
