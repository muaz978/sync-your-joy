import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('extension manifest privacy boundary', () => {
  it('does not request capture, cookies, web request, or debugger permissions', async () => {
    const raw = await readFile(new URL('../apps/extension/static/manifest.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(raw) as { permissions?: string[] }
    const permissions = manifest.permissions ?? []

    expect(permissions).not.toContain('tabCapture')
    expect(permissions).not.toContain('desktopCapture')
    expect(permissions).not.toContain('cookies')
    expect(permissions).not.toContain('webRequest')
    expect(permissions).not.toContain('debugger')
  })

  it('runs the generic video adapter on HTTP and HTTPS pages', async () => {
    const raw = await readFile(new URL('../apps/extension/static/manifest.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(raw) as { content_scripts?: Array<{ matches?: string[]; all_frames?: boolean }> }
    const matches = manifest.content_scripts?.[0]?.matches ?? []

    expect(matches).toContain('http://*/*')
    expect(matches).toContain('https://*/*')
    expect(manifest.content_scripts?.[0]?.all_frames).toBe(true)
  })
})
