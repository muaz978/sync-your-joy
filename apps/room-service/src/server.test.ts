import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import type { ServerMessage } from '@syncyourjoy/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
      // An unapproved requester must not see who is in the room. It only
      // sees its own pending entry (the signal clients use to show a
      // waiting view).
      expect(joined.snapshot.participants).toEqual([])
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

  it('keeps the local disconnect control token-gated and closes only the selected participant', async () => {
    service = await createRoomService({ port: 0, testControlToken: 'local-test-token' })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'DISC1234', media: null,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    await joinAndApprove(host, friend, created.snapshot.code, 'participant_friend', 'Rana', null)

    const endpoint = `${service.url.replace(/^ws:/, 'http:').replace(/\/rooms$/, '')}/__test/disconnect?room=${created.snapshot.code}&participant=participant_friend`
    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-syncyourjoy-test-token': 'wrong-token' },
    })
    expect(unauthorized.status).toBe(404)

    const hostUpdate = nextRoomSnapshot(host, 'participant_disconnected')
    const friendClosed = new Promise<void>(resolve => friend.once('close', () => resolve()))
    const disconnected = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-syncyourjoy-test-token': 'local-test-token' },
    })
    expect(disconnected.status).toBe(200)
    await expect(disconnected.json()).resolves.toEqual({ ok: true, closedSockets: 1 })
    await expect(friendClosed).resolves.toBeUndefined()
    await expect(hostUpdate).resolves.toMatchObject({
      snapshot: {
        participants: expect.arrayContaining([
          expect.objectContaining({ id: 'participant_friend', connected: false }),
        ]),
      },
    })

    host.close()
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

  it('keeps an old-client mixed room on legacy transport and ignores transactional acknowledgements', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const legacyFriend = await connect(service.url)
    const media = {
      service: 'youtube',
      canonicalId: 'youtube:mixed-version',
      title: 'Mixed-version test video',
      durationSeconds: 600,
    }

    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'MIXED123', media,
      capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')

    const pendingHost = nextRoomSnapshot(host, 'join_pending')
    legacyFriend.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_old', name: 'Legacy', code: created.snapshot.code, media,
    }))
    await nextMessage(legacyFriend)
    const pending = await pendingHost
    const approvedHost = nextRoomSnapshot(host, 'join_approved')
    const approvedFriend = nextRoomSnapshot(legacyFriend, 'join_approved')
    host.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_old', approve: true, actionId: 'action_approve_mixed',
      basedOnRevision: pending.snapshot.revision, leaseEpoch: pending.snapshot.controller.leaseEpoch,
    }))
    await Promise.all([approvedHost, approvedFriend])

    host.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await Promise.all([
      nextRoomSnapshot(host, 'participant_ready'),
      nextRoomSnapshot(legacyFriend, 'participant_ready'),
    ])
    legacyFriend.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    const [hostReady] = await Promise.all([
      nextRoomSnapshot(host, 'participant_ready'),
      nextRoomSnapshot(legacyFriend, 'participant_ready'),
    ])
    expect(hostReady.snapshot.contract?.mode).toBe('legacy')

    const playingHost = nextRoomSnapshot(host, 'control_play')
    const playingFriend = nextRoomSnapshot(legacyFriend, 'control_play')
    host.send(JSON.stringify({
      type: 'control', actionId: 'action_mixed_play', basedOnRevision: hostReady.snapshot.revision,
      leaseEpoch: hostReady.snapshot.controller.leaseEpoch, kind: 'play', positionSeconds: 0,
    }))
    const [playing] = await Promise.all([playingHost, playingFriend])
    expect(playing.snapshot.contract?.mode).toBe('legacy')
    expect(playing.snapshot.contract?.operation).toBeNull()

    host.send(JSON.stringify({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: 0, operationId: 'operation_mixed_123456', phase: 'prepared', participantId: 'participant_host',
        bindingId: 'binding_host_123456', sourceGeneration: 0, sampleSequence: 1,
        observedPositionSeconds: 0, observedAtLocalMs: 10_000,
      },
    }))
    await expectNoMessage(host)
    host.close()
    legacyFriend.close()
  })

  it('pauses a connected silent player from the cleanup timer and broadcasts one transition', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const media = {
      service: 'youtube',
      canonicalId: 'youtube:timer-health',
      title: 'Timer health test video',
      durationSeconds: 600,
    }

    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'HEALTH12', media,
    }))
    const created = await nextMessage(host)
    expect(created.type).toBe('room_joined')
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')

    host.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await expect(nextRoomSnapshot(host, 'participant_ready')).resolves.toMatchObject({
      snapshot: { participants: [expect.objectContaining({ id: 'participant_host', ready: true, mediaMatches: true })] },
    })

    const pendingPlay = nextRoomSnapshot(host, 'control_play')
    host.send(JSON.stringify({
      type: 'control', actionId: 'action_timer_health_play', basedOnRevision: created.snapshot.revision + 1, leaseEpoch: 1, kind: 'play', positionSeconds: 20,
    }))
    const play = await pendingPlay
    expect(play.snapshot.playback.status).toBe('playing')

    // One healthy sample establishes a progress baseline. The test then sends
    // no more messages. The service cleanup timer must evaluate the deadline
    // and publish the pause independently of an inbound player report.
    host.send(JSON.stringify({
      type: 'player_status',
      basedOnRevision: play.snapshot.revision,
      sample: {
        positionSeconds: 20,
        durationSeconds: media.durationSeconds,
        paused: false,
        buffering: false,
        sampledAtLocalMs: Date.now(),
        progressed: true,
        playbackStarted: true,
      },
    }))

    const health = await nextRoomSnapshot(host, 'participant_playback_stalled')
    expect(health.snapshot.playback).toMatchObject({ status: 'paused' })
    expect(health.snapshot.revision).toBe(play.snapshot.revision + 1)
    await expectNoMessage(host)
    host.close()
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

