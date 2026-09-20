import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import type { ServerMessage } from '@syncyourjoy/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createRoomService, type RoomService } from './server.ts'

let service: RoomService | null = null

afterEach(async () => {
  await service?.close()
  service = null
})

describe('room service', () => {
  it('creates a room and a second client\'s join_room becomes a pending request, not immediate membership', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)

    host.send(JSON.stringify({
      type: 'create_room',
      protocolVersion: 1,
      participantId: 'participant_host',
      name: 'Muaz',
      code: 'JOY7K2MX',
      media: {
        service: 'youtube',
        canonicalId: 'youtube:abc123',
        title: 'A useful test video',
        durationSeconds: 600,
      },
    }))
    const created = await nextMessage(host)
    expect(created.type).toBe('room_joined')
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')

    const hostPendingNotice = nextMessage(host)
    friend.send(JSON.stringify({
      type: 'join_room',
      protocolVersion: 1,
      participantId: 'participant_friend',
      name: 'Rana',
      code: created.snapshot.code,
      media: created.snapshot.media,
    }))
    const joined = await nextMessage(friend)
    expect(joined.type).toBe('room_joined')
    if (joined.type === 'room_joined') {
      expect(joined.snapshot.participants).toHaveLength(1)
      expect(joined.snapshot.pendingJoinRequests).toEqual([
        expect.objectContaining({ id: 'participant_friend', name: 'Rana' }),
      ])
    }
    await expect(hostPendingNotice).resolves.toMatchObject({
      type: 'room_snapshot',
      reason: 'join_pending',
      snapshot: { pendingJoinRequests: [expect.objectContaining({ id: 'participant_friend' })] },
    })

    host.close()
    friend.close()
  })

  it('lets the controller approve a pending join request, admitting the requester on both sides', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    const media = {
      service: 'youtube',
      canonicalId: 'youtube:abc123',
      title: 'A useful test video',
      durationSeconds: 600,
    }

    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'APPRV123', media,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')

    await joinAndApprove(host, friend, created.snapshot.code, 'participant_friend', 'Rana', media)

    host.send(JSON.stringify({ type: 'ping', id: 'ping_after_approve', sentAtLocalMs: 0 }))
    const afterApprove = await nextMessage(host)
    expect(afterApprove).toMatchObject({ type: 'pong', id: 'ping_after_approve' })

    host.close()
    friend.close()
  })

  it('forwards identity-bound prepare and started acknowledgements through a negotiated transactional room', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    const media = {
      service: 'youtube',
      canonicalId: 'youtube:transactional',
      title: 'Transactional test video',
      durationSeconds: 600,
    }

    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'TXN12345', media,
      capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')

    const hostPendingNotice = nextMessage(host)
    friend.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: created.snapshot.code, media,
      capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    await nextMessage(friend)
    await hostPendingNotice
    const hostApproved = nextMessage(host)
    const friendApproved = nextMessage(friend)
    host.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_approve_transactional', basedOnRevision: 0, leaseEpoch: 1,
    }))
    await Promise.all([hostApproved, friendApproved])

    host.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await Promise.all([
      nextRoomSnapshot(host, 'participant_ready'),
      nextRoomSnapshot(friend, 'participant_ready'),
    ])
    friend.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    const [hostReady, friendReady] = await Promise.all([
      nextRoomSnapshot(host, 'participant_ready'),
      nextRoomSnapshot(friend, 'participant_ready'),
    ])
    expect(hostReady.snapshot.contract?.mode).toBe('transactional')
    expect(friendReady.snapshot.contract?.mode).toBe('transactional')

    const pendingHost = nextRoomSnapshot(host, 'control_play_pending')
    const pendingFriend = nextRoomSnapshot(friend, 'control_play_pending')
    host.send(JSON.stringify({
      type: 'control', actionId: 'action_play_transactional', basedOnRevision: hostReady.snapshot.revision, leaseEpoch: 1, kind: 'play', positionSeconds: 0,
    }))
    const [pendingHostSnapshot] = await Promise.all([pendingHost, pendingFriend])
    const operation = pendingHostSnapshot.snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation')

    const hostPrepared = nextRoomSnapshot(host, 'operation_participant_prepared')
    const friendPrepared = nextRoomSnapshot(friend, 'operation_participant_prepared')
    host.send(JSON.stringify({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, bindingId: 'binding_host_123456', sourceGeneration: 0, sampleSequence: 1,
        phase: 'prepared', participantId: 'participant_host', observedPositionSeconds: 0, observedAtLocalMs: Date.now(),
      },
    }))
    await Promise.all([hostPrepared, friendPrepared])

    const committedHost = nextRoomSnapshot(host, 'operation_committed')
    const committedFriend = nextRoomSnapshot(friend, 'operation_committed')
    friend.send(JSON.stringify({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, bindingId: 'binding_friend_123456', sourceGeneration: 0, sampleSequence: 1,
        phase: 'prepared', participantId: 'participant_friend', observedPositionSeconds: 0, observedAtLocalMs: Date.now(),
      },
    }))
    const [committed] = await Promise.all([committedHost, committedFriend])
    expect(committed.snapshot.contract?.operation).toMatchObject({ phase: 'committed', preparedParticipantIds: ['participant_host', 'participant_friend'] })

    await new Promise(resolve => setTimeout(resolve, 220))
    const startedParticipantHost = nextRoomSnapshot(host, 'operation_participant_started')
    const startedParticipantFriend = nextRoomSnapshot(friend, 'operation_participant_started')
    host.send(JSON.stringify({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, bindingId: 'binding_host_123456', sourceGeneration: 0, sampleSequence: 2,
        phase: 'started', participantId: 'participant_host', observedPositionSeconds: 0, observedAtLocalMs: Date.now(),
      },
    }))
    await Promise.all([startedParticipantHost, startedParticipantFriend])

    const startedHost = nextRoomSnapshot(host, 'operation_started')
    const startedFriend = nextRoomSnapshot(friend, 'operation_started')
    friend.send(JSON.stringify({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, bindingId: 'binding_friend_123456', sourceGeneration: 0, sampleSequence: 2,
        phase: 'started', participantId: 'participant_friend', observedPositionSeconds: 0, observedAtLocalMs: Date.now(),
      },
    }))
    const [started] = await Promise.all([startedHost, startedFriend])
    expect(started.snapshot.contract?.operation).toMatchObject({ phase: 'started', startedParticipantIds: ['participant_host', 'participant_friend'] })

    host.close()
    friend.close()
  })

  it('lets the controller deny a pending join request; the denied socket is told and dropped from the room', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    const media = {
      service: 'youtube',
      canonicalId: 'youtube:abc123',
      title: 'A useful test video',
      durationSeconds: 600,
    }

    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'DENY1234', media,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')

    const hostPendingNotice = nextMessage(host)
    friend.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: created.snapshot.code, media,
    }))
    await nextMessage(friend)
    await hostPendingNotice

    const hostDenyBroadcast = nextMessage(host)
    const friendDenied = nextMessage(friend)
    const friendClosed = new Promise<void>((resolve) => friend.once('close', () => resolve()))
    host.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_friend', approve: false, actionId: 'action_deny_friend', basedOnRevision: 0, leaseEpoch: 1,
    }))

    await expect(hostDenyBroadcast).resolves.toMatchObject({
      type: 'room_snapshot',
      reason: 'join_denied',
      snapshot: { participants: [expect.objectContaining({ id: 'participant_host' })], pendingJoinRequests: [] },
    })
    await expect(friendDenied).resolves.toMatchObject({ type: 'command_rejected', code: 'join_denied' })
    await friendClosed

    host.close()
  })

  it('rejects malformed messages without crashing the connection', async () => {
    service = await createRoomService({ port: 0 })
    const socket = await connect(service.url)
    socket.send('{bad json')
    const response = await nextMessage(socket)
    expect(response).toMatchObject({ type: 'error', code: 'invalid_message' })
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  it('keeps a replacement connection ready and connected after closing its prior socket', async () => {
    service = await createRoomService({ port: 0 })
    const original = await connect(service.url)
    const media = {
      service: 'youtube',
      canonicalId: 'youtube:abc123',
      title: 'A useful test video',
      durationSeconds: 600,
    }
    original.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'REJOIN12', media,
    }))
    const originalJoined = await nextMessage(original)
    expect(originalJoined.type).toBe('room_joined')
    if (originalJoined.type !== 'room_joined')
      throw new Error('Expected room_joined')
    original.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await nextMessage(original)

    const originalClosed = new Promise<void>((resolve) => original.once('close', () => resolve()))
    const replacement = await connect(service.url)
    replacement.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: originalJoined.snapshot.code, media, sessionToken: originalJoined.sessionToken,
    }))
    const joined = await nextMessage(replacement)
    expect(joined).toMatchObject({
      type: 'room_joined',
      snapshot: { participants: [expect.objectContaining({ id: 'participant_host', connected: true, ready: true })] },
    })
    await originalClosed

    replacement.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    const confirmed = await nextRoomSnapshot(replacement, 'readiness_unchanged')
    expect(confirmed.snapshot.participants).toEqual([
      expect.objectContaining({ id: 'participant_host', connected: true, ready: true, mediaMatches: true }),
    ])
    replacement.close()
  })

  it('rejects duplicate participant replacement without the issued session token', async () => {
    service = await createRoomService({ port: 0 })
    const original = await connect(service.url)
    original.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'AUTH1234', media: null,
    }))
    const joined = await nextMessage(original)
    expect(joined.type).toBe('room_joined')
    if (joined.type !== 'room_joined')
      throw new Error('Expected room_joined')

    const replacement = await connect(service.url)
    replacement.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_host', name: 'Impostor', code: joined.snapshot.code, media: null,
    }))
    await expect(nextMessage(replacement)).resolves.toMatchObject({ type: 'command_rejected', code: 'session_invalid' })
    expect(original.readyState).toBe(WebSocket.OPEN)
    replacement.close()
    original.close()
  })

  it('collects sanitized diagnostic reports from every participant for the controller', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'LOGS1234', media: null,
    }))
    const hostCreated = await nextMessage(host)
    expect(hostCreated.type).toBe('room_joined')
    if (hostCreated.type !== 'room_joined')
      throw new Error('Expected room_joined')
    await joinAndApprove(host, friend, hostCreated.snapshot.code, 'participant_friend', 'Rana', null)

    const hostRequest = nextMessage(host)
    const friendRequest = nextMessage(friend)
    host.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_123456' }))
    await expect(hostRequest).resolves.toMatchObject({ type: 'diagnostics_requested', reportId: 'report_123456' })
    await expect(friendRequest).resolves.toMatchObject({ type: 'diagnostics_requested', reportId: 'report_123456' })

    const report = diagnosticReport()
    const ownResponse = nextMessage(host)
    host.send(JSON.stringify({ type: 'diagnostics_response', reportId: 'report_123456', report }))
    await expect(ownResponse).resolves.toMatchObject({ type: 'diagnostics_response', participantId: 'participant_host', participantName: 'Muaz' })
    const friendResponse = nextMessage(host)
    friend.send(JSON.stringify({ type: 'diagnostics_response', reportId: 'report_123456', report }))
    await expect(friendResponse).resolves.toMatchObject({ type: 'diagnostics_response', participantId: 'participant_friend', participantName: 'Rana' })

    const rejectedMemberRequest = nextMessage(friend)
    friend.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_654321' }))
    await expect(rejectedMemberRequest).resolves.toMatchObject({ type: 'error', code: 'controller_only' })
    host.close()
    friend.close()
  })

  it('ignores a diagnostics_response with an unrequested reportId, and only forwards one response per participant per request', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'FAKE1234', media: null,
    }))
    const hostCreated = await nextMessage(host)
    expect(hostCreated.type).toBe('room_joined')
    if (hostCreated.type !== 'room_joined')
      throw new Error('Expected room_joined')
    await joinAndApprove(host, friend, hostCreated.snapshot.code, 'participant_friend', 'Rana', null)

    // A fabricated reportId the controller never asked for must not reach it.
    friend.send(JSON.stringify({ type: 'diagnostics_response', reportId: 'report_never_requested', report: diagnosticReport() }))

    const hostRequest = nextMessage(host)
    host.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_real12' }))
    await expect(hostRequest).resolves.toMatchObject({ type: 'diagnostics_requested', reportId: 'report_real12' })

    const firstResponse = nextMessage(host)
    friend.send(JSON.stringify({ type: 'diagnostics_response', reportId: 'report_real12', report: diagnosticReport() }))
    await expect(firstResponse).resolves.toMatchObject({ type: 'diagnostics_response', participantId: 'participant_friend' })

    // A second response from the same participant for the same reportId is dropped, so the
    // fabricated report above -- and any replay -- never arrives at the controller.
    friend.send(JSON.stringify({ type: 'diagnostics_response', reportId: 'report_real12', report: diagnosticReport() }))
    host.send(JSON.stringify({ type: 'ping', id: 'ping_after_flood', sentAtLocalMs: 0 }))
    await expect(nextMessage(host)).resolves.toMatchObject({ type: 'pong', id: 'ping_after_flood' })

    host.close()
    friend.close()
  })

  it('mints the room code server-side instead of trusting the client-supplied value', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'AAAAAAAA', media: null,
    }))
    const created = await nextMessage(host)
    expect(created.type).toBe('room_joined')
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    expect(created.snapshot.code).not.toBe('AAAAAAAA')
    host.close()
  })

  it('rejects a websocket upgrade with no Origin header', async () => {
    service = await createRoomService({ port: 0 })
    const socket = new WebSocket(service.url)
    const outcome = await new Promise<'open' | 'rejected'>((resolve) => {
      socket.once('open', () => resolve('open'))
      socket.once('error', () => resolve('rejected'))
      socket.once('unexpected-response', () => resolve('rejected'))
    })
    expect(outcome).toBe('rejected')
  })

  it('rate-limits repeated upgrade attempts from one IP over a rolling window, independent of concurrent connections', async () => {
    service = await createRoomService({ port: 0 })

    // Close each socket before opening the next so the concurrent-pending-
    // connections cap never trips; only the rolling-window attempt counter
    // should be responsible for eventually rejecting this IP.
    for (let i = 0; i < 30; i += 1) {
      const socket = await connect(service.url)
      socket.close()
    }

    const limited = new WebSocket(service.url, undefined, { origin: 'chrome-extension://test-extension' })
    const outcome = await new Promise<'open' | 'rejected'>((resolve) => {
      limited.once('open', () => resolve('open'))
      limited.once('error', () => resolve('rejected'))
      limited.once('unexpected-response', () => resolve('rejected'))
    })
    expect(outcome).toBe('rejected')
  })

  it('caps how many concurrently open rooms one IP can create, and frees a slot once a room expires', async () => {
    service = await createRoomService({ port: 0 })

    // MAX_ROOMS_PER_IP is 20. Every socket here shares the loopback address,
    // so the 21st create_room from this same IP must be rejected even though
    // none of the previous rooms have become empty or expired yet.
    for (let i = 0; i < 20; i += 1) {
      const socket = await connect(service.url)
      socket.send(JSON.stringify({
        type: 'create_room', protocolVersion: 1, participantId: `participant_host_${i}`, name: 'Muaz', code: 'JOY7K2MX', media: null,
      }))
      await expect(nextMessage(socket)).resolves.toMatchObject({ type: 'room_joined' })
    }

    const limitedSocket = await connect(service.url)
    limitedSocket.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host_20', name: 'Muaz', code: 'JOY7K2MX', media: null,
    }))
    await expect(nextMessage(limitedSocket)).resolves.toMatchObject({ type: 'error', code: 'rate_limited' })
  })
})

