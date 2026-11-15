// Serves a local test page for a manual (headed) run with the real extension.
//
//   npm run dev:fixture                 the generic player page, as before
//   npm run dev:fixture -- --adaptive   the adaptive MSE fixture
//
// The adaptive mode serves fixtures/adaptive-player.html and its fragmented MP4
// from the same server the E2E specs use (tests/e2e/adaptive-fixture-server.ts),
// on a fixed port so the address survives a restart. It needs a Node that runs
// TypeScript files directly (22.18 or newer, or 24 and later).
//
// The adaptive page opens a nested cross-origin frame (`127.0.0.1` becomes
// `localhost`), so open it on `127.0.0.1`. Its controls and query parameters
// are listed in docs/CR_D02_ADAPTIVE_FIXTURES.md.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const adaptive = process.argv.includes('--adaptive') || process.env.SYNCYOURJOY_FIXTURE === 'adaptive'
const port = Number(process.env.SYNCYOURJOY_FIXTURE_PORT ?? 8788)

if (adaptive) {
  let createAdaptiveFixtureServer
  try {
    ({ createAdaptiveFixtureServer } = await import('../tests/e2e/adaptive-fixture-server.ts'))
  }
  catch (error) {
    console.error('The adaptive fixture is written in TypeScript and this Node cannot run it directly.')
    console.error(`Use Node 22.18 or newer. (${error instanceof Error ? error.message : String(error)})`)
    process.exit(1)
  }
  const fixture = await createAdaptiveFixtureServer({ port })
  console.log(`SyncYourJoy adaptive fixture: ${fixture.origin}/adaptive-player.html`)
  console.log(`  starts loading on its own:  ${fixture.origin}/adaptive-autostart.html`)
  console.log(`  query parameters:           autostart=1 delaySegment=N delayMs=50|80|120|250|500|1000|2000 missingSegment=N disjoint=1 rateReset=1`)
  const stop = () => void fixture.close().then(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
else {
  const fixturePath = resolve('fixtures/generic-player.html')
  const fixture = await readFile(fixturePath)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(fixture)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`SyncYourJoy fixture: http://127.0.0.1:${port}/generic-player`)
  })
  process.once('SIGINT', () => server.close(() => process.exit(0)))
  process.once('SIGTERM', () => server.close(() => process.exit(0)))
}
