import type { ParticipantPlaybackStatus, RoomSnapshot } from '@syncyourjoy/protocol'
import type { ExtensionState } from './internal.ts'
import { playbackStatusCopy } from './playback-status.ts'
import { isAwaitingApproval, pendingPillCopy } from './room-membership.ts'

/**
 * What the on-page pill shows, decided from the room state alone so it can be
 * tested without a page. content-script.ts's renderPill() only copies this
 * onto the pill's elements.
 *
 * The caller supplies `localStatus` because it depends on the player the
 * content script is driving, which is not state.
 */
export interface PillViewInput {
  state: Pick<ExtensionState, 'connection' | 'participantId' | 'lastError'> & { snapshot: RoomSnapshot }
  hasVideo: boolean
  localStatus: ParticipantPlaybackStatus
}

export interface PillView {
  status: string
  meta: string
  playbackHidden: boolean
  playbackDisabled: boolean
  playbackLabel: string
  syncDisabled: boolean
  /** The room's last error, shown as the notice; null leaves the notice as it is. */
  notice: string | null
}

export function pillView(input: PillViewInput): PillView {
  const { state, hasVideo, localStatus } = input
  const snapshot = state.snapshot
  const notice = state.lastError || null

  // A pending request is not a member: the placeholder snapshot has no
  // participants, so the member copy below ("Member, 0 connected", a
  // different-episode hint) would be wrong, and none of the room's controls
  // apply. Say what is actually happening and offer nothing to press.
  if (isAwaitingApproval(state)) {
    const copy = pendingPillCopy(state.connection)
    return {
      status: copy.status,
      meta: copy.detail,
      playbackHidden: true,
      playbackDisabled: true,
      playbackLabel: 'Play',
      syncDisabled: true,
      notice,
    }
  }

  const connected = snapshot.participants.filter(item => item.connected)
  const allReady = connected.every(item => item.ready && item.mediaMatches)
  const isController = snapshot.controller.participantId === state.participantId
  const copy = playbackStatusCopy(localStatus, isController)

  return {
    status: state.connection === 'reconnecting'
      ? 'Reconnecting'
      : snapshot.seek
        ? `Seeking ${snapshot.seek.acknowledgedParticipantIds.length}/${connected.length}`
        : copy.label,
    meta: snapshot.seek
      ? `Moving everyone to ${formatPillTime(snapshot.seek.positionSeconds)}`
      : `${copy.detail} ${isController ? 'Controller' : 'Member'}, ${connected.length} connected.`,
    playbackHidden: !isController || !hasVideo,
    playbackDisabled: snapshot.seek !== null || (snapshot.playback.status === 'paused' && !allReady),
    playbackLabel: snapshot.seek ? 'Aligning' : snapshot.playback.status === 'playing' ? 'Pause' : 'Play',
    syncDisabled: !hasVideo || localStatus === 'wrong-media',
    notice,
  }
}

/**
 * The pill for a notice about a room that no longer exists (it has just
 * ended). There is no room to show, so it carries the message alone.
 */
export function roomlessNoticeView(message: string): { status: string, meta: string } {
  return { status: 'SyncYourJoy', meta: message }
}

export function formatPillTime(value: number): string {
  const seconds = Math.max(0, Math.floor(value))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