describe('unapproved join requests receive nothing', () => {
  const hostMedia = { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A private title', durationSeconds: 600 }

  async function roomWithPendingFriend() {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'PEND1234', media: hostMedia,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    const hostNotice = nextMessage(host)
    friend.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: created.snapshot.code, media: null,
    }))
    const joined = await nextMessage(friend)
    if (joined.type !== 'room_joined')
      throw new Error('Expected room_joined')
    await hostNotice
    return { host, friend, code: created.snapshot.code, friendToken: joined.sessionToken, joined }
  }

  const approve = (host: WebSocket, id = 'participant_friend') => host.send(JSON.stringify({
    type: 'respond_to_join', participantId: id, approve: true, actionId: `action_approve_${id}`, basedOnRevision: 0, leaseEpoch: 1,
  }))

  it('gives a pending requester a snapshot that carries nothing about the room', async () => {
    const { host, friend, joined } = await roomWithPendingFriend()
    expect(joined.snapshot).toMatchObject({
      navigation: null,
      seek: null,
      participants: [],
      playback: { status: 'paused', positionSeconds: 0 },
      pendingJoinRequests: [expect.objectContaining({ id: 'participant_friend', name: 'Rana' })],
    })
    // A fingerprint that matches no real media, never the room's own and
    // never null, so a deployed player stays inert while the request waits.
    expect(joined.snapshot.media).not.toBeNull()
    expect(joined.snapshot.media?.canonicalId).not.toBe(hostMedia.canonicalId)
    expect(joined.snapshot.contract).toBeUndefined()
    expect(JSON.stringify(joined)).not.toContain('private title')
    expect(JSON.stringify(joined)).not.toContain('Muaz')
    host.close()
    friend.close()
  })

  it('sends a pending requester none of the room broadcasts', async () => {
    const { host, friend } = await roomWithPendingFriend()
    const hostReady = nextMessage(host)
    host.send(JSON.stringify({ type: 'set_ready', ready: true, media: hostMedia }))
    await hostReady
    const hostDiagnostics = nextMessage(host)
    host.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_pending_isolation' }))
    await hostDiagnostics
    await expectNoMessage(friend)
    host.close()
    friend.close()
  })

  it('withdraws the request when the requester disconnects, so it cannot be approved later', async () => {
    const { host, friend } = await roomWithPendingFriend()
    const hostNotice = nextMessage(host)
    friend.close()
    const withdrawn = await hostNotice
    expect(withdrawn).toMatchObject({ type: 'room_snapshot', reason: 'join_cancelled', snapshot: { pendingJoinRequests: [], participants: [expect.objectContaining({ id: 'participant_host' })] } })

    const rejection = nextMessage(host)
    approve(host)
    await expect(rejection).resolves.toMatchObject({ type: 'command_rejected', code: 'not_found' })
    host.close()
  })

  it('refuses a client that only knows the pending participant id and leaves the request untouched', async () => {
    const { host, friend, code } = await roomWithPendingFriend()
    const intruder = await connect(service!.url)
    const rejection = nextMessage(intruder)
    intruder.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Attacker', code, media: null,
    }))
    await expect(rejection).resolves.toMatchObject({ type: 'command_rejected', code: 'session_invalid', snapshot: null })

    const hostApproved = nextMessage(host)
    const friendApproved = nextMessage(friend)
    approve(host)
    await expect(friendApproved).resolves.toMatchObject({
      type: 'room_snapshot',
      reason: 'join_approved',
      snapshot: { participants: expect.arrayContaining([expect.objectContaining({ id: 'participant_friend', name: 'Rana' })]) },
    })
    await hostApproved
    intruder.close()
    host.close()
    friend.close()
  })

  it('lets the same client re-attach to its pending request with the token it was issued', async () => {
    const { host, friend, code, friendToken } = await roomWithPendingFriend()
    const replaced = new Promise<number>(resolve => friend.once('close', resolve))
    const reattached = await connect(service!.url)
    const rejoined = nextMessage(reattached)
    reattached.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code, media: null, sessionToken: friendToken,
    }))
    await expect(rejoined).resolves.toMatchObject({
      type: 'room_joined',
      sessionToken: friendToken,
      snapshot: { participants: [], pendingJoinRequests: [expect.objectContaining({ id: 'participant_friend' })] },
    })
    await expect(replaced).resolves.toBe(1000)

    const approved = nextMessage(reattached)
    approve(host)
    await expect(approved).resolves.toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
    reattached.close()
    host.close()
  })

  it('does not hand room state to a pending requester inside a rejection either', async () => {
    const { host, friend } = await roomWithPendingFriend()
    const rejection = nextMessage(friend)
    friend.send(JSON.stringify({
      type: 'control', actionId: 'action_pending_control', basedOnRevision: 0, leaseEpoch: 1, kind: 'play', positionSeconds: 1,
    }))
    const rejected = await rejection
    expect(rejected).toMatchObject({ type: 'command_rejected', actionId: 'action_pending_control', snapshot: null })
    expect(JSON.stringify(rejected)).not.toContain('private title')
    host.close()
    friend.close()
  })

  it('does not hand room state to a stranger who is turned away because the room is full', async () => {
    const { host, friend, code } = await roomWithPendingFriend()
    const fillers: WebSocket[] = []
    // The host and the first request take two of the ten places; eight more
    // pending requests fill the room, because pending requests count.
    for (let index = 0; index < 8; index += 1) {
      const socket = await connect(service!.url)
      const accepted = nextMessage(socket)
      socket.send(JSON.stringify({
        type: 'join_room', protocolVersion: 1, participantId: `participant_filler_${index}`, name: `Filler ${index}`, code, media: null,
      }))
      await expect(accepted).resolves.toMatchObject({ type: 'room_joined' })
      fillers.push(socket)
    }

    const stranger = await connect(service!.url)
    const rejection = nextMessage(stranger)
    stranger.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_stranger', name: 'Stranger', code, media: null,
    }))
    const rejected = await rejection

    expect(rejected).toMatchObject({ type: 'command_rejected', code: 'room_full', snapshot: null })
    expect(JSON.stringify(rejected)).not.toContain('private title')
    for (const socket of [host, friend, stranger, ...fillers])
      socket.close()
  })

  it('refuses an approval sent by a pending requester without handing it room state', async () => {
    const { host, friend } = await roomWithPendingFriend()
    const rejection = nextMessage(friend)
    friend.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_forged', basedOnRevision: 0, leaseEpoch: 1,
    }))

    const rejected = await rejection
    expect(rejected).toMatchObject({ type: 'command_rejected', actionId: 'action_forged', code: 'controller_only', snapshot: null })
    expect(JSON.stringify(rejected)).not.toContain('private title')

    // The forged approval changed nothing: the host can still decide.
    const friendApproved = nextMessage(friend)
    approve(host)
    await expect(friendApproved).resolves.toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
    host.close()
    friend.close()
  })

  it('tells only the denied requester it was denied, without any room state', async () => {
    const { host, friend } = await roomWithPendingFriend()
    const denied = nextMessage(friend)
    host.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_friend', approve: false, actionId: 'action_deny_friend', basedOnRevision: 0, leaseEpoch: 1,
    }))

    const message = await denied
    expect(message).toMatchObject({ type: 'command_rejected', code: 'join_denied', snapshot: null })
    expect(JSON.stringify(message)).not.toContain('private title')
    host.close()
    friend.close()
  })

  it('starts delivering the full room state once the request is approved', async () => {
    const { host, friend } = await roomWithPendingFriend()
    const approved = nextMessage(friend)
    approve(host)
    const message = await approved
    expect(message).toMatchObject({ type: 'room_snapshot', reason: 'join_approved' })
    if (message.type === 'room_snapshot') {
      expect(message.snapshot.participants).toHaveLength(2)
      expect(message.snapshot.media).toMatchObject({ canonicalId: 'youtube:private-id' })
    }
    host.close()
    friend.close()
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

describe('frames the websocket library rejects', () => {
  // ws closes the connection with the matching status code and then emits
  // 'error' on the socket. The service used to have no listener for it, so one
  // frame from any client with an allowed Origin ended the whole process and
  // every in-memory room with it.
  const nextClose = (socket: WebSocket) => new Promise<number>((resolve, reject) => {
    const timeout = AbortSignal.timeout(4_000)
    const onAbort = () => reject(new Error('The socket was not closed.'))
    timeout.addEventListener('abort', onAbort, { once: true })
    socket.once('close', (code) => {
      timeout.removeEventListener('abort', onAbort)
      resolve(code)
    })
  })

  async function bystanderStillServed(bystander: WebSocket): Promise<void> {
    const reply = nextMessage(bystander)
    bystander.send(JSON.stringify({ type: 'ping', id: 'ping_bystander', sentAtLocalMs: 1 }))
    await expect(reply).resolves.toMatchObject({ type: 'pong' })
  }

  it('closes a client that sends a frame over the size limit with 1009 and keeps serving others', async () => {
    service = await createRoomService({ port: 0 })
    const bystander = await connect(service.url)
    const offender = await connect(service.url)
    const closed = nextClose(offender)

    offender.send('x'.repeat(16_385))

    await expect(closed).resolves.toBe(1009)
    await bystanderStillServed(bystander)
    bystander.close()
  })

  it('closes a client that sends invalid UTF-8 in a text frame with 1007 and keeps serving others', async () => {
    service = await createRoomService({ port: 0 })
    const bystander = await connect(service.url)
    const offender = await connect(service.url)
    const closed = nextClose(offender)

    offender.send(Buffer.from([0xff, 0xfe, 0xfd, 0xfc]), { binary: false })

    await expect(closed).resolves.toBe(1007)
    await bystanderStillServed(bystander)
    bystander.close()
  })

  it('closes a client whose binary frame decodes past the size limit and keeps serving others', async () => {
    service = await createRoomService({ port: 0 })
    const bystander = await connect(service.url)
    const offender = await connect(service.url)
    const closed = nextClose(offender)

    // 16,384 bytes pass maxPayload, but invalid UTF-8 decodes to three bytes
    // per replacement character, which the service's own check catches.
    offender.send(Buffer.alloc(16_384, 0xff))

    await expect(closed).resolves.toBe(1009)
    await bystanderStillServed(bystander)
    bystander.close()
  })
})

describe('empty room expiry with unapproved requests', () => {
  const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000
  const startMs = 1_900_000_000_000
  const hostMedia = { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A private title', durationSeconds: 600 }

  // Room lifetime runs on an injected clock and a short cleanup tick, so
  // nothing here waits in real time or fakes the global Date: the test moves
  // the clock and polls the service's own view of the room.
  let clockMs = startMs

  async function until(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
    const deadline = AbortSignal.timeout(timeoutMs)
    while (!condition()) {
      if (deadline.aborted)
        throw new Error(`Timed out waiting for ${what}.`)
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }

  async function startedRoom() {
    clockMs = startMs
    service = await createRoomService({ port: 0, now: () => clockMs, cleanupIntervalMs: 10 })
    const host = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'EXPR1234', media: hostMedia,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    // The service assigns the room code; the one a client proposes is only a
    // hint, so every later join must use the code it was given.
    return { host, code: created.snapshot.code, hostToken: created.sessionToken }
  }

  async function request(code: string, participantId: string): Promise<WebSocket> {
    const socket = await connect(service!.url)
    socket.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId, name: 'Rana', code, media: null,
    }))
    const joined = await nextMessage(socket)
    if (joined.type !== 'room_joined')
      throw new Error(`Expected the request to be accepted as pending, got ${joined.type}`)
    return socket
  }

  it('does not let a withdrawn request restart the clock of an empty room', async () => {
    const { host, code } = await startedRoom()
    host.close()
    await until(() => service!.inspectRoom(code)?.emptySinceMs === startMs, 'the empty-room clock to start')

    // 29 minutes into the 30 minute window a stranger who only knows the
    // code opens a request and walks away again.
    clockMs = startMs + 29 * 60_000
    const stranger = await request(code, 'participant_stranger')
    await until(() => service!.inspectRoom(code)?.pendingRequests === 1, 'the request to be pending')
    stranger.close()
    await until(() => service!.inspectRoom(code)?.pendingRequests === 0, 'the request to be withdrawn')
    expect(service!.inspectRoom(code)?.emptySinceMs).toBe(startMs)

    clockMs = startMs + EMPTY_ROOM_TTL_MS + 60_000
    await until(() => service!.inspectRoom(code) === null, 'the room to expire on its original clock')
  })

  it('tells a request that is still waiting when the empty room expires', async () => {
    const { host, code } = await startedRoom()
    const waiting = await request(code, 'participant_waiting')
    host.close()
    await until(() => service!.inspectRoom(code)?.connectedParticipants === false, 'the host to be gone')

    const closed = new Promise<{ code: number, reason: string }>((resolve, reject) => {
      const timeout = AbortSignal.timeout(3_000)
      const onAbort = () => reject(new Error('The waiting request was left connected to an expired room.'))
      timeout.addEventListener('abort', onAbort, { once: true })
      waiting.once('close', (closeCode, reason) => {
        timeout.removeEventListener('abort', onAbort)
        resolve({ code: closeCode, reason: reason.toString() })
      })
    })
    clockMs = startMs + EMPTY_ROOM_TTL_MS + 60_000

    await expect(closed).resolves.toEqual({ code: 1000, reason: 'room_expired' })
    expect(service!.inspectRoom(code)).toBeNull()
  })

  it('keeps a room alive when a member comes back before the clock runs out', async () => {
    const { host, code, hostToken } = await startedRoom()
    host.close()
    await until(() => service!.inspectRoom(code)?.emptySinceMs === startMs, 'the empty-room clock to start')

    clockMs = startMs + 20 * 60_000
    const returning = await connect(service!.url)
    returning.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code, media: hostMedia, sessionToken: hostToken,
    }))
    await expect(nextMessage(returning)).resolves.toMatchObject({ type: 'room_joined' })
    expect(service!.inspectRoom(code)).toMatchObject({ connectedParticipants: true, emptySinceMs: null })

    // Well past the time the original clock would have expired, several
    // cleanup ticks later: the room is still there.
    clockMs = startMs + EMPTY_ROOM_TTL_MS + 5 * 60_000
    await new Promise<void>(resolve => setTimeout(resolve, 80))
    expect(service!.inspectRoom(code)).toMatchObject({ connectedParticipants: true, emptySinceMs: null })
    returning.close()
  })
})

