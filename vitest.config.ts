import { defineConfig } from 'vitest/config'

export default defineConfig({
  // apps/extension/src/service-worker.ts references this build-time
  // constant (normally substituted by scripts/build-extension.mjs' esbuild
  // `define`, see __ROOM_SERVER_URL__ there). Vitest transforms the module
  // through its own pipeline rather than that build script, so it needs the
  // same substitution here or importing the module in a test throws a
  // ReferenceError before any test code runs.
  define: {
    __ROOM_SERVER_URL__: JSON.stringify('ws://127.0.0.1:0/rooms'),
  },
  test: {
    coverage: {
      reporter: ['text', 'html'],
    },
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    // Real two-browser-profile E2E specs (tests/e2e/**/*.spec.ts) run under
    // Playwright via `npm run test:e2e`, never under vitest. The include
    // glob above already only matches *.test.ts, but tests/e2e/ is excluded
    // explicitly too so a stray *.test.ts added there is never silently
    // picked up by the fast unit-test run.
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
})
