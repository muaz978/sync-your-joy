import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('extension manifest privacy boundary', () => {
  it('does not request capture, cookies, web request, or debugger permissions', async () => {
    const raw = await readFile(new URL('../apps/extension/static/manifest.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(raw) as { permissions?: string[]; icons?: Record<string, string>; action?: { default_icon?: Record<string, string> } }
    const permissions = manifest.permissions ?? []

    expect(permissions).not.toContain('tabCapture')
    expect(permissions).not.toContain('desktopCapture')
    expect(permissions).not.toContain('cookies')
    expect(permissions).not.toContain('webRequest')
    expect(permissions).not.toContain('debugger')
    expect(manifest.icons).toMatchObject({ '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' })
    expect(manifest.action?.default_icon).toMatchObject({ '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png' })
  })

  it('runs the generic video adapter on HTTP and HTTPS pages', async () => {
    const raw = await readFile(new URL('../apps/extension/static/manifest.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(raw) as { content_scripts?: Array<{ matches?: string[]; all_frames?: boolean; match_origin_as_fallback?: boolean }> }
    const matches = manifest.content_scripts?.[0]?.matches ?? []

    expect(matches).toContain('http://*/*')
    expect(matches).toContain('https://*/*')
    expect(manifest.content_scripts?.[0]?.all_frames).toBe(true)
    expect(manifest.content_scripts?.[0]?.match_origin_as_fallback).toBe(true)
  })

  it('declares only the permissions needed by the current user-facing features', async () => {
    const raw = await readFile(new URL('../apps/extension/static/manifest.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(raw) as {
      permissions?: string[]
      background?: { service_worker?: string }
      content_security_policy?: { extension_pages?: string }
    }
    expect(manifest.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'downloads'])
    expect(manifest.background?.service_worker).toBe('service-worker.js')
    expect(manifest.content_security_policy?.extension_pages).toContain("script-src 'self'")
    expect(manifest.content_security_policy?.extension_pages).not.toContain('http://')
  })

  it('ships raster icons required by extension stores', async () => {
    for (const icon of ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png']) {
      const bytes = await readFile(new URL(`../apps/extension/static/icons/${icon}`, import.meta.url))
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    }
  })
})
