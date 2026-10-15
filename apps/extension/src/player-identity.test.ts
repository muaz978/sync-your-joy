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
