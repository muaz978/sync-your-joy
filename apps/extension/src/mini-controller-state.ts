export interface MiniControllerView {
  hostVisible: boolean
  controllerVisible: boolean
  restoreVisible: boolean
}

/**
 * `noticeWithoutRoom` is true while the page still has something to tell the
 * participant about a room that no longer exists (it has just ended). There is
 * no room UI left to carry it, so the controller is shown for the notice
 * alone, whether or not the participant had hidden it.
 */
export function miniControllerView(roomUiAvailable: boolean, hidden: boolean, noticeWithoutRoom = false): MiniControllerView {
  if (!roomUiAvailable && noticeWithoutRoom) {
    return { hostVisible: true, controllerVisible: true, restoreVisible: false }
  }
  return {
    hostVisible: roomUiAvailable,
    controllerVisible: roomUiAvailable && !hidden,
    restoreVisible: roomUiAvailable && hidden,
  }
}
