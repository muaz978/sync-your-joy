import type { FullConfig, FullResult, TestCase, TestResult } from '@playwright/test/reporter'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyFailure, countFailureClasses } from './e2e/artifact-classify.ts'
import ArtifactReporter from './e2e/artifact-reporter.ts'
import { findRepositoryRoot } from './e2e/artifact-utils.ts'

// run-summary.json is what a reader uses to tell a browser that did not start
// from a product that failed. Every result that is neither passed nor skipped
// has to land in one class, and the class has to follow from the status and
// the error text.

describe('failure classification', () => {
  const assertion = 'Error: expect(received).toBe(expected)\n\nExpected: "playing"\nReceived: "paused"'

  it('classifies a failure with the launch marker as browser-launch/setup', () => {
    expect(classifyFailure('failed', '[browser-launch] Storage state for a-profile could not be read (ENOENT).'))
      .toBe('browser-launch/setup')
  })

  it('classifies the other launch and startup wordings the same way', () => {
    expect(classifyFailure('failed', 'browserType.launchPersistentContext: Browser launch failed')).toBe('browser-launch/setup')
    expect(classifyFailure('failed', 'Timed out waiting for service worker startup')).toBe('browser-launch/setup')
  })

  it('classifies an assertion failure as product-assertion', () => {
    expect(classifyFailure('failed', assertion)).toBe('product-assertion')
    expect(classifyFailure('failed', '')).toBe('product-assertion')
  })

  it('classifies a timed-out test as timeout, whatever its text says', () => {
    expect(classifyFailure('timedOut', 'Test timeout of 120000ms exceeded.')).toBe('timeout')
    expect(classifyFailure('timedOut', '[browser-launch] hung')).toBe('timeout')
  })

  it('classifies an interrupted test as interrupted', () => {
    expect(classifyFailure('interrupted', '')).toBe('interrupted')
  })

  it('gives passed and skipped results no class', () => {
    expect(classifyFailure('passed', '')).toBeUndefined()
    expect(classifyFailure('skipped', '[browser-launch] text that is not a failure')).toBeUndefined()
  })

  it('counts each class, and counts a status it does not know as unclassified', () => {
    const counts = countFailureClasses([
      { status: 'failed', failureClass: 'browser-launch/setup' },
      { status: 'failed', failureClass: 'product-assertion' },
      { status: 'failed', failureClass: 'product-assertion' },
      { status: 'timedOut', failureClass: 'timeout' },
      { status: 'interrupted', failureClass: 'interrupted' },
      { status: 'passed' },
      { status: 'skipped' },
      { status: 'someNewStatus' },
    ])
    expect(counts).toEqual({ browserLaunchOrSetup: 1, productAssertions: 2, timeouts: 1, interrupted: 1, unclassified: 1 })
  })
})

