import { CURRENT_CLIENT_CAPABILITIES } from '@syncyourjoy/protocol'
import type { ServerMessage } from '@syncyourjoy/protocol'
import { DISCONNECT_PAUSE_GRACE_MS, PLAYBACK_PROGRESS_TIMEOUT_MS, PLAYBACK_REPORT_SILENCE_TIMEOUT_MS, PLAYBACK_STARTUP_GRACE_MS, PLAYBACK_STARTUP_TIMEOUT_MS, SEEK_BARRIER_MAX_WAIT_MS } from '@syncyourjoy/sync-engine'
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

  it('gives the controller the coordinator\'s own timeline with a report, including why a socket closed', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'TLINE123', media: null,
    }))
    const hostCreated = await nextMessage(host)
    if (hostCreated.type !== 'room_joined')
      throw new Error('Expected room_joined')
    await joinAndApprove(host, friend, hostCreated.snapshot.code, 'participant_friend', 'Rana', null)

    const hostNotified = nextMessage(host)
    friend.close(4000, 'Closed by https://example.test/watch?token=secret')
    await hostNotified

    const messages: ServerMessage[] = []
    const collect = (data: Buffer) => messages.push(JSON.parse(data.toString()) as ServerMessage)
    host.on('message', collect)
    host.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_timeline' }))
    await vi.waitFor(() => expect(messages.some(message => message.type === 'diagnostics_room')).toBe(true))
    host.off('message', collect)

    const timeline = messages.find(message => message.type === 'diagnostics_room')
    if (timeline?.type !== 'diagnostics_room')
      throw new Error('Expected diagnostics_room')
    expect(timeline.reportId).toBe('report_timeline')
    const closed = timeline.room.entries.find(entry => entry.kind === 'transport' && entry.event === 'socket_closed')
    expect(closed?.detail).toMatchObject({ participantId: 'participant_friend', code: 4000, reason: 'other', participantStillConnected: false })
    expect(JSON.stringify(timeline)).not.toContain('secret')
    expect(timeline.room.entries.some(entry => entry.kind === 'change' && entry.participants.some(participant => participant.id === 'participant_friend' && !participant.connected))).toBe(true)
    host.close()
  })

  it('does not hand the timeline to a participant who is not the controller', async () => {
    service = await createRoomService({ port: 0 })
    const host = await connect(service.url)
    const friend = await connect(service.url)
    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'TLINE456', media: null,
    }))
    const hostCreated = await nextMessage(host)
    if (hostCreated.type !== 'room_joined')
      throw new Error('Expected room_joined')
    await joinAndApprove(host, friend, hostCreated.snapshot.code, 'participant_friend', 'Rana', null)

    const messages: ServerMessage[] = []
    friend.on('message', data => messages.push(JSON.parse(data.toString()) as ServerMessage))
    friend.send(JSON.stringify({ type: 'request_diagnostics', reportId: 'report_member' }))
    await vi.waitFor(() => expect(messages.some(message => message.type === 'error')).toBe(true))
    expect(messages.some(message => message.type === 'diagnostics_room')).toBe(false)
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

describe('automatic resume after the room paused a stalled player (#141)', () => {
  const startMs = 1_800_000_000_000
  let clockMs = startMs
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 40))

  /** A host in a transactional room whose snapshots are collected, and the means to drive its player. */
  async function openRoom() {
    clockMs = startMs
    service = await createRoomService({ port: 0, now: () => clockMs, cleanupIntervalMs: 10 })
    const media = { service: 'youtube', canonicalId: 'youtube:auto-resume', title: 'Auto resume test video', durationSeconds: 600 }
    const host = await connect(service.url)
    const seen: Array<Extract<ServerMessage, { type: 'room_snapshot' }>> = []
    host.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as ServerMessage
      if (message.type === 'room_snapshot')
        seen.push(message)
    })
    const has = (reason: string) => seen.some(message => message.reason === reason)
    const waitFor = async (reason: string) => {
      const deadline = AbortSignal.timeout(3_000)
      for (;;) {
        const found = seen.find(message => message.reason === reason)
        if (found)
          return found
        if (deadline.aborted)
          throw new Error(`Timed out waiting for room snapshot: ${reason} (saw ${seen.map(message => message.reason).join(', ')})`)
        await new Promise<void>(resolve => setTimeout(resolve, 5))
      }
    }
    const sample = (overrides: Record<string, unknown> = {}) => host.send(JSON.stringify({
      type: 'player_status',
      basedOnRevision: seen.at(-1)!.snapshot.revision,
      sample: { positionSeconds: 20, durationSeconds: 600, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: clockMs, ...overrides },
    }))
    /** Sends `overrides` as the player's report once a second until the room says `reason`, at most `steps` times. */
    const reportUntil = async (reason: string, steps: number, overrides: Record<string, unknown>) => {
      for (let step = 0; step < steps && !has(reason); step += 1) {
        sample(overrides)
        await settle()
        clockMs += 1_000
      }
    }

    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'AUTORSM1', media, capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    seen.push({ type: 'room_snapshot', reason: 'room_joined', snapshot: created.snapshot })
    host.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await waitFor('participant_ready')
    return { host, seen, has, waitFor, sample, reportUntil }
  }

  /** Plays from 20 s and returns once the host's player has acknowledged the start. */
  async function startPlaying(room: Awaited<ReturnType<typeof openRoom>>) {
    room.host.send(JSON.stringify({
      type: 'control', actionId: 'action_auto_resume_play', basedOnRevision: room.seen.at(-1)!.snapshot.revision, leaseEpoch: 1, kind: 'play', positionSeconds: 20,
    }))
    const operation = (await room.waitFor('control_play_pending')).snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const acknowledge = (phase: 'prepared' | 'started', sampleSequence: number) => room.host.send(JSON.stringify({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase, participantId: 'participant_host',
        bindingId: 'binding_host_123456', sourceGeneration: 1, sampleSequence, observedPositionSeconds: 20, observedAtLocalMs: clockMs,
      },
    }))
    acknowledge('prepared', 1)
    const committed = await room.waitFor('operation_committed')
    clockMs = committed.snapshot.contract?.operation?.effectiveAtServerMs ?? clockMs
    acknowledge('started', 2)
    await room.waitFor('operation_started')
  }

  it('resumes from the cleanup timer once the player can play again, and tells the room', async () => {
    const room = await openRoom()
    await startPlaying(room)

    // The player buffers until the room pauses for everyone.
    clockMs += 3_000
    await room.reportUntil('participant_buffering', 8, { buffering: true, progressed: false })
    const paused = await room.waitFor('participant_buffering')
    expect(paused.snapshot.playback.status).toBe('paused')

    // It cannot play yet: nothing is started, however long it stays that way.
    for (let step = 0; step < 3; step += 1) {
      room.sample({ paused: true, buffering: true, progressed: false, canPlay: false })
      await settle()
      clockMs += 1_000
    }
    expect(room.has('auto_resume_play_pending')).toBe(false)

    // Once it can play for the stability window, the room starts a Play by itself.
    await room.reportUntil('auto_resume_play_pending', 4, { paused: true, buffering: false, progressed: false, canPlay: true })
    const resumed = await room.waitFor('auto_resume_play_pending')
    expect(resumed.snapshot.contract?.operation).toMatchObject({ kind: 'play', phase: 'preparing', targetPositionSeconds: paused.snapshot.playback.positionSeconds })
    room.host.close()
  })
})

