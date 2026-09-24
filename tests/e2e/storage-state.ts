// Storage-state handling for the persistent extension profiles (issue #30).
//
// Playwright 1.63 has no `storageState` option on
// `chromium.launchPersistentContext`: the client reads the file, then the
// protocol validator drops the key and the persistent context starts empty,
// with no error. extension-profile.ts therefore applies the state with the
// supported `BrowserContext.setStorageState` call and uses these helpers to
// prove it arrived before any provider page opens.
//
// Nothing here returns or throws cookie names, values, domains, origins,
// localStorage keys or file contents. Real provider states are authentication
// material, so errors and summaries carry the profile label and counts only.
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { BrowserContext } from '@playwright/test'

/** Matched by artifact-reporter.ts, which then records a setup failure. */
const setupMarker = '[browser-launch]'

export type StorageStateFile = Exclude<Parameters<BrowserContext['setStorageState']>[0], string>

type CookieIdentity = { name: string, domain: string, path: string, partitionKey?: unknown }

/** The subset of `BrowserContext.storageState()` the check compares. */
export interface AppliedStorageState {
  cookies: CookieIdentity[]
  origins: Array<{ origin: string, localStorage: Array<{ name: string }> }>
}

export interface StorageStateCheck {
  cookiesExpected: number
  cookiesApplied: number
  /** Cookies already expired in the file. Chrome discards them on write. */
  cookiesExpiredInFile: number
  localStorageOriginsExpected: number
  localStorageOriginsApplied: number
  localStorageKeysExpected: number
  localStorageKeysApplied: number
}

/**
 * What a signed-in provider state must carry. The names identify the
 * session cookies. They are configuration, never cookie values.
 */
export interface StorageStateSession {
  /** Provider site, such as `crunchyroll.com`. The host and its subdomains match. */
  site: string
  cookieNames: readonly string[]
}

export interface StorageStateSessionCheck {
  /** Unexpired cookies on the provider site that reached the profile. */
  siteCookiesApplied: number
  sessionCookiesExpected: number
  /** Declared session cookies that are unexpired in the file and reached the profile. */
  sessionCookiesApplied: number
}

export async function readStorageStateFile(path: string, label: string): Promise<StorageStateFile> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  }
  catch (error) {
    throw new Error(`Storage state for ${label} could not be read (${errorCode(error)}).`)
  }
  return parseStorageStateFile(text, label)
}

export function parseStorageStateFile(text: string, label: string): StorageStateFile {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    // JSON.parse messages quote the surrounding source text, which here would
    // be cookie values, so the original message is deliberately dropped.
    throw new Error(`Storage state for ${label} is not valid JSON.`)
  }
  const state = value as { cookies?: unknown, origins?: unknown } | null
  const cookies: unknown = state?.cookies
  const origins: unknown = state?.origins ?? []
  const isRecord = (entry: unknown): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null
  const valid = Array.isArray(cookies)
    && Array.isArray(origins)
    && cookies.every(cookie => isRecord(cookie)
      && typeof cookie.name === 'string'
      && typeof cookie.domain === 'string'
      && typeof cookie.path === 'string')
    && origins.every(origin => isRecord(origin)
      && typeof origin.origin === 'string'
      && Array.isArray(origin.localStorage)
      && origin.localStorage.every(entry => isRecord(entry) && typeof entry.name === 'string'))
  if (!valid)
    throw new Error(`Storage state for ${label} is not a Playwright storage-state file.`)
  // Any other malformed field is rejected by Playwright's own protocol
  // validator, whose messages name the field path and type, never the value.
  return { ...(state as StorageStateFile), origins: origins as StorageStateFile['origins'] }
}

/**
 * Compares the file with what the context reports after `setStorageState`.
 * Cookies match by name, domain, path and whether they are partitioned, and
 * are counted with multiplicity, so each of two partitioned cookies that
 * differ only by partition must arrive.
 */
