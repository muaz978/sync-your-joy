import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADAPTIVE_SEGMENT_DURATION_SECONDS = 4
export const ADAPTIVE_DURATION_SECONDS = 120

interface FragmentedMedia {
  init: Buffer
  segments: Buffer[]
}

export interface AdaptiveFixtureServer {
  origin: string
  manifest: {
    durationSeconds: number
    segmentDurationSeconds: number
    segmentCount: number
  }
  close: () => Promise<void>
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const pagePath = resolve(root, 'fixtures/adaptive-player.html')
const mediaPath = resolve(root, 'fixtures/adaptive-test-clip.mp4')

export async function createAdaptiveFixtureServer(): Promise<AdaptiveFixtureServer> {
  const [page, media] = await Promise.all([readFile(pagePath), readFile(mediaPath)])
  const fragmentedMedia = parseFragmentedMp4(media)

  const server = createServer((request, response) => {
    void routeRequest(request, response, page, fragmentedMedia)
  })
  await new Promise<void>((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Adaptive fixture server did not expose a TCP address.')
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    manifest: {
      durationSeconds: ADAPTIVE_DURATION_SECONDS,
      segmentDurationSeconds: ADAPTIVE_SEGMENT_DURATION_SECONDS,
      segmentCount: fragmentedMedia.segments.length,
    },
    close: () => closeServer(server),
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  page: Buffer,
  media: FragmentedMedia,
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('cache-control', 'no-store')

  if (requestUrl.pathname === '/adaptive-player.html' || requestUrl.pathname === '/adaptive-autostart.html') {
    send(response, 200, 'text/html; charset=utf-8', page)
    return
  }

  if (requestUrl.pathname === '/adaptive-manifest.json') {
    sendJson(response, 200, {
      durationSeconds: ADAPTIVE_DURATION_SECONDS,
      segmentDurationSeconds: ADAPTIVE_SEGMENT_DURATION_SECONDS,
      segmentCount: media.segments.length,
      initUrl: '/adaptive/init.mp4',
      segmentUrl: '/adaptive/segment/{index}.mp4',
    })
    return
  }

  if (requestUrl.pathname === '/adaptive/init.mp4') {
    send(response, 200, 'video/mp4', media.init)
    return
  }

  const segmentMatch = requestUrl.pathname.match(/^\/adaptive\/segment\/(\d+)\.mp4$/)
  if (segmentMatch) {
    const index = Number(segmentMatch[1])
    const segment = media.segments[index]
    if (!segment) {
      sendJson(response, 404, { error: 'unknown-segment', index })
      return
    }

    const delayMs = boundedInteger(requestUrl.searchParams.get('delayMs'), 0, 0, 2_000)
    const missing = requestUrl.searchParams.get('missing') === '1'
    if (delayMs > 0)
      await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs))
    if (missing) {
      sendJson(response, 404, { error: 'controlled-missing-segment', index, delayMs })
      return
    }

    response.setHeader('x-syncyourjoy-fixture-segment', String(index))
    response.setHeader('x-syncyourjoy-fixture-delay-ms', String(delayMs))
    send(response, 200, 'video/mp4', segment)
    return
  }

  sendJson(response, 404, { error: 'not-found' })
}

function parseFragmentedMp4(media: Buffer): FragmentedMedia {
  const boxes = readTopLevelBoxes(media)
  const firstMoofIndex = boxes.findIndex(box => box.type === 'moof')
  if (firstMoofIndex < 0)
    throw new Error('Adaptive fixture media has no fragmented MP4 moof box.')

  const firstMoof = boxes[firstMoofIndex]
  if (!firstMoof)
    throw new Error('Adaptive fixture first moof box is missing.')
  const initEnd = firstMoof.offset
  const segments: Buffer[] = []
  for (let index = firstMoofIndex; index < boxes.length; index++) {
    const current = boxes[index]
    if (!current || current.type !== 'moof')
      continue
    const following = boxes[index + 1]
    if (!following || following.type !== 'mdat')
      throw new Error(`Adaptive fixture moof at ${current.offset} has no mdat box.`)
    segments.push(media.subarray(current.offset, following.offset + following.size))
  }
  if (segments.length < 2)
    throw new Error('Adaptive fixture media must contain multiple MSE segments.')
  return { init: media.subarray(0, initEnd), segments }
}

function readTopLevelBoxes(media: Buffer): Array<{ type: string, offset: number, size: number }> {
  const boxes: Array<{ type: string, offset: number, size: number }> = []
  let offset = 0
  while (offset + 8 <= media.length) {
    const start = offset
    let size = media.readUInt32BE(offset)
    const type = media.toString('ascii', offset + 4, offset + 8)
    offset += 8
    if (size === 1) {
      if (offset + 8 > media.length)
        throw new Error(`Invalid extended MP4 box at ${start}.`)
      const extendedSize = media.readBigUInt64BE(offset)
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(`MP4 box at ${start} is too large.`)
      size = Number(extendedSize)
      offset += 8
    }
    else if (size === 0) {
      size = media.length - start
    }
    if (size < offset - start || start + size > media.length)
      throw new Error(`Invalid MP4 box size at ${start}.`)
    boxes.push({ type, offset: start, size })
    offset = start + size
  }
  return boxes
}

function boundedInteger(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
}

function send(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, { 'content-type': contentType, 'content-length': body.length })
  response.end(body)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify(body)}\n`))
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening)
    return
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose())
  })
}