describe('ArtifactReporter', () => {
  const repoRoot = findRepositoryRoot(dirname(fileURLToPath(import.meta.url))) as string
  let base: string

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'syj-reporter-'))
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const fakeTest = (id: string, title: string[]): TestCase => ({
    id,
    titlePath: () => ['', 'chromium', 'spec.ts', ...title],
    location: { file: join(repoRoot, 'tests/e2e/spec.ts'), line: 1, column: 1 },
  }) as unknown as TestCase

  const fakeResult = (status: TestResult['status'], errors: Array<{ message?: string, stack?: string }> = []): TestResult => ({
    status,
    duration: 12,
    errors,
    attachments: [],
  }) as unknown as TestResult

  const fakeConfig = (outputDir: string | undefined): FullConfig => ({
    rootDir: join(repoRoot, 'tests/e2e'),
    projects: outputDir === undefined ? [] : [{ outputDir }],
  }) as unknown as FullConfig

  const summaryOf = (directory: string) => JSON.parse(readFileSync(join(directory, 'run-summary.json'), 'utf8'))

  it('writes a class for every result that is neither passed nor skipped, and counts each one', async () => {
    const directory = join(base, 'all-statuses')
    const reporter = new ArtifactReporter()
    await reporter.onBegin(fakeConfig(directory))
    reporter.onTestEnd(fakeTest('t1', ['passes']), fakeResult('passed'))
    reporter.onTestEnd(fakeTest('t2', ['is skipped']), fakeResult('skipped'))
    reporter.onTestEnd(fakeTest('t3', ['launch fails']), fakeResult('failed', [{ message: '[browser-launch] Could not start the profile.' }]))
    reporter.onTestEnd(fakeTest('t4', ['asserts']), fakeResult('failed', [{ message: 'expect(received).toBe(expected)' }]))
    reporter.onTestEnd(fakeTest('t5', ['hangs']), fakeResult('timedOut', [{ message: 'Test timeout of 120000ms exceeded.' }]))
    reporter.onTestEnd(fakeTest('t6', ['is stopped']), fakeResult('interrupted'))
    await reporter.onEnd({ status: 'failed' } as FullResult)

    const summary = summaryOf(directory)
    expect(summary.outcome).toBe('failed')
    expect(summary.tests.map((test: { id: string, status: string, failureClass?: string }) => [test.id, test.status, test.failureClass])).toEqual([
      ['t1', 'passed', undefined],
      ['t2', 'skipped', undefined],
      ['t3', 'failed', 'browser-launch/setup'],
      ['t4', 'failed', 'product-assertion'],
      ['t5', 'timedOut', 'timeout'],
      ['t6', 'interrupted', 'interrupted'],
    ])
    expect(summary.failureClasses).toEqual({
      browserLaunchOrSetup: 1,
      productAssertions: 1,
      timeouts: 1,
      interrupted: 1,
      unclassified: 0,
    })

    // Nothing that did not pass and was not skipped is left out of the counts.
    const notPassing = summary.tests.filter((test: { status: string }) => test.status !== 'passed' && test.status !== 'skipped').length
    const counted = Object.entries(summary.failureClasses as Record<string, number>)
      .filter(([name]) => name !== 'unclassified')
      .reduce((sum, [, count]) => sum + count, 0)
    expect(counted).toBe(notPassing)
  })

  it('keeps the run summary for a clean run free of any class', async () => {
    const directory = join(base, 'clean')
    const reporter = new ArtifactReporter()
    await reporter.onBegin(fakeConfig(directory))
    reporter.onTestEnd(fakeTest('t1', ['passes']), fakeResult('passed'))
    await reporter.onEnd({ status: 'passed' } as FullResult)

    const summary = summaryOf(directory)
    expect(summary.failureClasses).toEqual({ browserLaunchOrSetup: 0, productAssertions: 0, timeouts: 0, interrupted: 0, unclassified: 0 })
    expect(summary.tests[0]).not.toHaveProperty('failureClass')
  })

  it('masks the repository root, other absolute paths and escape sequences in the errors it writes', async () => {
    const directory = join(base, 'masked')
    const reporter = new ArtifactReporter()
    await reporter.onBegin(fakeConfig(directory))
    reporter.onTestEnd(fakeTest('t1', ['fails']), fakeResult('failed', [{
      message: '\u001B[31mexpected\u001B[0m a to be b at https://synthetic.invalid/page?token=abc123',
      stack: `Error: x\n    at ${join(repoRoot, 'tests/e2e/spec.ts')}:10:5\n    at /home/other/work/elsewhere/lib/helper.js:3:1`,
    }]))
    await reporter.onEnd({ status: 'failed' } as FullResult)

    const [test] = summaryOf(directory).tests
    expect(test.file).toBe('spec.ts')
    expect(test.errors[0].message).toBe('expected a to be b at https://synthetic.invalid/page')
    expect(test.errors[0].stack).toContain('at <repo>/tests/e2e/spec.ts:10:5')
    expect(test.errors[0].stack).toContain('at <path>/lib/helper.js:3:1')
    expect(JSON.stringify(test)).not.toContain(repoRoot)
    expect(JSON.stringify(test)).not.toContain('other')
    expect(JSON.stringify(test)).not.toContain('abc123')
  })

  it('writes to the project output directory when the environment names another allowed one too', async () => {
    const previous = process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
    try {
      const fromProject = join(base, 'precedence-project')
      const fromEnvironment = join(base, 'precedence-env')
      process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = fromEnvironment
      const reporter = new ArtifactReporter()
      await reporter.onBegin(fakeConfig(fromProject))
      reporter.onTestEnd(fakeTest('t1', ['passes']), fakeResult('passed'))
      await reporter.onEnd({ status: 'passed' } as FullResult)

      expect(summaryOf(fromProject).tests).toHaveLength(1)
      expect(existsSync(join(fromEnvironment, 'run-summary.json'))).toBe(false)
    }
    finally {
      if (previous === undefined)
        delete process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
      else
        process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = previous
    }
  })

  it('writes to the environment\'s directory when the project names none and the directory is allowed', async () => {
    const previous = process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
    try {
      const fromEnvironment = join(base, 'precedence-env-only')
      process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = fromEnvironment
      const reporter = new ArtifactReporter()
      await reporter.onBegin(fakeConfig(undefined))
      reporter.onTestEnd(fakeTest('t1', ['passes']), fakeResult('passed'))
      await reporter.onEnd({ status: 'passed' } as FullResult)

      expect(summaryOf(fromEnvironment).tests).toHaveLength(1)
    }
    finally {
      if (previous === undefined)
        delete process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
      else
        process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = previous
    }
  })

  it('refuses an output directory override that would be written over, instead of using it', async () => {
    const previous = process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
    try {
      process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = join(repoRoot, 'apps/extension/dist')
      await expect(new ArtifactReporter().onBegin(fakeConfig(undefined))).rejects.toThrow(/SYNCYOURJOY_E2E_OUTPUT_DIR=.*release output/)

      const allowed = join(base, 'override-ok')
      mkdirSync(base, { recursive: true })
      process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = allowed
      const reporter = new ArtifactReporter()
      await reporter.onBegin(fakeConfig(undefined))
      await reporter.onEnd({ status: 'passed' } as FullResult)
      expect(summaryOf(allowed).outcome).toBe('passed')
    }
    finally {
      if (previous === undefined)
        delete process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
      else
        process.env.SYNCYOURJOY_E2E_OUTPUT_DIR = previous
    }
  })
})
