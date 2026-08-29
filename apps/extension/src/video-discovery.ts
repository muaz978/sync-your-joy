/**
 * Discover native video elements in the current document and in open Shadow
 * DOM roots. Content scripts run independently in each injected frame, so
 * cross-origin frame coverage is provided by the manifest's all_frames and
 * related-frame matching rather than by walking iframe contents here.
 * See https://developer.mozilla.org/en-US/docs/Web/API/ShadowRoot and
 * https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts.
 */
export function discoverVideoElements(root: Document | ShadowRoot): HTMLVideoElement[] {
  const videos = new Set<HTMLVideoElement>()
  const visitedRoots = new Set<Document | ShadowRoot>()

  const visit = (current: Document | ShadowRoot): void => {
    if (visitedRoots.has(current))
      return
    visitedRoots.add(current)
    for (const element of current.querySelectorAll('*')) {
      if (element.localName === 'video')
        videos.add(element as HTMLVideoElement)
      if (element.shadowRoot)
        visit(element.shadowRoot)
    }
  }

  visit(root)
  return [...videos]
}

export function discoverOpenShadowRoots(root: Document | ShadowRoot): ShadowRoot[] {
  const roots = new Set<ShadowRoot>()
  const visitedRoots = new Set<Document | ShadowRoot>()

  const visit = (current: Document | ShadowRoot): void => {
    if (visitedRoots.has(current))
      return
    visitedRoots.add(current)
    for (const element of current.querySelectorAll('*')) {
      if (element.shadowRoot) {
        roots.add(element.shadowRoot)
        visit(element.shadowRoot)
      }
    }
  }

  visit(root)
  return [...roots]
}
