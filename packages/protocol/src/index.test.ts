import type { MediaFingerprint } from './index.ts'
import { describe, expect, it } from 'vitest'
import { mediaMatches, normalizeCanonicalId, normalizePageUrl, parseClientMessage } from './index.ts'

describe('media identity matching', () => {
  it('does not treat two missing players as a video match', () => {
    expect(mediaMatches(null, null)).toBe(false)
  })

  it('matches legacy and stable Crunchyroll IDs for the same episode', () => {
    const host: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'www.crunchyroll.com/watch/GE00345558JAJP/from-now-on',
      title: 'Localized host title',
      durationSeconds: 1_470,
    }
    const guest: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00345558JAJP',
      title: 'Different regional page title',
      durationSeconds: 1_465,
    }

    expect(mediaMatches(host, guest)).toBe(true)
    expect(normalizeCanonicalId(host.service, host.canonicalId)).toBe(guest.canonicalId)
  })

  it('does not match different Crunchyroll episode IDs', () => {
    const base: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00345558JAJP',
      title: 'Episode 12',
      durationSeconds: 1_470,
    }

    expect(mediaMatches(base, { ...base, canonicalId: 'crunchyroll:GOTHER123456' })).toBe(false)
  })

  it('matches the same Qfilm video across page variants without relying on signed player URLs', () => {
    const host: MediaFingerprint = {
      service: 'qfilm', canonicalId: 'qfilm:a0821a41c', title: 'Host page', durationSeconds: null,
      pageUrl: 'https://a.qfilm.tv/play.php?vid=a0821a41c',
    }
    const guest: MediaFingerprint = {
      service: 'qfilm', canonicalId: 'qfilm:A0821A41C', title: 'Embedded player', durationSeconds: null,
      pageUrl: 'https://a.qfilm.tv/embed.php?vid=A0821A41C',
    }

    expect(mediaMatches(host, guest)).toBe(true)
    expect(normalizeCanonicalId(guest.service, guest.canonicalId)).toBe('qfilm:a0821a41c')
  })

  it('treats identical normalized page links as a strong match on generic sites', () => {
    const host: MediaFingerprint = {
      service: 'html5', canonicalId: 'page:host-variant', title: 'Host title', durationSeconds: 100,
      pageUrl: 'https://video.example/watch?id=42&utm_source=chat',
    }
    const guest: MediaFingerprint = {
      service: 'html5', canonicalId: 'page:guest-variant', title: 'Guest title', durationSeconds: 120,
      pageUrl: 'https://video.example/watch?id=42',
    }
    expect(mediaMatches(host, guest)).toBe(true)
  })

  it('allows only normalized HTTP and HTTPS room links', () => {
    expect(normalizePageUrl('https://Example.com/watch/?b=2&a=1#player')).toBe('https://example.com/watch?a=1&b=2')
    expect(normalizePageUrl('javascript:alert(1)')).toBeNull()
    expect(normalizePageUrl('file:///tmp/video.mp4')).toBeNull()
    expect(normalizePageUrl('https://user:secret@example.com/watch')).toBeNull()
    expect(normalizePageUrl(`https://example.com/${'x'.repeat(2_100)}`)).toBeNull()
    expect(parseClientMessage({
      type: 'open_link',
      actionId: 'action_open_safe',
      basedOnRevision: 1,
      leaseEpoch: 1,
      url: 'javascript:alert(1)',
    })).toBeNull()
  })

  it('requires player-health reports to identify the room revision they observed', () => {
    const sample = {
      positionSeconds: 7,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: 10_000,
    }
    expect(parseClientMessage({ type: 'player_status', sample })).toBeNull()
    expect(parseClientMessage({ type: 'player_status', basedOnRevision: 4, sample })).toMatchObject({
      type: 'player_status',
      basedOnRevision: 4,
    })
  })

  it('accepts only finite seek-completion acknowledgements', () => {
    expect(parseClientMessage({ type: 'seek_applied', revision: 7, positionSeconds: 120 })).toMatchObject({
      type: 'seek_applied',
      revision: 7,
    })
    expect(parseClientMessage({ type: 'seek_applied', revision: 7, positionSeconds: Number.NaN })).toBeNull()
  })

  it('accepts bounded sanitized diagnostic reports and rejects oversized event lists', () => {
    const report = {
      extensionVersion: '0.1.11',
      generatedAtLocalMs: 10_000,
      userAgent: 'Chrome test',
      connection: 'connected',
      roomRevision: 7,
      playbackStatus: 'playing',
      playerFrameId: 0,
      playerAreaPixels: 500_000,
      playerLastSeenAtMs: 9_900,
      mediaService: 'html5',
      mediaCanonicalId: 'page:https://video.example/watch/42',
      mediaPageUrl: 'https://video.example/watch/42',
      sample: null,
      events: [{ atLocalMs: 9_900, category: 'playback', message: 'player_status', details: { paused: false } }],
    }
    expect(parseClientMessage({ type: 'diagnostics_response', reportId: 'report_123456', report })).toMatchObject({
      type: 'diagnostics_response',
      reportId: 'report_123456',
    })
    expect(parseClientMessage({
      type: 'diagnostics_response',
      reportId: 'report_123456',
      report: { ...report, events: Array.from({ length: 121 }, () => report.events[0]) },
    })).toBeNull()
  })
})
