const EDITABLE_FIELD_IDS = new Set([
  'display-name',
  'room-code',
  'shared-video-url',
])

export function shouldDeferPanelRender(pointerActive: boolean, activeElementId: string | null): boolean {
  return pointerActive || (activeElementId !== null && EDITABLE_FIELD_IDS.has(activeElementId))
}
