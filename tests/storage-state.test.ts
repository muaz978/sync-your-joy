import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertDistinctStorageStateFiles,
  assertNoSecretLogging,
  assertStorageStateApplied,
  assertStorageStateSession,
  checkStorageStateApplied,
  checkStorageStateSession,
  describeStorageStateCheck,
  enabledRunnerArtifacts,
  parseStorageStateFile,
  readStorageStateFile,
  secretLoggingSource,
  type StorageStateFile,
} from './e2e/storage-state.ts'

// Synthetic values only. None of them is a real cookie or provider origin.
const now = 1_900_000_000
const cookie = { path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }
const state: StorageStateFile = {
  cookies: [
    { ...cookie, name: 'syn_session', value: 'synthetic-session', domain: '.synthetic.invalid' },
    { ...cookie, name: 'syn_prefs', value: 'synthetic-prefs', domain: 'www.synthetic.invalid', expires: now + 60 },
    { ...cookie, name: 'syn_bot', value: 'synthetic-bot', domain: '.synthetic.invalid', expires: now - 60 },
  ],
  origins: [
    { origin: 'https://www.synthetic.invalid', localStorage: [{ name: 'syn_key_1', value: 'v1' }, { name: 'syn_key_2', value: 'v2' }] },
    { origin: 'https://empty.synthetic.invalid', localStorage: [] },
  ],
}
const appliedCookies = [
  { name: 'syn_session', domain: '.synthetic.invalid', path: '/' },
  { name: 'syn_prefs', domain: 'www.synthetic.invalid', path: '/' },
]
const appliedOrigins = [{ origin: 'https://www.synthetic.invalid', localStorage: [{ name: 'syn_key_1' }, { name: 'syn_key_2' }] }]
const session = { site: 'synthetic.invalid', cookieNames: ['syn_session'] }
const secretLike = /syn_|synthetic/i

function thrownMessage(action: () => unknown): string {
  try {
    action()
  }
  catch (error) {
    return String(error)
  }
  throw new Error('Expected the call to throw.')
}

