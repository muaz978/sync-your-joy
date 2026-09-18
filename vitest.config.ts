import { defineConfig } from 'vitest/config'

export default defineConfig({
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
