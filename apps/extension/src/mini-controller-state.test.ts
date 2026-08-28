import { describe, expect, it } from 'vitest'
import { miniControllerView } from './mini-controller-state.ts'

describe('mini controller visibility', () => {
  it('shows the full controller while room UI is available', () => {
    expect(miniControllerView(true, false)).toEqual({
      hostVisible: true,
      controllerVisible: true,
      restoreVisible: false,
    })
  })

  it('keeps only the restore handle visible after hiding the controller', () => {
    expect(miniControllerView(true, true)).toEqual({
      hostVisible: true,
      controllerVisible: false,
      restoreVisible: true,
    })
  })

  it('hides both surfaces outside a room player context', () => {
    expect(miniControllerView(false, true)).toEqual({
      hostVisible: false,
      controllerVisible: false,
      restoreVisible: false,
    })
  })
})
