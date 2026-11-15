// Decides which directories the E2E harness and the extension build may write
// to and delete. Kept free of the build and of Playwright so it can be unit
// tested (tests/output-directory-guard.test.ts) and shared by
// tests/e2e/playwright.config.ts, tests/e2e/global-setup.ts,
// tests/e2e/artifact-reporter.ts and scripts/build-extension.mjs.
//
// Two different questions are answered here:
//
//   - Where may an E2E run keep its output? Playwright empties its output
//     directory when a run starts and the build removes `<output>/extension`,
//     so SYNCYOURJOY_E2E_OUTPUT_DIR may only name a directory that belongs to
//     test output: below `<repo>/test-results`, or below the OS temporary
//     directory. Anything else is refused, including the release directory.
//   - Where may the extension build delete and rebuild? The build is also how
//     releases are made, into apps/extension/dist, so it only refuses a
//     directory that is clearly dangerous: the filesystem root, the home
//     directory, the repository or one of its ancestors, .git, node_modules,
//     apps, packages, or the build's own inputs.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const E2E_OUTPUT_ENV = 'SYNCYOURJOY_E2E_OUTPUT_DIR'

/** The release output, relative to the repository root. */
export const RELEASE_DIRECTORY = join('apps', 'extension', 'dist')

/**
 * The real path of `path`. For a path that does not exist (yet) it is the real
 * path of its nearest existing ancestor followed by the missing part, so a
 * symlink in the existing part cannot be used to point somewhere else.
 */
export function canonicalPath(path) {
  const absolute = resolve(path)
  const missing = []
  let current = absolute
  for (;;) {
    try {
      return missing.length === 0 ? realpathSync(current) : join(realpathSync(current), ...missing.reverse())
    }
    catch {
      const parent = dirname(current)
      if (parent === current)
        return absolute
      missing.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
}

/** Whether `child` is `parent` or below it. Both have to be canonical. */
function isSameOrInside(parent, child) {
  const relation = relative(parent, child)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

function isFilesystemRoot(path) {
  return dirname(path) === path
}

/**
 * A directory name for a run that cannot collide with another run: the time,
 * the process and a random UUID. This is the default and is not changed by the
 * guard.
 */
export function defaultE2EOutputDirectory(repoRoot, { now = Date.now(), pid = process.pid, uuid = randomUUID() } = {}) {
  return resolve(repoRoot, 'test-results', `e2e-${now}-${pid}-${uuid}`)
}

function refuse(label, directory, reason) {
  return new Error(`${label}=${directory} is refused: ${reason}`)
}

/**
 * Returns the absolute E2E output directory, or throws a message that names
 * the variable and the reason.
 *
 * Allowed: a directory strictly below `<repo>/test-results` or strictly below
 * the OS temporary directory. Anything inside the repository but outside
 * test-results is refused, so the release directory, source directories and
 * .git can never be named; so are the repository root, any ancestor of it, the
 * home directory and the filesystem root.
 */
export function assertSafeE2EOutputDirectory(directory, { repoRoot, homeDirectory = homedir(), tempDirectory = tmpdir(), label = E2E_OUTPUT_ENV } = {}) {
  if (typeof directory !== 'string' || directory.trim() === '')
    throw new Error(`${label} is set but empty. Unset it to get a unique directory under test-results, or name a directory below test-results or the system temporary directory.`)
  if (!repoRoot)
    throw new Error('assertSafeE2EOutputDirectory needs the repository root.')

  const target = canonicalPath(directory)
  const repo = canonicalPath(repoRoot)
  const home = canonicalPath(homeDirectory)
  const temp = canonicalPath(tempDirectory)
  const results = join(repo, 'test-results')

  if (isFilesystemRoot(target))
    throw refuse(label, target, 'it is the filesystem root.')
  if (target === home)
    throw refuse(label, target, 'it is the home directory.')
  if (target === repo)
    throw refuse(label, target, 'it is the repository root.')
  if (isSameOrInside(target, repo))
    throw refuse(label, target, 'it contains the repository.')
  if (isSameOrInside(join(repo, RELEASE_DIRECTORY), target))
    throw refuse(label, target, `it is the release output (${RELEASE_DIRECTORY}), which a test build must never replace.`)
  if (isSameOrInside(target, home))
    throw refuse(label, target, 'it contains the home directory.')
  if (isSameOrInside(repo, target)) {
    if (target === results || !isSameOrInside(results, target))
      throw refuse(label, target, 'inside the repository only a directory below test-results is allowed.')
    return resolve(directory)
  }
  if (target !== temp && isSameOrInside(temp, target))
    return resolve(directory)
  throw refuse(label, target, 'it is outside the allowed locations (a directory below test-results in the repository, or below the system temporary directory).')
}

/**
 * The directory an E2E run writes to: SYNCYOURJOY_E2E_OUTPUT_DIR after the
 * guard, or, with no override, a new unique directory under test-results
 * exactly as before. `overridden` says which of the two it is.
 */
export function resolveE2EOutputDirectory({ env = process.env, repoRoot, fallbackDirectory, ...options }) {
  const override = env[E2E_OUTPUT_ENV]
  if (override === undefined) {
    return { directory: fallbackDirectory ?? defaultE2EOutputDirectory(repoRoot, options), overridden: false }
  }
  return { directory: assertSafeE2EOutputDirectory(override, { repoRoot, ...options }), overridden: true }
}

/**
 * Throws for an extension build output that would delete something it must
 * not. Unlike the E2E guard this accepts any other directory, because the
 * default output is the release directory and a build may be pointed at an
 * ordinary scratch directory.
 */
export function assertSafeBuildOutputDirectory(directory, { repoRoot, homeDirectory = homedir(), label = 'SYNCYOURJOY_EXTENSION_OUTPUT_DIR' } = {}) {
  if (typeof directory !== 'string' || directory.trim() === '')
    throw new Error(`${label} is set but empty.`)
  if (!repoRoot)
    throw new Error('assertSafeBuildOutputDirectory needs the repository root.')

  const target = canonicalPath(directory)
  const repo = canonicalPath(repoRoot)
  const home = canonicalPath(homeDirectory)

  if (isFilesystemRoot(target))
    throw refuse(label, target, 'it is the filesystem root.')
  if (target === home)
    throw refuse(label, target, 'it is the home directory.')
  if (isSameOrInside(target, home))
    throw refuse(label, target, 'it contains the home directory.')
  if (target === repo)
    throw refuse(label, target, 'it is the repository root.')
  if (isSameOrInside(target, repo))
    throw refuse(label, target, 'it contains the repository.')

  for (const protectedName of ['.git', 'node_modules']) {
    if (isSameOrInside(join(repo, protectedName), target))
      throw refuse(label, target, `it is ${protectedName} or inside it.`)
  }
  for (const protectedName of ['apps', 'packages']) {
    if (target === join(repo, protectedName))
      throw refuse(label, target, `it is the ${protectedName} directory.`)
  }
  // The build deletes its output before it reads these.
  for (const input of [join('apps', 'extension', 'src'), join('apps', 'extension', 'static')]) {
    const inputPath = join(repo, input)
    if (isSameOrInside(inputPath, target) || isSameOrInside(target, inputPath))
      throw refuse(label, target, `it is, contains or is inside the build input ${input}.`)
  }
  return resolve(directory)
}
