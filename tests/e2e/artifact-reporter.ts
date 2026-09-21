import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { sanitizeDiagnosticText } from './artifact-utils.ts'

interface E2ETestArtifact {
  id: string
  title: string
  file: string
  status: TestResult['status']
  durationMs: number
  failureClass?: 'browser-launch/setup' | 'product-assertion'
  errors: Array<{ message: string, stack?: string }>
  attachments: Array<{ name: string, path?: string, contentType?: string }>
}

export default class ArtifactReporter implements Reporter {
  private outputDirectory = ''
  private rootDirectory = ''
  private startedAt = ''
  private tests: E2ETestArtifact[] = []

  async onBegin(config: FullConfig): Promise<void> {
    this.rootDirectory = config.rootDir
    this.outputDirectory = config.projects[0]?.outputDir
      ?? process.env.SYNCYOURJOY_E2E_OUTPUT_DIR
      ?? resolve(config.rootDir, 'test-results')
    this.startedAt = new Date().toISOString()
    await mkdir(this.outputDirectory, { recursive: true })
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const sanitizeErrorText = (value: string): string => sanitizeDiagnosticText(value)
      .replaceAll(this.rootDirectory, '<repo>')
    const errors = result.errors.map(error => ({
      message: sanitizeErrorText(error.message ?? 'Unknown test error.'),
      ...(error.stack ? { stack: sanitizeErrorText(error.stack) } : {}),
    }))
    const failureText = errors.map(error => `${error.message}\n${error.stack ?? ''}`).join('\n')
    const failureClass = result.status === 'failed'
      ? /\[browser-launch\]|browser launch|service worker startup/i.test(failureText)
        ? 'browser-launch/setup' as const
        : 'product-assertion' as const
      : undefined

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
      failureClasses: {
        browserLaunchOrSetup: this.tests.filter(test => test.failureClass === 'browser-launch/setup').length,
        productAssertions: this.tests.filter(test => test.failureClass === 'product-assertion').length,
      },
    }, null, 2)}\n`)
  }
}