describe('E2E storage-state application check', () => {
  it('counts every unexpired cookie and localStorage key that reached the context', () => {
    const check = checkStorageStateApplied(state, { cookies: appliedCookies, origins: appliedOrigins }, now)
    expect(check).toEqual({
      cookiesExpected: 2,
      cookiesApplied: 2,
      cookiesExpiredInFile: 1,
      localStorageOriginsExpected: 1,
      localStorageOriginsApplied: 1,
      localStorageKeysExpected: 2,
      localStorageKeysApplied: 2,
    })
    expect(() => assertStorageStateApplied(check, 'profile-a')).not.toThrow()
    expect(describeStorageStateCheck(check))
      .toBe('cookies 2/2 (1 expired in file, skipped), localStorage origins 1/1, keys 2/2')
  })

  it('fails closed with counts only when a cookie or key is missing', () => {
    const check = checkStorageStateApplied(state, {
      cookies: [{ name: 'syn_session', domain: '.synthetic.invalid', path: '/' }],
      origins: [{ origin: 'https://www.synthetic.invalid', localStorage: [{ name: 'syn_key_1' }] }],
    }, now)
    expect(check).toMatchObject({ cookiesApplied: 1, cookiesExpected: 2, localStorageKeysApplied: 1 })
    const message = thrownMessage(() => assertStorageStateApplied(check, 'profile-a'))
    expect(message).toContain('Storage state for profile-a was not fully applied (cookies 1/2')
    expect(message).not.toMatch(secretLike)
  })

  it('fails closed when only a localStorage key is missing', () => {
    const check = checkStorageStateApplied(state, {
      cookies: appliedCookies,
      origins: [{ origin: 'https://www.synthetic.invalid', localStorage: [{ name: 'syn_key_1' }] }],
    }, now)
    const message = thrownMessage(() => assertStorageStateApplied(check, 'profile-a'))
    expect(message).toContain('(cookies 2/2 (1 expired in file, skipped), localStorage origins 0/1, keys 1/2)')
    expect(message).not.toMatch(secretLike)
  })

  it('fails closed when only a whole localStorage origin is missing', () => {
    const check = checkStorageStateApplied(state, { cookies: appliedCookies, origins: [] }, now)
    const message = thrownMessage(() => assertStorageStateApplied(check, 'profile-a'))
    expect(message).toContain('localStorage origins 0/1, keys 0/2')
    expect(message).not.toMatch(secretLike)
  })

  it('treats an empty context as not applied', () => {
    const check = checkStorageStateApplied(state, { cookies: [], origins: [] }, now)
    expect(() => assertStorageStateApplied(check, 'profile-b')).toThrow(/cookies 0\/2.*keys 0\/2/)
  })

  it('does not match a cookie on a different path or name', () => {
    const check = checkStorageStateApplied(state, {
      cookies: [
        { name: 'syn_session', domain: '.synthetic.invalid', path: '/other' },
        { name: 'Syn_prefs', domain: 'www.synthetic.invalid', path: '/' },
      ],
      origins: appliedOrigins,
    }, now)
    expect(check.cookiesApplied).toBe(0)
  })

  it('keeps a host-only cookie apart from a domain cookie with the same name', () => {
    const twins: StorageStateFile = {
      cookies: [
        { ...cookie, name: 'syn_same', value: 'host', domain: 'www.synthetic.invalid' },
        { ...cookie, name: 'syn_same', value: 'domain', domain: '.www.synthetic.invalid' },
      ],
      origins: [],
    }
    const check = checkStorageStateApplied(twins, {
      cookies: [{ name: 'syn_same', domain: '.www.synthetic.invalid', path: '/' }],
      origins: [],
    }, now)
    expect(check).toMatchObject({ cookiesExpected: 2, cookiesApplied: 1 })
    // Chrome keeps the dot on host names, so a dropped dot is a different cookie.
    expect(checkStorageStateApplied(state, {
      cookies: [{ name: 'syn_session', domain: 'synthetic.invalid', path: '/' }],
      origins: [],
    }, now).cookiesApplied).toBe(0)
  })

  it('drops the leading dot only for an IP address, and ignores domain case', () => {
    const loopback: StorageStateFile = {
      cookies: [
        { ...cookie, name: 'syn_ip', value: 'ip', domain: '.127.0.0.1' },
        { ...cookie, name: 'syn_case', value: 'case', domain: 'WWW.Synthetic.Invalid' },
      ],
      origins: [],
    }
    const check = checkStorageStateApplied(loopback, {
      cookies: [
        { name: 'syn_ip', domain: '127.0.0.1', path: '/' },
        { name: 'syn_case', domain: 'www.synthetic.invalid', path: '/' },
      ],
      origins: [],
    }, now)
    expect(check).toMatchObject({ cookiesExpected: 2, cookiesApplied: 2 })
  })

  it('keeps a partitioned cookie apart from an unpartitioned one', () => {
    const partitioned = {
      cookies: [
        { ...cookie, name: 'syn_p', value: '1', domain: 'www.synthetic.invalid', sameSite: 'None' as const },
        { ...cookie, name: 'syn_p', value: '2', domain: 'www.synthetic.invalid', sameSite: 'None' as const, partitionKey: 'https://top.synthetic.invalid' },
      ],
      origins: [],
    } as StorageStateFile
    const onlyUnpartitioned = checkStorageStateApplied(partitioned, {
      cookies: [{ name: 'syn_p', domain: 'www.synthetic.invalid', path: '/' }],
      origins: [],
    }, now)
    expect(onlyUnpartitioned).toMatchObject({ cookiesExpected: 2, cookiesApplied: 1 })
    // Chrome rewrites the partition key to the top-level site. That still matches.
    const both = checkStorageStateApplied(partitioned, {
      cookies: [
        { name: 'syn_p', domain: 'www.synthetic.invalid', path: '/' },
        { name: 'syn_p', domain: 'www.synthetic.invalid', path: '/', partitionKey: 'https://synthetic.invalid' },
      ],
      origins: [],
    }, now)
    expect(both).toMatchObject({ cookiesExpected: 2, cookiesApplied: 2 })
  })

  it('refuses a state with no unexpired cookies', () => {
    const expiredOnly = { ...state, cookies: [state.cookies[2]!] }
    const check = checkStorageStateApplied(expiredOnly, { cookies: [], origins: [] }, now)
    expect(() => assertStorageStateApplied(check, 'profile-a'))
      .toThrow('Storage state for profile-a has no unexpired cookies (1 expired).')
  })
})

