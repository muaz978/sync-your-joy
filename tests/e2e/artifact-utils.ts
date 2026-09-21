import { basename } from 'node:path'

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

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'`]+/g, match => sanitizeBrowserUrl(match))
    .replace(/\b(password|passwd|token|cookie|secret|authorization)=([^\s&]+)/gi, '$1=<redacted>')
}

export function sanitizeError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sanitizeDiagnosticText(error.message),
      ...(error.stack ? { stack: sanitizeDiagnosticText(error.stack) } : {}),
    }
  }
  return { message: sanitizeDiagnosticText(String(error)) }
}

export function artifactFileName(label: string, suffix: string): string {
  return `${basename(label).replace(/[^a-zA-Z0-9._-]+/g, '_')}.${suffix}`
}