export function checkStorageStateApplied(
  expected: StorageStateFile,
  actual: AppliedStorageState,
  nowSeconds: number,
): StorageStateCheck {
  const liveCookies = expected.cookies.filter(cookie => isLiveCookie(cookie, nowSeconds))
  const appliedCounts = countKeys(actual.cookies.map(cookieKey))
  let cookiesApplied = 0
  for (const [key, count] of countKeys(liveCookies.map(cookieKey)))
    cookiesApplied += Math.min(count, appliedCounts.get(key) ?? 0)

  const expectedOrigins = expected.origins.filter(origin => origin.localStorage.length > 0)
  let localStorageOriginsApplied = 0
  let localStorageKeysExpected = 0
  let localStorageKeysApplied = 0
  for (const origin of expectedOrigins) {
    const keys = new Set(origin.localStorage.map(entry => entry.name))
    const appliedKeys = new Set(actual.origins
      .filter(candidate => candidate.origin === origin.origin)
      .flatMap(candidate => candidate.localStorage.map(entry => entry.name)))
    const present = [...keys].filter(key => appliedKeys.has(key)).length
    localStorageKeysExpected += keys.size
    localStorageKeysApplied += present
    if (present === keys.size)
      localStorageOriginsApplied++
  }

  return {
    cookiesExpected: liveCookies.length,
    cookiesApplied,
    cookiesExpiredInFile: expected.cookies.length - liveCookies.length,
    localStorageOriginsExpected: expectedOrigins.length,
    localStorageOriginsApplied,
    localStorageKeysExpected,
    localStorageKeysApplied,
  }
}

/**
 * Fails closed: an authenticated provider run must never continue with a
 * profile that is missing any part of its saved state.
 */
export function assertStorageStateApplied(check: StorageStateCheck, label: string): void {
  if (check.cookiesExpected === 0) {
    throw new Error(`Storage state for ${label} has no unexpired cookies `
      + `(${check.cookiesExpiredInFile} expired). Refresh the protected storage state.`)
  }
  if (check.cookiesApplied !== check.cookiesExpected
    || check.localStorageOriginsApplied !== check.localStorageOriginsExpected
    || check.localStorageKeysApplied !== check.localStorageKeysExpected) {
    throw new Error(`Storage state for ${label} was not fully applied (${describeStorageStateCheck(check)}). `
      + 'The profile would run without its saved session, so the launch was stopped.')
  }
}

export function describeStorageStateCheck(check: StorageStateCheck): string {
  const expired = check.cookiesExpiredInFile
    ? ` (${check.cookiesExpiredInFile} expired in file, skipped)`
    : ''
  return `cookies ${check.cookiesApplied}/${check.cookiesExpected}${expired}, `
    + `localStorage origins ${check.localStorageOriginsApplied}/${check.localStorageOriginsExpected}, `
    + `keys ${check.localStorageKeysApplied}/${check.localStorageKeysExpected}`
}

/**
 * The applied-state check alone passes for a state whose session cookie has
 * expired or that was saved signed out, as long as any other cookie is live.
 * This check requires every declared session cookie to be unexpired in the
 * file and present in the profile. It still cannot see a session that the
 * provider revoked on its side.
 */
export function checkStorageStateSession(
  expected: StorageStateFile,
  actual: AppliedStorageState,
  session: StorageStateSession,
  nowSeconds: number,
): StorageStateSessionCheck {
  const appliedCookies = new Set(actual.cookies.map(cookieKey))
  const liveSiteCookies = expected.cookies.filter(cookie => isLiveCookie(cookie, nowSeconds)
    && isOnSite(cookie.domain, session.site)
    && appliedCookies.has(cookieKey(cookie)))
  const names = new Set(session.cookieNames)
  return {
    siteCookiesApplied: liveSiteCookies.length,
    sessionCookiesExpected: names.size,
    sessionCookiesApplied: [...names].filter(name => liveSiteCookies.some(cookie => cookie.name === name)).length,
  }
}

