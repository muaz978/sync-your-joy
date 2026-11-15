// What the specs share about fixtures/adaptive-player.html: the shape of the
// page's own snapshot and the two ways every spec reads it.
//
// The snapshot is what the page recorded about itself (its event log, the
// buffered ranges it read from the element, the segments it appended). It is
// not an observation of anything on screen: a counter or a clock that moves in
// it is not evidence that a frame was painted.
import type { Frame, Page, TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { sanitizeDiagnosticText } from './artifact-utils.ts'

export interface FixtureEvent {
  at: string
  elapsedMs: number
  type: string
  index?: number
  delayMs?: number
  requestedDelayMs?: number
  appliedDelayMs?: number
  fetchMs?: number
  status?: number
  label?: string
  node?: string
  nodeSerial?: number
  previous?: string
  next?: string
  sameElement?: boolean
  readyState?: number
  paused?: boolean
  currentTime?: number
  playbackRate?: number
  generation?: number
  reason?: string
  timestampOffset?: number
  [key: string]: unknown
}

export interface FixtureSnapshot {
  phase: string
  surface: string
  route: string
  duration: number
  bufferedRanges: number[][]
  loadedSegments: number[]
  missingSegments: number[]
  mediaSourceType: string
  activePlayerNode: string | null
  nodeSerial: number
  loadCount: number
  holding: boolean
  playbackRate: number
  events: FixtureEvent[]
}

interface FixtureApi {
  snapshot: () => FixtureSnapshot
  load: (reason?: string) => Promise<void>
  replaceSource: (reason?: string) => Promise<void>
  release: () => boolean
}

declare global {
  interface Window {
    __SYNCYOURJOY_ADAPTIVE_FIXTURE__?: FixtureApi
  }
}

export type FixtureTarget = Page | Frame

export async function readFixtureSnapshot(target: FixtureTarget): Promise<FixtureSnapshot> {
  const snapshot = await target.evaluate(() => window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot())
  if (!snapshot)
    throw new Error('The adaptive fixture did not expose its snapshot.')
  return snapshot
}

export async function waitForFixtureEvent(
  target: FixtureTarget,
  type: string,
  options: { timeout?: number, since?: number } = {},
): Promise<void> {
  await target.waitForFunction(
    ({ wanted, since }) => (window.__SYNCYOURJOY_ADAPTIVE_FIXTURE__?.snapshot().events ?? [])
      .slice(since)
      .some(event => event.type === wanted),
    { wanted: type, since: options.since ?? 0 },
    { timeout: options.timeout ?? 120_000 },
  )
}

/**
 * Keeps the page's own event log with the test's output. It is written to a
 * file in the test's output directory and attached by path, so the run's
 * reporter (which records an attachment's name and path, not a body) names a
 * file that exists. The text passes through the same sanitizer the failure
 * text does (absolute paths, the home directory and the repository root are
 * masked, URLs are reduced). It is attached whether the test passes or fails.
 */
export async function attachFixtureEvents(
  testInfo: TestInfo,
  name: string,
  target: FixtureTarget,
): Promise<FixtureSnapshot | undefined> {
  const snapshot = await readFixtureSnapshot(target).catch(() => undefined)
  if (!snapshot)
    return undefined
  const fileName = `fixture-events-${name}.json`
  const path = testInfo.outputPath(fileName)
  await writeFile(path, `${sanitizeDiagnosticText(JSON.stringify(snapshot, null, 2))}\n`)
  await testInfo.attach(fileName, { path, contentType: 'application/json' })
  return snapshot
}

/** Events of one type, in the order the page recorded them. */
export function eventsOfType(snapshot: FixtureSnapshot, type: string): FixtureEvent[] {
  return snapshot.events.filter(event => event.type === type)
}
