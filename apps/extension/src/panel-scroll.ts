export function retainedPanelScrollTop(
  previousViewKey: string | null,
  nextViewKey: string,
  previousScrollTop: number,
): number {
  if (previousViewKey !== nextViewKey || !Number.isFinite(previousScrollTop))
    return 0
  return Math.max(0, previousScrollTop)
}
