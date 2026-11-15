import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSafeE2EOutputDirectory } from '../../scripts/output-directory-guard.mjs'
import { type FailureClass, classifyFailure, countFailureClasses } from './artifact-classify.ts'
import { sanitizeDiagnosticText } from './artifact-utils.ts'

interface E2ETestArtifact {
  id: string
  title: string
  file: string
  status: TestResult['status']
  durationMs: number
  failureClass?: FailureClass
  errors: Array<{ message: string, stack?: string }>
  attachments: Array<{ name: string, path?: string, contentType?: string }>
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export default class ArtifactReporter implements Reporter {
  private outputDirectory = ''
  private rootDirectory = ''
  private startedAt = ''
  private tests: E2ETestArtifact[] = []

  async onBegin(config: FullConfig): Promise<void> {
    this.rootDirectory = config.rootDir
    const override = process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
    this.outputDirectory = config.projects[0]?.outputDir
      ?? (override === undefined ? undefined : assertSafeE2EOutputDirectory(override, { repoRoot }))
      ?? resolve(config.rootDir, 'test-results')
    this.startedAt = new Date().toISOString()
    await mkdir(this.outputDirectory, { recursive: true })
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // config.rootDir is tests/e2e (testDir is '.'), not the repository, so the
    // repository root is found from this file and masked by the sanitizer.
    const sanitizeErrorText = (value: string): string => sanitizeDiagnosticText(value)
    const errors = result.errors.map(error => ({
      message: sanitizeErrorText(error.message ?? 'Unknown test error.'),
      ...(error.stack ? { stack: sanitizeErrorText(error.stack) } : {}),
    }))
    const failureText = errors.map(error => `${error.message}\n${error.stack ?? ''}`).join('\n')
    const failureClass = classifyFailure(result.status, failureText)

    this.tests.push({
      id: test.id,
      title: test.titlePath().filter(Boolean).join(' > '),
      file: relative(this.rootDirectory, test.location.file),
      status: result.status,
      durationMs: result.duration,
      ...(failureClass ? { failureClass } : {}),
      errors,
      attachments: result.attachments.map(attachment => ({
        name: attachment.name,
        ...(attachment.path ? { path: relative(this.outputDirectory, resolve(attachment.path)) } : {}),
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      })),
    })
  }

  async onEnd(result: FullResult): Promise<void> {
    await writeFile(resolve(this.outputDirectory, 'run-summary.json'), `${JSON.stringify({
      schemaVersion: 1,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      outcome: result.status,
      tests: this.tests,
      failureClasses: countFailureClasses(this.tests),
    }, null, 2)}\n`)
  }
}
