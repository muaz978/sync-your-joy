export const LOCAL_INTENT_HOLD_MS = 2_500

export function shouldDeferAuthoritativeSync(options: {
  isController: boolean
  isSeeking: boolean
  holdUntil: number
  now: number
}): boolean {
  return options.isController && (options.isSeeking || options.now < options.holdUntil)
}
