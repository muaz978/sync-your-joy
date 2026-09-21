import { describe, expect, it } from 'vitest'
import { artifactFileName, sanitizeBrowserUrl, sanitizeDiagnosticText } from './e2e/artifact-utils.ts'

describe('E2E artifact sanitization', () => {
  it('removes query strings and fragments from browser URLs', () => {
    expect(sanitizeBrowserUrl('https://www.crunchyroll.com/watch/episode?token=secret#player'))
      .toBe('https://www.crunchyroll.com/watch/episode')
    expect(sanitizeBrowserUrl('chrome-extension://abc123/sidepanel.html?room=private'))
      .toBe('chrome-extension://abc123/sidepanel.html')
  })

  it('redacts unsupported URL schemes and credential-like diagnostics', () => {
    expect(sanitizeBrowserUrl('ws://synthetic.invalid/rooms?secret=1')).toBe('ws://redacted')
    expect(sanitizeDiagnosticText('https://www.crunchyroll.com/watch/episode?token=secret password=private'))
      .toBe('https://www.crunchyroll.com/watch/episode password=<redacted>')
  })

  it('creates stable safe artifact filenames', () => {
    expect(artifactFileName('profile A', 'events.json')).toBe('profile_A.events.json')
  })
})
