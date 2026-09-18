import { generateRoomCode } from '@syncyourjoy/protocol'
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

  host.socket.send(JSON.stringify({
    type: 'control',
    actionId: 'action_smoke_play',
    basedOnRevision: ready.snapshot.revision,
    leaseEpoch: ready.snapshot.controller.leaseEpoch,
    kind: 'play',
    positionSeconds: 12,
  }))
  const playing = await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.playback.status === 'playing')
  const friendPlaying = await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.playback.status === 'playing')

  if (playing.snapshot.revision !== friendPlaying.snapshot.revision)
    throw new Error('Clients received different authoritative revisions.')
  if (playing.snapshot.playback.effectiveAtServerMs !== friendPlaying.snapshot.playback.effectiveAtServerMs)
    throw new Error('Clients received different effective playback times.')

  host.socket.send(JSON.stringify({
    type: 'control',
    actionId: 'action_smoke_seek',
    basedOnRevision: playing.snapshot.revision,
    leaseEpoch: playing.snapshot.controller.leaseEpoch,
    kind: 'seek',
    positionSeconds: 137,
  }))
  const sought = await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.seek?.positionSeconds === 137)
  const friendSought = await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.seek?.positionSeconds === 137)
  if (sought.snapshot.revision !== friendSought.snapshot.revision)
    throw new Error('Clients received different seek revisions.')

  const seekBarrierStartedAt = Date.now()
  host.socket.send(JSON.stringify({ type: 'seek_applied', revision: sought.snapshot.revision, positionSeconds: 137 }))
  friend.socket.send(JSON.stringify({ type: 'seek_applied', revision: sought.snapshot.revision, positionSeconds: 137 }))
  const seekResumed = await host.waitFor(message => message.type === 'room_snapshot'
    && message.snapshot.revision > sought.snapshot.revision
    && message.snapshot.seek === null
    && message.snapshot.playback.status === 'playing'
    && message.snapshot.playback.positionSeconds === 137)
  await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.revision === seekResumed.snapshot.revision)
  const seekBarrierMs = Date.now() - seekBarrierStartedAt

  host.socket.send(JSON.stringify({
    type: 'control',
    actionId: 'action_smoke_timeout_seek',
    basedOnRevision: seekResumed.snapshot.revision,
    leaseEpoch: seekResumed.snapshot.controller.leaseEpoch,
    kind: 'seek',
    positionSeconds: 155,
  }))
  const timeoutSeek = await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.seek?.positionSeconds === 155)
  await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.revision === timeoutSeek.snapshot.revision)
  const timeoutStartedAt = Date.now()
  host.socket.send(JSON.stringify({ type: 'seek_applied', revision: timeoutSeek.snapshot.revision, positionSeconds: 155 }))
  const timeoutReleased = await host.waitFor(message => message.type === 'room_snapshot'
    && message.reason === 'seek_timeout_paused'
    && message.snapshot.seek === null
    && message.snapshot.playback.status === 'paused'
    && message.snapshot.playback.positionSeconds === 155)
  await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.revision === timeoutReleased.snapshot.revision)
  const seekTimeoutReleaseMs = Date.now() - timeoutStartedAt

  host.socket.send(JSON.stringify({
    type: 'control',
    actionId: 'action_smoke_rapid_pause',
    basedOnRevision: timeoutReleased.snapshot.revision,
    leaseEpoch: timeoutReleased.snapshot.controller.leaseEpoch,
    kind: 'pause',
    positionSeconds: 137,
  }))
  host.socket.send(JSON.stringify({
    type: 'control',
    actionId: 'action_smoke_rapid_play',
    basedOnRevision: timeoutReleased.snapshot.revision,
    leaseEpoch: timeoutReleased.snapshot.controller.leaseEpoch,
    kind: 'play',
    positionSeconds: 137,
  }))
  const rapidPlaying = await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.revision >= timeoutReleased.snapshot.revision + 2 && message.snapshot.playback.status === 'playing')
  const friendRapidPlaying = await friend.waitFor(message => message.type === 'room_snapshot' && message.snapshot.revision === rapidPlaying.snapshot.revision)
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
    diagnosticsParticipants: diagnosticResponses.map(message => message.participantId).sort(),
    staleBufferingProtected: true,
    startupBufferingProtected: true,
  }))
}
finally {
  host.socket.close()
  friend?.socket.close()
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
