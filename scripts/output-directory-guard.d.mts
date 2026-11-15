export const E2E_OUTPUT_ENV: 'SYNCYOURJOY_E2E_OUTPUT_DIR'
export const RELEASE_DIRECTORY: string

export function canonicalPath(path: string): string

export interface UniqueDirectoryParts {
  now?: number
  pid?: number
  uuid?: string
}

export function defaultE2EOutputDirectory(repoRoot: string, parts?: UniqueDirectoryParts): string

export interface E2EGuardOptions {
  repoRoot: string
  homeDirectory?: string
  tempDirectory?: string
  label?: string
}

export function assertSafeE2EOutputDirectory(directory: string, options: E2EGuardOptions): string

export interface ResolveE2EOutputOptions extends UniqueDirectoryParts {
  env?: Record<string, string | undefined>
  repoRoot: string
  fallbackDirectory?: string
  homeDirectory?: string
  tempDirectory?: string
}

export function resolveE2EOutputDirectory(options: ResolveE2EOutputOptions): { directory: string, overridden: boolean }

export interface BuildGuardOptions {
  repoRoot: string
  homeDirectory?: string
  label?: string
}

export function assertSafeBuildOutputDirectory(directory: string, options: BuildGuardOptions): string
