import type { MediaFingerprint } from './index.ts'
import { describe, expect, it } from 'vitest'
import { canAcknowledgeOperation, CURRENT_CLIENT_CAPABILITIES, generateRoomCode, isAllowedOrigin, isCurrentOperation, isRoomOperation, mediaMatches, negotiateRoomMode, normalizeCanonicalId, normalizeMediaPageUrl, normalizePageUrl, normalizeRoomContractSnapshot, parseClientMessage, parseOperationAcknowledgement, ROOM_CODE_ALPHABET } from './index.ts'

describe('media identity matching', () => {
  it('does not treat two missing players as a video match', () => {
    expect(mediaMatches(null, null)).toBe(false)
  })

  it('matches legacy and stable Crunchyroll IDs for the same episode', () => {
    const host: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'www.crunchyroll.com/watch/GE00345558JAJP/from-now-on',
      title: 'Localized host title',
      durationSeconds: 1_470,
    }
    const guest: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00345558JAJP',
      title: 'Different regional page title',
      durationSeconds: 1_465,
    }

    expect(mediaMatches(host, guest)).toBe(true)
    expect(normalizeCanonicalId(host.service, host.canonicalId)).toBe(guest.canonicalId)
  })

  it('does not match different Crunchyroll episode IDs', () => {
    const base: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00345558JAJP',
      title: 'Episode 12',
      durationSeconds: 1_470,
    }

    expect(mediaMatches(base, { ...base, canonicalId: 'crunchyroll:GOTHER123456' })).toBe(false)
  })

  it('matches the same Qfilm video across page variants without relying on signed player URLs', () => {
    const host: MediaFingerprint = {
      service: 'qfilm', canonicalId: 'qfilm:a0821a41c', title: 'Host page', durationSeconds: null,
      pageUrl: 'https://a.qfilm.tv/play.php?vid=a0821a41c',
    }
    const guest: MediaFingerprint = {
      service: 'qfilm', canonicalId: 'qfilm:A0821A41C', title: 'Embedded player', durationSeconds: null,
      pageUrl: 'https://a.qfilm.tv/embed.php?vid=A0821A41C',
    }

    expect(mediaMatches(host, guest)).toBe(true)
    expect(normalizeCanonicalId(guest.service, guest.canonicalId)).toBe('qfilm:a0821a41c')
  })

  it('treats identical normalized page links as a strong match on generic sites', () => {
    const host: MediaFingerprint = {
      service: 'html5', canonicalId: 'page:host-variant', title: 'Host title', durationSeconds: 100,
      pageUrl: 'https://video.example/watch?id=42&utm_source=chat',
    }
    const guest: MediaFingerprint = {
      service: 'html5', canonicalId: 'page:guest-variant', title: 'Guest title', durationSeconds: 120,
      pageUrl: 'https://video.example/watch?id=42',
    }
    expect(mediaMatches(host, guest)).toBe(true)
  })

  it('allows only normalized HTTP and HTTPS room links', () => {
    expect(normalizePageUrl('https://Example.com/watch/?b=2&a=1#player')).toBe('https://example.com/watch?a=1&b=2')
    expect(normalizePageUrl('javascript:alert(1)')).toBeNull()
    expect(normalizePageUrl('file:///tmp/video.mp4')).toBeNull()
    expect(normalizePageUrl('https://user:secret@example.com/watch')).toBeNull()
    expect(normalizePageUrl(`https://example.com/${'x'.repeat(2_100)}`)).toBeNull()
    expect(parseClientMessage({
      type: 'open_link',
      actionId: 'action_open_safe',
      basedOnRevision: 1,
      leaseEpoch: 1,
      url: 'javascript:alert(1)',
    })).toBeNull()
  })

  it('removes unknown temporary query parameters from media identity URLs', () => {
    expect(normalizeMediaPageUrl('https://eta.animerco.org/jwplayer/?pnonce=temporary-client-token')).toBe('https://eta.animerco.org/jwplayer')
    expect(normalizeMediaPageUrl('https://a.qfilm.tv/play.php?vid=A0821A41C&token=temporary')).toBe('https://a.qfilm.tv/play.php?vid=A0821A41C')
  })

  it('strips temporary media pageUrl parameters from create_room, join_room and set_ready before they can be stored or broadcast', () => {
    const media = {
      service: 'html5',
      canonicalId: 'page:https://eta.animerco.org/jwplayer/',
      title: 'Episode 4',
      durationSeconds: 1_200,
      pageUrl: 'https://eta.animerco.org/jwplayer/?pnonce=temporary-client-token',
    }

    const create = parseClientMessage({
      type: 'create_room', protocolVersion: 1, participantId: 'participant_host', name: 'Muaz', code: 'ABCDEFGH', media,
    })
    expect(create).toMatchObject({ media: { pageUrl: 'https://eta.animerco.org/jwplayer' } })

    const join = parseClientMessage({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: 'ABCDEFGH', media,
    })
    expect(join).toMatchObject({ media: { pageUrl: 'https://eta.animerco.org/jwplayer' } })

    const setReady = parseClientMessage({ type: 'set_ready', ready: true, media })
    expect(setReady).toMatchObject({ media: { pageUrl: 'https://eta.animerco.org/jwplayer' } })
  })

  it('requires player-health reports to identify the room revision they observed', () => {
    const sample = {
      positionSeconds: 7,
      durationSeconds: 600,
      paused: false,
      buffering: false,
      sampledAtLocalMs: 10_000,
    }
    expect(parseClientMessage({ type: 'player_status', sample })).toBeNull()
    expect(parseClientMessage({ type: 'player_status', basedOnRevision: 4, sample })).toMatchObject({
      type: 'player_status',
      basedOnRevision: 4,
    })
    expect(parseClientMessage({
      type: 'player_status',
      basedOnRevision: 4,
      sample: { ...sample, progressed: true, progressEvidence: 'frames', playbackStarted: true, playbackStartFailed: false },
    })).toMatchObject({ sample: { progressed: true, progressEvidence: 'frames', playbackStarted: true } })
    expect(parseClientMessage({
      type: 'player_status',
      basedOnRevision: 4,
      sample: { ...sample, progressed: 'yes' },
    })).toBeNull()
    expect(parseClientMessage({
      type: 'player_status',
      basedOnRevision: 4,
      sample: { ...sample, progressEvidence: 'pixels' },
    })).toBeNull()
  })


  it('accepts only finite seek-completion acknowledgements', () => {
    expect(parseClientMessage({ type: 'seek_applied', revision: 7, positionSeconds: 120 })).toMatchObject({
      type: 'seek_applied',
      revision: 7,
    })
    expect(parseClientMessage({ type: 'seek_applied', revision: 7, positionSeconds: Number.NaN })).toBeNull()
  })

  it('accepts bounded sanitized diagnostic reports and rejects oversized event lists', () => {
    const report = {
      extensionVersion: '0.1.11',
      generatedAtLocalMs: 10_000,
      userAgent: 'Chrome test',
      connection: 'connected',
      roomRevision: 7,
      playbackStatus: 'playing',
      playerFrameId: 0,
      playerAreaPixels: 500_000,
      playerLastSeenAtMs: 9_900,
      mediaService: 'html5',
      mediaCanonicalId: 'page:https://video.example/watch/42',
      mediaPageUrl: 'https://video.example/watch/42',
      sample: null,
      events: [{ atLocalMs: 9_900, category: 'playback', message: 'player_status', details: { paused: false } }],
    }
    expect(parseClientMessage({ type: 'diagnostics_response', reportId: 'report_123456', report })).toMatchObject({
      type: 'diagnostics_response',
      reportId: 'report_123456',
    })
    expect(parseClientMessage({
      type: 'diagnostics_response',
      reportId: 'report_123456',
      report: { ...report, events: Array.from({ length: 121 }, () => report.events[0]) },
    })).toBeNull()
  })

  it('accepts a valid respond_to_join controller message and rejects a malformed one', () => {
    expect(parseClientMessage({
      type: 'respond_to_join',
      participantId: 'participant_friend',
      approve: true,
      actionId: 'action_respond1',
      basedOnRevision: 4,
      leaseEpoch: 1,
    })).toMatchObject({
      type: 'respond_to_join',
      participantId: 'participant_friend',
      approve: true,
    })

    expect(parseClientMessage({
      type: 'respond_to_join',
      participantId: 'participant_friend',
      approve: 'yes',
      actionId: 'action_respond2',
      basedOnRevision: 4,
      leaseEpoch: 1,
    })).toBeNull()

    expect(parseClientMessage({
      type: 'respond_to_join',
      participantId: 'participant_friend',
      approve: false,
      actionId: 'action_respond3',
      basedOnRevision: -1,
      leaseEpoch: 1,
    })).toBeNull()
  })

  it('accepts an optional reconnect session token only in join messages', () => {
    expect(parseClientMessage({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: 'ABCDEFGH', media: null,
      sessionToken: '0123456789abcdefghij',
    })).toMatchObject({ sessionToken: '0123456789abcdefghij' })
    expect(parseClientMessage({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_friend', name: 'Rana', code: 'ABCDEFGH', media: null,
      sessionToken: 'short',
    })).toBeNull()
  })
})

