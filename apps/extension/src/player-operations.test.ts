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

  it('retires the active seek when the source is replaced, so its late completion is not local intent', () => {
    const operations = new PlayerOperations()
    const { operation } = operations.beginSeek(120, 4, 100)

    operations.invalidateSource(200)

    expect(operations.currentSeek).toBeNull()
    expect(operations.isCurrentSeek(operation.token)).toBe(false)
    expect(operations.classifySeekEvent(120, 4_999)).toBe('retired')
    expect(operations.classifySeekEvent(210, 4_999)).toBe('user')
  })

  it('does not complete a seek that a source change retired', () => {
    const operations = new PlayerOperations()
    const { operation } = operations.beginSeek(120, 4, 100)

    operations.invalidateSource(200)

    expect(operations.completeSeek(operation.token)).toBe(false)
    expect(operations.markSeekTimedOut(operation.token)).toBe(false)
  })

  it('keeps a retired seek attributable for exactly its five-second window', () => {
    const operations = new PlayerOperations()
    operations.beginSeek(120, 4, 100)
    operations.invalidateCommand(1_000)

    expect(operations.classifySeekEvent(120, 5_999)).toBe('retired')
    expect(operations.classifySeekEvent(120, 6_000)).toBe('user')
  })

  it('attributes a retired seek within one second of its target and not beyond', () => {
    const operations = new PlayerOperations()
    operations.beginSeek(120, 4, 100)
    operations.invalidateCommand(200)

    expect(operations.classifySeekEvent(119, 300)).toBe('retired')
    expect(operations.classifySeekEvent(121, 300)).toBe('retired')
    expect(operations.classifySeekEvent(121.01, 300)).toBe('user')
    expect(operations.classifySeekEvent(118.99, 300)).toBe('user')
  })

  describe('the list of retired seeks', () => {
    // Targets are 60 s apart, so each is attributable only to its own entry.
    function retireSeeks(count: number): PlayerOperations {
      const operations = new PlayerOperations()
      for (let index = 1; index <= count; index += 1)
        operations.beginSeek(index * 60, index, 100 + index)
      operations.invalidateCommand(200)
      return operations
    }

    it('holds the eight most recent and forgets the oldest of nine', () => {
      const operations = retireSeeks(9)

      expect(operations.classifySeekEvent(60, 300)).toBe('user')
      for (let index = 2; index <= 9; index += 1)
        expect(operations.classifySeekEvent(index * 60, 300)).toBe('retired')
    })

    it('holds all eight when exactly eight were retired', () => {
      const operations = retireSeeks(8)

      for (let index = 1; index <= 8; index += 1)
        expect(operations.classifySeekEvent(index * 60, 300)).toBe('retired')
    })

    it('forgets the oldest first as later seeks are retired, whatever the reason', () => {
      const operations = retireSeeks(8)
      operations.beginSeek(900, 9, 300)
      operations.invalidateSource(310)

      expect(operations.classifySeekEvent(60, 400)).toBe('user')
      expect(operations.classifySeekEvent(120, 400)).toBe('retired')
      expect(operations.classifySeekEvent(900, 400)).toBe('retired')
    })

    it('retires a seek that a newer target replaced, without waiting for a command change', () => {
      const operations = new PlayerOperations()
      operations.beginSeek(120, 4, 100)
      operations.beginSeek(400, 5, 150)

      expect(operations.currentSeek?.positionSeconds).toBe(400)
      // Only the active seek is consulted while one exists.
      expect(operations.classifySeekEvent(120, 200)).toBe('active')
      operations.invalidateCommand(250)
      expect(operations.classifySeekEvent(120, 300)).toBe('retired')
      expect(operations.classifySeekEvent(400, 300)).toBe('retired')
    })
  })

  describe('a seek the page saw complete before the element\'s own seeked event', () => {
    it('leaves nothing to attribute when the seeked event itself delivered the completion', () => {
      const operations = new PlayerOperations()
      const { operation } = operations.beginSeek(120, 4, 100)

      expect(operations.completeSeek(operation.token)).toBe(true)

      expect(operations.currentSeek).toBeNull()
      expect(operations.classifySeekEvent(120, 200)).toBe('user')
    })

    it('keeps the completed target attributable when a readiness event or probe delivered it', () => {
      const operations = new PlayerOperations()
      const { operation } = operations.beginSeek(120, 4, 100)

      expect(operations.completeSeek(operation.token, 150)).toBe(true)

      expect(operations.currentSeek).toBeNull()
      expect(operations.isCurrentSeek(operation.token)).toBe(false)
      expect(operations.classifySeekEvent(120, 5_149)).toBe('retired')
      expect(operations.classifySeekEvent(120, 5_150)).toBe('user')
      expect(operations.classifySeekEvent(210, 200)).toBe('user')
    })

    it('does not attribute anything for a seek that is no longer the current one', () => {
      const operations = new PlayerOperations()
      const { operation } = operations.beginSeek(120, 4, 100)
      operations.beginSeek(400, 5, 150)

      expect(operations.completeSeek(operation.token, 160)).toBe(false)
      expect(operations.currentSeek?.positionSeconds).toBe(400)
    })
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
