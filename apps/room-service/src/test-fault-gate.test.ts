// The /__test/* hooks of the room service are for in-process browser tests. They
// exist only when a test supplies a test control value, and then only for a
// caller that sends it. This file pins that for /__test/fault, the hook that
// changes what the service does with one participant's messages, next to
// /__test/disconnect.
import type { ServerMessage } from '@syncyourjoy/protocol'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createRoomService, type RoomService } from './server.ts'

let service: RoomService | null = null
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0))
    socket.close()
  await service?.close()
  service = null
})

const HEADER = 'x-syncyourjoy-test-token'
const FAULT_MODES = ['hold_acks', 'drop_acks', 'silent', 'release', 'clear']

async function openRoom(url: string): Promise<{ code: string, participantId: string }> {
  const socket = new WebSocket(url, undefined, { origin: 'chrome-extension://test-extension' })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const joined = new Promise<ServerMessage>((resolve, reject) => {
    const timeout = AbortSignal.timeout(4_000)
    timeout.addEventListener('abort', () => reject(new Error('Timed out waiting for the room.')), { once: true })
    socket.once('message', data => resolve(JSON.parse(data.toString()) as ServerMessage))
  })
  socket.send(JSON.stringify({
    type: 'create_room', protocolVersion: 1, participantId: 'participant_gate', name: 'Gate', code: 'GATE1234', media: null,
  }))
  const message = await joined
  if (message.type !== 'room_joined')
    throw new Error(`Expected room_joined, got ${message.type}`)
  return { code: message.snapshot.code, participantId: 'participant_gate' }
}

function controlUrl(serviceUrl: string, path: string, params: Record<string, string>): URL {
  const url = new URL(serviceUrl.replace(/^ws:/, 'http:'))
  url.pathname = path
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value)
  return url
}

describe('the /__test/* hooks', () => {
  it('are not reachable on a service started without a test control value, whatever the caller sends', async () => {
    service = await createRoomService({ port: 0 })
    const { code, participantId } = await openRoom(service.url)
    for (const path of ['/__test/fault', '/__test/disconnect']) {
      for (const mode of FAULT_MODES) {
        // No header, a guess, and an empty one: none of them opens anything.
        for (const value of [undefined, 'guess', '']) {
          const response = await fetch(controlUrl(service.url, path, { room: code, participant: participantId, mode }), {
            method: 'POST',
            headers: value === undefined ? {} : { [HEADER]: value },
          })
          expect(response.status, `${path} ${mode} with ${value === undefined ? 'no header' : `header "${value}"`}`).toBe(404)
        }
      }
    }
  })

  it('refuse a caller without the value, with a wrong one, and a malformed request, on a service that has one', async () => {
    const control = randomBytes(24).toString('base64url')
    service = await createRoomService({ port: 0, testControlToken: control })
    const { code, participantId } = await openRoom(service.url)
    const right = { [HEADER]: control }

    for (const headers of [{}, { [HEADER]: 'wrong' }]) {
      const response = await fetch(controlUrl(service.url, '/__test/fault', { room: code, participant: participantId, mode: 'hold_acks' }), { method: 'POST', headers })
      expect(response.status).toBe(404)
    }
    // Only POST, a known room, a participant, and a known mode.
    expect((await fetch(controlUrl(service.url, '/__test/fault', { room: code, participant: participantId, mode: 'hold_acks' }), { method: 'GET', headers: right })).status).toBe(404)
    expect((await fetch(controlUrl(service.url, '/__test/fault', { room: 'NOSUCHRM', participant: participantId, mode: 'hold_acks' }), { method: 'POST', headers: right })).status).toBe(404)
    expect((await fetch(controlUrl(service.url, '/__test/fault', { room: code, mode: 'hold_acks' }), { method: 'POST', headers: right })).status).toBe(404)
    expect((await fetch(controlUrl(service.url, '/__test/fault', { room: code, participant: participantId, mode: 'explode' }), { method: 'POST', headers: right })).status).toBe(404)

    // The right value and a valid request is the one thing that works.
    const accepted = await fetch(controlUrl(service.url, '/__test/fault', { room: code, participant: participantId, mode: 'hold_acks' }), { method: 'POST', headers: right })
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, mode: 'hold_acks', released: 0 })
    const cleared = await fetch(controlUrl(service.url, '/__test/fault', { room: code, participant: participantId, mode: 'clear' }), { method: 'POST', headers: right })
    expect(cleared.status).toBe(200)
  })

  it('are not part of the production start path', async () => {
    // `npm run dev:server` and the built server start through the block that
    // follows `const invokedPath` at the end of server.ts. It must not hand the
    // service a test control value, and the edge service has no such route.
    const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8')
    const startBlock = source.slice(source.indexOf('const invokedPath'))
    expect(startBlock.length).toBeGreaterThan(0)
    expect(startBlock).not.toMatch(/testControlToken|SYNCYOURJOY_E2E|__test/)
    const edge = await readFile(new URL('../../edge-service/src/worker.ts', import.meta.url), 'utf8')
    expect(edge).not.toMatch(/__test/)
  })
})
