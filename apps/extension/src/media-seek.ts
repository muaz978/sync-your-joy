export interface SeekRange {
  start: number
  end: number
}

export function resolveSeekTarget(targetSeconds: number, durationSeconds: number | null, ranges: SeekRange[]): number | null {
  if (!Number.isFinite(targetSeconds))
    return null

  const maximum = durationSeconds !== null && Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds - 0.05)
    : Number.POSITIVE_INFINITY
  const target = Math.max(0, Math.min(targetSeconds, maximum))
  const validRanges = ranges
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end >= range.start)
    .sort((left, right) => left.start - right.start)

  if (validRanges.length === 0)
    return target
  for (const range of validRanges) {
    if (target >= range.start && target <= range.end)
      return target
  }

  let nearest = validRanges[0]!.start
  let nearestDistance = Math.abs(target - nearest)
  for (const range of validRanges) {
    for (const boundary of [range.start, Math.max(range.start, range.end - 0.05)]) {
      const distance = Math.abs(target - boundary)
      if (distance < nearestDistance) {
        nearest = boundary
        nearestDistance = distance
      }
    }
  }
  return nearest
}
