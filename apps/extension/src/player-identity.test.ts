import type { MediaFingerprint } from '@syncyourjoy/protocol'
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
