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
import { existsSync } from 'node:fs'
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
