import type { MediaFingerprint } from '@syncyourjoy/protocol'
import { normalizeMediaPageUrl, normalizePageUrl as normalizeProtocolPageUrl } from '@syncyourjoy/protocol'

export function serviceName(hostname: string): string {
  const normalized = hostname.toLowerCase()
  if (normalized.includes('netflix'))
    return 'netflix'
  if (normalized.includes('disneyplus'))
    return 'disney-plus'
  if (normalized.includes('crunchyroll'))
    return 'crunchyroll'
  if (normalized.includes('youtube'))
    return 'youtube'
  if (normalized === 'qfilm.tv' || normalized.endsWith('.qfilm.tv'))
    return 'qfilm'
  return 'html5'
}

export function canonicalMediaId(service: string, url: URL): string {
  if (service === 'youtube') {
    const videoId = url.searchParams.get('v')
    if (videoId)
      return `youtube:${videoId}`
  }

  if (service === 'crunchyroll') {
    const episodeId = url.pathname.match(/\/watch\/([a-z0-9]+)/i)?.[1]
    if (episodeId)
      return `crunchyroll:${episodeId.toUpperCase()}`
  }

  if (service === 'netflix') {
    const videoId = url.pathname.match(/\/watch\/(\d+)/)?.[1]
    if (videoId)
      return `netflix:${videoId}`
  }

  if (service === 'disney-plus') {
    const videoId = url.pathname.match(/\/video\/([a-z0-9-]+)/i)?.[1]
    if (videoId)
      return `disney-plus:${videoId.toLowerCase()}`
  }

  if (service === 'qfilm') {
    const videoId = url.searchParams.get('vid')?.trim()
    if (videoId && /^[a-z0-9]+$/i.test(videoId))
      return `qfilm:${videoId.toLowerCase()}`
  }

  const normalized = normalizeMediaPageUrl(url.toString())
  return normalized ? `page:${normalized}` : `${url.hostname.toLowerCase()}${url.pathname}`
}

export function normalizePageUrl(url: URL): string | null {
  return normalizeProtocolPageUrl(url.toString())
}

export function cleanMediaTitle(title: string): string {
  return title
    .replace(/\s*[|-]\s*(Netflix|Disney\+|Crunchyroll|YouTube)\s*$/i, '')
    .trim()
}

export function bindMediaToSharedPage(media: MediaFingerprint, navigationUrl: string | undefined): MediaFingerprint {
  if (!navigationUrl)
    return media
  const pageUrl = normalizeMediaPageUrl(navigationUrl)
  if (!pageUrl)
    return media
  const identityUrl = new URL(pageUrl)
  const service = serviceName(identityUrl.hostname)
  return {
    ...media,
    service,
    canonicalId: canonicalMediaId(service, identityUrl).slice(0, 500),
    pageUrl,
  }
}
