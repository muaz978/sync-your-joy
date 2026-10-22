import type { RoomResult } from '@syncyourjoy/sync-engine'

export type DeadlineSource = 'seek' | 'operation' | 'health' | 'disconnect' | 'autoResume'

export interface DeadlineCoordinator {
  releaseExpiredSeek(nowMs: number): RoomResult | null
  releaseExpiredOperation(nowMs: number): RoomResult | null
  evaluateHealth(nowMs: number): RoomResult | null
  evaluateDisconnectGrace(nowMs: number): RoomResult | null
  evaluateAutoResume(nowMs: number): RoomResult | null
}

export interface DeadlineEvaluation {
  source: DeadlineSource
  result: RoomResult
}

export interface DurableRoomStorage {
  put<T>(key: string, value: T): Promise<void>
  setAlarm(timestamp: number): Promise<void>
}

/**
 * Apply at most one deadline transition for an alarm turn.
 *
 * Alarm delivery is not a transaction boundary. Once a deadline transition
 * changes the coordinator, the resulting state must be persisted and observed
 * before another deadline family is evaluated on a later turn. This keeps a
 * delayed or repeated alarm from emitting a sequence of snapshots derived
 * from one stale pre-alarm state.
 */
export function applyEarliestDueDeadline(coordinator: DeadlineCoordinator, nowMs: number): DeadlineEvaluation | null {
  const candidates: Array<[DeadlineSource, () => RoomResult | null]> = [
    ['seek', () => coordinator.releaseExpiredSeek(nowMs)],
    ['operation', () => coordinator.releaseExpiredOperation(nowMs)],
    ['health', () => coordinator.evaluateHealth(nowMs)],
    ['disconnect', () => coordinator.evaluateDisconnectGrace(nowMs)],
    ['autoResume', () => coordinator.evaluateAutoResume(nowMs)],
  ]

  for (const [source, evaluate] of candidates) {
    const result = evaluate()
    if (result)
      return { source, result }
  }

  return null
}

export function earliestAlarmAtMs(deadlines: Array<number | null | undefined>): number | null {
  const validDeadlines = deadlines.filter((deadline): deadline is number => Number.isFinite(deadline))
  return validDeadlines.length > 0 ? Math.min(...validDeadlines) : null
}

/**
 * Writes the room and sets the earliest alarm. `afterWrite` runs once the room
 * is durable and before the alarm is set, so what has to be observed only
 * after the state is saved does not wait for, or depend on, the alarm.
 */
export async function persistRoomAndSchedule<T>(
  storage: DurableRoomStorage,
  room: T,
  deadlines: Array<number | null | undefined>,
  afterWrite?: () => void,
): Promise<void> {
  await storage.put('room', room)
  afterWrite?.()
  const alarmAtMs = earliestAlarmAtMs(deadlines)
  if (alarmAtMs !== null)
    await storage.setAlarm(alarmAtMs)
}

/**
 * The Durable Object must make its state durable before a peer can observe the
 * state transition. The callback is deliberately injected so the ordering is
 * testable without replacing Cloudflare storage or WebSocket semantics.
 */
export async function persistThenObserve(
  persist: () => Promise<void>,
  observe: () => void,
): Promise<void> {
  await persist()
  observe()
}
