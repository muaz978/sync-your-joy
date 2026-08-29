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

export function hasUsableVideoSource(
  currentSrc: string,
  srcAttribute: string | null,
  nestedSource: string | null,
  hasSourceObject: boolean,
  readyState = 0,
  networkState = 0,
): boolean {
  // MediaSource-backed players can be initialized through source buffers
  // without a useful src attribute. Once metadata exists and the media
  // network state is not EMPTY, the element is a real player rather than a
  // decorative or pre-created decoy video.
  return hasSourceObject
    || Boolean(currentSrc.trim() || srcAttribute?.trim() || nestedSource?.trim())
    || (networkState !== 0 && readyState >= 1)
}