describe('E2E storage-state session check', () => {
  it('passes when every declared session cookie is live and applied', () => {
    const check = checkStorageStateSession(state, { cookies: appliedCookies, origins: appliedOrigins }, session, now)
    expect(check).toEqual({ siteCookiesApplied: 2, sessionCookiesExpected: 1, sessionCookiesApplied: 1 })
    expect(() => assertStorageStateSession(check, 'profile-a')).not.toThrow()
  })

  it('refuses a state whose session cookie expired while another cookie is still live', () => {
    // The applied-state check passes this state: its only live cookie applies.
    const stale: StorageStateFile = {
      cookies: [
        { ...cookie, name: 'syn_session', value: 'old-session', domain: '.synthetic.invalid', expires: now - 60 },
        { ...cookie, name: 'syn_consent', value: 'yes', domain: '.synthetic.invalid', expires: now + 1800 },
      ],
      origins: [],
    }
    const applied = { cookies: [{ name: 'syn_consent', domain: '.synthetic.invalid', path: '/' }], origins: [] }
    expect(() => assertStorageStateApplied(checkStorageStateApplied(stale, applied, now), 'profile-a')).not.toThrow()
    const message = thrownMessage(() =>
      assertStorageStateSession(checkStorageStateSession(stale, applied, session, now), 'profile-a'))
    expect(message).toContain('Storage state for profile-a does not carry a live signed-in session '
      + '(session cookies 0/1, provider-site cookies 1)')
    expect(message).not.toMatch(secretLike)
    // An entry that expired in the file never counts, even if the context
    // reports a cookie with the same name, domain and path.
    const reported = { cookies: [...applied.cookies, { name: 'syn_session', domain: '.synthetic.invalid', path: '/' }], origins: [] }
    expect(checkStorageStateSession(stale, reported, session, now).sessionCookiesApplied).toBe(0)
  })

  it('refuses a signed-out state and a state saved for another site', () => {
    const signedOut = { ...state, cookies: state.cookies.filter(entry => entry.name !== 'syn_session') }
    const signedOutApplied = { cookies: appliedCookies.slice(1), origins: appliedOrigins }
    expect(() => assertStorageStateSession(checkStorageStateSession(signedOut, signedOutApplied, session, now), 'profile-a'))
      .toThrow('(session cookies 0/1, provider-site cookies 1)')
    const otherSite = { site: 'other.invalid', cookieNames: ['syn_session'] }
    expect(() => assertStorageStateSession(
      checkStorageStateSession(state, { cookies: appliedCookies, origins: appliedOrigins }, otherSite, now),
      'profile-a',
    )).toThrow('(session cookies 0/1, provider-site cookies 0)')
  })

  it('refuses a declared session cookie that did not reach the profile', () => {
    const check = checkStorageStateSession(state, { cookies: appliedCookies.slice(1), origins: [] }, session, now)
    expect(check).toMatchObject({ sessionCookiesApplied: 0, sessionCookiesExpected: 1 })
  })

  it('refuses a requirement with no cookie names', () => {
    const check = checkStorageStateSession(state, { cookies: appliedCookies, origins: [] }, { ...session, cookieNames: [] }, now)
    expect(() => assertStorageStateSession(check, 'profile-a'))
      .toThrow('Storage state for profile-a has no declared session cookies to check.')
  })
})

describe('E2E storage-state pair check', () => {
  const withDirectory = async (run: (directory: string) => Promise<void>): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'syncyourjoy-storage-state-pair-'))
    try {
      await run(directory)
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  const other: StorageStateFile = {
    ...state,
    cookies: state.cookies.map(entry => ({ ...entry, value: `${entry.value}-other` })),
  }

  it('accepts two different signed-in states', async () => {
    await withDirectory(async (directory) => {
      await writeFile(join(directory, 'a.json'), JSON.stringify(state))
      await writeFile(join(directory, 'b.json'), JSON.stringify(other))
      await expect(assertDistinctStorageStateFiles(join(directory, 'a.json'), join(directory, 'b.json'), session))
        .resolves.toBeUndefined()
    })
  })

  it('refuses one file reached twice, identical copies and a shared session cookie', async () => {
    await withDirectory(async (directory) => {
      const a = join(directory, 'a.json')
      await writeFile(a, JSON.stringify(state))
      await symlink(a, join(directory, 'link.json'))
      await writeFile(join(directory, 'copy.json'), JSON.stringify(state))
      await writeFile(join(directory, 'shared.json'), JSON.stringify({
        ...other,
        cookies: [state.cookies[0], ...other.cookies.slice(1)],
      }))
      const failures = await Promise.all(['link.json', 'copy.json', 'shared.json'].map(name =>
        assertDistinctStorageStateFiles(a, join(directory, name), session).then(() => '', String)))
      expect(failures[0]).toContain('The two storage states are the same file.')
      expect(failures[1]).toContain('The two storage states have identical contents.')
      expect(failures[2]).toContain('The two storage states share a session cookie')
      for (const failure of failures)
        expect(failure).not.toMatch(secretLike)
    })
  })
})

