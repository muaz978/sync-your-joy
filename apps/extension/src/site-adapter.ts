const AUTOMATIC_CLICK_TO_LOAD_HOSTS = ['animerco.org']
const ADVERTISING_HOSTS = [
  'acceptable.a-ads.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adnxs.com',
]

export function shouldBootstrapClickToLoadPlayer(hostname: string, isTopFrame: boolean, navigationMatches: boolean): boolean {
  return isTopFrame
    && navigationMatches
    && AUTOMATIC_CLICK_TO_LOAD_HOSTS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

export function isLikelyAdvertisingUrl(value: string | undefined): boolean {
  if (!value)
    return false
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return ADVERTISING_HOSTS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
  }
  catch {
    return false
  }
}

export function hasUsableVideoSource(currentSrc: string, srcAttribute: string | null, nestedSource: string | null, hasSourceObject: boolean): boolean {
  return hasSourceObject || Boolean(currentSrc.trim() || srcAttribute?.trim() || nestedSource?.trim())
}
