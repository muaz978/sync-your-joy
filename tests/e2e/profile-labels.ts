// Profile labels name each profile's artifact files (`<label>.events.json`,
// `<label>.trace.zip`) in a run's output directory, so two suites that launch a
// profile under the same label write over each other's files. Every
// three-profile suite has its own prefix; the two-profile suites use `a` and `b`.
export const THREE_PROFILE_PREFIXES = {
  matrix: 'three-profile',
  fault: 'three-profile-fault',
  seek: 'three-profile-seek',
} as const

export function profileLabels(prefix: string): [string, string, string] {
  if (prefix === '')
    throw new Error('A three-profile suite needs a prefix of its own for its artifact names.')
  return [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`]
}