describe('controller recovery', () => {
  const GRACE_MS = 60
  const media = { service: 'youtube', canonicalId: 'youtube:private-id', title: 'A title', durationSeconds: 600 }

  async function roomWithApprovedFriend(serviceOptions: { controllerGraceMs?: number } = { controllerGraceMs: GRACE_MS }) {
    service = await createRoomService({ port: 0, cleanupIntervalMs: 10, ...serviceOptions })
    const host = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'RECV1234', media,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    const code = created.snapshot.code

    const friend = await connect(service.url)
    const hostNotice = nextMessage(host)
    friend.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code, media: null,
    }))
    const friendJoined = await nextMessage(friend)
    if (friendJoined.type !== 'room_joined')
      throw new Error('Expected room_joined')
    await hostNotice
    const hostApproved = nextMessage(host)
    const friendApproved = nextMessage(friend)
    host.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_approve_friend', basedOnRevision: 0, leaseEpoch: 1,
    }))
    await Promise.all([hostApproved, friendApproved])
    return { host, friend, code, friendToken: friendJoined.sessionToken }
  }

  async function until(condition: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
    const deadline = AbortSignal.timeout(timeoutMs)
    while (!condition()) {
      if (deadline.aborted)
        throw new Error(`Timed out waiting for ${what}.`)
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }

  // Recovery timers with this delay are captured instead of started: the test
  // reads the delay each one was given and decides when it fires, so nothing
  // here waits for a grace period or races one.
  function captureRecoveryTimers(delayMs: number) {
    const startTimer = globalThis.setTimeout
    const planned: Array<{ delayMs: number, fire: () => void }> = []
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
      if (delay !== delayMs)
        return startTimer(handler, delay, ...args)
      planned.push({ delayMs: delay, fire: handler })
      return startTimer(() => {}, 0)
    }) as unknown as typeof setTimeout)
    return { planned, release: () => spy.mockRestore() }
  }

  it('hands control to a connected member when the controller does not return in time', async () => {
    const { host, friend } = await roomWithApprovedFriend()

    host.close()
    const recovered = await nextRoomSnapshot(friend, 'controller_recovered')

    expect(recovered.snapshot.controller.participantId).toBe('participant_friend')
    friend.close()
  })

  it('hands control to a member that returns after the grace period lapsed with nobody connected', async () => {
    const { host, friend, code, friendToken } = await roomWithApprovedFriend()

    host.close()
    friend.close()
    await until(() => service!.inspectRoom(code)?.connectedParticipants === false, 'everyone to be gone')
    // Long enough for the grace period to run out with nobody to take control.
    await new Promise<void>(resolve => setTimeout(resolve, GRACE_MS * 4))

    const back = await connect(service!.url)
    back.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code, media: null, sessionToken: friendToken,
    }))
    await expect(nextMessage(back)).resolves.toMatchObject({ type: 'room_joined' })
    const recovered = await nextRoomSnapshot(back, 'controller_recovered')

    expect(recovered.snapshot.controller.participantId).toBe('participant_friend')
    back.close()
  })

  describe('with the grace period captured', () => {
    // A value nothing else in the process uses as a timer delay.
    const CAPTURED_GRACE_MS = 4_321

    it('gives the host a full grace period again when a member returns after the plan lapsed', async () => {
      const timers = captureRecoveryTimers(CAPTURED_GRACE_MS)
      try {
        const { host, friend, code, friendToken } = await roomWithApprovedFriend({ controllerGraceMs: CAPTURED_GRACE_MS })
        host.close()
        await until(() => timers.planned.length === 1, 'the recovery to be planned')
        friend.close()
        await until(() => service!.inspectRoom(code)?.connectedParticipants === false, 'everyone to be gone')
        // The grace period runs out with nobody there to hand control to.
        timers.planned[0]!.fire()

        const back = await connect(service!.url)
        back.send(JSON.stringify({
          type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code, media: null, sessionToken: friendToken,
        }))
        await expect(nextMessage(back)).resolves.toMatchObject({ type: 'room_joined' })

        // A new plan with a full grace period, not control handed over at once.
        expect(timers.planned).toHaveLength(2)
        expect(timers.planned[1]!.delayMs).toBe(CAPTURED_GRACE_MS)
        timers.planned[1]!.fire()
        const recovered = await nextRoomSnapshot(back, 'controller_recovered')
        expect(recovered.snapshot.controller.participantId).toBe('participant_friend')
        back.close()
      }
      finally {
        timers.release()
      }
    })

    it('keeps the recovery that is already pending when a member reconnects', async () => {
      const timers = captureRecoveryTimers(CAPTURED_GRACE_MS)
      try {
        const { host, friend, code, friendToken } = await roomWithApprovedFriend({ controllerGraceMs: CAPTURED_GRACE_MS })
        host.close()
        await until(() => timers.planned.length === 1, 'the recovery to be planned')
        friend.close()
        await until(() => service!.inspectRoom(code)?.connectedParticipants === false, 'everyone to be gone')

        const again = await connect(service!.url)
        again.send(JSON.stringify({
          type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code, media: null, sessionToken: friendToken,
        }))
        await expect(nextMessage(again)).resolves.toMatchObject({ type: 'room_joined' })

        // The member's return starts nothing new: the plan made when the host
        // left is still the one in force, so a member that keeps reconnecting
        // cannot keep a host that is gone in control.
        expect(timers.planned).toHaveLength(1)
        timers.planned[0]!.fire()
        const recovered = await nextRoomSnapshot(again, 'controller_recovered')
        expect(recovered.snapshot.controller.participantId).toBe('participant_friend')
        again.close()
      }
      finally {
        timers.release()
      }
    })
  })
})

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
    const timeout = AbortSignal.timeout(4_000)
    const onAbort = () => {
      socket.off('message', onMessage)
      reject(new Error('Timed out waiting for server message.'))
    }
    const onMessage = (data: Buffer) => {
      timeout.removeEventListener('abort', onAbort)
      resolve(JSON.parse(data.toString()) as ServerMessage)
    }
    timeout.addEventListener('abort', onAbort, { once: true })
    socket.once('message', onMessage)
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

async function expectNoMessage(socket: WebSocket): Promise<void> {
  await expect(nextMessageForAbsence(socket)).rejects.toThrow('Timed out waiting for server message.')
}

async function nextMessageForAbsence(socket: WebSocket): Promise<ServerMessage> {
  return new Promise<ServerMessage>((resolve, reject) => {
    const timeout = AbortSignal.timeout(300)
    const onAbort = () => {
      socket.off('message', onMessage)
      reject(new Error('Timed out waiting for server message.'))
    }
    const onMessage = (data: Buffer) => {
      timeout.removeEventListener('abort', onAbort)
      resolve(JSON.parse(data.toString()) as ServerMessage)
    }
    timeout.addEventListener('abort', onAbort, { once: true })
    socket.once('message', onMessage)
  })
}