export function assertStorageStateSession(check: StorageStateSessionCheck, label: string): void {
  if (check.sessionCookiesExpected === 0)
    throw new Error(`Storage state for ${label} has no declared session cookies to check.`)
  if (check.sessionCookiesApplied !== check.sessionCookiesExpected) {
    throw new Error(`Storage state for ${label} does not carry a live signed-in session `
      + `(${describeStorageStateSessionCheck(check)}). It may be expired, signed out or saved for another site. `
      + 'Refresh the protected storage state.')
  }
}

export function describeStorageStateSessionCheck(check: StorageStateSessionCheck): string {
  return `session cookies ${check.sessionCookiesApplied}/${check.sessionCookiesExpected}, `
    + `provider-site cookies ${check.siteCookiesApplied}`
}

/**
 * Two-profile acceptance needs two sessions. Refuses two paths to one file,
 * two identical files, and two files that share a declared session cookie.
 * Compares in memory and reports only which of those it found.
 */
export async function assertDistinctStorageStateFiles(
  pathA: string,
  pathB: string,
  session: StorageStateSession,
): Promise<void> {
  const resolve = async (path: string): Promise<string> => {
    try {
      return await realpath(path)
    }
    catch (error) {
      throw new Error(`A storage state could not be resolved (${errorCode(error)}).`)
    }
  }
  const failure = 'Each profile needs its own signed-in account.'
  if (await resolve(pathA) === await resolve(pathB))
    throw new Error(`The two storage states are the same file. ${failure}`)

  const [textA, textB] = await Promise.all([pathA, pathB].map(async (path) => {
    try {
      return await readFile(path, 'utf8')
    }
    catch (error) {
      throw new Error(`A storage state could not be read (${errorCode(error)}).`)
    }
  })) as [string, string]
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
  if (digest(textA) === digest(textB))
    throw new Error(`The two storage states have identical contents. ${failure}`)

  const sessionValues = (state: StorageStateFile): Set<string> => new Set(state.cookies
    .filter(cookie => session.cookieNames.includes(cookie.name) && isOnSite(cookie.domain, session.site))
    .map(cookie => JSON.stringify([cookieKey(cookie), cookie.value])))
  const valuesA = sessionValues(parseStorageStateFile(textA, 'profile A'))
  const valuesB = sessionValues(parseStorageStateFile(textB, 'profile B'))
  if ([...valuesA].some(value => valuesB.has(value)))
    throw new Error(`The two storage states share a session cookie, so both profiles would be one session. ${failure}`)
}

/**
 * Everything an authenticated provider run must prove before any profile
 * launches: the runner's own trace, screenshots and video are off, and the
 * two states are two different sessions. Refusals carry the `[browser-launch]`
 * marker, so the artifact reporter records them as setup failures rather than
 * product assertions.
 */
export async function preflightAuthenticatedRun(
  runnerArtifacts: { trace?: unknown, screenshot?: unknown, video?: unknown },
  pathA: string,
  pathB: string,
  session: StorageStateSession,
): Promise<void> {
  try {
    const enabled = enabledRunnerArtifacts(runnerArtifacts)
    if (enabled.length > 0)
      throw new Error(`Playwright runner ${enabled.join(', ')} must stay off for authenticated provider runs.`)
    await assertDistinctStorageStateFiles(pathA, pathB, session)
  }
  catch (error) {
    throw new Error(`${setupMarker} ${(error as Error).message}`)
  }
}

/**
 * Repeats the helper's fail-closed result after launch, so a provider run can
 * never start unauthenticated if the helper changes. Carries the setup marker.
 */
