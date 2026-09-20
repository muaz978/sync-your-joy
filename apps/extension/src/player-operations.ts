export type OperationKind = 'play' | 'seek'

export interface OperationToken {
  id: number
  kind: OperationKind
  commandGeneration: number
  sourceGeneration: number
}

export interface SeekOperation {
  token: OperationToken
  positionSeconds: number
  roomRevision: number | null
  since: number
  lastAttemptAt: number
  timedOut: boolean
}

export type SeekEventAttribution = 'active' | 'retired' | 'user'

export interface OperationGeneration {
  commandGeneration: number
  sourceGeneration: number
}

export interface BeginSeekResult {
  operation: SeekOperation
  created: boolean
}

const SEEK_ATTRIBUTION_WINDOW_MS = 5_000
const MAX_RETIRED_SEEKS = 8
const SEEK_MATCH_TOLERANCE_SECONDS = 1

/**
 * Owns the identity of asynchronous player operations independently from the
 * DOM element that happens to execute them. A provider can complete a native
 * operation after a room command, source or controller has changed, so the
 * completion must be attributable before it can become local intent.
 */
export class PlayerOperations {
  private nextId = 0
  private commandGeneration = 0
  private sourceGeneration = 0
  private activeSeek: SeekOperation | null = null
  private activePlay: OperationToken | null = null
  private retiredSeeks: Array<{ positionSeconds: number; expiresAt: number }> = []

  get currentSeek(): SeekOperation | null {
    return this.activeSeek
  }

  snapshot(): OperationGeneration {
    return {
      commandGeneration: this.commandGeneration,
      sourceGeneration: this.sourceGeneration,
    }
  }

  isCurrentGeneration(generation: OperationGeneration): boolean {
    return generation.commandGeneration === this.commandGeneration
      && generation.sourceGeneration === this.sourceGeneration
  }

  invalidateCommand(nowMs: number): void {
    this.commandGeneration += 1
    this.retireSeek(nowMs)
    this.activePlay = null
  }

  invalidateSource(nowMs: number): void {
    this.sourceGeneration += 1
    this.invalidateCommand(nowMs)
  }

  retireSeek(nowMs: number): void {
    if (this.activeSeek) {
      this.retiredSeeks.push({
        positionSeconds: this.activeSeek.positionSeconds,
        expiresAt: nowMs + SEEK_ATTRIBUTION_WINDOW_MS,
      })
      this.retiredSeeks = this.retiredSeeks.slice(-MAX_RETIRED_SEEKS)
    }
    this.activeSeek = null
  }

  retirePlay(): void {
    this.activePlay = null
  }

  beginSeek(positionSeconds: number, roomRevision: number | null, nowMs: number): BeginSeekResult {
    this.pruneRetiredSeeks(nowMs)
    const existing = this.activeSeek
    if (existing
      && existing.positionSeconds === positionSeconds
      && existing.roomRevision === roomRevision)
      return { operation: existing, created: false }

    this.retireSeek(nowMs)
    const operation: SeekOperation = {
      token: this.createToken('seek'),
      positionSeconds,
      roomRevision,
      since: nowMs,
      lastAttemptAt: nowMs,
      timedOut: false,
    }
    this.activeSeek = operation
    return { operation, created: true }
  }

  markSeekTimedOut(token: OperationToken): boolean {
    if (!this.activeSeek || !this.sameToken(this.activeSeek.token, token))
      return false
    this.activeSeek.timedOut = true
    return true
  }

  isCurrentSeek(token: OperationToken): boolean {
    return this.activeSeek !== null && this.sameToken(this.activeSeek.token, token)
  }

  completeSeek(token: OperationToken): boolean {
    if (!this.isCurrentSeek(token))
      return false
    this.activeSeek = null
    return true
  }

  classifySeekEvent(positionSeconds: number, nowMs: number): SeekEventAttribution {
    this.pruneRetiredSeeks(nowMs)
    if (this.activeSeek)
      return 'active'
    if (this.retiredSeeks.some(item => Math.abs(item.positionSeconds - positionSeconds) <= SEEK_MATCH_TOLERANCE_SECONDS))
      return 'retired'
    return 'user'
  }

  beginPlay(): OperationToken | null {
    if (this.activePlay)
      return null
    this.activePlay = this.createToken('play')
    return this.activePlay
  }

  isCurrentPlay(token: OperationToken): boolean {
    return this.activePlay !== null && this.sameToken(this.activePlay, token)
  }

  settlePlay(token: OperationToken): boolean {
    if (!this.isCurrentPlay(token))
      return false
    this.activePlay = null
    return true
  }

  private createToken(kind: OperationKind): OperationToken {
    return {
      id: ++this.nextId,
      kind,
      commandGeneration: this.commandGeneration,
      sourceGeneration: this.sourceGeneration,
    }
  }

  private sameToken(left: OperationToken, right: OperationToken): boolean {
    return left.id === right.id
      && left.kind === right.kind
      && left.commandGeneration === right.commandGeneration
      && left.sourceGeneration === right.sourceGeneration
  }

  private pruneRetiredSeeks(nowMs: number): void {
    this.retiredSeeks = this.retiredSeeks.filter(item => item.expiresAt > nowMs)
  }
}