describe('room code generation', () => {
  it('generates an 8-character code', () => {
    expect(generateRoomCode()).toHaveLength(8)
  })

  it('only uses characters from the given alphabet', () => {
    const code = generateRoomCode()
    for (const character of code)
      expect(ROOM_CODE_ALPHABET.includes(character)).toBe(true)
  })

  it('respects a custom alphabet', () => {
    const code = generateRoomCode('AB')
    for (const character of code)
      expect(character === 'A' || character === 'B').toBe(true)
  })

  it('is not deterministic or hardcoded', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateRoomCode()))
    expect(codes.size).toBeGreaterThan(1)
  })
})

describe('origin allowlist', () => {
  it('accepts every allowed origin prefix', () => {
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnop')).toBe(true)
    expect(isAllowedOrigin('moz-extension://abcdefgh-ijkl-mnop')).toBe(true)
    expect(isAllowedOrigin('safari-web-extension://abcdefgh-ijkl')).toBe(true)
    expect(isAllowedOrigin('safari-extension://abcdefgh-ijkl')).toBe(true)
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
  })

  it('rejects a missing origin', () => {
    expect(isAllowedOrigin(null)).toBe(false)
    expect(isAllowedOrigin(undefined)).toBe(false)
  })

  it('rejects a disallowed origin', () => {
    expect(isAllowedOrigin('https://evil.example')).toBe(false)
  })
})