export function assertLaunchedWithSession(
  check: StorageStateCheck | undefined,
  sessionCheck: StorageStateSessionCheck | undefined,
  session: StorageStateSession,
  label: string,
): void {
  const applied = check !== undefined
    && check.cookiesExpected > 0
    && check.cookiesApplied === check.cookiesExpected
    && check.localStorageOriginsApplied === check.localStorageOriginsExpected
    && check.localStorageKeysApplied === check.localStorageKeysExpected
  const signedIn = sessionCheck !== undefined
    && sessionCheck.sessionCookiesExpected === new Set(session.cookieNames).size
    && sessionCheck.sessionCookiesApplied === sessionCheck.sessionCookiesExpected
  if (!applied || !signedIn)
    throw new Error(`${setupMarker} Profile ${label} did not report a fully applied, signed-in storage state.`)
}

/**
 * Playwright's own debug channels print every protocol parameter, so they
 * would print the saved cookies and localStorage values. Returns the name of
 * the variable that turns one on, if any.
 */
export function secretLoggingSource(env: Record<string, string | undefined> = process.env): string | undefined {
  for (const name of ['PWDEBUG', 'PWPAUSE']) {
    const value = env[name]
    if (value && value !== '0')
      return name
  }
  const debug = env.DEBUG
  if (debug && ['pw:protocol', 'pw:channel', 'pw:server:channel'].some(namespace => debugEnables(debug, namespace)))
    return 'DEBUG'
  return undefined
}

export function assertNoSecretLogging(label: string, env: Record<string, string | undefined> = process.env): void {
  const source = secretLoggingSource(env)
  if (source) {
    throw new Error(`Storage state for ${label} was not applied because ${source} is set, `
      + `and Playwright would log the saved cookies. Unset ${source} and rerun.`)
  }
}

/**
 * The Playwright runner's `trace`, `screenshot` and `video` options, reduced
 * to the names of the ones that are on. Any of them would capture a provider
 * profile's session or pages.
 */
export function enabledRunnerArtifacts(options: { trace?: unknown, screenshot?: unknown, video?: unknown }): string[] {
  const mode = (value: unknown): unknown =>
    typeof value === 'object' && value !== null ? (value as { mode?: unknown }).mode : value
  return (['trace', 'screenshot', 'video'] as const)
    .filter(name => (mode(options[name]) ?? 'off') !== 'off')
}

function isLiveCookie(cookie: { expires?: number }, nowSeconds: number): boolean {
  return typeof cookie.expires !== 'number' || cookie.expires <= 0 || cookie.expires > nowSeconds
}

/**
 * Chrome keeps the leading dot of a domain cookie on a host name, and the dot
 * is what separates it from a host-only cookie with the same name, so it
 * stays in the key. An IP address has no subdomains and Chrome reports
 * `.127.0.0.1` as `127.0.0.1`, so the dot is dropped there only. Chrome
 * rewrites a partition key to its top-level site, so the key records only
 * whether the cookie is partitioned. `checkStorageStateApplied` counts keys
 * with multiplicity, so partitioned siblings are not merged.
 */
function cookieKey(cookie: CookieIdentity): string {
  const domain = cookie.domain.toLowerCase()
  const bare = domain.replace(/^\./, '')
  const ipAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare) || /^\[?[\da-f]*:[\da-f:.]*\]?$/.test(bare)
  return JSON.stringify([cookie.name, ipAddress ? bare : domain, cookie.path, typeof cookie.partitionKey === 'string'])
}

function countKeys(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const key of keys)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  return counts
}

function isOnSite(domain: string, site: string): boolean {
  const host = domain.toLowerCase().replace(/^\./, '')
  const base = site.toLowerCase().replace(/^\./, '')
  return host === base || host.endsWith(`.${base}`)
}

/** Mirrors the `debug` package: a matching `-pattern` wins over any match. */
function debugEnables(setting: string, namespace: string): boolean {
  const matches = (pattern: string): boolean => new RegExp(`^${pattern.split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')}$`).test(namespace)
  const tokens = setting.split(/[\s,]+/).filter(Boolean)
  const skipped = tokens.some(token => token.startsWith('-') && matches(token.slice(1)))
  return !skipped && tokens.some(token => !token.startsWith('-') && matches(token))
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'read error'
}
