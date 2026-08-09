import { writeFile } from 'node:fs/promises'
import WebSocket from 'ws'

const [, , endpoint, targetUrl, outputPath] = process.argv
if (!endpoint || !targetUrl || !outputPath)
  throw new Error('Usage: node scripts/capture-cdp.mjs <endpoint> <target-url> <output-path>')

const created = await fetch(`${endpoint}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
if (!created.ok)
  throw new Error(`Could not open target: ${created.status}`)

const target = await created.json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let nextId = 0
const pending = new Map()
let loaded = false

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString())
  if (message.method === 'Page.loadEventFired')
    loaded = true
  if (!message.id)
    return
  const request = pending.get(message.id)
  if (!request)
    return
  pending.delete(message.id)
  if (message.error)
    request.reject(new Error(message.error.message))
  else
    request.resolve(message.result)
})

function send(method, params = {}) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 380,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})

for (let attempt = 0; attempt < 40 && !loaded; attempt += 1)
  await new Promise(resolve => setTimeout(resolve, 50))
await new Promise(resolve => setTimeout(resolve, 400))

const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'))
socket.close()
console.log(`Captured ${outputPath}`)
