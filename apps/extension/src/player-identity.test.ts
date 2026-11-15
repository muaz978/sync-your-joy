import type { MediaFingerprint } from '@syncyourjoy/protocol'
import { RoomCoordinator } from '@syncyourjoy/sync-engine'
import { describe, expect, it } from 'vitest'
import { decidePlayerIdentity, hasStrongLocalIdentity } from './player-identity.ts'

const roomMedia: MediaFingerprint = {
  service: 'html5',
  canonicalId: 'page:https://watch.example/episode/42',
  title: 'Episode 42',
  durationSeconds: 120,
  pageUrl: 'https://watch.example/episode/42',
}

const nestedWrapper: MediaFingerprint = {
  service: 'html5',
  canonicalId: 'page:https://player.example/embed/client-wrapper',
  title: 'Embedded player',
  durationSeconds: 120,
  pageUrl: 'https://player.example/embed/client-wrapper',
}

describe('player identity decisions', () => {
  it('treats a stable provider ID as strong evidence even inside a nested frame', () => {
    expect(hasStrongLocalIdentity({
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00365016JAJP',
      title: 'Episode',
      durationSeconds: 1_420,
    }, true)).toBe(true)
  })

  it('uses a matching worker binding for an unresolved generic nested frame', () => {
    expect(decidePlayerIdentity({
      roomMedia,
      localMedia: nestedWrapper,
      workerBoundMedia: roomMedia,
      nested: true,
    })).toBe('match')
  })

  it('does not let an unresolved nested frame act without a worker binding', () => {
    expect(decidePlayerIdentity({
      roomMedia,
      localMedia: nestedWrapper,
      workerBoundMedia: null,
      nested: true,
    })).toBe('unknown')
  })

  it('blocks a strong provider mismatch even when a worker binding is present', () => {
    const crunchyrollRoom: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00365016JAJP',
      title: 'Episode',
      durationSeconds: 1_420,
    }
    const crunchyrollNext: MediaFingerprint = {
      service: 'crunchyroll',
      canonicalId: 'crunchyroll:GE00365017JAJP',
      title: 'Next episode',
      durationSeconds: 1_420,
    }
    expect(decidePlayerIdentity({
      roomMedia: crunchyrollRoom,
      localMedia: crunchyrollNext,
      workerBoundMedia: crunchyrollNext,
      nested: true,
    })).toBe('mismatch')
  })

  it('keeps a top-document generic page mismatch explicit', () => {
    expect(decidePlayerIdentity({
      roomMedia,
      localMedia: { ...roomMedia, canonicalId: 'page:https://watch.example/other', pageUrl: 'https://watch.example/other' },
      workerBoundMedia: null,
      nested: false,
    })).toBe('mismatch')
  })

  // The worker binds a frame by tab and frame, not by what it plays. A binding
  // that matches the room says "this frame was accepted for the room", and must
  // not outvote a stable provider ID the frame itself reports for another
  // episode: the worker is only the authority where the frame cannot say.
  describe('a nested frame that names another episode', () => {
    const sameRoomAndBinding = (room: MediaFingerprint, local: MediaFingerprint) => decidePlayerIdentity({
      roomMedia: room,
      localMedia: local,
      workerBoundMedia: room,
      nested: true,
    })

    it.each([
      ['crunchyroll', 'crunchyroll:GE00365016JAJP', 'crunchyroll:GE00365017JAJP'],
      ['youtube', 'youtube:abc123', 'youtube:xyz789'],
      ['netflix', 'netflix:80100172', 'netflix:80100173'],
      ['disney-plus', 'disney-plus:0a1b2c', 'disney-plus:3d4e5f'],
      ['qfilm', 'qfilm:a0821a41c', 'qfilm:b1932b52d'],
    ])('is a mismatch for %s even though the worker binding matches the room', (service, roomId, otherId) => {
      const media = (canonicalId: string): MediaFingerprint => ({ service, canonicalId, title: 'Episode', durationSeconds: 1_420 })
      expect(sameRoomAndBinding(media(roomId), media(otherId))).toBe('mismatch')
      // The same frame reporting the room's own ID stays a match, so the case
      // above is decided by the ID and not by an unrelated default.
      expect(sameRoomAndBinding(media(roomId), media(roomId))).toBe('match')
    })

    it('is a mismatch when the provider ID prefix is not lower case', () => {
      const room: MediaFingerprint = { service: 'crunchyroll', canonicalId: 'crunchyroll:GE00365016JAJP', title: 'Episode', durationSeconds: 1_420 }
      const other: MediaFingerprint = { ...room, canonicalId: 'Crunchyroll:GE00365017JAJP' }
      expect(sameRoomAndBinding(room, other)).toBe('mismatch')
    })
  })

  describe('a nested generic wrapper', () => {
    const otherPage: MediaFingerprint = {
      service: 'html5',
      canonicalId: 'page:https://watch.example/episode/43',
      title: 'Episode 43',
      durationSeconds: 120,
      pageUrl: 'https://watch.example/episode/43',
    }

    it('is a mismatch when the worker binding names another page than the room, whatever the wrapper says', () => {
      for (const localMedia of [nestedWrapper, roomMedia, otherPage]) {
        expect(decidePlayerIdentity({ roomMedia, localMedia, workerBoundMedia: otherPage, nested: true }), localMedia.canonicalId).toBe('mismatch')
      }
    })
  })

  // Qfilm's player lives in a nested frame whose own URL does not identify the
  // movie, but its video ID is stable provider evidence: it is decided by that
  // ID with or without a worker binding.
  describe('a nested Qfilm player', () => {
    const qfilm = (id: string): MediaFingerprint => ({
      service: 'qfilm',
      canonicalId: `qfilm:${id}`,
      title: 'Qfilm movie',
      durationSeconds: 120,
      pageUrl: `https://a.qfilm.tv/play.php?vid=${id}`,
    })

    it('matches its own video ID without a worker binding', () => {
      expect(decidePlayerIdentity({ roomMedia: qfilm('a0821a41c'), localMedia: qfilm('a0821a41c'), workerBoundMedia: null, nested: true })).toBe('match')
    })

    it('is a mismatch for another video ID without a worker binding', () => {
      expect(decidePlayerIdentity({ roomMedia: qfilm('a0821a41c'), localMedia: qfilm('b1932b52d'), workerBoundMedia: null, nested: true })).toBe('mismatch')
    })

    it('is a mismatch for another video ID with a worker binding that matches the room', () => {
      expect(decidePlayerIdentity({ roomMedia: qfilm('a0821a41c'), localMedia: qfilm('b1932b52d'), workerBoundMedia: qfilm('a0821a41c'), nested: true })).toBe('mismatch')
    })

    it('is a mismatch when the worker binding names another video than the room, even for the room\'s own ID', () => {
      expect(decidePlayerIdentity({ roomMedia: qfilm('a0821a41c'), localMedia: qfilm('a0821a41c'), workerBoundMedia: qfilm('b1932b52d'), nested: true })).toBe('mismatch')
    })
  })
})

