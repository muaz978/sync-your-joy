import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('store-readiness documentation', () => {
  it('keeps privacy, beta, and store submission documents present and aligned', async () => {
    const [privacy, beta, storePack, readme] = await Promise.all([
      readFile(new URL('../docs/PRIVACY_POLICY.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/PRIVATE_BETA.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/STORE_SUBMISSION.md', import.meta.url), 'utf8'),
      readFile(new URL('../README.md', import.meta.url), 'utf8'),
    ])

    expect(privacy).toContain('What SyncYourJoy does not collect')
    expect(privacy).toContain('Detailed diagnostic reports')
    expect(privacy).toContain('replace or supplement this link with a monitored privacy contact address')
    expect(beta).toContain('Download detailed report')
    expect(beta).toContain('do not refresh')
    expect(storePack).toContain('Chrome Web Store package')
    expect(storePack).toContain('Firefox package')
    expect(storePack).toContain('Safari package')
    expect(readme).toContain('Privacy and permissions')
    expect(readme).toContain('docs/PRIVACY_POLICY.md')
  })
})
