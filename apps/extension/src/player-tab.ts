export function shouldAcceptPlayerTab(options: {
  hasRoom: boolean
  boundTabId: number | null
  senderTabId: number
  senderIsActive: boolean
}): boolean {
  if (options.hasRoom && options.boundTabId !== null)
    return options.senderTabId === options.boundTabId
  return options.senderIsActive
}
