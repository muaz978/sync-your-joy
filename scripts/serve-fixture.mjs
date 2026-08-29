import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const port = Number(process.env.SYNCYOURJOY_FIXTURE_PORT ?? 8788)
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
