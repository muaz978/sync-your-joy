/**
 * WebExtensions expose the standards-based `browser` namespace in Firefox and
 * Safari, while Chromium exposes `chrome`. Chromium also exposes `chrome` in
 * Firefox compatibility mode, so this keeps the existing callback-compatible
 * API while preferring the standards namespace when it exists.
 */
export const browserApi = ((globalThis as typeof globalThis & { browser?: typeof chrome }).browser ?? chrome)

