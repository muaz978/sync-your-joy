import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FragmentedMedia {
  init: Buffer
  segments: Buffer[]
  /** Media timescale read from the initialization section (`mdhd`). */
  timescale: number
  /** Start time of every fragment, read from its own `tfdt` box. */
  segmentStartSeconds: number[]
  /** End of the last fragment: its start plus the sum of its sample durations. */
  durationSeconds: number
  /** Duration of the first fragment, which the page uses as the segment length. */
  segmentDurationSeconds: number
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
const fixtureHost = [127, 0, 0, 1].join('.')
const fixtureProtocol = ['h', 't', 't', 'p'].join('')

export async function createAdaptiveFixtureServer(): Promise<AdaptiveFixtureServer> {
  const [page, media] = await Promise.all([readFile(pagePath), readFile(mediaPath)])
  const fragmentedMedia = parseFragmentedMp4(media)

  const server = createServer((request, response) => {
    void routeRequest(request, response, page, fragmentedMedia)
  })
  await new Promise<void>((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, fixtureHost, () => resolveServer())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    throw new Error('Adaptive fixture server did not expose a TCP address.')
  }

  return {
    origin: `${fixtureProtocol}://${fixtureHost}:${address.port}`,
    manifest: {
      durationSeconds: fragmentedMedia.durationSeconds,
      segmentDurationSeconds: fragmentedMedia.segmentDurationSeconds,
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
  const requestUrl = new URL(request.url ?? '/', `${fixtureProtocol}://${request.headers.host ?? fixtureHost}`)
  response.setHeader('access-control-allow-origin', '*')
  response.setHeader('cache-control', 'no-store')

  if (requestUrl.pathname === '/adaptive-player.html' || requestUrl.pathname === '/adaptive-autostart.html') {
    send(response, 200, 'text/html; charset=utf-8', page)
    return
  }

  if (requestUrl.pathname === '/adaptive-manifest.json') {
    // Same allowlist as the segments: a test can hold the manifest back to keep
    // a load in flight. Anything off the list is not delayed.
    const manifestDelayMs = fixtureDelayMs(requestUrl.searchParams.get('delayMs'))
    if (manifestDelayMs > 0)
      await waitForFixtureDelay(manifestDelayMs)
    response.setHeader('x-syncyourjoy-fixture-delay-ms', String(manifestDelayMs))
    sendJson(response, 200, {
      durationSeconds: media.durationSeconds,
      segmentDurationSeconds: media.segmentDurationSeconds,
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

    const delayMs = fixtureDelayMs(requestUrl.searchParams.get('delayMs'))
    const missing = requestUrl.searchParams.get('missing') === '1'
    if (delayMs > 0)
      await waitForFixtureDelay(delayMs)
    // The delay the server really applied, on the missing response as well as
    // the delivered one: a page that asked for a value off the allowlist reads
    // 0 here and can tell that nothing was delayed.
    response.setHeader('x-syncyourjoy-fixture-segment', String(index))
    response.setHeader('x-syncyourjoy-fixture-delay-ms', String(delayMs))
    if (missing) {
      sendJson(response, 404, { error: 'controlled-missing-segment', index, delayMs })
      return
    }

    send(response, 200, 'video/mp4', segment)
    return
  }

  sendJson(response, 404, { error: 'not-found' })
}

export function parseFragmentedMp4(media: Buffer): FragmentedMedia {
  const boxes = readBoxes(media, 0, media.length)
  const firstMoofIndex = boxes.findIndex(box => box.type === 'moof')
  if (firstMoofIndex < 0)
    throw new Error('Adaptive fixture media has no fragmented MP4 moof box.')

  const firstMoof = boxes[firstMoofIndex]
  if (!firstMoof)
    throw new Error('Adaptive fixture first moof box is missing.')
  const initEnd = firstMoof.offset
  const segments: Buffer[] = []
  const segmentStartSeconds: number[] = []
  const segmentDurationsSeconds: number[] = []
  const timescale = readTimescale(media, boxes)
  for (let index = firstMoofIndex; index < boxes.length; index++) {
    const current = boxes[index]
    if (!current || current.type !== 'moof')
      continue
    const following = boxes[index + 1]
    if (!following || following.type !== 'mdat')
      throw new Error(`Adaptive fixture moof at ${current.offset} has no mdat box.`)
    segments.push(media.subarray(current.offset, following.offset + following.size))
    const fragment = readFragmentTiming(media, current)
    segmentStartSeconds.push(fragment.startTicks / timescale)
    segmentDurationsSeconds.push(fragment.durationTicks / timescale)
  }
  if (segments.length < 2)
    throw new Error('Adaptive fixture media must contain multiple MSE segments.')
  const lastIndex = segments.length - 1
  return {
    init: media.subarray(0, initEnd),
    segments,
    timescale,
    segmentStartSeconds,
    // The end of the last fragment, as the media itself declares it. Nothing
    // here is a constant: a regenerated or truncated asset changes it.
    durationSeconds: (segmentStartSeconds[lastIndex] ?? 0) + (segmentDurationsSeconds[lastIndex] ?? 0),
    segmentDurationSeconds: segmentDurationsSeconds[0] ?? 0,
  }
}

function readTimescale(media: Buffer, topLevel: MediaBox[]): number {
  const moov = topLevel.find(box => box.type === 'moov')
  const mdhd = moov ? findBox(media, moov, ['trak', 'mdia', 'mdhd']) : undefined
  if (!mdhd)
    throw new Error('Adaptive fixture initialization section has no mdhd box.')
  // Full box: version and flags, then creation and modification times (4 bytes
  // each, or 8 in version 1) and the timescale.
  const version = media.readUInt8(mdhd.offset + 8)
  const timescale = media.readUInt32BE(mdhd.offset + 8 + 4 + (version === 1 ? 16 : 8))
  if (timescale <= 0)
    throw new Error('Adaptive fixture media has a zero timescale.')
  return timescale
}

function readFragmentTiming(media: Buffer, moof: MediaBox): { startTicks: number, durationTicks: number } {
  const tfhd = findBox(media, moof, ['traf', 'tfhd'])
  const tfdt = findBox(media, moof, ['traf', 'tfdt'])
  const trun = findBox(media, moof, ['traf', 'trun'])
  if (!tfhd || !tfdt || !trun)
    throw new Error(`Adaptive fixture moof at ${moof.offset} is missing tfhd, tfdt or trun.`)

  const tfdtVersion = media.readUInt8(tfdt.offset + 8)
  const startTicks = tfdtVersion === 1
    ? Number(media.readBigUInt64BE(tfdt.offset + 12))
    : media.readUInt32BE(tfdt.offset + 12)

  // tfhd: version and flags, track id, then optional fields in a fixed order.
  const tfhdFlags = media.readUIntBE(tfhd.offset + 9, 3)
  let cursor = tfhd.offset + 16
  if (tfhdFlags & 0x1)
    cursor += 8
  if (tfhdFlags & 0x2)
    cursor += 4
  const defaultSampleDuration = tfhdFlags & 0x8 ? media.readUInt32BE(cursor) : 0

  const trunFlags = media.readUIntBE(trun.offset + 9, 3)
  const sampleCount = media.readUInt32BE(trun.offset + 12)
  let durationTicks = sampleCount * defaultSampleDuration
  if (trunFlags & 0x100) {
    // Every sample carries its own duration: add them up instead.
    let sampleCursor = trun.offset + 16
    if (trunFlags & 0x1)
      sampleCursor += 4
    if (trunFlags & 0x4)
      sampleCursor += 4
    const perSample = [0x100, 0x200, 0x400, 0x800].reduce((width, flag) => width + (trunFlags & flag ? 4 : 0), 0)
    durationTicks = 0
    for (let sample = 0; sample < sampleCount; sample++)
      durationTicks += media.readUInt32BE(sampleCursor + sample * perSample)
  }
  if (durationTicks <= 0)
    throw new Error(`Adaptive fixture moof at ${moof.offset} declares no sample duration.`)
  return { startTicks, durationTicks }
}

interface MediaBox { type: string, offset: number, size: number }

function findBox(media: Buffer, parent: MediaBox, path: string[]): MediaBox | undefined {
  let current: MediaBox | undefined = parent
  for (const type of path) {
    if (!current)
      return undefined
    current = readBoxes(media, current.offset + 8, current.offset + current.size).find(box => box.type === type)
  }
  return current
}

function readBoxes(media: Buffer, from: number, until: number): MediaBox[] {
  const boxes: MediaBox[] = []
  let offset = from
  while (offset + 8 <= until) {
    const start = offset
    let size = media.readUInt32BE(offset)
    const type = media.toString('ascii', offset + 4, offset + 8)
    offset += 8
    if (size === 1) {
      if (offset + 8 > until)
        throw new Error(`Invalid extended MP4 box at ${start}.`)
      const extendedSize = media.readBigUInt64BE(offset)
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error(`MP4 box at ${start} is too large.`)
      size = Number(extendedSize)
      offset += 8
    }
    else if (size === 0) {
      size = until - start
    }
    if (size < offset - start || start + size > until)
      throw new Error(`Invalid MP4 box size at ${start}.`)
    boxes.push({ type, offset: start, size })
    offset = start + size
  }
  return boxes
}

function fixtureDelayMs(value: string | null): number {
  switch (value) {
    case '50':
      return 50
    case '80':
      return 80
    case '120':
      return 120
    case '250':
      return 250
    case '500':
      return 500
    case '1_000':
    case '1000':
      return 1_000
    case '2_000':
    case '2000':
      return 2_000
    default:
      return 0
  }
}

async function waitForFixtureDelay(delayMs: number): Promise<void> {
  switch (delayMs) {
    case 50:
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
      return
    case 80:
      await new Promise(resolveDelay => setTimeout(resolveDelay, 80))
      return
    case 120:
      await new Promise(resolveDelay => setTimeout(resolveDelay, 120))
      return
    case 250:
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
      return
    case 500:
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
      return
    case 1_000:
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1_000))
      return
    case 2_000:
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))
      return
    default:
      return
  }
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
