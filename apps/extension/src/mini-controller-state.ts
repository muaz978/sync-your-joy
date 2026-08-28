export interface MiniControllerView {
  hostVisible: boolean
  controllerVisible: boolean
  restoreVisible: boolean
}

export function miniControllerView(roomUiAvailable: boolean, hidden: boolean): MiniControllerView {
  return {
    hostVisible: roomUiAvailable,
    controllerVisible: roomUiAvailable && !hidden,
    restoreVisible: roomUiAvailable && hidden,
  }
}
