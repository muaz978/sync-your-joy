import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SanitizedArtifactEvent {
  at: string
  type: string
  details?: Record<string, unknown>
}

export function sanitizeBrowserUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'chrome-extension:')
      return `${url.protocol}//${url.host}${url.pathname}`
    return `${url.protocol}//redacted`
  }
  catch {
    return '<invalid-url>'
  }
}

// Control Sequence Introducers (colors, cursor moves), OSC strings (titles,
// hyperlinks) and the remaining two-character escapes.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g

// A path segment: anything but a separator, whitespace, a quote or a bracket.
// `:` stays in, so `x.ts:10:5` is one segment.
const SEGMENT = '[^\\s/\\\\"\'`<>|(){}\\[\\],;]+'
// An absolute POSIX path of at least two segments that does not continue a
// word or a host (`host/a/b`, `[::1]/a/b`), a URL scheme (`://host/a/b`: the
// second slash follows a slash), a relative path (`./a/b`), a masked path
// (`<path>/a/b`), a home shorthand (`~/a/b`) or a user or option (`user@/a/b`,
// `-/a/b`). A colon is not in the list, so `cwd:/home/someone/x` is masked.
const POSIX_PATH = new RegExp(`(?<![\\w/.<>~@\\]-])(?:/${SEGMENT}){2,}`, 'g')
// `C:\Users\someone\repo\x.ts` or `C:/Users/...`, after a non-word character.
const WINDOWS_PATH = new RegExp(`(?<![\\w])[A-Za-z]:[\\\\/](?:${SEGMENT}[\\\\/])*${SEGMENT}`, 'g')

/**
 * What stays of an absolute path: `<path>` and its last two segments, never
 * the first two (`/home/<user>`, `C:\Users\<user>`, `/Users/<user>`), which
 * is where a user name sits. `/home/someone/work/repo/tests/e2e/x.ts:10`
 * becomes `<path>/e2e/x.ts:10`, which still says which file failed.
 */
function maskedPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  const tail = segments.slice(2).slice(-2)
  return tail.length > 0 ? `<path>/${tail.join('/')}` : '<path>'
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replaces a known directory (and its other-separator spelling) where it starts a path. */
function replaceDirectory(text: string, directory: string, marker: string): string {
  const spellings = new Set([directory, directory.replaceAll('\\', '/'), directory.replaceAll('/', '\\')])
  let result = text
  for (const spelling of spellings) {
    if (spelling.length < 2 || /^[\\/]+$/.test(spelling))
      continue
    result = result.replace(
      new RegExp(`(?<![\\w/:.<>~@-])${escapeRegExp(spelling.replace(/[\\/]+$/, ''))}(?=$|[\\\\/\\s"'\`)\\]},;:])`, 'g'),
      marker,
    )
  }
  return result
}

/** The nearest directory at or above `fromDirectory` that has a `.git`, or null. */
export function findRepositoryRoot(fromDirectory: string): string | null {
  let current = resolve(fromDirectory)
  for (;;) {
    if (existsSync(resolve(current, '.git')))
      return current
    const parent = dirname(current)
    if (parent === current)
      return null
    current = parent
  }
}

export interface SanitizeOptions {
  /** The repository root, shown as `<repo>`. Defaults to the repository this file is in; `null` for none. */
  repositoryRoot?: string | null
  /** The home directory, shown as `<home>`. Defaults to the current user's; `null` for none. */
  homeDirectory?: string | null
}

/**
 * Text that goes into an artifact file. In this order it: strips ANSI escape
 * sequences, reduces http(s) URLs to scheme, host and path, turns the
 * repository root into `<repo>` and the home directory into `<home>`, masks any
 * other absolute POSIX or Windows path (see maskedPath), and redacts
 * `password=`, `token=` and similar pairs.
 *
 * URL paths are not touched by the path rules: a path that continues a URL or
 * a `scheme://` is not an absolute path. A path with a space in it is only
 * recognized up to the space unless it is the repository or the home
 * directory, which are replaced as a whole.
 */
export function sanitizeDiagnosticText(value: string, options: SanitizeOptions = {}): string {
  const repositoryRoot = options.repositoryRoot === undefined ? defaultRepositoryRoot() : options.repositoryRoot
  const homeDirectory = options.homeDirectory === undefined ? safeHomeDirectory() : options.homeDirectory
  let text = value
    .replace(ANSI_ESCAPE, '')
    .replace(/https?:\/\/[^\s"'`]+/g, match => sanitizeBrowserUrl(match))
    // A file:// URL is a path; its slashes would otherwise protect it.
    .replace(/\bfile:\/\/\/(?=[A-Za-z]:)/gi, '')
    .replace(/\bfile:\/\/(?=\/)/gi, '')
  if (repositoryRoot)
    text = replaceDirectory(text, repositoryRoot, '<repo>')
  if (homeDirectory)
    text = replaceDirectory(text, homeDirectory, '<home>')
  return text
    .replace(WINDOWS_PATH, match => maskedPath(match.slice(2)))
    .replace(POSIX_PATH, match => maskedPath(match))
    .replace(/\b(password|passwd|token|cookie|secret|authorization)=([^\s&]+)/gi, '$1=<redacted>')
}

let cachedRepositoryRoot: string | null | undefined
function defaultRepositoryRoot(): string | null {
  cachedRepositoryRoot ??= findRepositoryRoot(dirname(fileURLToPath(import.meta.url)))
  return cachedRepositoryRoot
}

function safeHomeDirectory(): string | null {
  try {
    return homedir()
  }
  catch {
    return null
  }
}

export function sanitizeError(error: unknown, options: SanitizeOptions = {}): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeDiagnosticText(error.message, options),
      ...(error.stack ? { stack: sanitizeDiagnosticText(error.stack, options) } : {}),
    }
  }
  return { message: sanitizeDiagnosticText(String(error), options) }
}

export function artifactFileName(label: string, suffix: string): string {
  return `${basename(label).replace(/[^a-zA-Z0-9._-]+/g, '_')}.${suffix}`
}
