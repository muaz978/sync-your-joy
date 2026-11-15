import { defineConfig } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveE2EOutputDirectory } from '../../scripts/output-directory-guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
// With no SYNCYOURJOY_E2E_OUTPUT_DIR this is a new directory under test-results
// for every run. An override has to be a directory below test-results or the
// system temporary directory: Playwright empties its output directory and the
// build deletes `<output>/extension`, so the release output, the repository,
// its ancestors and the home directory are refused (scripts/output-directory-guard.mjs).
const { directory: outputDirectory } = resolveE2EOutputDirectory({ env: process.env, repoRoot })

process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = outputDirectory

// This project is intentionally separate from vitest.config.ts (see
// docs/TEST_GUIDE.md, "Real two-browser-profile end-to-end test"). It
// drives two persistent Chromium profiles with the real unpacked extension
// loaded, so it is slower and needs its own timeouts and its own
// `npm run test:e2e` entry point rather than living inside `npm test`.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // A single spec drives two whole browser profiles against one shared
  // room-service instance from global-setup.ts; running specs in parallel
  // workers would mean racing extension builds and room-service lifecycles
  // for no benefit here.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: outputDirectory,
  expect: {
    timeout: 15_000,
  },
  globalSetup: './global-setup.ts',
  reporter: [['list'], [resolve(here, './artifact-reporter.ts')]],
  use: {
    trace: 'off',
    video: process.env.SYNCYOURJOY_E2E_VIDEO === '1' ? 'retain-on-failure' : 'off',
  },
})
