import { CURRENT_CLIENT_CAPABILITIES, generateRoomCode } from '@syncyourjoy/protocol'
import WebSocket from 'ws'

const baseUrl = process.argv[2] ?? process.env.SYNCYOURJOY_ROOM_SERVER_URL
if (!baseUrl)
  throw new Error('Provide a WebSocket URL, for example: npm run smoke:edge -- wss://worker.example.workers.dev/rooms')

const code = generateRoomCode()
const hostMedia = {
  service: 'crunchyroll',
  canonicalId: 'www.crunchyroll.com/ar/watch/GE00345558JAJP/from-now-on',
  title: 'Localized host title',
  durationSeconds: 1_470,
  pageUrl: 'https://www.crunchyroll.com/watch/GE00345558JAJP/from-now-on',
}
const friendMedia = {
  service: 'crunchyroll',
  canonicalId: 'crunchyroll:GE00345558JAJP',
  title: 'Different regional page title',
  durationSeconds: 1_465,
  pageUrl: 'https://www.crunchyroll.com/watch/GE00345558JAJP/from-now-on',
}

const host = await connect(baseUrl, code)
let friend

try {
  host.socket.send(JSON.stringify({
    type: 'create_room',
    protocolVersion: 1,
    participantId: 'participant_smoke_host',
    name: 'Deployment host',
    code,
    media: null,
    capabilities: CURRENT_CLIENT_CAPABILITIES,
  }))
  const created = await host.waitFor(message => message.type === 'room_joined')

  // room-service mints its own server-side code and ignores the client's
  // suggestion (the room code is a bearer secret, so it must come from the
  // server's own CSPRNG); edge-service uses the client-supplied code as-is.
  // Either way, the friend must join using the code the room actually has,
  // not the one this script originally generated.
  const roomCode = created.snapshot.code
  friend = await connect(baseUrl, roomCode)

  // Host-approval join (docs/CODE_AUDIT.md SYJ-AUD-003): the friend's
  // join_room becomes a pending request, not immediate membership, so the
  // host must approve it before either side sees 2 participants.
  friend.socket.send(JSON.stringify({
    type: 'join_room',
    protocolVersion: 1,
    participantId: 'participant_smoke_friend',
    name: 'Deployment friend',
    code: roomCode,
    media: null,
    capabilities: CURRENT_CLIENT_CAPABILITIES,
  }))
  await friend.waitFor(message => message.type === 'room_joined')
  const pendingNotice = await host.waitFor(message => message.type === 'room_snapshot' && message.reason === 'join_pending')
  host.socket.send(JSON.stringify({
    type: 'respond_to_join',
    participantId: 'participant_smoke_friend',
    approve: true,
    actionId: 'action_smoke_approve_friend',
    basedOnRevision: pendingNotice.snapshot.revision,
    leaseEpoch: pendingNotice.snapshot.controller.leaseEpoch,
  }))
  const approved = await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.participants.length === 2)
  await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.participants.length === 2)

  const diagnosticsReportId = 'report_smoke_diagnostics'
  host.socket.send(JSON.stringify({ type: 'request_diagnostics', reportId: diagnosticsReportId }))
  await host.waitFor(message => message.type === 'diagnostics_requested' && message.reportId === diagnosticsReportId)
  await friend.waitFor(message => message.type === 'diagnostics_requested' && message.reportId === diagnosticsReportId)
  host.socket.send(JSON.stringify({ type: 'diagnostics_response', reportId: diagnosticsReportId, report: diagnosticReport('host') }))
  friend.socket.send(JSON.stringify({ type: 'diagnostics_response', reportId: diagnosticsReportId, report: diagnosticReport('friend') }))
  const diagnosticResponses = await Promise.all([
    host.waitFor(message => message.type === 'diagnostics_response' && message.reportId === diagnosticsReportId && message.participantId === 'participant_smoke_host'),
    host.waitFor(message => message.type === 'diagnostics_response' && message.reportId === diagnosticsReportId && message.participantId === 'participant_smoke_friend'),
  ])
  await friend.expectNoMessage(message => message.type === 'diagnostics_response' && message.reportId === diagnosticsReportId, 250)

  host.socket.send(JSON.stringify({
    type: 'open_link',
    actionId: 'action_smoke_open_link',
    basedOnRevision: approved.snapshot.revision,
    leaseEpoch: approved.snapshot.controller.leaseEpoch,
    url: 'https://www.crunchyroll.com/watch/GE00345558JAJP/from-now-on#player',
  }))
  const navigated = await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.navigation?.url === 'https://www.crunchyroll.com/watch/GE00345558JAJP/from-now-on')
  const friendNavigated = await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.navigation?.revision === navigated.snapshot.navigation?.revision)
  if (navigated.snapshot.navigation?.effectiveAtServerMs !== friendNavigated.snapshot.navigation?.effectiveAtServerMs)
    throw new Error('Clients received different shared-link navigation times.')

  host.socket.send(JSON.stringify({ type: 'set_ready', ready: true, media: hostMedia }))
  await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.participants.find(participant => participant.id === 'participant_smoke_host')?.ready)

  friend.socket.send(JSON.stringify({ type: 'set_ready', ready: true, media: friendMedia }))
  const ready = await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.participants.every(participant => participant.ready))

  const pingSentAt = Date.now()
  host.socket.send(JSON.stringify({ type: 'ping', id: 'ping_smoke_test', sentAtLocalMs: pingSentAt }))
  await host.waitFor(message => message.type === 'pong' && message.id === 'ping_smoke_test')
  const roundTripMs = Date.now() - pingSentAt

  const playingPair = await completeTransactionalOperation(host, friend, {
    actionId: 'action_smoke_play',
    basedOnRevision: ready.snapshot.revision,
    leaseEpoch: ready.snapshot.controller.leaseEpoch,
    kind: 'play',
    positionSeconds: 12,
  })
  const playing = playingPair.host
  const friendPlaying = playingPair.friend

  if (playing.snapshot.revision !== friendPlaying.snapshot.revision)
    throw new Error('Clients received different authoritative revisions.')
  if (playing.snapshot.playback.effectiveAtServerMs !== friendPlaying.snapshot.playback.effectiveAtServerMs)
    throw new Error('Clients received different effective playback times.')

  const seekStartedAt = Date.now()
  const soughtPair = await completeTransactionalOperation(host, friend, {
    actionId: 'action_smoke_seek',
    basedOnRevision: playing.snapshot.revision,
    leaseEpoch: playing.snapshot.controller.leaseEpoch,
    kind: 'seek',
    positionSeconds: 137,
  })
  const sought = soughtPair.host
  const friendSought = soughtPair.friend
  if (sought.snapshot.revision !== friendSought.snapshot.revision)
    throw new Error('Clients received different seek revisions.')
  if (sought.snapshot.contract?.mode !== 'transactional'
    || sought.snapshot.contract.operation?.phase !== 'started'
    || sought.snapshot.playback.positionSeconds !== 137)
    throw new Error('The transactional seek did not reach started state at its fixed target.')
  const seekResumed = sought
  const seekBarrierMs = Date.now() - seekStartedAt

  const timeoutPendingHost = host.waitFor(message => message.type === 'room_snapshot' && message.reason === 'control_seek_pending')
  const timeoutPendingFriend = friend.waitFor(message => message.type === 'room_snapshot' && message.reason === 'control_seek_pending')
  host.socket.send(JSON.stringify({
    type: 'control',
    actionId: 'action_smoke_timeout_seek',
    basedOnRevision: seekResumed.snapshot.revision,
    leaseEpoch: seekResumed.snapshot.controller.leaseEpoch,
    kind: 'seek',
    positionSeconds: 155,
  }))
  const [timeoutSeek] = await Promise.all([timeoutPendingHost, timeoutPendingFriend])
  const timeoutOperation = timeoutSeek.snapshot.contract?.operation
  if (!timeoutOperation)
    throw new Error('Expected a transactional timeout operation.')
  const timeoutStartedAt = Date.now()
  const timeoutReleasedHost = host.waitFor(message => message.type === 'room_snapshot'
    && message.reason === 'operation_timeout_paused'
    && message.snapshot.contract?.operation?.phase === 'failed'
    && message.snapshot.playback.status === 'paused'
    && message.snapshot.playback.positionSeconds === 155)
  const timeoutReleasedFriend = friend.waitFor(message => message.type === 'room_snapshot'
    && message.reason === 'operation_timeout_paused'
    && message.snapshot.contract?.operation?.phase === 'failed'
    && message.snapshot.playback.status === 'paused'
    && message.snapshot.playback.positionSeconds === 155)
  host.socket.send(JSON.stringify({
    type: 'operation_ack',
    acknowledgement: operationAcknowledgement(timeoutOperation, 'participant_smoke_host', 'prepared', 155, 1),
  }))
  const [timeoutReleased] = await Promise.all([timeoutReleasedHost, timeoutReleasedFriend])
  const seekTimeoutReleaseMs = Date.now() - timeoutStartedAt

  const rapidPause = host.waitFor(message => message.type === 'room_snapshot' && message.reason === 'control_pause')
  const rapidPauseFriend = friend.waitFor(message => message.type === 'room_snapshot' && message.reason === 'control_pause')
  host.socket.send(JSON.stringify({
    type: 'control',
    actionId: 'action_smoke_rapid_pause',
    basedOnRevision: timeoutReleased.snapshot.revision,
    leaseEpoch: timeoutReleased.snapshot.controller.leaseEpoch,
    kind: 'pause',
    positionSeconds: 137,
  }))
  const [paused] = await Promise.all([rapidPause, rapidPauseFriend])
  const rapidPair = await completeTransactionalOperation(host, friend, {
    actionId: 'action_smoke_rapid_play',
    basedOnRevision: paused.snapshot.revision,
    leaseEpoch: paused.snapshot.controller.leaseEpoch,
    kind: 'play',
    positionSeconds: 137,
  })
  const rapidPlaying = rapidPair.host
  const friendRapidPlaying = rapidPair.friend
  if (rapidPlaying.snapshot.playback.effectiveAtServerMs !== friendRapidPlaying.snapshot.playback.effectiveAtServerMs)
    throw new Error('Clients received different rapid-control effective times.')
  const scheduledLeadMs = rapidPlaying.snapshot.playback.effectiveAtServerMs - Date.now()

  const bufferingSample = {
    positionSeconds: 137,
    durationSeconds: 1_470,
    paused: false,
    buffering: true,
    sampledAtLocalMs: Date.now(),
  }
  host.socket.send(JSON.stringify({
    type: 'player_status',
    basedOnRevision: sought.snapshot.revision,
    sample: bufferingSample,
  }))
  await host.expectNoMessage(message => message.type === 'room_snapshot'
    && message.snapshot.revision > rapidPlaying.snapshot.revision
    && message.snapshot.playback.status === 'paused')

  host.socket.send(JSON.stringify({
    type: 'player_status',
    basedOnRevision: rapidPlaying.snapshot.revision,
    sample: { ...bufferingSample, sampledAtLocalMs: Date.now() },
  }))
  await host.expectNoMessage(message => message.type === 'room_snapshot'
    && message.snapshot.revision > rapidPlaying.snapshot.revision
    && message.snapshot.playback.status === 'paused')

  console.log(JSON.stringify({
    ok: true,
    code: roomCode,
    roundTripMs,
    revision: rapidPlaying.snapshot.revision,
    seekPositionSeconds: sought.snapshot.playback.positionSeconds,
    seekBarrierProtected: true,
    seekBarrierMs,
    seekTimeoutReleaseMs,
    scheduledLeadMs,
    transactionalContractVerified: true,
    diagnosticsParticipants: diagnosticResponses.map(message => message.participantId).sort(),
    staleBufferingProtected: true,
    startupBufferingProtected: true,
  }))
}
finally {
  host.socket.close()
  friend?.socket.close()
}

