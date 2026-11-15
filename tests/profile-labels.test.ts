import { describe, expect, it } from 'vitest'
import { profileLabels, THREE_PROFILE_PREFIXES } from './e2e/profile-labels.ts'

describe('profile labels for the three-profile suites', () => {
  it('give every profile of every suite its own artifact name, none of them a two-profile suite\'s', () => {
    const labels = Object.values(THREE_PROFILE_PREFIXES).flatMap(prefix => profileLabels(prefix))
    expect(labels).toHaveLength(9)
    expect(new Set(labels).size).toBe(9)
    // two-profile-sync.spec.ts and the other two-profile suites launch `a` and `b`.
    for (const reserved of ['a', 'b', 'c'])
      expect(labels).not.toContain(reserved)
  })

  it('refuses an empty prefix, which would reuse the two-profile suites\' names', () => {
    expect(() => profileLabels('')).toThrow(/prefix of its own/)
  })
})
