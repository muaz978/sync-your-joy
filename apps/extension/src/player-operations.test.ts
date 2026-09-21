import { describe, expect, it } from 'vitest'
import { PlayerOperations } from './player-operations.ts'

describe('PlayerOperations', () => {
  it('keeps one in-flight seek owner for the same target', () => {
    const operations = new PlayerOperations()
    const first = operations.beginSeek(120, 4, 100)
    const second = operations.beginSeek(120, 4, 200)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.operation.token).toEqual(first.operation.token)
  })

  it('keeps a timed-out seek attributable for late read-only completion', () => {
    const operations = new PlayerOperations()
    const { operation } = operations.beginSeek(120, 4, 100)

    expect(operations.markSeekTimedOut(operation.token)).toBe(true)
    expect(operations.classifySeekEvent(120, 5_099)).toBe('active')
    expect(operations.completeSeek(operation.token)).toBe(true)
    expect(operations.currentSeek).toBeNull()
  })

  it('classifies a cancelled native completion as retired, not local intent', () => {
    const operations = new PlayerOperations()
    const { operation } = operations.beginSeek(120, 4, 100)

    operations.invalidateCommand(200)

    expect(operations.classifySeekEvent(120, 4_999)).toBe('retired')
    expect(operations.classifySeekEvent(210, 4_999)).toBe('user')
    expect(operations.classifySeekEvent(120, 5_200)).toBe('user')
    expect(operations.isCurrentSeek(operation.token)).toBe(false)
  })

  it('retires old play callbacks when command ownership changes', () => {
    const operations = new PlayerOperations()
    const oldPlay = operations.beginPlay()
    expect(operations.hasActivePlay).toBe(true)

    operations.invalidateCommand(100)

    const newPlay = operations.beginPlay()
    expect(oldPlay).not.toBeNull()
    expect(newPlay).not.toBeNull()
    expect(operations.hasActivePlay).toBe(true)
    expect(operations.isCurrentPlay(oldPlay!)).toBe(false)
    expect(operations.isCurrentPlay(newPlay!)).toBe(true)

    operations.settlePlay(newPlay!)
    expect(operations.hasActivePlay).toBe(false)
  })

  it('invalidates controller intent timers across source changes', () => {
    const operations = new PlayerOperations()
    const beforeSourceChange = operations.snapshot()

    operations.invalidateSource(100)

    expect(operations.isCurrentGeneration(beforeSourceChange)).toBe(false)
    expect(operations.isCurrentGeneration(operations.snapshot())).toBe(true)
  })
})
