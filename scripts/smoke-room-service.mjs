import WebSocket from 'ws'

const baseUrl = process.argv[2] ?? process.env.SYNCYOURJOY_ROOM_SERVER_URL
if (!baseUrl)
  throw new Error('Provide a WebSocket URL, for example: npm run smoke:edge -- wss://worker.example.workers.dev/rooms')

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const randomBytes = crypto.getRandomValues(new Uint8Array(8))
const code = [...randomBytes].map(byte => alphabet[byte % alphabet.length]).join('')
const media = {
  service: 'youtube',
  canonicalId: 'youtube:syncyourjoy-smoke-test',
  title: 'SyncYourJoy deployment smoke test',
  durationSeconds: 600,
}

const host = await connect(baseUrl, code)
const friend = await connect(baseUrl, code)

try {
  host.socket.send(JSON.stringify({
    type: 'create_room',
    protocolVersion: 1,
    participantId: 'participant_smoke_host',
    name: 'Deployment host',
    code,
    media,
  }))
  await host.waitFor(message => message.type === 'room_joined')

  friend.socket.send(JSON.stringify({
    type: 'join_room',
    protocolVersion: 1,
    participantId: 'participant_smoke_friend',
    name: 'Deployment friend',
    code,
    media,
  }))
  await friend.waitFor(message => message.type === 'room_joined')
  await host.waitFor(message => message.type === 'room_snapshot' && message.snapshot.participants.length === 2)

  friend.socket.send(JSON.stringify({ type: 'set_ready', ready: true, media }))
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

  console.log(JSON.stringify({
    ok: true,
    code,
    roundTripMs,
    revision: playing.snapshot.revision,
    scheduledLeadMs: playing.snapshot.playback.effectiveAtServerMs - Date.now(),
  }))
}
finally {
  host.socket.close()
  friend.socket.close()
}

async function connect(url, code) {
  const target = new URL(url)
  target.searchParams.set('code', code)
  const socket = new WebSocket(target)
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
        const timer = setTimeout(() => reject(new Error('Timed out waiting for a room-service message.')), 8_000)
        waiters.push({ predicate, resolve, reject, timer })
      })
    },
  }
}
