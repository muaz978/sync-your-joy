import { expect, type Page } from '@playwright/test'

export const SYNC_TOLERANCE_SECONDS = 0.75

/**
 * Finds the visible, metadata-ready video without reading its source URL or
 * any protected media data. Crunchyroll can keep more than one video element
 * in the document while it replaces or prepares the active player, so the
 * largest visible ready element is the least fragile state-only selector.
 */
export function findVisibleVideo(): HTMLVideoElement | null {
  const candidates = Array.from(document.querySelectorAll('video'))
    .filter(video => {
      const rect = video.getBoundingClientRect()
      return rect.width >= 200
        && rect.height >= 100
        && video.readyState >= 2
        && Number.isFinite(video.duration)
        && video.duration > 15
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect()
      const rightRect = right.getBoundingClientRect()
      return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height)
    })
  return candidates[0] ?? null
}

export async function waitForProviderVideos(...pages: Page[]): Promise<void> {
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    const videos = Array.from(document.querySelectorAll('video'))
    return videos.some(video => {
      const rect = video.getBoundingClientRect()
      return rect.width >= 200
        && rect.height >= 100
        && video.readyState >= 2
        && Number.isFinite(video.duration)
        && video.duration > 15
    })
  }, undefined, { timeout: 90_000 })))
}

export async function assertBothProviderVideosAdvance(...pages: Page[]): Promise<void> {
  await Promise.all(pages.map(page => page.evaluate(() => new Promise<void>((resolveProgress, rejectProgress) => {
    const video = Array.from(document.querySelectorAll('video'))
      .filter(candidate => {
        const rect = candidate.getBoundingClientRect()
        return rect.width >= 200
          && rect.height >= 100
          && candidate.readyState >= 2
          && Number.isFinite(candidate.duration)
          && candidate.duration > 15
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect()
        const rightRect = right.getBoundingClientRect()
        return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height)
      })[0] ?? null
    if (!video || typeof video.requestVideoFrameCallback !== 'function') {
      rejectProgress(new Error('A visible provider video with frame callbacks is required.'))
      return
    }

    let baseline: { mediaTime: number, position: number, presentedFrames: number } | null = null
    let callbackId = 0
    const timeout = window.setTimeout(() => {
      video.cancelVideoFrameCallback(callbackId)
      rejectProgress(new Error('Provider playback did not produce sustained media and frame progress.'))
    }, 15_000)

    const observe: VideoFrameRequestCallback = (_now, frame) => {
      if (video.paused || video.seeking) {
        baseline = null
      }
      else {
        baseline ??= {
          mediaTime: frame.mediaTime,
          position: video.currentTime,
          presentedFrames: frame.presentedFrames,
        }
        if (frame.mediaTime - baseline.mediaTime >= 0.6
          && video.currentTime - baseline.position >= 0.6
          && frame.presentedFrames - baseline.presentedFrames >= 3) {
          window.clearTimeout(timeout)
          resolveProgress()
          return
        }
      }
      callbackId = video.requestVideoFrameCallback(observe)
    }

    callbackId = video.requestVideoFrameCallback(observe)
  }))))
}

export async function providerVideoSnapshot(page: Page): Promise<{
  currentTime: number
  paused: boolean
  duration: number
}> {
  return page.evaluate(() => {
    const video = Array.from(document.querySelectorAll('video'))
      .filter(candidate => {
        const rect = candidate.getBoundingClientRect()
        return rect.width >= 200
          && rect.height >= 100
          && candidate.readyState >= 2
          && Number.isFinite(candidate.duration)
          && candidate.duration > 15
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect()
        const rightRect = right.getBoundingClientRect()
        return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height)
      })[0] ?? null
    if (!video)
      throw new Error('A visible provider video is required.')
    return {
      currentTime: video.currentTime,
      paused: video.paused,
      duration: video.duration,
    }
  })
}

export async function assertProviderPositionsConverge(pageA: Page, pageB: Page): Promise<void> {
  await expect.poll(async () => {
    const [videoA, videoB] = await Promise.all([
      providerVideoSnapshot(pageA),
      providerVideoSnapshot(pageB),
    ])
    return Math.abs(videoA.currentTime - videoB.currentTime)
  }, { message: 'Provider video timelines should converge.' }).toBeLessThanOrEqual(SYNC_TOLERANCE_SECONDS)
}
