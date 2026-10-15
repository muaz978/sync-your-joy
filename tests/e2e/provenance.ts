// What a run's provenance.json records, kept out of tests/e2e/global-setup.ts
// so it can be unit tested (tests/provenance.test.ts).
//
// Two trees are involved in a run, and they are not always the same one:
//
//   - the checkout, which supplies the coordinator (apps/room-service) and
//     the specs, and
//   - the extension source, which is what the extension bundle was built
//     from. It is the checkout unless SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT
//     names another one (for example a worktree of a release tag), which is
//     how a shipped extension is checked against the current coordinator.
//
// `source`, `lock` and `config` describe the checkout, as they always have.
// `extensionSource` describes the tree the extension was built from, so
// evidence for a run against a release build is not attributed to whatever
// the current checkout happens to be. It carries the same values as the
// checkout's when the two are the same tree.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const SOURCE_FILE_PATTERN = /^(apps|packages|scripts|tests|fixtures)\//

export const CONFIG_FILES = [
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'uno.config.mjs',
  'scripts/build-extension.mjs',
  'tests/e2e/playwright.config.ts',
  'apps/extension/static/manifest.json',
] as const

export interface ConfigIdentity {
  files: string[]
  sha256: string
  /** Configuration files this tree does not have (an older release may lack some). */
  missing?: string[]
}

export interface SourceIdentity {
  commit: string
  tree: string
  trackedSourceSha256: string
  packageLockSha256: string
  config: ConfigIdentity
}

export interface ProvenanceRecord {
  schemaVersion: 1
  runId: string
  createdAt: string
  source: { commit: string, tree: string, trackedSourceSha256: string }
  lock: { packageLockSha256: string }
  config: ConfigIdentity
  e2e: { roomServerOrigin: string, extensionOutput: string, extensionManifestSha256: string }
  extensionSource: {
    /** Relative to the checkout; `.` when the extension is built from it. */
    root: string
    sameAsCheckout: boolean
    commit: string
    tree: string
    trackedSourceSha256: string
    packageLockSha256: string
    config: ConfigIdentity
  }
}

/** The tree the extension is built from: the override when one is given. */
export function resolveExtensionSourceRoot(checkoutRoot: string, override: string | undefined): string {
  return override ? resolve(override) : checkoutRoot
}

/**
 * Fails with a message that names the variable when the other tree cannot be
 * built from, instead of the "spawnSync node ENOENT" a missing path produces,
 * or a git error that arrives only after the whole build has run.
 */
export function assertExtensionSourceRoot(sourceRoot: string): void {
  const variable = 'SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT'
  if (!existsSync(sourceRoot))
    throw new Error(`${variable} points at ${sourceRoot}, which does not exist.`)
  if (!existsSync(resolve(sourceRoot, 'scripts/build-extension.mjs'))) {
    throw new Error(`${variable} points at ${sourceRoot}, which has no scripts/build-extension.mjs. It has to be a checkout of this repository with its dependencies installed.`)
  }
  // The run records which commit and tree the extension came from, and reads
  // them from git. An export of a tag (`git archive`) has the files and no
  // history, so it would be built in full and then fail on `git ls-files`.
  if (!existsSync(resolve(sourceRoot, '.git'))) {
    throw new Error(`${variable} points at ${sourceRoot}, which is not a git checkout or worktree (it has no .git). The run records the commit and tree the extension was built from, so use \`git worktree add\` for the tag rather than an export.`)
  }
}

/**
 * The build has to have written the extension into the run's own directory.
 * A release that predates SYNCYOURJOY_EXTENSION_OUTPUT_DIR (v0.2.4 and
 * earlier) writes into its own apps/extension/dist instead, and the run would
 * otherwise fail later with ENOENT on manifest.json.
 */
export function assertExtensionBuilt(extensionDistDir: string, sourceRoot: string): void {
  const manifest = resolve(extensionDistDir, 'manifest.json')
  if (existsSync(manifest))
    return
  throw new Error(
    `The extension build in ${sourceRoot} did not write ${manifest}. `
    + 'A build script that ignores SYNCYOURJOY_EXTENSION_OUTPUT_DIR (v0.2.4 and earlier) cannot be used as an extension source; v0.2.5 and later can.',
  )
}

export async function readSourceIdentity(root: string): Promise<SourceIdentity> {
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const sourceFiles = trackedFiles.filter(path => SOURCE_FILE_PATTERN.test(path))
  const presentConfigFiles = CONFIG_FILES.filter(path => existsSync(resolve(root, path)))
  const missingConfigFiles = CONFIG_FILES.filter(path => !presentConfigFiles.includes(path))

  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim(),
    trackedSourceSha256: await hashFiles(root, sourceFiles),
    packageLockSha256: await hashFiles(root, ['package-lock.json']),
    config: {
      files: [...presentConfigFiles],
      sha256: await hashFiles(root, presentConfigFiles),
      ...(missingConfigFiles.length > 0 ? { missing: [...missingConfigFiles] } : {}),
    },
  }
}

export interface CollectProvenanceInput {
  runId: string
  createdAt: string
  /** Supplies the coordinator and the specs. */
  checkoutRoot: string
  /** What the extension bundle was built from; the checkout when no override is used. */
  extensionSourceRoot: string
  extensionDistDir: string
  roomServerUrl: string
}

