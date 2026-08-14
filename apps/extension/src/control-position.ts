import type { ControlKind, PlayerSample } from '@syncyourjoy/protocol'

export function resolveControlPosition(
  kind: ControlKind,
  explicitPosition: number | undefined,
  lastSample: PlayerSample | null,
  authoritativePosition: number,
): number {
  if (explicitPosition !== undefined)
    return explicitPosition
  if (kind === 'seek')
    return lastSample?.positionSeconds ?? authoritativePosition
  return authoritativePosition
}