describe('a connection that drops while the room is playing', () => {
  const startMs = 1_800_000_000_000
  const GRACE_MS = 8_000
  let clockMs = startMs
  const realWait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  const media = { service: 'youtube', canonicalId: 'youtube:dropped-connection', title: 'Dropped connection test video', durationSeconds: 600 }

  /** A host and an approved friend, both ready, a transactional Play started and acknowledged by both. */
  async function playingPair() {
    clockMs = startMs
    service = await createRoomService({ port: 0, now: () => clockMs, cleanupIntervalMs: 10, controllerGraceMs: 600_000 })
    const host = await connect(service.url)
    const seen: Array<Extract<ServerMessage, { type: 'room_snapshot' }>> = []
    host.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as ServerMessage
      if (message.type === 'room_snapshot')
        seen.push(message)
    })
    const waitFor = async (matches: (message: Extract<ServerMessage, { type: 'room_snapshot' }>) => boolean, what: string) => {
      const deadline = AbortSignal.timeout(3_000)
      for (;;) {
        const found = seen.find(matches)
        if (found)
          return found
        if (deadline.aborted)
          throw new Error(`Timed out waiting for ${what} (saw ${seen.map(message => message.reason).join(', ')})`)
        await new Promise<void>(resolve => setTimeout(resolve, 5))
      }
    }
    const latest = () => seen.at(-1)!.snapshot
    const reasons = () => seen.map(message => message.reason)

    host.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'DROPCON1', media, capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    const created = await nextMessage(host)
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    seen.push({ type: 'room_snapshot', reason: 'room_joined', snapshot: created.snapshot })
    host.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await waitFor(message => message.reason === 'participant_ready', 'the host to be ready')

    const friend = await connect(service.url)
    friend.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: created.snapshot.code, media, capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    const friendJoined = await nextMessage(friend)
    if (friendJoined.type !== 'room_joined')
      throw new Error('Expected room_joined')
    host.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_friend', approve: true, actionId: 'action_approve_drop_friend', basedOnRevision: 0, leaseEpoch: 1,
    }))
    await waitFor(message => message.snapshot.participants.some(participant => participant.id === 'participant_friend'), 'the friend to be admitted')
    friend.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    await waitFor(message => message.snapshot.participants.every(participant => participant.ready), 'both to be ready')

    // A client presses Play on the room state it has; let the room finish announcing before it does.
    for (let count = -1; count !== seen.length;) {
      count = seen.length
      await realWait(60)
    }
    host.send(JSON.stringify({
      type: 'control', actionId: 'action_drop_play', basedOnRevision: latest().revision, leaseEpoch: 1, kind: 'play', positionSeconds: 20,
    }))
    const operation = (await waitFor(message => message.reason === 'control_play_pending', 'the Play')).snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const acknowledge = (socket: WebSocket, participantId: string, phase: 'prepared' | 'started', sampleSequence: number) => socket.send(JSON.stringify({
      type: 'operation_ack',
      acknowledgement: {
        mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase, participantId,
        bindingId: `binding_${participantId}`, sourceGeneration: 1, sampleSequence, observedPositionSeconds: 20, observedAtLocalMs: clockMs,
      },
    }))
    acknowledge(host, 'participant_host', 'prepared', 1)
    acknowledge(friend, 'participant_friend', 'prepared', 1)
    const committed = await waitFor(message => message.reason === 'operation_committed', 'the Play to commit')
    clockMs = committed.snapshot.contract?.operation?.effectiveAtServerMs ?? clockMs
    acknowledge(host, 'participant_host', 'started', 2)
    acknowledge(friend, 'participant_friend', 'started', 2)
    await waitFor(message => message.reason === 'operation_started', 'the Play to start')
    return { host, friend, seen, waitFor, reasons, code: created.snapshot.code, friendToken: friendJoined.sessionToken }
  }

  it('keeps playing for the grace, then pauses for everyone', async () => {
    const room = await playingPair()

    room.friend.terminate()
    const dropped = await room.waitFor(message => message.reason === 'participant_disconnected', 'the drop')
    expect(dropped.snapshot.playback.status).toBe('playing')
    expect(dropped.snapshot.participants.find(participant => participant.id === 'participant_friend')).toMatchObject({ connected: false })

    clockMs += GRACE_MS - 1_000
    await realWait(80)
    expect(room.reasons()).not.toContain('participant_disconnect_timeout')

    clockMs += 1_000
    const paused = await room.waitFor(message => message.reason === 'participant_disconnect_timeout', 'the pause after the grace')
    expect(paused.snapshot.playback.status).toBe('paused')
    room.host.close()
  })

  it('pauses at once for a participant who leaves on purpose', async () => {
    const room = await playingPair()

    room.friend.close(1000, 'left_room')
    const left = await room.waitFor(message => message.reason === 'participant_disconnected', 'the departure')

    expect(left.snapshot.playback.status).toBe('paused')
    room.host.close()
  })

  it('keeps playing when the participant is back inside the grace', async () => {
    const room = await playingPair()
    room.friend.terminate()
    await room.waitFor(message => message.reason === 'participant_disconnected', 'the drop')

    clockMs += 1_000
    const back = await connect(service!.url)
    back.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: room.code, media, sessionToken: room.friendToken, capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    const returned = await room.waitFor(message => message.reason === 'participant_reconnected', 'the return')
    expect(returned.snapshot.playback.status).toBe('playing')

    // Past the grace the room is not paused for the participant who came back. (It may still
    // pause for silent players, which these fakes are, so only the grace is checked.)
    clockMs += GRACE_MS * 2
    await realWait(80)
    expect(room.reasons()).not.toContain('participant_disconnect_timeout')
    back.close()
    room.host.close()
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

  // Recovery timers with one of these delays are captured instead of started:
  // the test reads the delay each one was given and decides when it fires, so
  // nothing here waits for a grace period or races one.
  function captureRecoveryTimers(delaysMs: number[]) {
    const startTimer = globalThis.setTimeout
    const planned: Array<{ delayMs: number, fire: () => void }> = []
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === undefined || !delaysMs.includes(delay))
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

  describe('with the recovery timers captured', () => {
    // A value nothing else in the process uses as a timer delay.
    const CAPTURED_GRACE_MS = 4_321

    it('gives the host a full grace period again when a member returns after the plan lapsed', async () => {
      const timers = captureRecoveryTimers([CAPTURED_GRACE_MS])
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

    it('gives a controller that is backing off a longer grace period when a member re-arms the recovery', async () => {
      // The delays the service uses when it is not given a shorter grace period.
      const timers = captureRecoveryTimers([10_000, 20_000])
      try {
        const { host, friend, code, friendToken } = await roomWithApprovedFriend({})
        host.close()
        await until(() => timers.planned.length === 1, 'the recovery to be planned')
        friend.close()
        await until(() => service!.inspectRoom(code)?.connectedParticipants === false, 'everyone to be gone')
        timers.planned[0]!.fire()

        const back = await connect(service!.url)
        back.send(JSON.stringify({
          type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code, media: null, sessionToken: friendToken,
        }))
        await expect(nextMessage(back)).resolves.toMatchObject({ type: 'room_joined' })

        // The host that left while a member was there gets 10 s. One that has
        // been backing off since an outage is given more than the extension's
        // longest reconnect delay (15 s plus up to 250 ms of jitter).
        expect(timers.planned.map(timer => timer.delayMs)).toEqual([10_000, 20_000])
        back.close()
      }
      finally {
        timers.release()
      }
    })

    it('keeps the recovery that is already pending when a member reconnects', async () => {
      const timers = captureRecoveryTimers([CAPTURED_GRACE_MS])
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

    it('plans no recovery when a member returns while the controller is connected', async () => {
      const timers = captureRecoveryTimers([CAPTURED_GRACE_MS])
      try {
        const { host, friend, code, friendToken } = await roomWithApprovedFriend({ controllerGraceMs: CAPTURED_GRACE_MS })
        friend.close()
        await until(() => service!.inspectRoom(code)?.sockets === 1, 'the member to be gone')

        const again = await connect(service!.url)
        again.send(JSON.stringify({
          type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code, media: null, sessionToken: friendToken,
        }))
        await expect(nextMessage(again)).resolves.toMatchObject({ type: 'room_joined' })

        // The host is there, so the member's return starts no timer that
        // would only wake the room to find nothing to do.
        expect(timers.planned).toHaveLength(0)
        host.close()
        again.close()
      }
      finally {
        timers.release()
      }
    })
  })
})

describe('deadlines the cleanup timer enforces, seen over sockets', () => {
  const startMs = 1_800_000_000_000
  let clockMs = startMs
  let opened: WebSocket[] = []
  const realWait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  // Eight 10 ms cleanup ticks of real time, for the timer to act on a clock that has moved.
  const ticks = () => realWait(80)
  const media = { service: 'youtube', canonicalId: 'youtube:socket-deadlines', title: 'Socket deadline test video', durationSeconds: 600 }
  type Snapshot = Extract<ServerMessage, { type: 'room_snapshot' }>
  type Operation = NonNullable<NonNullable<Snapshot['snapshot']['contract']>['operation']>
  const label = (message: ServerMessage) => message.type === 'room_snapshot' ? message.reason : message.type

  afterEach(() => {
    for (const socket of opened)
      socket.terminate()
    opened = []
  })

  /** A socket and every message it receives, so a test can count exactly what one transition sent. */
  async function watch(url: string, participantId: string) {
    const socket = await connect(url)
    opened.push(socket)
    const received: ServerMessage[] = []
    socket.on('message', (data: Buffer) => {
      received.push(JSON.parse(data.toString()) as ServerMessage)
    })
    const until = async (matches: (message: ServerMessage) => boolean, what: string, from = 0) => {
      const deadline = AbortSignal.timeout(3_000)
      for (;;) {
        const found = received.slice(from).find(matches)
        if (found)
          return found
        if (deadline.aborted)
          throw new Error(`Timed out waiting for ${what} (saw ${JSON.stringify(received.slice(from))})`)
        await realWait(5)
      }
    }
    return {
      socket,
      participantId,
      received,
      until,
      mark: () => received.length,
      since: (mark: number) => received.slice(mark).map(label),
      snapshotWith: async (reason: string, from = 0) => await until(message => message.type === 'room_snapshot' && message.reason === reason, `room snapshot ${reason}`, from) as Snapshot,
      lastSnapshot: (): Snapshot => {
        const found = received.filter((message): message is Snapshot => message.type === 'room_snapshot').at(-1)
        if (!found)
          throw new Error('No room snapshot received yet.')
        return found
      },
      /** The newest room state this socket has been told, whatever message carried it. */
      latest: () => {
        const found = received.filter((message): message is Snapshot | Extract<ServerMessage, { type: 'room_joined' }> => message.type === 'room_snapshot' || message.type === 'room_joined').at(-1)
        if (!found)
          throw new Error('No room state received yet.')
        return found.snapshot
      },
    }
  }
  type Watched = Awaited<ReturnType<typeof watch>>
  interface Room { url: string, code: string, negotiated: boolean, host: Watched }
  let actionCount = 0

  // With manual ticks the service's cleanup timer is captured instead of started, so a test decides
  // exactly when a timer turn happens and can tell one turn from the next.
  const MANUAL_TICK_INTERVAL_MS = 3_600_000
  let runCleanupTurn: (() => void) | null = null

  async function openRoom(options: { negotiated: boolean, manualTicks?: boolean }): Promise<Room> {
    clockMs = startMs
    runCleanupTurn = null
    const startInterval = globalThis.setInterval
    const spy = options.manualTicks
      ? vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, delay?: number, ...args: unknown[]) => {
        if (delay !== MANUAL_TICK_INTERVAL_MS)
          return startInterval(handler, delay, ...args)
        runCleanupTurn = handler
        return startInterval(() => {}, MANUAL_TICK_INTERVAL_MS)
      }) as unknown as typeof setInterval)
      : null
    try {
      service = await createRoomService({ port: 0, now: () => clockMs, cleanupIntervalMs: options.manualTicks ? MANUAL_TICK_INTERVAL_MS : 10 })
    }
    finally {
      spy?.mockRestore()
    }
    const host = await watch(service.url, 'participant_host')
    host.socket.send(JSON.stringify({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'LOCAL000', media,
      ...(options.negotiated ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}),
    }))
    const created = await host.until(message => message.type === 'room_joined', 'room_joined')
    if (created.type !== 'room_joined')
      throw new Error('Expected room_joined')
    // The service issues its own room code; the one sent here is ignored.
    return { url: service.url, code: created.snapshot.code, negotiated: options.negotiated, host }
  }

  /** Approves a new member through the host, as a real join does, and returns its socket and session token. */
  async function admit(room: Room, participantId: string, name: string) {
    const guest = await watch(room.url, participantId)
    guest.socket.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId, name, code: room.code, media,
      ...(room.negotiated ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}),
    }))
    const joined = await guest.until(message => message.type === 'room_joined', 'room_joined')
    if (joined.type !== 'room_joined')
      throw new Error('Expected room_joined')
    room.host.socket.send(JSON.stringify({
      type: 'respond_to_join', participantId, approve: true, actionId: `action_approve_${participantId}`, basedOnRevision: 0, leaseEpoch: 1,
    }))
    await guest.snapshotWith('join_approved')
    return { guest, sessionToken: joined.sessionToken }
  }

  async function makeReady(...players: Watched[]) {
    for (const player of players) {
      const from = player.mark()
      player.socket.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
      await player.snapshotWith('participant_ready', from)
    }
  }

  /** Waits until no player has received anything new for a moment, so the next press is made on the room's current state. */
  async function quiet(...players: Watched[]) {
    const total = () => players.reduce((sum, player) => sum + player.received.length, 0)
    for (let count = -1; count !== total();) {
      count = total()
      await realWait(60)
    }
  }

  /** A host and, optionally, an approved friend, all ready and with the room quiet. */
  async function readyRoom(options: { negotiated: boolean, friend: boolean, manualTicks?: boolean }) {
    const room = await openRoom(options)
    await makeReady(room.host)
    if (!options.friend) {
      await quiet(room.host)
      return { room, friend: null, friendToken: '' }
    }
    const { guest, sessionToken } = await admit(room, 'participant_friend', 'Rana')
    await makeReady(guest)
    await quiet(room.host, guest)
    return { room, friend: guest, friendToken: sessionToken }
  }

  /** The controller presses Play or a seek on the state it has, and the snapshot announcing it is returned. */
  async function press(room: Room, kind: 'play' | 'seek', positionSeconds: number): Promise<Snapshot> {
    const reason = kind === 'seek' ? 'control_seek_pending' : room.negotiated ? 'control_play_pending' : 'control_play'
    const from = room.host.mark()
    actionCount += 1
    room.host.socket.send(JSON.stringify({
      type: 'control', actionId: `action_${kind}_${actionCount}`, basedOnRevision: room.host.latest().revision, leaseEpoch: 1, kind, positionSeconds,
    }))
    return await room.host.snapshotWith(reason, from)
  }

  const acknowledge = (player: Watched, operation: Operation, phase: 'prepared' | 'started', sampleSequence: number) => player.socket.send(JSON.stringify({
    type: 'operation_ack',
    acknowledgement: {
      mediaEpoch: operation.mediaEpoch, operationId: operation.operationId, phase, participantId: player.participantId,
      bindingId: `binding_${player.participantId}`, sourceGeneration: 1, sampleSequence, observedPositionSeconds: 20, observedAtLocalMs: clockMs,
    },
  }))

  /** Plays from 20 s in a negotiated room: every player prepares, the Play commits, and every player acknowledges the start. */
  async function playNegotiated(room: Room, players: Watched[]) {
    const operation = (await press(room, 'play', 20)).snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const from = room.host.mark()
    for (const player of players)
      acknowledge(player, operation, 'prepared', 1)
    const committed = await room.host.snapshotWith('operation_committed', from)
    clockMs = committed.snapshot.contract?.operation?.effectiveAtServerMs ?? clockMs
    for (const player of players)
      acknowledge(player, operation, 'started', 2)
    return await room.host.snapshotWith('operation_started', from)
  }

  const report = (player: Watched, overrides: Record<string, unknown> = {}) => player.socket.send(JSON.stringify({
    type: 'player_status',
    basedOnRevision: player.latest().revision,
    sample: { positionSeconds: 20, durationSeconds: media.durationSeconds, paused: false, buffering: false, progressed: true, playbackStarted: true, sampledAtLocalMs: clockMs, ...overrides },
  }))

  /** Moves the clock to `untilMs` in one-second steps, each with a healthy report from every player in `players`. */
  async function reportHealthyUntil(players: Watched[], untilMs: number) {
    while (clockMs < untilMs) {
      clockMs = Math.min(clockMs + 1_000, untilMs)
      for (const player of players)
        report(player)
      await realWait(30)
    }
  }

  /** Runs exactly one cleanup turn of a manual-ticks room, then gives its broadcast time to arrive. */
  async function cleanupTurn() {
    if (!runCleanupTurn)
      throw new Error('This room was not opened with manual ticks.')
    runCleanupTurn()
    await realWait(60)
  }

  /** Moves the clock to `ms`, waits for the transition `reason`, then gives the timer more ticks to send anything else. */
  async function crossDeadline(player: Watched, ms: number, reason: string, mark: number) {
    clockMs = ms
    await player.snapshotWith(reason, mark)
    await ticks()
  }

  /** Long steps of the clock after a transition: the timer has nothing left to say about it. */
  async function letTheClockRun() {
    clockMs += 1_000
    await ticks()
    clockMs += 20_000
    await ticks()
  }

  /** Messages on one socket are handled in order, so once the pong is back everything the room sent before it has arrived. */
  async function settle(player: Watched) {
    const mark = player.mark()
    const id = `settle_${mark}`
    player.socket.send(JSON.stringify({ type: 'ping', id, sentAtLocalMs: clockMs }))
    await player.until(message => message.type === 'pong' && message.id === id, `pong ${id}`, mark)
  }

  /** What a socket was told since `mark`, without the pongs of `settle` and the status changes that player reports cause. */
  const transitions = (player: Watched, mark: number) => player.since(mark).filter(reason => reason !== 'pong' && reason !== 'participant_status_changed')

  /** The friend's connection drops without a goodbye while the room plays; returns the snapshot that tells the host so. */
  async function dropFriend(room: Room, friend: Watched): Promise<Snapshot> {
    const from = room.host.mark()
    friend.socket.terminate()
    return await room.host.snapshotWith('participant_disconnected', from)
  }

  it('pauses once, from the cleanup timer, when no player confirms a seek before the barrier closes', async () => {
    const { room } = await readyRoom({ negotiated: false, friend: false })
    const issuedAt = clockMs
    const pending = await press(room, 'seek', 90)
    expect(pending.snapshot.seek).not.toBeNull()
    const mark = room.host.mark()

    clockMs = issuedAt + SEEK_BARRIER_MAX_WAIT_MS - 1
    await ticks()
    expect(room.host.since(mark)).toEqual([])

    await crossDeadline(room.host, issuedAt + SEEK_BARRIER_MAX_WAIT_MS, 'seek_timeout_paused', mark)
    expect(room.host.since(mark)).toEqual(['seek_timeout_paused'])
    const timedOut = room.host.lastSnapshot()
    expect(timedOut.snapshot.playback).toMatchObject({ status: 'paused', positionSeconds: 90 })
    expect(timedOut.snapshot.revision).toBe(pending.snapshot.revision + 1)
    expect(timedOut.snapshot.seek).toBeNull()
    expect(timedOut.snapshot.participants).toEqual([expect.objectContaining({ id: 'participant_host', playbackStatus: 'recovery-required' })])

    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['seek_timeout_paused'])
  })

  it('does not time out a seek that every player confirmed in time', async () => {
    const { room } = await readyRoom({ negotiated: false, friend: false })
    const issuedAt = clockMs
    const pending = await press(room, 'seek', 90)
    const mark = room.host.mark()

    clockMs = issuedAt + 500
    room.host.socket.send(JSON.stringify({ type: 'seek_applied', revision: pending.snapshot.revision, positionSeconds: 90 }))
    await room.host.snapshotWith('seek_aligned_paused', mark)

    clockMs = issuedAt + SEEK_BARRIER_MAX_WAIT_MS
    await ticks()
    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['seek_aligned_paused'])
    expect(room.host.lastSnapshot().snapshot.revision).toBe(pending.snapshot.revision + 1)
  })

  it('pauses once, from the cleanup timer, when the prepare acknowledgement of a negotiated Play never comes', async () => {
    const { room } = await readyRoom({ negotiated: true, friend: false })
    const issuedAt = clockMs
    const pending = await press(room, 'play', 20)
    const operation = pending.snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    expect(operation.phase).toBe('preparing')
    const mark = room.host.mark()

    clockMs = issuedAt + SEEK_BARRIER_MAX_WAIT_MS - 1
    await ticks()
    expect(room.host.since(mark)).toEqual([])

    await crossDeadline(room.host, issuedAt + SEEK_BARRIER_MAX_WAIT_MS, 'operation_timeout_paused', mark)
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused'])
    const timedOut = room.host.lastSnapshot()
    expect(timedOut.snapshot.playback).toMatchObject({ status: 'paused', positionSeconds: 20 })
    expect(timedOut.snapshot.revision).toBe(pending.snapshot.revision + 1)
    expect(timedOut.snapshot.contract?.operation).toMatchObject({ operationId: operation.operationId, phase: 'failed', reason: 'deadline-expired' })

    // A late acknowledgement for the failed operation does not revive it.
    acknowledge(room.host, operation, 'prepared', 1)
    await ticks()
    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused'])
  })

  it('answers a prepare acknowledgement that arrives after the deadline with the timeout, before the timer has looked', async () => {
    const { room } = await readyRoom({ negotiated: true, friend: false, manualTicks: true })
    const pending = await press(room, 'play', 20)
    const operation = pending.snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const mark = room.host.mark()

    // No cleanup turn has run, so only the acknowledgement can tell the room that the window is over.
    clockMs = operation.deadlineAtServerMs
    acknowledge(room.host, operation, 'prepared', 1)
    await room.host.snapshotWith('operation_timeout_paused', mark)
    await settle(room.host)
    expect(transitions(room.host, mark)).toEqual(['operation_timeout_paused'])
    const timedOut = room.host.lastSnapshot()
    expect(timedOut.snapshot.playback).toMatchObject({ status: 'paused', positionSeconds: 20 })
    expect(timedOut.snapshot.revision).toBe(pending.snapshot.revision + 1)
    expect(timedOut.snapshot.contract?.operation).toMatchObject({ operationId: operation.operationId, phase: 'failed', reason: 'deadline-expired' })

    // The timer finds nothing left to release, and a second late acknowledgement changes nothing.
    await cleanupTurn()
    acknowledge(room.host, operation, 'prepared', 2)
    await settle(room.host)
    await cleanupTurn()
    expect(transitions(room.host, mark)).toEqual(['operation_timeout_paused'])
    expect(room.host.lastSnapshot().snapshot.revision).toBe(timedOut.snapshot.revision)
  })

  it('ignores a repeated prepare acknowledgement for an operation the controller has already paused', async () => {
    const { room } = await readyRoom({ negotiated: true, friend: true })
    const operation = (await press(room, 'play', 20)).snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const from = room.host.mark()
    acknowledge(room.host, operation, 'prepared', 1)
    await room.host.snapshotWith('operation_participant_prepared', from)
    room.host.socket.send(JSON.stringify({
      type: 'control', actionId: 'action_pause_prepared', basedOnRevision: room.host.latest().revision, leaseEpoch: 1, kind: 'pause', positionSeconds: 20,
    }))
    const paused = await room.host.snapshotWith('control_pause', from)
    expect(paused.snapshot.contract?.operation).toMatchObject({ operationId: operation.operationId, phase: 'cancelled', reason: 'controller-request' })
    const mark = room.host.mark()

    // The window is still open and the host had prepared, which is what a repeat of its acknowledgement would be answered with.
    acknowledge(room.host, operation, 'prepared', 1)
    await settle(room.host)
    expect(transitions(room.host, mark)).toEqual([])
    expect(room.host.lastSnapshot().snapshot.revision).toBe(paused.snapshot.revision)
    expect(room.host.lastSnapshot().snapshot.contract?.operation).toMatchObject({ phase: 'cancelled' })
  })

  it('pauses once, from the cleanup timer, when a negotiated Play was prepared but the start is never acknowledged', async () => {
    const { room } = await readyRoom({ negotiated: true, friend: false })
    const operation = (await press(room, 'play', 20)).snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const from = room.host.mark()
    acknowledge(room.host, operation, 'prepared', 1)
    const committed = await room.host.snapshotWith('operation_committed', from)
    const committedOperation = committed.snapshot.contract?.operation
    if (!committedOperation || committedOperation.effectiveAtServerMs === null)
      throw new Error('Expected a committed operation with a start time.')
    const deadlineMs = committedOperation.deadlineAtServerMs
    expect(deadlineMs).toBe(committedOperation.effectiveAtServerMs + PLAYBACK_STARTUP_GRACE_MS + PLAYBACK_PROGRESS_TIMEOUT_MS)
    const mark = room.host.mark()

    clockMs = deadlineMs - 1
    await ticks()
    expect(room.host.since(mark)).toEqual([])

    await crossDeadline(room.host, deadlineMs, 'operation_timeout_paused', mark)
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused'])
    const timedOut = room.host.lastSnapshot()
    // The start never happened, so the room stays at the target rather than skipping video nobody watched.
    expect(timedOut.snapshot.playback).toMatchObject({ status: 'paused', positionSeconds: 20 })
    expect(timedOut.snapshot.revision).toBe(committed.snapshot.revision + 1)
    expect(timedOut.snapshot.contract?.operation).toMatchObject({ operationId: operation.operationId, phase: 'failed', reason: 'start-timeout' })

    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused'])
  })

  it('announces only the operation timeout when the silence window has also run out by the time the timer looks', async () => {
    const { room } = await readyRoom({ negotiated: true, friend: false })
    const operation = (await press(room, 'play', 20)).snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected a transactional operation.')
    const from = room.host.mark()
    acknowledge(room.host, operation, 'prepared', 1)
    const committed = await room.host.snapshotWith('operation_committed', from)
    const committedOperation = committed.snapshot.contract?.operation
    if (!committedOperation || committedOperation.effectiveAtServerMs === null)
      throw new Error('Expected a committed operation with a start time.')
    const mark = room.host.mark()

    // One step of the clock past both the start window and the silence window of a player that never reported.
    // The timer reports one transition per room per tick, and the operation is the first deadline in its order.
    expect(committedOperation.deadlineAtServerMs).toBeLessThan(committedOperation.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS)
    await crossDeadline(room.host, committedOperation.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS + 1_000, 'operation_timeout_paused', mark)
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused'])
    expect(room.host.lastSnapshot().snapshot.revision).toBe(committed.snapshot.revision + 1)
    expect(room.host.lastSnapshot().snapshot.contract?.operation).toMatchObject({ phase: 'failed', reason: 'start-timeout' })

    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused'])
  })

  it('tells the room about one transition per timer turn, and the one that follows from it in the next turn', async () => {
    const { room } = await readyRoom({ negotiated: true, friend: false, manualTicks: true })
    const started = await playNegotiated(room, [room.host])

    // One report of progress, then the player stops moving: the timer pauses the room as stalled.
    clockMs = started.snapshot.playback.effectiveAtServerMs + 500
    report(room.host)
    await realWait(40)
    const reportedAtMs = clockMs
    clockMs = reportedAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS
    const stalledFrom = room.host.mark()
    await cleanupTurn()
    expect(room.host.since(stalledFrom)).toEqual(['participant_playback_stalled'])
    const stalled = room.host.lastSnapshot()
    expect(stalled.snapshot.playback.status).toBe('paused')

    // The player can play again, and the room starts a Play by itself once that has held for the stability window.
    const resumeFrom = room.host.mark()
    for (let step = 0; step < 6 && !room.host.since(resumeFrom).includes('auto_resume_play_pending'); step += 1) {
      report(room.host, { paused: true, progressed: false, canPlay: true })
      await realWait(40)
      await cleanupTurn()
      clockMs += 1_000
    }
    const pending = await room.host.snapshotWith('auto_resume_play_pending', resumeFrom)
    const operation = pending.snapshot.contract?.operation
    if (!operation)
      throw new Error('Expected the automatic Play to be a transactional operation.')
    expect(operation.phase).toBe('preparing')
    await cleanupTurn()

    // Nobody prepares the Play. The turn in which its window closes carries the timeout and nothing else,
    // even though the automatic resume that started it has also reached its end.
    const mark = room.host.mark()
    clockMs = operation.deadlineAtServerMs
    await cleanupTurn()
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused'])
    const timedOut = room.host.lastSnapshot()
    expect(timedOut.snapshot.revision).toBe(pending.snapshot.revision + 1)
    expect(timedOut.snapshot.contract?.operation).toMatchObject({ operationId: operation.operationId, phase: 'failed', reason: 'deadline-expired' })

    // The next turn gives that up, and says so once. It changes no state, so the revision stays.
    await cleanupTurn()
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused', 'auto_resume_abandoned'])
    expect(room.host.lastSnapshot().snapshot.revision).toBe(timedOut.snapshot.revision)
    expect(room.host.lastSnapshot().snapshot.playback.status).toBe('paused')

    await cleanupTurn()
    clockMs += 20_000
    await cleanupTurn()
    expect(room.host.since(mark)).toEqual(['operation_timeout_paused', 'auto_resume_abandoned'])
  })

  it('pauses once, from the cleanup timer, for a player that said it had not started playing', async () => {
    const { room } = await readyRoom({ negotiated: false, friend: false })
    const play = await press(room, 'play', 20)
    const deadlineMs = play.snapshot.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
    report(room.host, { progressed: false, playbackStarted: false })
    await ticks()
    const mark = room.host.mark()

    // Reports stop here. Only the timer can act on the missing start.
    clockMs = deadlineMs - 1
    await ticks()
    expect(room.host.since(mark)).toEqual([])

    await crossDeadline(room.host, deadlineMs, 'participant_playback_startup_timeout', mark)
    expect(room.host.since(mark)).toEqual(['participant_playback_startup_timeout'])
    const paused = room.host.lastSnapshot()
    expect(paused.snapshot.playback.status).toBe('paused')
    expect(paused.snapshot.revision).toBe(play.snapshot.revision + 1)
    expect(paused.snapshot.participants).toEqual([expect.objectContaining({ id: 'participant_host', playbackStatus: 'recovery-required' })])

    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['participant_playback_startup_timeout'])
  })

  it.each([
    ['paused', { paused: true, progressed: false }],
    ['buffering', { buffering: true, progressed: false }],
  ])('calls a player that last reported %s and then went quiet silent, not stalled', async (_state, sample) => {
    const { room } = await readyRoom({ negotiated: false, friend: false })
    const play = await press(room, 'play', 20)
    clockMs = play.snapshot.playback.effectiveAtServerMs + 500
    report(room.host, sample)
    await ticks()
    const reportedAtMs = clockMs
    const mark = room.host.mark()

    clockMs = reportedAtMs + PLAYBACK_REPORT_SILENCE_TIMEOUT_MS - 1
    await ticks()
    expect(room.host.since(mark)).toEqual([])

    await crossDeadline(room.host, reportedAtMs + PLAYBACK_REPORT_SILENCE_TIMEOUT_MS, 'participant_playback_silent', mark)
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
    const paused = room.host.lastSnapshot()
    expect(paused.snapshot.playback.status).toBe('paused')
    expect(paused.snapshot.revision).toBe(play.snapshot.revision + 1)
    expect(paused.snapshot.participants).toEqual([expect.objectContaining({ id: 'participant_host', playbackStatus: 'silent' })])

    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
  })

  it('pauses once for a negotiated player that acknowledged the start and then never reported', async () => {
    const { room } = await readyRoom({ negotiated: true, friend: false })
    const started = await playNegotiated(room, [room.host])
    const mark = room.host.mark()
    const deadlineMs = started.snapshot.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS

    clockMs = deadlineMs - 1
    await ticks()
    expect(room.host.since(mark)).toEqual([])

    await crossDeadline(room.host, deadlineMs, 'participant_playback_silent', mark)
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
    const paused = room.host.lastSnapshot()
    expect(paused.snapshot.playback.status).toBe('paused')
    expect(paused.snapshot.revision).toBe(started.snapshot.revision + 1)
    expect(paused.snapshot.contract?.operation).toMatchObject({ phase: 'cancelled', reason: 'manual-recovery' })
    expect(paused.snapshot.participants).toEqual([expect.objectContaining({ id: 'participant_host', playbackStatus: 'silent' })])

    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
  })

  it.each([
    ['legacy', false],
    ['negotiated', true],
  ])('names the silent player when the other player in a %s room keeps reporting', async (_mode, negotiated) => {
    const { room, friend } = await readyRoom({ negotiated, friend: true })
    if (!friend)
      throw new Error('Expected a friend.')
    // The friend never sends a player report, which is all it takes to be silent.
    const playing = negotiated
      ? await playNegotiated(room, [room.host, friend])
      : await press(room, 'play', 20)
    const deadlineMs = playing.snapshot.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS

    await reportHealthyUntil([room.host], deadlineMs - 1)
    const trigger = room.host.latest()
    const mark = room.host.mark()
    expect(trigger.playback.status).toBe('playing')

    await crossDeadline(room.host, deadlineMs, 'participant_playback_silent', mark)
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
    const paused = room.host.lastSnapshot()
    expect(paused.snapshot.playback.status).toBe('paused')
    expect(paused.snapshot.revision).toBe(trigger.revision + 1)
    const statuses = Object.fromEntries(paused.snapshot.participants.map(participant => [participant.id, participant.playbackStatus]))
    expect(statuses.participant_friend).toBe('silent')
    expect(statuses.participant_host).not.toBe('silent')
    if (negotiated)
      expect(paused.snapshot.contract?.operation).toMatchObject({ phase: 'cancelled', reason: 'manual-recovery' })
    // Both sockets were told, and only once.
    expect(friend.since(0).filter(reason => reason === 'participant_playback_silent')).toEqual(['participant_playback_silent'])

    await letTheClockRun()
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
  })

  it('does not count WebSocket pings as player reports, and answers each one', async () => {
    const { room } = await readyRoom({ negotiated: false, friend: false })
    const play = await press(room, 'play', 20)
    clockMs = play.snapshot.playback.effectiveAtServerMs + 500
    report(room.host)
    await ticks()
    const mark = room.host.mark()
    const reportedAtMs = clockMs

    // A ping every 500 ms of room time is faster than the 1.8 s no-progress window. If a ping
    // counted as evidence of progress, the room would never pause.
    const pingIds: string[] = []
    const ping = async () => {
      const id = `ping_only_${pingIds.length}`
      pingIds.push(id)
      room.host.socket.send(JSON.stringify({ type: 'ping', id, sentAtLocalMs: clockMs }))
      await room.host.until(message => message.type === 'pong' && message.id === id, `pong ${id}`, mark)
    }
    while (clockMs < reportedAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS - 1) {
      clockMs = Math.min(clockMs + 500, reportedAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS - 1)
      await ping()
      await ticks()
    }
    expect(room.host.since(mark).filter(reason => reason !== 'pong')).toEqual([])

    clockMs = reportedAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS
    await ping()
    await room.host.snapshotWith('participant_playback_stalled', mark)
    await ticks()
    const stalled = room.host.received.slice(mark).filter(message => message.type === 'room_snapshot')
    expect(stalled.map(label)).toEqual(['participant_playback_stalled'])
    expect(room.host.lastSnapshot().snapshot.playback.status).toBe('paused')
    expect(room.host.lastSnapshot().snapshot.revision).toBe(play.snapshot.revision + 1)

    // Pings after the pause are still answered and change nothing.
    for (let count = 0; count < 3; count += 1) {
      clockMs += 500
      await ping()
    }
    await ticks()
    const pongs = room.host.received.slice(mark).filter(message => message.type === 'pong')
    expect(pongs.map(pong => pong.id)).toEqual(pingIds)
    expect(room.host.since(mark).filter(reason => reason !== 'pong')).toEqual(['participant_playback_stalled'])
  })

  it.each([
    ['legacy', false],
    ['negotiated', true],
  ])('pauses once, from the cleanup timer, when a dropped player is still away after the grace in a %s room', async (_mode, negotiated) => {
    const { room, friend } = await readyRoom({ negotiated, friend: true, manualTicks: true })
    if (!friend)
      throw new Error('Expected a friend.')
    if (negotiated)
      await playNegotiated(room, [room.host, friend])
    else
      await press(room, 'play', 20)
    const dropped = await dropFriend(room, friend)
    expect(dropped.snapshot.playback.status).toBe('playing')
    const droppedAtMs = clockMs
    const mark = room.host.mark()

    // The host keeps reporting progress, so the dropped player is the only reason left for the room to pause.
    await reportHealthyUntil([room.host], droppedAtMs + DISCONNECT_PAUSE_GRACE_MS - 1)
    await cleanupTurn()
    expect(transitions(room.host, mark)).toEqual([])

    clockMs = droppedAtMs + DISCONNECT_PAUSE_GRACE_MS
    report(room.host)
    await realWait(40)
    await cleanupTurn()
    expect(transitions(room.host, mark)).toEqual(['participant_disconnect_timeout'])
    const paused = room.host.lastSnapshot()
    expect(paused.snapshot.playback.status).toBe('paused')
    expect(paused.snapshot.revision).toBe(dropped.snapshot.revision + 1)
    expect(paused.snapshot.participants.find(participant => participant.id === 'participant_friend')).toMatchObject({ connected: false })

    await cleanupTurn()
    clockMs += 20_000
    await cleanupTurn()
    expect(transitions(room.host, mark)).toEqual(['participant_disconnect_timeout'])
  })

  it.each([
    ['legacy', false],
    ['negotiated', true],
  ])('names the silent player, not the dropped one, when both windows have run out by the time the timer looks in a %s room', async (_mode, negotiated) => {
    const { room, friend } = await readyRoom({ negotiated, friend: true, manualTicks: true })
    if (!friend)
      throw new Error('Expected a friend.')
    const playing = negotiated
      ? await playNegotiated(room, [room.host, friend])
      : await press(room, 'play', 20)
    const dropped = await dropFriend(room, friend)
    const droppedAtMs = clockMs
    // The host never reports, so its silence is due at the startup deadline, which is later than the grace.
    const silentAtMs = playing.snapshot.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
    expect(silentAtMs).toBeGreaterThan(droppedAtMs + DISCONNECT_PAUSE_GRACE_MS)
    const mark = room.host.mark()

    // One timer turn can announce one transition, and the health check comes before the grace.
    clockMs = silentAtMs
    await cleanupTurn()
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
    const paused = room.host.lastSnapshot()
    expect(paused.snapshot.playback.status).toBe('paused')
    expect(paused.snapshot.revision).toBe(dropped.snapshot.revision + 1)
    const statuses = Object.fromEntries(paused.snapshot.participants.map(participant => [participant.id, participant.playbackStatus]))
    expect(statuses.participant_host).toBe('silent')
    expect(statuses.participant_friend).toBe('unknown')

    await cleanupTurn()
    clockMs += 20_000
    await cleanupTurn()
    expect(room.host.since(mark)).toEqual(['participant_playback_silent'])
  })

  /** The replacement is the participant's live socket: it stays open and the room still answers it. */
  async function expectLiveParticipant(replacement: Watched) {
    expect(replacement.socket.readyState).toBe(WebSocket.OPEN)
    const mark = replacement.mark()
    replacement.socket.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
    const confirmed = await replacement.snapshotWith('readiness_unchanged', mark)
    expect(confirmed.snapshot.participants).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'participant_friend', connected: true, ready: true })]))
  }

  it('leaves no seek deadline behind when a participant replaces its live socket', async () => {
    const { room, friend, friendToken } = await readyRoom({ negotiated: false, friend: true })
    if (!friend)
      throw new Error('Expected a friend.')
    const issuedAt = clockMs
    const pending = await press(room, 'seek', 90)
    await friend.snapshotWith('control_seek_pending')
    const hostMark = room.host.mark()

    const originalClosed = new Promise<{ code: number, reason: string }>(resolve => friend.socket.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })))
    const replacement = await watch(room.url, 'participant_friend')
    replacement.socket.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: room.code, media, sessionToken: friendToken,
    }))
    await replacement.until(message => message.type === 'room_joined', 'room_joined')
    await expect(originalClosed).resolves.toEqual({ code: 1000, reason: 'session_replaced' })
    await room.host.snapshotWith('participant_reconnected', hostMark)
    // The replacement pauses the room and ends the seek barrier it interrupted.
    expect(room.host.lastSnapshot().snapshot).toMatchObject({ seek: null, revision: pending.snapshot.revision + 1, playback: { status: 'paused' } })

    clockMs = issuedAt + SEEK_BARRIER_MAX_WAIT_MS
    await ticks()
    await letTheClockRun()
    expect(room.host.since(hostMark)).toEqual(['participant_reconnected'])
    expect(replacement.received.map(label)).toEqual(['room_joined'])

    await expectLiveParticipant(replacement)
  })

  it('leaves no operation deadline behind when a participant replaces its live socket', async () => {
    const { room, friend, friendToken } = await readyRoom({ negotiated: true, friend: true })
    if (!friend)
      throw new Error('Expected a friend.')
    const issuedAt = clockMs
    const pending = await press(room, 'play', 20)
    await friend.snapshotWith('control_play_pending')
    const hostMark = room.host.mark()

    const replacement = await watch(room.url, 'participant_friend')
    replacement.socket.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: room.code, media, sessionToken: friendToken,
      capabilities: CURRENT_CLIENT_CAPABILITIES,
    }))
    await replacement.until(message => message.type === 'room_joined', 'room_joined')
    await room.host.snapshotWith('participant_reconnected', hostMark)
    expect(room.host.lastSnapshot().snapshot.revision).toBe(pending.snapshot.revision + 1)
    expect(room.host.lastSnapshot().snapshot.contract?.operation).toMatchObject({ phase: 'cancelled', reason: 'participant-disconnected' })

    clockMs = issuedAt + SEEK_BARRIER_MAX_WAIT_MS
    await ticks()
    await letTheClockRun()
    expect(room.host.since(hostMark)).toEqual(['participant_reconnected'])
    expect(replacement.received.map(label)).toEqual(['room_joined'])
    await expectLiveParticipant(replacement)
  })

  it('leaves no silence deadline behind when the silent participant replaces its live socket', async () => {
    const { room, friend, friendToken } = await readyRoom({ negotiated: false, friend: true })
    if (!friend)
      throw new Error('Expected a friend.')
    const play = await press(room, 'play', 20)
    const deadlineMs = play.snapshot.playback.effectiveAtServerMs + PLAYBACK_STARTUP_TIMEOUT_MS
    await reportHealthyUntil([room.host], deadlineMs - 2_000)
    const hostMark = room.host.mark()

    const replacement = await watch(room.url, 'participant_friend')
    replacement.socket.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: room.code, media, sessionToken: friendToken,
    }))
    await replacement.until(message => message.type === 'room_joined', 'room_joined')
    await room.host.snapshotWith('participant_reconnected', hostMark)
    expect(room.host.lastSnapshot().snapshot.playback.status).toBe('paused')

    clockMs = deadlineMs
    await ticks()
    await letTheClockRun()
    expect(room.host.since(hostMark)).toEqual(['participant_reconnected'])
    expect(replacement.received.map(label)).toEqual(['room_joined'])
    await expectLiveParticipant(replacement)
  })

  it.each([
    ['legacy', false],
    ['negotiated', true],
  ])('keeps a healthy two-player %s room playing after a join request and a denial', async (_mode, negotiated) => {
    const { room, friend } = await readyRoom({ negotiated, friend: true })
    if (!friend)
      throw new Error('Expected a friend.')
    const playing = negotiated
      ? await playNegotiated(room, [room.host, friend])
      : await press(room, 'play', 20)
    const players = [room.host, friend]
    await reportHealthyUntil(players, clockMs + 3_000)
    const mark = room.host.mark()
    expect(room.host.latest().playback.status).toBe('playing')

    const visitor = await watch(room.url, 'participant_visitor')
    visitor.socket.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_visitor', name: 'Sami', code: room.code, media,
      ...(negotiated ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}),
    }))
    await room.host.snapshotWith('join_pending', mark)
    await reportHealthyUntil(players, clockMs + 4_000)

    room.host.socket.send(JSON.stringify({
      type: 'respond_to_join', participantId: 'participant_visitor', approve: false, actionId: 'action_deny_visitor', basedOnRevision: 0, leaseEpoch: 1,
    }))
    await room.host.snapshotWith('join_denied', mark)
    await reportHealthyUntil(players, clockMs + 4_000)

    // Both players kept reporting progress, so no deadline is due: the only snapshots are the two events.
    expect(room.host.since(mark).filter(reason => reason !== 'participant_status_changed')).toEqual(['join_pending', 'join_denied'])
    expect(room.host.lastSnapshot().snapshot.playback.status).toBe('playing')
    expect(room.host.lastSnapshot().snapshot.revision).toBe(playing.snapshot.revision + 2)
  })

  it.each([
    ['legacy', false],
    ['negotiated', true],
  ])('does not give a player that went quiet more time because somebody asked to join a %s room', async (_mode, negotiated) => {
    const { room, friend } = await readyRoom({ negotiated, friend: true })
    if (!friend)
      throw new Error('Expected a friend.')
    const playing = negotiated
      ? await playNegotiated(room, [room.host, friend])
      : await press(room, 'play', 20)

    // Both players report progress once; from then on only the host keeps reporting.
    clockMs = playing.snapshot.playback.effectiveAtServerMs + 500
    report(room.host)
    report(friend)
    await realWait(40)
    const lastProgressAtMs = clockMs
    const deadlineMs = lastProgressAtMs + PLAYBACK_PROGRESS_TIMEOUT_MS
    await reportHealthyUntil([room.host], lastProgressAtMs + 1_000)

    const mark = room.host.mark()
    const visitor = await watch(room.url, 'participant_visitor')
    visitor.socket.send(JSON.stringify({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_visitor', name: 'Sami', code: room.code, media,
      ...(negotiated ? { capabilities: CURRENT_CLIENT_CAPABILITIES } : {}),
    }))
    const requested = await room.host.snapshotWith('join_pending', mark)
    await reportHealthyUntil([room.host], deadlineMs - 1)
    expect(room.host.since(mark).filter(reason => reason !== 'participant_status_changed')).toEqual(['join_pending'])

    // The friend's window ran out on its own schedule: the request did not restart it.
    await crossDeadline(room.host, deadlineMs, 'participant_playback_stalled', mark)
    expect(room.host.since(mark).filter(reason => reason !== 'participant_status_changed')).toEqual(['join_pending', 'participant_playback_stalled'])
    const paused = room.host.lastSnapshot()
    expect(paused.snapshot.playback.status).toBe('paused')
    expect(paused.snapshot.revision).toBe(requested.snapshot.revision + 1)
    const statuses = Object.fromEntries(paused.snapshot.participants.map(participant => [participant.id, participant.playbackStatus]))
    expect(statuses.participant_friend).toBe('recovery-required')
    expect(statuses.participant_host).not.toBe('recovery-required')
  })

  async function healthyPairAfterControlTransfer(negotiated: boolean) {
    const { room, friend } = await readyRoom({ negotiated, friend: true })
    if (!friend)
      throw new Error('Expected a friend.')
    const playing = negotiated
      ? await playNegotiated(room, [room.host, friend])
      : await press(room, 'play', 20)
    const players = [room.host, friend]
    await reportHealthyUntil(players, clockMs + 3_000)
    const mark = room.host.mark()

    room.host.socket.send(JSON.stringify({ type: 'transfer_control', participantId: 'participant_friend', leaseEpoch: 1 }))
    await room.host.snapshotWith('control_transferred', mark)
    await reportHealthyUntil(players, clockMs + 4_000)

    expect(room.host.since(mark).filter(reason => reason !== 'participant_status_changed')).toEqual(['control_transferred'])
    expect(room.host.lastSnapshot().snapshot.controller.participantId).toBe('participant_friend')
    expect(room.host.lastSnapshot().snapshot.playback.status).toBe('playing')
    expect(room.host.lastSnapshot().snapshot.revision).toBe(playing.snapshot.revision + 1)
  }

  it('keeps a healthy two-player legacy room playing after control passes to the other player', async () => {
    await healthyPairAfterControlTransfer(false)
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
