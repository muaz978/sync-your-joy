// How a test result is classified in run-summary.json, kept out of
// artifact-reporter.ts so it can be unit tested (tests/artifact-reporter.test.ts).
//
// Every result that is neither passed nor skipped gets a class, so the run
// summary never leaves one uncounted:
//
//   failed + a launch/setup marker in the error text  browser-launch/setup
//   failed + anything else                            product-assertion
//   timedOut                                          timeout
//   interrupted                                       interrupted
//   passed, skipped                                   none
//
// A timed-out test is not folded into either failed class. Playwright reports
// the timeout by status and its message does not say whether a hung launch or
// a hung product step caused it, so the status decides and the text is not
// consulted. `interrupted` is a run that was stopped (maxFailures, Ctrl+C), so
// it is not evidence about the product or the browser either way.

export type ArtifactTestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'

export type FailureClass = 'browser-launch/setup' | 'product-assertion' | 'timeout' | 'interrupted'

/** `[browser-launch]` is the marker tests/e2e/storage-state.ts and the profile helper put on a launch failure. */
export const BROWSER_LAUNCH_PATTERN = /\[browser-launch\]|browser launch|service worker startup/i

export function classifyFailure(status: string, failureText: string): FailureClass | undefined {
  switch (status) {
    case 'failed':
      return BROWSER_LAUNCH_PATTERN.test(failureText) ? 'browser-launch/setup' : 'product-assertion'
    case 'timedOut':
      return 'timeout'
    case 'interrupted':
      return 'interrupted'
    default:
      return undefined
  }
}

export interface FailureClassCounts {
  browserLaunchOrSetup: number
  productAssertions: number
  timeouts: number
  interrupted: number
  /** Results that are neither passed nor skipped and got no class (a status this file does not know). */
  unclassified: number
}

export function countFailureClasses(tests: ReadonlyArray<{ status: string, failureClass?: FailureClass | undefined }>): FailureClassCounts {
  const withClass = (failureClass: FailureClass) => tests.filter(test => test.failureClass === failureClass).length
  return {
    browserLaunchOrSetup: withClass('browser-launch/setup'),
    productAssertions: withClass('product-assertion'),
    timeouts: withClass('timeout'),
    interrupted: withClass('interrupted'),
    unclassified: tests.filter(test => test.status !== 'passed' && test.status !== 'skipped' && !test.failureClass).length,
  }
}