async function completeTransactionalOperation(host, friend, intent) {
  const pendingHost = host.waitFor(message => message.type === 'room_snapshot' && message.reason === `control_${intent.kind}_pending`)
  const pendingFriend = friend.waitFor(message => message.type === 'room_snapshot' && message.reason === `control_${intent.kind}_pending`)
  host.socket.send(JSON.stringify({ type: 'control', ...intent }))
  const [pending] = await Promise.all([pendingHost, pendingFriend])
  if (pending.snapshot.contract?.mode !== 'transactional')
    throw new Error(`Expected transactional mode for ${intent.kind}.`)
  const operation = pending.snapshot.contract.operation
  if (!operation)
    throw new Error(`Expected a transactional ${intent.kind} operation.`)

  const preparedHost = host.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_participant_prepared')
  const preparedFriend = friend.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_participant_prepared')
  host.socket.send(JSON.stringify({
    type: 'operation_ack',
    acknowledgement: operationAcknowledgement(operation, 'participant_smoke_host', 'prepared', intent.positionSeconds, 1),
  }))
  await Promise.all([preparedHost, preparedFriend])

  const committedHost = host.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_committed')
  const committedFriend = friend.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_committed')
  friend.socket.send(JSON.stringify({
    type: 'operation_ack',
    acknowledgement: operationAcknowledgement(operation, 'participant_smoke_friend', 'prepared', intent.positionSeconds, 1),
  }))
  const [committed, committedPeer] = await Promise.all([committedHost, committedFriend])

  const waitForEffectiveTimeMs = Math.max(0, committed.snapshot.playback.effectiveAtServerMs - Date.now() + 20)
  await new Promise(resolve => setTimeout(resolve, waitForEffectiveTimeMs))
  const startedHost = host.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_participant_started')
  const startedFriend = friend.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_participant_started')
  host.socket.send(JSON.stringify({
    type: 'operation_ack',
    acknowledgement: operationAcknowledgement(operation, 'participant_smoke_host', 'started', intent.positionSeconds, 2),
  }))
  await Promise.all([startedHost, startedFriend])

  const completedHost = host.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_started')
  const completedFriend = friend.waitFor(message => message.type === 'room_snapshot' && message.reason === 'operation_started')
  friend.socket.send(JSON.stringify({
    type: 'operation_ack',
    acknowledgement: operationAcknowledgement(operation, 'participant_smoke_friend', 'started', intent.positionSeconds, 2),
  }))
  const [started, startedPeer] = await Promise.all([completedHost, completedFriend])
  return { host: started, friend: startedPeer, committed, committedPeer }
}