// Installed extensions decide whether a snapshot may drive their page's video
// with decidePlayerIdentity: anything but 'match' makes the content script
// leave the video alone. The coordinator's placeholder for an unapproved join
// request relies on that: if it were ever judged a match, every installed
// extension would pause and rewind a requester's own video the moment the
// coordinator is redeployed. The content-script tests cannot pin this, because
// the newer guard for pending requests runs first, so it is pinned here.
describe('the placeholder an unapproved join request receives', () => {
  const real: MediaFingerprint[] = [
    { service: 'crunchyroll', canonicalId: 'crunchyroll:GE00365016JAJP', title: 'Episode', durationSeconds: 1_420, pageUrl: 'https://www.crunchyroll.com/watch/GE00365016JAJP/episode' },
    { service: 'youtube', canonicalId: 'youtube:abc123', title: 'A video', durationSeconds: 600 },
    { service: 'netflix', canonicalId: 'netflix:80100172', title: 'A show', durationSeconds: 3_000 },
    { service: 'qfilm', canonicalId: 'qfilm:a0821a41c', title: 'Qfilm movie', durationSeconds: 120, pageUrl: 'https://a.qfilm.tv/play.php?vid=a0821a41c' },
    roomMedia,
    nestedWrapper,
    { service: 'html5', canonicalId: 'page:https://other.example/watch', title: 'Untitled', durationSeconds: null },
  ]

  function placeholderMedia(): MediaFingerprint {
    const room = new RoomCoordinator({ roomId: 'room_123456', code: 'ABCDEFGH' }, { id: 'participant_host', name: 'Muaz', media: real[0]! })
    room.join({ id: 'participant_friend', name: 'Rana', media: real[1]!, sessionToken: 'friend-session-token-000000' })
    const media = room.pendingSnapshot('participant_friend').media
    if (!media)
      throw new Error('The placeholder must carry a fingerprint, not null: null reads as "matches the room".')
    return media
  }

  it('is never a match for any local media, with or without a worker-bound player, nested or not', () => {
    const roomMediaPlaceholder = placeholderMedia()
    for (const localMedia of real) {
      for (const workerBoundMedia of [null, ...real]) {
        for (const nested of [false, true]) {
          const decision = decidePlayerIdentity({ roomMedia: roomMediaPlaceholder, localMedia, workerBoundMedia, nested })
          expect(decision, `${localMedia.canonicalId} / ${workerBoundMedia?.canonicalId ?? 'unbound'} / nested=${nested}`).not.toBe('match')
        }
      }
    }
  })
})
