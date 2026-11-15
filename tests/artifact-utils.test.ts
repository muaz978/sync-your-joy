import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { artifactFileName, findRepositoryRoot, sanitizeBrowserUrl, sanitizeDiagnosticText, sanitizeError } from './e2e/artifact-utils.ts'

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

  describe('paths and terminal sequences in diagnostic text', () => {
    // Synthetic roots, so the expectations do not depend on where the tests run.
    const options = { repositoryRoot: '/home/someone/work/repo', homeDirectory: '/home/someone' }
    const sanitize = (value: string) => sanitizeDiagnosticText(value, options)

    it('masks an absolute POSIX path, dropping the first two segments and keeping the last two', () => {
      expect(sanitize('at /home/other/work/project/tests/e2e/x.ts:10:5'))
        .toBe('at <path>/e2e/x.ts:10:5')
      expect(sanitize('Error: ENOENT, open \'/var/lib/other/cache/state.json\''))
        .toBe('Error: ENOENT, open \'<path>/cache/state.json\'')
    })

    it('never keeps the first two segments, where a user name sits', () => {
      expect(sanitize('/Users/alice/x.ts')).toBe('<path>/x.ts')
      expect(sanitize('/home/alice/repo/x.ts')).not.toContain('alice')
    })

    it('masks a Windows path written with backslashes or forward slashes', () => {
      expect(sanitize('at C:\\Users\\other\\repo\\x.ts:3:1')).toBe('at <path>/repo/x.ts:3:1')
      expect(sanitize('D:/a/work/pkg/dist/main.js')).toBe('<path>/dist/main.js')
      expect(sanitize('at C:\\Users\\other\\repo\\x.ts')).not.toContain('other')
    })

    it('does not count the drive letter as a segment, so a short Windows path loses its user name', () => {
      expect(sanitize('C:\\Users\\alice\\x.ts')).toBe('<path>/x.ts')
      expect(sanitize('C:\\Users\\alice')).toBe('<path>')
      expect(sanitize('C:/Users/alice')).toBe('<path>')
      expect(sanitize('at C:\\Users\\alice\\a\\b.ts')).toBe('at <path>/a/b.ts')
      expect(sanitize('at C:\\Users\\alice\\a\\b.ts')).not.toContain('alice')
      expect(sanitize('C:\\Users\\alice\\a\\b\\c.ts')).toBe('<path>/b/c.ts')
    })

    it('masks the path of a file:// stack frame', () => {
      expect(sanitize('at file:///opt/build/ci/work/repo/tests/e2e/x.ts:7:9'))
        .toBe('at <path>/e2e/x.ts:7:9')
      expect(sanitize('at file:///C:/Users/other/repo/x.ts:7:9'))
        .toBe('at <path>/repo/x.ts:7:9')
    })

    it('shows the repository root as <repo> and the home directory as <home>, so a failure stays locatable', () => {
      expect(sanitize('at Object.<anonymous> (/home/someone/work/repo/tests/e2e/x.ts:10:5)'))
        .toBe('at Object.<anonymous> (<repo>/tests/e2e/x.ts:10:5)')
      expect(sanitize('cache in /home/someone/.cache/x and /home/someone')).toBe('cache in <home>/.cache/x and <home>')
      // A sibling directory that shares the prefix is another directory.
      expect(sanitize('/home/someone/work/repo-copy/a/b.ts')).toBe('<home>/work/repo-copy/a/b.ts')
      expect(sanitize('/home/someone/work/repo-copy/a/b.ts')).not.toContain('<repo>')
    })

    it('replaces a repository root that has a space in it as a whole', () => {
      expect(sanitizeDiagnosticText('failed at /srv/my project/repo/tests/e2e/x.ts:1', { repositoryRoot: '/srv/my project/repo', homeDirectory: null }))
        .toBe('failed at <repo>/tests/e2e/x.ts:1')
    })

    it('strips ANSI color, cursor and hyperlink sequences', () => {
      expect(sanitize('\u001B[31mError:\u001B[0m expected \u001B[1;32m2\u001B[39m'))
        .toBe('Error: expected 2')
      expect(sanitize('\u001B[2K\u001B[1Gdone')).toBe('done')
      expect(sanitize('\u001B]8;;https://synthetic.invalid/x\u0007link\u001B]8;;\u0007')).toBe('link')
      expect(sanitize('\u001B[31m/home/other/a/b/c.ts:1\u001B[0m')).toBe('<path>/b/c.ts:1')
    })

    it('strips a sequence before the URL rule, so a colored URL still loses its query', () => {
      expect(sanitize('\u001B[36mhttps://synthetic.invalid/watch/ep?token=abc123#t\u001B[0m'))
        .toBe('https://synthetic.invalid/watch/ep')
    })

    it('leaves http(s) URL paths exactly as the URL rule returns them', () => {
      expect(sanitize('GET https://host.invalid/a/b failed')).toBe('GET https://host.invalid/a/b failed')
      expect(sanitize('https://host.invalid/a/b/c/d.html?x=1#y')).toBe('https://host.invalid/a/b/c/d.html')
      expect(sanitize('https://www.crunchyroll.com/watch/episode?token=secret password=private'))
        .toBe('https://www.crunchyroll.com/watch/episode password=<redacted>')
    })

    it('leaves chrome-extension and other scheme URLs in text unchanged', () => {
      expect(sanitize('page chrome-extension://abcdefghijklmnop/sidepanel.html failed'))
        .toBe('page chrome-extension://abcdefghijklmnop/sidepanel.html failed')
      expect(sanitize('socket ws://synthetic.invalid:8787/rooms closed'))
        .toBe('socket ws://synthetic.invalid:8787/rooms closed')
      expect(sanitize('see node:internal/modules/run_main:123')).toBe('see node:internal/modules/run_main:123')
    })

    it('leaves relative paths, fractions and an already masked path alone', () => {
      expect(sanitize('open ./tests/e2e/x.ts and ../scripts/y.mjs')).toBe('open ./tests/e2e/x.ts and ../scripts/y.mjs')
      expect(sanitize('3/4 of and/or')).toBe('3/4 of and/or')
      expect(sanitize(sanitize('/home/other/work/repo2/a/b.ts'))).toBe('<path>/a/b.ts')
    })

    it('returns a URL with a bracketed IPv6 host exactly as the URL rule does, with or without a port', () => {
      const urls = [
        'http://[::1]/a/b/c', // DevSkim: ignore DS137138
        'https://[::1]/a/b',
        'ws://[::1]/rooms/a',
        'chrome-extension://[::1]/a/b/c.html',
        'http://[::1]:8787/rooms/a', // DevSkim: ignore DS137138
        'https://[::1]:8443/a/b/c',
        'ws://[::1]:8787/rooms/a',
        'chrome-extension://[::1]:1234/a/b',
        'https://[2001:db8::1]/a/b/c',
      ]
      for (const url of urls)
        expect(sanitize(`open ${url} now`), url).toBe(`open ${url} now`)
      expect(sanitize('http://[::1]:8787/a/b/c?token=abc#x')).toBe('http://[::1]:8787/a/b/c') // DevSkim: ignore DS137138
    })

    it('masks a path directly after a colon, where a user name would otherwise leak', () => {
      expect(sanitize('cwd:/home/someone/x/y')).toBe('cwd:<path>/x/y')
      expect(sanitize('path:/Users/someone/repo/a.ts')).toBe('path:<path>/repo/a.ts')
      expect(sanitize('cwd:/home/other/work/repo')).not.toContain('other')
    })

    it('leaves every URL form unchanged now that a colon does not protect a path', () => {
      for (const url of [
        'https://h/a/b',
        'http://h:8787/a/b', // DevSkim: ignore DS137138
        'chrome-extension://id/page.html',
        'ws://h:8787/a/b/c',
        'wss://h/rooms/a/b',
      ])
        expect(sanitize(`at ${url} done`), url).toBe(`at ${url} done`)
      // A file URL is a path on disk, so it is masked like one.
      expect(sanitize('file:///a/b/c')).toBe('<path>/c')
    })

    it('masks an absolute path of two segments, which is where a user name sits, and keeps a single segment', () => {
      const bare = (value: string) => sanitizeDiagnosticText(value, { repositoryRoot: null, homeDirectory: null })
      expect(bare('/home/someone')).toBe('<path>')
      expect(bare('/tmp/x')).toBe('<path>')
      expect(bare('/Users/someone/x.ts')).toBe('<path>/x.ts')
      expect(bare('/tmp')).toBe('/tmp')
      expect(bare('/x')).toBe('/x')
      expect(bare('open /tmp then /x')).toBe('open /tmp then /x')
    })

    it('leaves a path that follows ~, @, - or a dot alone, and a relative path', () => {
      for (const text of ['~/a/b', 'user@/a/b', '-/a/b', './a/b', '../a/b', 'x./a/b'])
        expect(sanitize(text), text).toBe(text)
    })

    it('keeps a secret-looking final file name, a documented limit of masking by pattern', () => {
      expect(sanitize('read /var/lib/other/vault/secret-token-file.txt'))
        .toBe('read <path>/vault/secret-token-file.txt')
    })

    it('drops a credential that sits in a dropped path segment, and redacts a credential pair in a kept one', () => {
      // The first two segments and everything before the last two are gone.
      const deep = sanitize('read /home/other/signing-key-abc123/vault/sub/key.pem then password=hunter2')
      expect(deep).toBe('read <path>/sub/key.pem then password=<redacted>')

      // A key=value pair in a kept segment goes through the credential rule.
      const kept = sanitize('read /home/other/.config/token=abc123XYZ/session.json')
      expect(kept).toBe('read <path>/token=<redacted>')
      expect(kept).not.toContain('abc123')
      expect(kept).not.toContain('other')
    })

    it('masks paths in an error and its stack, the way setup-failure.json and the launch-failure event are written', () => {
      const error = new Error('[browser-launch] Could not read /home/other/work/proj/state/profile.json token=abc123')
      error.stack = `Error: ${error.message}\n    at launch (/home/other/work/proj/tests/e2e/extension-profile.ts:220:11)`
      const result = sanitizeError(error, options)
      expect(result.message).toBe('[browser-launch] Could not read <path>/state/profile.json token=<redacted>')
      expect(result.stack).toContain('at launch (<path>/e2e/extension-profile.ts:220:11)')
      expect(JSON.stringify(result)).not.toContain('other')
      expect(JSON.stringify(result)).not.toContain('abc123')
    })

    it('passes the repository root and the home directory on to both the message and the stack of an error', () => {
      const error = new Error('[browser-launch] Could not read /home/someone/work/repo/state/p.json and /home/someone/.cache/x')
      error.stack = `Error: ${error.message}\n    at launch (/home/someone/work/repo/tests/e2e/setup.ts:1:2)\n    at open (/home/someone/.cache/y.js:3:4)`
      const result = sanitizeError(error, options)
      expect(result.message).toBe('[browser-launch] Could not read <repo>/state/p.json and <home>/.cache/x')
      expect(result.stack).toBe(
        'Error: [browser-launch] Could not read <repo>/state/p.json and <home>/.cache/x\n'
        + '    at launch (<repo>/tests/e2e/setup.ts:1:2)\n'
        + '    at open (<home>/.cache/y.js:3:4)',
      )
      expect(sanitizeError('failed in /home/someone/work/repo/a/b.ts', options).message).toBe('failed in <repo>/a/b.ts')
    })

    it('treats a null repository root or home directory as none, and an undefined one as the default', () => {
      const text = 'at /home/someone/work/repo/tests/e2e/x.ts:1:2'
      expect(sanitizeDiagnosticText(text, { repositoryRoot: null, homeDirectory: null })).toBe('at <path>/e2e/x.ts:1:2')
      expect(sanitizeDiagnosticText(text, { repositoryRoot: '/home/someone/work/repo', homeDirectory: null })).toBe('at <repo>/tests/e2e/x.ts:1:2')
      expect(sanitizeDiagnosticText(text, { repositoryRoot: null, homeDirectory: '/home/someone' })).toBe('at <home>/work/repo/tests/e2e/x.ts:1:2')
      // Defaults are the real repository and the real home, neither of which is the synthetic one.
      expect(sanitizeDiagnosticText(text)).toBe('at <path>/e2e/x.ts:1:2')
    })

    it('does not fall back to the real repository or home directory when it is told there is none', () => {
      const root = findRepositoryRoot(dirname(fileURLToPath(import.meta.url))) as string
      const inRepository = `at ${join(root, 'tests/e2e/x.ts')}:1:2`
      expect(sanitizeDiagnosticText(inRepository, { homeDirectory: null })).toBe('at <repo>/tests/e2e/x.ts:1:2')
      expect(sanitizeDiagnosticText(inRepository, { repositoryRoot: null, homeDirectory: null })).toBe('at <path>/e2e/x.ts:1:2')

      const inHome = `at ${join(homedir(), 'work/lib/deep/x.ts')}:1:2`
      expect(sanitizeDiagnosticText(inHome, { repositoryRoot: null })).toBe('at <home>/work/lib/deep/x.ts:1:2')
      expect(sanitizeDiagnosticText(inHome, { repositoryRoot: null, homeDirectory: null })).not.toContain('<home>')
    })

    it('replaces a directory spelled with the other separator, and one with regular expression characters', () => {
      expect(sanitizeDiagnosticText('at C:/work/repo/tests/x.ts:1', { repositoryRoot: 'C:\\work\\repo', homeDirectory: null }))
        .toBe('at <repo>/tests/x.ts:1')
      expect(sanitizeDiagnosticText('at C:\\work\\repo\\tests\\x.ts:1', { repositoryRoot: 'C:/work/repo', homeDirectory: null }))
        .toBe('at <repo>\\tests\\x.ts:1')
      // A dot in the root is a dot, not "any character".
      expect(sanitizeDiagnosticText('at /srv/a.b/repo/x.ts:1 and /srv/aXb/repo/x.ts:1', { repositoryRoot: '/srv/a.b/repo', homeDirectory: null }))
        .toBe('at <repo>/x.ts:1 and <path>/repo/x.ts:1')
      expect(sanitizeDiagnosticText('at /srv/(x)+/repo/y.ts:1', { repositoryRoot: '/srv/(x)+/repo', homeDirectory: null }))
        .toBe('at <repo>/y.ts:1')
    })

    it('does not replace a directory that only appears inside a longer path', () => {
      expect(sanitizeDiagnosticText('see /opt/other/home/someone/x/y.ts:1', { repositoryRoot: null, homeDirectory: '/home/someone' }))
        .not.toContain('<home>')
      expect(sanitizeDiagnosticText('see ./home/someone/x/y.ts:1', { repositoryRoot: null, homeDirectory: '/home/someone' }))
        .toBe('see ./home/someone/x/y.ts:1')
    })

    it('finds the repository root from a file inside it, and by default masks the real one', () => {
      const root = findRepositoryRoot(dirname(fileURLToPath(import.meta.url))) as string
      expect(root).not.toBeNull()
      expect(existsSync(join(root, '.git'))).toBe(true)
      expect(existsSync(join(root, 'tests/e2e/artifact-utils.ts'))).toBe(true)
      expect(sanitizeDiagnosticText(`at ${join(root, 'tests/e2e/x.ts')}:1:2`, { homeDirectory: null }))
        .toBe('at <repo>/tests/e2e/x.ts:1:2')
      expect(sanitizeDiagnosticText(`at ${join(root, 'tests/e2e/x.ts')}:1:2`)).not.toContain(root)
    })
  })
})