function operationAcknowledgement(operation, participantId, phase, positionSeconds, sampleSequence) {
  return {
    mediaEpoch: operation.mediaEpoch,
    operationId: operation.operationId,
    phase,
    participantId,
    bindingId: `binding_${participantId}`,
    sourceGeneration: 0,
    sampleSequence,
    observedPositionSeconds: positionSeconds,
    observedAtLocalMs: Date.now(),
  }
}

function diagnosticReport(label) {
  return {
    extensionVersion: 'smoke',
    generatedAtLocalMs: Date.now(),
    userAgent: `SyncYourJoy smoke ${label}`,
    connection: 'connected',
    roomRevision: 1,
    playbackStatus: null,
    playerFrameId: null,
    playerAreaPixels: 0,
    playerLastSeenAtMs: 0,
    mediaService: null,
    mediaCanonicalId: null,
    mediaPageUrl: null,
    sample: null,
    events: [],
  }
}

async function connect(url, code) {
  const target = new URL(url)
  target.searchParams.set('code', code)
  // A real browser (including the extension) always sends Origin, and
  // originAllowed()/isAllowedOrigin() now rejects a missing one -- this CLI
  // tool must present one of the allowed prefixes explicitly, the same way
  // apps/room-service/src/server.test.ts's own test client does.
  const socket = new WebSocket(target, undefined, { origin: 'http://localhost' })
  const queue = []
  const waiters = []

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message))
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
    else {
      queue.push(message)
    }
  })

  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  return {
    socket,
    waitFor(predicate) {
      const queuedIndex = queue.findIndex(predicate)
      if (queuedIndex >= 0)
        return Promise.resolve(queue.splice(queuedIndex, 1)[0])

      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0)
            waiters.splice(index, 1)
          reject(new Error('Timed out waiting for a room-service message.'))
        }, 8_000)
        waiters.push(waiter)
      })
    },
    expectNoMessage(predicate, durationMs = 500) {
      if (queue.some(predicate))
        return Promise.reject(new Error('Received an unexpected room-service message.'))

      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: () => reject(new Error('Received an unexpected room-service message.')),
          reject,
          timer: null,
        }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0)
            waiters.splice(index, 1)
          resolve()
        }, durationMs)
        waiters.push(waiter)
      })
    },
  }
}
