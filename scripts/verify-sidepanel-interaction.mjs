import WebSocket from 'ws'

const [, , endpoint = 'http://127.0.0.1:9229'] = process.argv
const targetsResponse = await fetch(`${endpoint}/json/list`)
if (!targetsResponse.ok)
  throw new Error(`Could not list Chrome targets: ${targetsResponse.status}`)
const targets = await targetsResponse.json()
const target = targets.find(item => String(item.url).includes('sidepanel-preview.html'))
if (!target?.webSocketDebuggerUrl)
  throw new Error('Open the SyncYourJoy side-panel preview before running this check.')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let nextId = 0
const pending = new Map()
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString())
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

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.exceptionDetails)
    throw new Error(response.exceptionDetails.text)
  return response.result.value
}

const selection = await evaluate(`(async () => {
  const input = document.querySelector('#shared-video-url')
  const openButton = document.querySelector('#open-shared-link')
  input.value = ''
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
  const emptyDraftDisablesOpen = openButton.disabled
  input.value = 'https://www.crunchyroll.com/watch/GR75Q020Y/example-episode'
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  const typedDraftEnablesOpen = !openButton.disabled
  input.focus()
  input.setSelectionRange(8, 32)
  const original = input
  for (const listener of listeners)
    listener({ type: 'ROOM_STATE_UPDATED', state: { ...previewState, clockUncertaintyMs: 41 } })
  await Promise.resolve()
  return {
    sameElement: original === document.querySelector('#shared-video-url'),
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
    autocomplete: input.autocomplete,
    value: input.value,
    emptyDraftDisablesOpen,
    typedDraftEnablesOpen,
  }
})()`)

if (!selection.sameElement || selection.selectionStart !== 8 || selection.selectionEnd !== 32 || selection.autocomplete !== 'off' || !selection.emptyDraftDisablesOpen || !selection.typedDraftEnablesOpen)
  throw new Error(`Shared-link editing was interrupted: ${JSON.stringify(selection)}`)

const readiness = await evaluate(`(async () => {
  document.querySelector('#shared-video-url').blur()
  await new Promise(resolve => setTimeout(resolve, 0))
  const button = document.querySelector('#ready-button')
  button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  for (const listener of listeners)
    listener({ type: 'ROOM_STATE_UPDATED', state: { ...previewState, clockUncertaintyMs: 42 } })
  const survivedUpdate = button === document.querySelector('#ready-button')
  button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  button.click()
  await new Promise(resolve => setTimeout(resolve, 20))
  const request = previewRequests.filter(item => item.type === 'SET_READY').at(-1)
  return { survivedUpdate, request }
})()`)

socket.close()
if (!readiness.survivedUpdate || readiness.request?.ready !== false)
  throw new Error(`Ready click was interrupted: ${JSON.stringify(readiness)}`)

console.log(JSON.stringify({ selection, readiness }, null, 2))
