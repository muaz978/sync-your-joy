import { describe, expect, it } from 'vitest'
import { shouldDeferPanelRender } from './panel-interaction.ts'

describe('side panel interaction rendering', () => {
  it('does not replace a control during an active pointer gesture', () => {
    expect(shouldDeferPanelRender(true, null)).toBe(true)
  })

  it('does not replace editable fields while the user is selecting or typing', () => {
    expect(shouldDeferPanelRender(false, 'shared-video-url')).toBe(true)
    expect(shouldDeferPanelRender(false, 'display-name')).toBe(true)
    expect(shouldDeferPanelRender(false, 'room-code')).toBe(true)
  })

  it('allows live rendering when no form or pointer interaction is active', () => {
    expect(shouldDeferPanelRender(false, null)).toBe(false)
    expect(shouldDeferPanelRender(false, 'primary-control')).toBe(false)
  })
})