export async function collectProvenance(input: CollectProvenanceInput): Promise<ProvenanceRecord> {
  const checkout = await readSourceIdentity(input.checkoutRoot)
  const sameAsCheckout = resolve(input.extensionSourceRoot) === resolve(input.checkoutRoot)
  const extension = sameAsCheckout ? checkout : await readSourceIdentity(input.extensionSourceRoot)
  const manifestPath = resolve(input.extensionDistDir, 'manifest.json')

  return {
    schemaVersion: 1,
    runId: input.runId,
    createdAt: input.createdAt,
    source: {
      commit: checkout.commit,
      tree: checkout.tree,
      trackedSourceSha256: checkout.trackedSourceSha256,
    },
    lock: {
      packageLockSha256: checkout.packageLockSha256,
    },
    config: checkout.config,
    e2e: {
      roomServerOrigin: new URL(input.roomServerUrl).origin,
      extensionOutput: relative(input.checkoutRoot, input.extensionDistDir),
      extensionManifestSha256: await hashFiles(input.checkoutRoot, [manifestPath]),
    },
    extensionSource: {
      root: relative(input.checkoutRoot, input.extensionSourceRoot) || '.',
      sameAsCheckout,
      commit: extension.commit,
      tree: extension.tree,
      trackedSourceSha256: extension.trackedSourceSha256,
      packageLockSha256: extension.packageLockSha256,
      config: extension.config,
    },
  }
}

export interface BuildExtensionInput {
  runId: string
  createdAt: string
  /** Supplies the coordinator and the specs. */
  checkoutRoot: string
  /** SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT: another tree to build the extension from, if any. */
  extensionSourceOverride: string | undefined
  extensionDistDir: string
  roomServerUrl: string
  /** The environment the build runs in; the room server URL and output directory are added to it. */
  env: NodeJS.ProcessEnv
  /** How the build's output is handled; the run's own output by default. */
  stdio?: 'inherit' | 'ignore'
  log?: (line: string) => void
}

/**
 * Builds the extension for a run and returns the provenance of the run.
 *
 * The extension is built from the checkout, or from the tree
 * SYNCYOURJOY_E2E_EXTENSION_SOURCE_ROOT names (for example a worktree of a
 * release tag, with its own node_modules installed) while the coordinator and
 * the specs stay the checkout's. That is how a shipped extension is checked
 * against the current coordinator.
 *
 * That tree's build script has to read SYNCYOURJOY_ROOM_SERVER_URL,
 * SYNCYOURJOY_EXTENSION_OUTPUT_DIR and the SYNCYOURJOY_E2E_TEST_* variables.
 * Releases from v0.2.5 on do. v0.2.4 and earlier ignore the output directory
 * and build into their own apps/extension/dist, which assertExtensionBuilt()
 * reports instead of the run failing later on a missing manifest.
 *
 * All of this is here, and not in tests/e2e/global-setup.ts, so that which
 * tree is built, from where, and what is recorded about it can be tested
 * (tests/provenance.test.ts).
 */
export async function buildExtensionAndRecordProvenance(input: BuildExtensionInput): Promise<ProvenanceRecord> {
  const sourceRoot = resolveExtensionSourceRoot(input.checkoutRoot, input.extensionSourceOverride)
  const external = resolve(sourceRoot) !== resolve(input.checkoutRoot)
  if (external)
    assertExtensionSourceRoot(sourceRoot)

  const log = input.log ?? ((line: string) => console.log(line))
  log(`[e2e] building an isolated extension at ${relative(input.checkoutRoot, input.extensionDistDir)}${external ? ` from ${sourceRoot}` : ''}...`)
  execFileSync(process.execPath, [resolve(sourceRoot, 'scripts/build-extension.mjs')], {
    cwd: sourceRoot,
    env: {
      ...input.env,
      SYNCYOURJOY_ROOM_SERVER_URL: input.roomServerUrl,
      SYNCYOURJOY_EXTENSION_OUTPUT_DIR: input.extensionDistDir,
    },
    stdio: input.stdio ?? 'inherit',
  })
  assertExtensionBuilt(input.extensionDistDir, sourceRoot)

  return collectProvenance({
    runId: input.runId,
    createdAt: input.createdAt,
    checkoutRoot: input.checkoutRoot,
    extensionSourceRoot: sourceRoot,
    extensionDistDir: input.extensionDistDir,
    roomServerUrl: input.roomServerUrl,
  })
}

/**
 * Whether the run's extension was built from the checkout the specs belong to.
 * A spec that sends the extension a message only this checkout's build
 * understands is meaningless against a release build, and uses this to say so
 * rather than fail. Without a provenance record there is nothing to say a
 * different build was used, so the answer is yes.
 */
export function isCheckoutExtensionBuild(artifactDirectory: string | undefined): boolean {
  if (!artifactDirectory)
    return true
  try {
    const record = JSON.parse(readFileSync(resolve(artifactDirectory, 'provenance.json'), 'utf8')) as Partial<ProvenanceRecord>
    return record.extensionSource?.sameAsCheckout !== false
  }
  catch {
    return true
  }
}

/**
 * SHA-256 over each path (as given, sorted) followed by its content, relative
 * to `root`. An absolute path is read as it is.
 */
export async function hashFiles(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const path of [...paths].sort()) {
    const filePath = resolve(root, path)
    hash.update(path)
    hash.update('\0')
    hash.update(await readFile(filePath))
  }
  return hash.digest('hex')
}
