import { describe, expect, it } from 'vitest'
import { bufferedAheadBucket, sanitizeElapsedMs, sanitizeMediaErrorCode, sanitizeRangeCount, sanitizeRangePairs, sanitizeRangeSeconds, summarizeTimeRanges } from './media-ranges.ts'
import type { TimeRangesLike } from './media-ranges.ts'

function ranges(...pairs: Array<[number, number]>): TimeRangesLike {
  return {
    length: pairs.length,
    start: (index: number) => {
      const pair = pairs[index]
      if (!pair)
        throw new DOMException('Index out of range', 'IndexSizeError')
      return pair[0]
    },
    end: (index: number) => {
      const pair = pairs[index]
      if (!pair)
        throw new DOMException('Index out of range', 'IndexSizeError')
      return pair[1]
    },
  }
}

describe('media time range summary', () => {
  it('shows a playhead with nothing buffered around it, the state a stuck seek leaves behind', () => {
    expect(summarizeTimeRanges(ranges([0, 60.04]), 197.442125, 4)).toEqual({ count: 1, ranges: [0, 60], aheadSeconds: 0 })
  })

  it('measures the contiguous buffer ahead of a playhead that sits inside a range', () => {
    expect(summarizeTimeRanges(ranges([0, 12.34], [60, 90]), 10, 4)).toEqual({ count: 2, ranges: [0, 12.3, 60, 90], aheadSeconds: 2.3 })
  })

  it('keeps the ranges nearest the playhead, in ascending order, when there are more than the cap', () => {
    const many = ranges([0, 1], [10, 11], [20, 21], [100, 101], [200, 201], [300, 301])
    const summary = summarizeTimeRanges(many, 105, 2)
    expect(summary.count).toBe(6)
    expect(summary.ranges).toEqual([20, 21, 100, 101])
  })

  it('returns an empty summary for absent, empty, hostile or throwing ranges', () => {
    expect(summarizeTimeRanges(null, 5, 4)).toEqual({ count: 0, ranges: [], aheadSeconds: null })
    expect(summarizeTimeRanges(ranges(), 5, 4)).toEqual({ count: 0, ranges: [], aheadSeconds: 0 })
    expect(summarizeTimeRanges(ranges([Number.NaN, 4], [9, 3]), 5, 4).ranges).toEqual([])
    const throwing: TimeRangesLike = { length: 2, start: () => { throw new Error('detached') }, end: () => 1 }
    expect(summarizeTimeRanges(throwing, 5, 4)).toEqual({ count: 2, ranges: [], aheadSeconds: null })
    const brokenLength = { get length(): number { throw new Error('detached') }, start: () => 0, end: () => 1 } as TimeRangesLike
    expect(summarizeTimeRanges(brokenLength, 5, 4)).toEqual({ count: 0, ranges: [], aheadSeconds: null })
  })

  it('clamps live-stream infinities and negative starts to plain finite numbers', () => {
    const summary = summarizeTimeRanges(ranges([-3, Number.POSITIVE_INFINITY]), 20, 4)
    expect(summary.ranges).toEqual([0, 10_000_000])
    expect(Number.isFinite(summary.aheadSeconds)).toBe(true)
  })

  it('reports no lead when the playhead sits in a hole just before a range', () => {
    expect(summarizeTimeRanges(ranges([10, 20]), 9.6, 4)).toEqual({ count: 1, ranges: [10, 20], aheadSeconds: 0 })
    expect(summarizeTimeRanges(ranges([10, 20]), 9.98, 4).aheadSeconds).toBe(10)
  })

  it('reads every range of a heavily fragmented buffer before choosing the ones around the playhead', () => {
    const many = ranges(...Array.from({ length: 100 }, (_, index): [number, number] => [index * 10, index * 10 + 5]))
    expect(summarizeTimeRanges(many, 802, 2)).toEqual({ count: 100, ranges: [790, 795, 800, 805], aheadSeconds: 3 })
  })

  it('tolerates a non-finite playhead', () => {
    expect(summarizeTimeRanges(ranges([0, 30]), Number.NaN, 4)).toEqual({ count: 1, ranges: [0, 30], aheadSeconds: 30 })
  })
})

describe('report sanitizers for values that crossed a message boundary', () => {
  it('keeps only MediaError codes 1 to 4', () => {
    expect([0, 1, 2, 3, 4, 5, 1.5, '3', null, undefined, Number.NaN].map(sanitizeMediaErrorCode)).toEqual([null, 1, 2, 3, 4, null, null, null, null, null, null])
  })

  it('bounds counts, seconds and elapsed time', () => {
    expect([-1, 0, 7, 99_999, 2.5, Number.NaN, '1'].map(sanitizeRangeCount)).toEqual([null, 0, 7, 10_000, null, null, null])
    expect([12.34, -5, Number.POSITIVE_INFINITY, Number.NaN, 20_000_000].map(sanitizeRangeSeconds)).toEqual([12.3, 0, null, null, 10_000_000])
    expect([2_100.6, -1, Number.NaN, 9_999_999_999].map(sanitizeElapsedMs)).toEqual([2_101, null, null, 3_600_000])
  })

  it('drops malformed pairs, caps the list and rounds what remains', () => {
    expect(sanitizeRangePairs('nope', 4)).toBeNull()
    expect(sanitizeRangePairs([0, 1.26, 5, 3, Number.NaN, 2, '4', 6, 10, 11], 2)).toEqual([0, 1.3, 10, 11])
    expect(sanitizeRangePairs([0, 1, 2], 4)).toEqual([0, 1])
  })

  it('buckets the buffer level so a heartbeat only changes when the level does', () => {
    expect([null, undefined, Number.NaN, 0, 0.4, 1.99, 2, 300].map(bufferedAheadBucket)).toEqual([null, null, null, 'empty', 'low', 'low', 'ok', 'ok'])
  })
})
