import type { MediaFingerprint } from '@syncyourjoy/protocol'
import { normalizePageUrl as normalizeProtocolPageUrl } from '@syncyourjoy/protocol'

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

  const normalized = normalizePageUrl(url)
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
  const pageUrl = normalizeProtocolPageUrl(navigationUrl)
  return pageUrl ? { ...media, pageUrl } : media
}
