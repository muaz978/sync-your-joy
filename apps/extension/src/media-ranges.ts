/** The subset of `TimeRanges` that the summary needs, so tests can fake it. */
export interface TimeRangesLike {
  readonly length: number
  start(index: number): number
  end(index: number): number
}

export interface TimeRangeSummary {
  /** True number of ranges the element reported, even when only some are listed. */
  count: number
  /** Flat `[start0, end0, start1, end1, ...]`, ascending, rounded to 0.1 s. */
  ranges: number[]
  /** Contiguous media after the playhead, or null when the ranges are unreadable. */
  aheadSeconds: number | null
}

/** Ranges beyond this are clamped: live streams report unbounded ends. */
export const MAX_RANGE_SECONDS = 10_000_000
/** How many buffered and seekable ranges a report lists; the count is always exact. */
export const MAX_BUFFERED_PAIRS = 4
export const MAX_SEEKABLE_PAIRS = 2
const ROUND_STEP_SECONDS = 10
// Rounding and a paused element's exact position can sit a hair before a range start.
const PLAYHEAD_TOLERANCE_SECONDS = 0.05
// A player that fragments its buffer into hundreds of ranges is still read in full.
const MAX_RANGES_READ = 512

function rounded(seconds: number): number {
  return Math.round(Math.min(Math.max(seconds, 0), MAX_RANGE_SECONDS) * ROUND_STEP_SECONDS) / ROUND_STEP_SECONDS
}

/**
 * Reduces media time ranges to a small, bounded set of plain numbers that are
 * safe to put in a diagnostics report. The range holding the playhead is kept
 * first, then the ranges nearest to it, so a long fragmented buffer still
 * shows what surrounds the position that matters. Nothing here ever reads a
 * URL, a key or an error message.
 *
 * `TimeRanges.start()` and `end()` throw when the index is out of range and a
 * detached element may throw on `length`, so every read is guarded and a
 * failure degrades to an empty summary rather than breaking media reporting.
 */
export function summarizeTimeRanges(ranges: TimeRangesLike | null | undefined, currentSeconds: number, maxPairs: number): TimeRangeSummary {
  if (!ranges)
    return { count: 0, ranges: [], aheadSeconds: null }
  let count = 0
  const pairs: Array<{ start: number; end: number }> = []
  try {
    count = Number.isSafeInteger(ranges.length) && ranges.length > 0 ? ranges.length : 0
    for (let index = 0; index < Math.min(count, MAX_RANGES_READ); index += 1) {
      const start = ranges.start(index)
      const end = ranges.end(index)
      if (Number.isNaN(start) || Number.isNaN(end) || end < start)
        continue
      pairs.push({ start: rounded(start), end: rounded(end) })
    }
  }
  catch {
    return { count, ranges: [], aheadSeconds: null }
  }

  const position = Number.isFinite(currentSeconds) ? Math.max(0, currentSeconds) : 0
  const distance = (pair: { start: number; end: number }): number =>
    position < pair.start ? pair.start - position : position > pair.end ? position - pair.end : 0
  const kept = [...pairs]
    .sort((left, right) => distance(left) - distance(right) || left.start - right.start)
    .slice(0, Math.max(0, maxPairs))
    .sort((left, right) => left.start - right.start)

  const holding = pairs.find(pair => position + PLAYHEAD_TOLERANCE_SECONDS >= pair.start && position <= pair.end)
  return {
    count,
    ranges: kept.flatMap(pair => [pair.start, pair.end]),
    aheadSeconds: holding ? rounded(Math.max(0, holding.end - position)) : 0,
  }
}

/** Coarse buffer level for event details, so an event is only new when the level changes. */
export function bufferedAheadBucket(aheadSeconds: number | null | undefined): 'empty' | 'low' | 'ok' | null {
  if (typeof aheadSeconds !== 'number' || !Number.isFinite(aheadSeconds))
    return null
  return aheadSeconds <= 0 ? 'empty' : aheadSeconds < 2 ? 'low' : 'ok'
}

/** `MediaError.code` is 1 to 4. Anything else, and every message, is dropped. */
export function sanitizeMediaErrorCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4 ? value : null
}

export function sanitizeRangeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : null
}

export function sanitizeRangeSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? rounded(value) : null
}

export function sanitizeElapsedMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), 3_600_000) : null
}

/**
 * Re-validates ranges that crossed a message boundary before they enter a
 * report: the content script is our own code, but a stale or restored state
 * object is not guaranteed to hold what today's build writes.
 */
export function sanitizeRangePairs(value: unknown, maxPairs: number): number[] | null {
  if (!Array.isArray(value))
    return null
  const pairs: number[] = []
  for (let index = 0; index + 1 < value.length && pairs.length < maxPairs * 2; index += 2) {
    const start: unknown = value[index]
    const end: unknown = value[index + 1]
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || end < start)
      continue
    pairs.push(rounded(start), rounded(end))
  }
  return pairs
}
