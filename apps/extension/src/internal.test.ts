import { describe, expect, it } from 'vitest'
import { normalizeStoredContractState } from './internal.ts'

describe('stored operation contract defaults', () => {
  it('does not restore a pre-contract room as transactional or operation-ready', () => {
    expect(normalizeStoredContractState(undefined)).toEqual({
      mode: 'legacy',
      capabilities: { contractVersion: 0, capabilities: [] },
      mediaEpoch: 0,
      operation: null,
      bindingId: null,
      sourceGeneration: 0,
      sampleSequence: 0,
    })
  })

  it('keeps a valid negotiated contract but drops an invalid stored binding', () => {
    expect(normalizeStoredContractState({
      mode: 'transactional',
      capabilities: { contractVersion: 1, capabilities: ['media-epoch', 'operation-identity', 'prepare-start', 'binding-sequence'] },
      mediaEpoch: 2,
      operation: {
        mediaEpoch: 2,
        operationId: 'operation_play_123456',
        kind: 'play',
        phase: 'preparing',
        requiredParticipantIds: ['participant_host'],
        preparedParticipantIds: [],
        startedParticipantIds: [],
        targetPositionSeconds: 0,
        effectiveAtServerMs: null,
        deadlineAtServerMs: 100,
      },
      bindingId: 'bad binding',
      sourceGeneration: 7,
      sampleSequence: 12,
    })).toEqual({
      mode: 'transactional',
      capabilities: { contractVersion: 1, capabilities: ['media-epoch', 'operation-identity', 'prepare-start', 'binding-sequence'] },
      mediaEpoch: 2,
      operation: { mediaEpoch: 2, operationId: 'operation_play_123456' },
      bindingId: null,
      sourceGeneration: 7,
      sampleSequence: 12,
    })
  })

  it('does not let an old operation survive a malformed transactional record', () => {
    const restored = normalizeStoredContractState({
      mode: 'transactional',
      capabilities: { contractVersion: 1, capabilities: ['media-epoch', 'operation-identity', 'prepare-start', 'binding-sequence'] },
      mediaEpoch: 4,
      operation: { mediaEpoch: 4, operationId: 'short' },
    })
    expect(restored.mode).toBe('transactional')
    expect(restored.mediaEpoch).toBe(4)
    expect(restored.operation).toBeNull()
  })
})
