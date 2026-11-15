// What the specs share about fixtures/adaptive-player.html: the shape of the
// page's own snapshot and the two ways every spec reads it.
//
// The snapshot is what the page recorded about itself (its event log, the
// buffered ranges it read from the element, the segments it appended). It is
// not an observation of anything on screen: a counter or a clock that moves in
// it is not evidence that a frame was painted.
import type { Frame, Page, TestInfo } from '@playwright/test'

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
 * Keeps the page's own event log with the test's output. It is attached
 * whether the test passes or fails, so a run that went wrong can be read
 * afterwards, and run-summary.json names the attachment.
 */
export async function attachFixtureEvents(
  testInfo: TestInfo,
  name: string,
  target: FixtureTarget,
): Promise<FixtureSnapshot | undefined> {
  const snapshot = await readFixtureSnapshot(target).catch(() => undefined)
  if (!snapshot)
    return undefined
  await testInfo.attach(`fixture-events-${name}.json`, {
    body: `${JSON.stringify(snapshot, null, 2)}\n`,
    contentType: 'application/json',
  })
  return snapshot
}

/** Events of one type, in the order the page recorded them. */
export function eventsOfType(snapshot: FixtureSnapshot, type: string): FixtureEvent[] {
  return snapshot.events.filter(event => event.type === type)
}