describe('operation identity and compatibility contract', () => {
  const operation = {
    mediaEpoch: 3,
    operationId: 'operation_seek_123456',
  }

  it('keeps operation validity separate from snapshot ordering', () => {
    expect(isCurrentOperation(operation, { ...operation })).toBe(true)
    expect(isCurrentOperation(operation, { ...operation, operationId: 'operation_seek_654321' })).toBe(false)
    expect(isCurrentOperation(operation, { ...operation, mediaEpoch: 4 })).toBe(false)
  })

  it('requires fixed, bounded participant evidence and terminal reasons', () => {
    const valid = {
      ...operation,
      kind: 'seek',
      phase: 'preparing',
      requiredParticipantIds: ['participant_host', 'participant_guest'],
      preparedParticipantIds: [],
      startedParticipantIds: [],
      targetPositionSeconds: 120,
      effectiveAtServerMs: null,
      deadlineAtServerMs: 10_000,
    }
    expect(isRoomOperation(valid)).toBe(true)
    expect(isRoomOperation({ ...valid, preparedParticipantIds: ['participant_unknown'] })).toBe(false)
    expect(isRoomOperation({ ...valid, phase: 'cancelled' })).toBe(false)
    expect(isRoomOperation({ ...valid, phase: 'cancelled', reason: 'deadline-expired' })).toBe(true)
    expect(isRoomOperation({ ...valid, requiredParticipantIds: Array.from({ length: 11 }, (_, index) => `participant_${index}`) })).toBe(false)
  })

  it('accepts current binding/sample acknowledgements and rejects stale-shaped data', () => {
    const acknowledgement = parseOperationAcknowledgement({
      ...operation,
      phase: 'prepared',
      participantId: 'participant_guest',
      bindingId: 'binding_123456',
      sourceGeneration: 2,
      sampleSequence: 9,
      observedPositionSeconds: 120,
      observedAtLocalMs: 50_000,
    })
    expect(acknowledgement).toMatchObject({ phase: 'prepared', sampleSequence: 9 })
    expect(parseOperationAcknowledgement({
      ...acknowledgement,
      mediaEpoch: -1,
    })).toBeNull()
    expect(parseOperationAcknowledgement({
      ...acknowledgement,
      bindingId: 'bad!',
    })).toBeNull()
    expect(parseOperationAcknowledgement({
      ...acknowledgement,
      sampleSequence: Number.MAX_SAFE_INTEGER + 1,
    })).toBeNull()
  })

  it('fails closed when every peer does not advertise the transaction contract', () => {
    const transactional = negotiateRoomMode([
      { participantId: 'participant_host', capabilities: CURRENT_CLIENT_CAPABILITIES },
      { participantId: 'participant_guest', capabilities: CURRENT_CLIENT_CAPABILITIES },
    ])
    expect(transactional).toMatchObject({ mode: 'transactional', incompatibleParticipantIds: [] })
    expect(canAcknowledgeOperation('transactional', transactional.sharedCapabilities, operation)).toBe(true)

    const legacy = negotiateRoomMode([
      { participantId: 'participant_host', capabilities: CURRENT_CLIENT_CAPABILITIES },
      { participantId: 'participant_old', capabilities: { contractVersion: 0, capabilities: [] } },
    ])
    expect(legacy.mode).toBe('legacy')
    expect(legacy.incompatibleParticipantIds).toEqual(['participant_old'])
    expect(canAcknowledgeOperation(legacy.mode, legacy.sharedCapabilities, operation)).toBe(false)
  })

  it('accepts legacy create/join messages without silently upgrading them', () => {
    const legacy = parseClientMessage({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_guest', name: 'Rana', code: 'ABCDEFGH', media: null,
    })
    expect(legacy).not.toBeNull()
    expect(parseClientMessage({
      type: 'join_room', protocolVersion: 1, participantId: 'participant_guest', name: 'Rana', code: 'ABCDEFGH', media: null,
      capabilities: { contractVersion: 1, capabilities: ['unsupported-feature'] },
    })).toBeNull()
  })

  it('restores old or malformed contract state to paused-safe legacy defaults', () => {
    expect(normalizeRoomContractSnapshot(undefined)).toEqual({
      mode: 'legacy', mediaEpoch: 0, sharedCapabilities: [], operation: null,
    })
    expect(normalizeRoomContractSnapshot({
      mode: 'transactional', mediaEpoch: 4, sharedCapabilities: [...CURRENT_CLIENT_CAPABILITIES.capabilities], operation: { bad: true },
    })).toEqual({
      mode: 'transactional', mediaEpoch: 4, sharedCapabilities: [...CURRENT_CLIENT_CAPABILITIES.capabilities], operation: null,
    })
    expect(normalizeRoomContractSnapshot({
      mode: 'transactional', mediaEpoch: 4, sharedCapabilities: [...CURRENT_CLIENT_CAPABILITIES.capabilities], operation: {
        mediaEpoch: 3,
        operationId: 'operation_seek_123456',
        kind: 'seek',
        phase: 'preparing',
        requiredParticipantIds: ['participant_host'],
        preparedParticipantIds: [],
        startedParticipantIds: [],
        targetPositionSeconds: 120,
        effectiveAtServerMs: null,
        deadlineAtServerMs: 10_000,
      },
    })).toEqual({
      mode: 'transactional', mediaEpoch: 4, sharedCapabilities: [...CURRENT_CLIENT_CAPABILITIES.capabilities], operation: null,
    })
    expect(normalizeRoomContractSnapshot({
      mode: 'transactional', mediaEpoch: 4, sharedCapabilities: ['unknown'], operation: null,
    })).toEqual({
      mode: 'legacy', mediaEpoch: 4, sharedCapabilities: [], operation: null,
    })
  })
})
