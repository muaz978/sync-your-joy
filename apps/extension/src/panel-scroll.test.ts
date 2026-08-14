import { describe, expect, it } from 'vitest'
import { retainedPanelScrollTop } from './panel-scroll.ts'

describe('retainedPanelScrollTop', () => {
  it('keeps the current room scroll position across live state renders', () => {
    expect(retainedPanelScrollTop('room:ABCD2345', 'room:ABCD2345', 428)).toBe(428)
  })

  it('starts at the top when the panel changes rooms or returns home', () => {
    expect(retainedPanelScrollTop('room:ABCD2345', 'room:EFGH6789', 428)).toBe(0)
    expect(retainedPanelScrollTop('room:ABCD2345', 'welcome', 428)).toBe(0)
  })

  it('normalizes invalid or negative positions', () => {
    expect(retainedPanelScrollTop('welcome', 'welcome', Number.NaN)).toBe(0)
    expect(retainedPanelScrollTop('welcome', 'welcome', -20)).toBe(0)
  })
})