describe('E2E storage-state privacy guards', () => {
  it('refuses Playwright debug modes that log protocol parameters', () => {
    expect(secretLoggingSource({})).toBeUndefined()
    expect(secretLoggingSource({ PWDEBUG: '1' })).toBe('PWDEBUG')
    expect(secretLoggingSource({ PWDEBUG: 'console' })).toBe('PWDEBUG')
    expect(secretLoggingSource({ PWDEBUG: '0' })).toBeUndefined()
    expect(secretLoggingSource({ PWPAUSE: '1' })).toBe('PWPAUSE')
    for (const debug of ['pw:protocol', 'pw:channel', 'pw:*', '*', 'app:*,pw:server:*', 'pw:api pw:protocol'])
      expect(secretLoggingSource({ DEBUG: debug }), debug).toBe('DEBUG')
    for (const debug of ['pw:api', 'pw:browser', 'app:*', 'pw:*,-pw:protocol,-pw:channel,-pw:server:channel'])
      expect(secretLoggingSource({ DEBUG: debug }), debug).toBeUndefined()
    expect(() => assertNoSecretLogging('profile-a', { DEBUG: 'pw:protocol' }))
      .toThrow('Storage state for profile-a was not applied because DEBUG is set')
  })

  it('names the runner artifacts that are on', () => {
    expect(enabledRunnerArtifacts({ trace: 'off', screenshot: 'off', video: 'off' })).toEqual([])
    expect(enabledRunnerArtifacts({})).toEqual([])
    expect(enabledRunnerArtifacts({ trace: 'on', screenshot: { mode: 'only-on-failure' }, video: { mode: 'off' } }))
      .toEqual(['trace', 'screenshot'])
    expect(enabledRunnerArtifacts({ trace: { mode: 'retain-on-failure' }, video: 'on-first-retry' }))
      .toEqual(['trace', 'video'])
  })
})

describe('E2E storage-state file parsing', () => {
  it('accepts the Playwright storage-state shape', () => {
    expect(parseStorageStateFile(JSON.stringify(state), 'profile-a')).toEqual(state)
    expect(parseStorageStateFile(JSON.stringify({ cookies: state.cookies }), 'profile-a').origins).toEqual([])
  })

  it('rejects invalid JSON without echoing file contents', () => {
    const broken = '{"cookies":[{"name":"syn_session","value":"synthetic-session"'
    const message = thrownMessage(() => parseStorageStateFile(broken, 'profile-a'))
    expect(message).toContain('Storage state for profile-a is not valid JSON.')
    expect(message).not.toMatch(secretLike)
  })

  it('rejects files that are not storage states', () => {
    for (const value of [null, [], {}, { cookies: {} }, { cookies: [{ name: 'syn_session' }] }, { cookies: [], origins: [{ origin: 1 }] }]) {
      expect(() => parseStorageStateFile(JSON.stringify(value), 'profile-a'))
        .toThrow('Storage state for profile-a is not a Playwright storage-state file.')
    }
  })

  it('reports an unreadable file by error code only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syncyourjoy-storage-state-test-'))
    try {
      await expect(readStorageStateFile(join(directory, 'missing.json'), 'profile-a'))
        .rejects.toThrow('Storage state for profile-a could not be read (ENOENT).')
      const path = join(directory, 'state.json')
      await writeFile(path, JSON.stringify(state))
      await expect(readStorageStateFile(path, 'profile-a')).resolves.toEqual(state)
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