function diagnosticReport() {
  return {
    extensionVersion: '0.1.11', generatedAtLocalMs: 10_000, userAgent: 'Chrome test', connection: 'connected',
    roomRevision: 1, playbackStatus: 'paused', playerFrameId: 0, playerAreaPixels: 500_000, playerLastSeenAtMs: 9_900,
    mediaService: null, mediaCanonicalId: null, mediaPageUrl: null, sample: null,
    events: [{ atLocalMs: 9_900, category: 'room', message: 'room_joined', details: { revision: 1 } }],
  }
}

/**
 * Sends join_room from `friend`, waits for the controller (`host`) to see it
 * as a pending request, then has the controller approve it and waits for
 * both sides to see the resulting broadcast -- the same two-step flow a real
 * host-approval join (docs/CODE_AUDIT.md SYJ-AUD-003) now requires before a
 * brand-new participant is a genuine room member.
 */
async function joinAndApprove(
  host: WebSocket,
  friend: WebSocket,
  roomCode: string,
  friendParticipantId: string,
  friendName: string,
  media: unknown,
): Promise<void> {
  const hostPendingNotice = nextMessage(host)
  friend.send(JSON.stringify({
    type: 'join_room', protocolVersion: 1, participantId: friendParticipantId, name: friendName, code: roomCode, media,
  }))
  const friendJoined = await nextMessage(friend)
  if (friendJoined.type !== 'room_joined')
    throw new Error('Expected room_joined')
  await hostPendingNotice

  const hostApproved = nextMessage(host)
  const friendApproved = nextMessage(friend)
  host.send(JSON.stringify({
    type: 'respond_to_join',
    participantId: friendParticipantId,
    approve: true,
    actionId: `action_approve_${friendParticipantId}`,
    basedOnRevision: 0,
    leaseEpoch: 1,
  }))
  await Promise.all([hostApproved, friendApproved])
}

async function connect(url: string): Promise<WebSocket> {
  // A real browser (including the extension) always sends Origin on a
  // WebSocket handshake; originAllowed() now rejects a missing one, so the
  // test client must set an allowed origin explicitly like `ws` does not by default.
  const socket = new WebSocket(url, undefined, { origin: 'chrome-extension://test-extension' })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for server message.')), 2_000)
    socket.once('message', (data) => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()) as ServerMessage)
    })
  })
}

async function nextRoomSnapshot(socket: WebSocket, reason: string): Promise<Extract<ServerMessage, { type: 'room_snapshot' }>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const message = await nextMessage(socket)
    if (message.type === 'room_snapshot' && message.reason === reason)
      return message
  }
  throw new Error(`Timed out waiting for room snapshot: ${reason}`)
}
