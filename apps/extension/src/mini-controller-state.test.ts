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

  // The room has just ended and the page must still be told why, even though
  // there is no room UI any more and even if the controller had been hidden.
  it('shows the controller, not the restore handle, for a notice about a room that is gone', () => {
    const view = {
      hostVisible: true,
      controllerVisible: true,
      restoreVisible: false,
    }
    expect(miniControllerView(false, false, true)).toEqual(view)
    expect(miniControllerView(false, true, true)).toEqual(view)
  })

  it('does not let a notice change the view while the room UI is available', () => {
    expect(miniControllerView(true, false, true)).toEqual(miniControllerView(true, false))
    expect(miniControllerView(true, true, true)).toEqual(miniControllerView(true, true))
  })
})
